/**
 * `AgentLoginWorkflow`'s step bodies (§18.22) — plain functions over a `LoginStepScope`, so a test
 * drives them (or the whole class) against Postgres with a `FakeSandbox` and a fake driver.
 *
 * The row is the claim and the truth: every step re-reads it, and every status write is a
 * compare-and-set from the statuses that step may leave. A cancel (the route flips the row to
 * `cancelled`) is noticed by the next step to read it — `stopped` — and the Workflow goes straight
 * to `cleanup`.
 *
 * **No step returns a secret.** `capture` seals the credential into `agent_credentials` inside the
 * step and returns `{ ok: true }`; the pasted code is decrypted inside `submit#N`, handed to the
 * sandbox, and nulled on the row in the same step; every failure message goes through
 * `safeErrorMessage`, which masks anything key-shaped.
 */
import {
  AGENT_LOGIN_ACTIVE_STATUSES,
  AGENT_RUNTIME_LABELS,
  type AgentLoginParams,
  type AgentLoginStatus,
  type AgentRuntimeId,
} from '@launch/shared/launch-agents'
import { and, eq, inArray } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { type AgentLoginRow, agentLogins } from '../../../../db/schema'
import { decryptToken } from '../../../auth/oauth-encryption'
import type { Logger } from '../../../utils/core/logger'
import { recordAudit, SYSTEM_ACTOR } from '../../launch/audit'
import { putSealed } from '../credentials/store'
import { safeErrorMessage } from '../events'
import type { SandboxPort } from '../ports'
import { runtimeFor } from '../runtimes'
import type { LoginContext, LoginDriver } from '../runtimes/types'

/** How often a polling step looks again. */
export const LOGIN_POLL_MS = 2_000
/** The most one polling step waits before handing back to the Workflow (a new step, same loop). */
export const LOGIN_POLL_STEP_MS = 60_000
/** The most rounds of each polling loop — a correctness guard; the TTL ends a login far sooner. */
export const MAX_LOGIN_ROUNDS = 40
/** The bound on destroying the sandbox in `cleanup` (it never holds the login up longer). */
export const LOGIN_DESTROY_MS = 30_000

/** The login sandbox's name: never a session id, so it can never be mistaken for one. */
export const loginSandboxName = (loginId: string) => `login-${loginId}`

export interface LoginStepScope {
  db: Database
  cfg: AppConfig
  params: AgentLoginParams
  /** The sandbox named `name` — `ports.sandbox`, the same adapter sessions use. */
  sandbox(name: string): SandboxPort
  /**
   * Before the CLI starts: the egress's `prepareLogin` — on the remote sandbox host, the grant
   * that lets exactly this runtime's sign-in through (`egress/host.ts`). Absent / `proxied`:
   * nothing (Launch's handlers find the login row by the sandbox id).
   */
  prepareLogin?(sandbox: SandboxPort, runtime: AgentRuntimeId): Promise<void>
  logger?: Pick<Logger, 'warn' | 'info' | 'error'>
  now: () => Date
  /** MUST yield (a timer) — tests pass one that advances `now`. */
  sleep: (ms: number) => Promise<void>
  /** The runtime's driver (tests hand in a fake). Default: `runtimeFor(runtime).login`. */
  driverFor?: (runtime: AgentRuntimeId) => LoginDriver | undefined
}

/** A polling step's verdict. */
export type LoginPoll =
  | { state: 'ready' }
  | { state: 'waiting' }
  | { state: 'stopped' }
  | { state: 'expired' }

async function loadLogin(scope: LoginStepScope): Promise<AgentLoginRow | null> {
  const [row] = await scope.db
    .select()
    .from(agentLogins)
    .where(
      and(eq(agentLogins.tenantId, scope.params.tenantId), eq(agentLogins.id, scope.params.loginId))
    )
    .limit(1)
  return row ?? null
}

const isActive = (row: AgentLoginRow | null): row is AgentLoginRow =>
  Boolean(row && (AGENT_LOGIN_ACTIVE_STATUSES as readonly AgentLoginStatus[]).includes(row.status))

const expired = (row: AgentLoginRow, scope: LoginStepScope) =>
  row.expiresAt.getTime() <= scope.now().getTime()

function driverOf(scope: LoginStepScope, runtime: AgentRuntimeId): LoginDriver {
  const driver = scope.driverFor ? scope.driverFor(runtime) : runtimeFor(runtime).login
  if (!driver) throw new Error(`${AGENT_RUNTIME_LABELS[runtime]} has no sign-in`)
  return driver
}

function contextOf(scope: LoginStepScope): LoginContext {
  return {
    sandbox: scope.sandbox(loginSandboxName(scope.params.loginId)),
    loginId: scope.params.loginId,
  }
}

/** One compare-and-set on the row, from `from` to whatever `set` says. The row, or null. */
async function transition(
  scope: LoginStepScope,
  from: readonly AgentLoginStatus[],
  set: Partial<typeof agentLogins.$inferInsert>
): Promise<AgentLoginRow | null> {
  const [row] = await scope.db
    .update(agentLogins)
    .set({ ...set, updatedAt: scope.now() })
    .where(
      and(
        eq(agentLogins.tenantId, scope.params.tenantId),
        eq(agentLogins.id, scope.params.loginId),
        inArray(agentLogins.status, [...from])
      )
    )
    .returning()
  return row ?? null
}

/**
 * `start`: record the sandbox's id BEFORE it starts (so its egress can find the login), boot it
 * with the driver's hosts on its allow-list, and start the CLI. `go: false` when the row is no
 * longer `starting` (cancelled already, or a replay after it moved on).
 */
export async function loginStartStep(scope: LoginStepScope): Promise<{ go: boolean }> {
  const row = await loadLogin(scope)
  if (!row || row.status !== 'starting') return { go: false }
  const driver = driverOf(scope, row.runtime)
  const ctx = contextOf(scope)
  const marked = await transition(scope, ['starting'], { sandboxId: ctx.sandbox.id })
  if (!marked) return { go: false }
  await ctx.sandbox.start({ extraAllowedHosts: [...driver.hosts] })
  await scope.prepareLogin?.(ctx.sandbox, row.runtime)
  await driver.start(ctx)
  return { go: true }
}

/**
 * `prompt#N`: wait (up to one step's worth) for the CLI to print the provider's URL — and Codex's
 * code — then put them on the row (`awaiting_user`) for the modal.
 */
export async function loginPromptStep(scope: LoginStepScope): Promise<LoginPoll> {
  const startedAt = scope.now().getTime()
  for (;;) {
    const row = await loadLogin(scope)
    if (!isActive(row)) return { state: 'stopped' }
    if (row.status !== 'starting') return { state: 'ready' }
    if (expired(row, scope)) return { state: 'expired' }
    const prompt = await driverOf(scope, row.runtime).readPrompt(contextOf(scope))
    if (prompt) {
      const moved = await transition(scope, ['starting'], {
        status: 'awaiting_user',
        verificationUrl: prompt.verificationUrl,
        userCode: prompt.userCode,
      })
      return moved ? { state: 'ready' } : { state: 'stopped' }
    }
    if (scope.now().getTime() - startedAt >= LOGIN_POLL_STEP_MS) return { state: 'waiting' }
    await scope.sleep(LOGIN_POLL_MS)
  }
}

/**
 * `submit#N` (a runtime that takes a code back): the route sealed the person's code onto the row
 * and flipped it to `submitting`; hand it to the CLI and forget it (`finishing`, code nulled).
 * `waiting` when no code is there yet (a stray wake).
 */
export async function loginSubmitStep(scope: LoginStepScope): Promise<LoginPoll> {
  const row = await loadLogin(scope)
  if (!isActive(row)) return { state: 'stopped' }
  if (expired(row, scope)) return { state: 'expired' }
  if (row.status !== 'submitting' || !row.codeSealed) return { state: 'waiting' }
  const driver = driverOf(scope, row.runtime)
  const code = (await decryptToken(scope.cfg, row.codeSealed)) as string
  if (!driver.submitCode) throw new Error('This sign-in does not take a code')
  await driver.submitCode(contextOf(scope), code)
  const moved = await transition(scope, ['submitting'], { status: 'finishing', codeSealed: null })
  return moved ? { state: 'ready' } : { state: 'stopped' }
}

/** `finish#N`: wait (up to one step's worth) for the CLI to exit — it has written the credential. */
export async function loginFinishStep(
  scope: LoginStepScope
): Promise<LoginPoll | { state: 'exited'; exitCode: number | null }> {
  const startedAt = scope.now().getTime()
  for (;;) {
    const row = await loadLogin(scope)
    if (!isActive(row)) return { state: 'stopped' }
    if (expired(row, scope)) return { state: 'expired' }
    const progress = await driverOf(scope, row.runtime).poll(contextOf(scope))
    if (progress.state === 'exited') return progress
    if (scope.now().getTime() - startedAt >= LOGIN_POLL_STEP_MS) return { state: 'waiting' }
    await scope.sleep(LOGIN_POLL_MS)
  }
}

/**
 * `capture`: take the credential the CLI wrote (the driver deletes it from the sandbox), SEAL it
 * into `agent_credentials` (a reconnect replaces the old one), mark the login `succeeded`, audit.
 * Returns `{ ok: true }` and nothing else — never the credential.
 */
export async function loginCaptureStep(scope: LoginStepScope): Promise<{ ok: boolean }> {
  const row = await loadLogin(scope)
  if (!isActive(row)) return { ok: false }
  const driver = driverOf(scope, row.runtime)
  const capture = await driver.capture(contextOf(scope))
  await putSealed(scope.db, scope.cfg, {
    tenantId: row.tenantId,
    userId: row.userId,
    runtime: row.runtime,
    kind: capture.kind,
    secret: capture.secret,
    expiresAt: capture.expiresAt,
    metadata: capture.metadata,
    now: scope.now(),
  })
  // Sealed: only now may the CLI's copy go (a failure above leaves it for the retry to read).
  await driver.discard(contextOf(scope)).catch(() => {})
  const done = await transition(scope, AGENT_LOGIN_ACTIVE_STATUSES, {
    status: 'succeeded',
    finishedAt: scope.now(),
    codeSealed: null,
  })
  await recordAudit(scope.db, {
    ...SYSTEM_ACTOR,
    actorType: 'user',
    actorUserId: row.userId,
    tenantId: row.tenantId,
    action: 'agent_credential.connected',
    targetType: 'agent_credential',
    targetId: row.id,
    summary: { after: { runtime: row.runtime, kind: capture.kind, credential: 'set' } },
  })
  return { ok: Boolean(done) }
}

/** End an active login `failed` or `expired`, with a secret-free sentence. */
export async function loginSettleStep(
  scope: LoginStepScope,
  status: 'failed' | 'expired',
  error: unknown
): Promise<{ status: AgentLoginStatus | null }> {
  const message =
    status === 'expired'
      ? 'The sign-in took too long and was stopped. Start it again.'
      : safeErrorMessage(error, 'The sign-in failed', 300)
  const row = await transition(scope, AGENT_LOGIN_ACTIVE_STATUSES, {
    status,
    error: message,
    codeSealed: null,
    finishedAt: scope.now(),
  })
  return { status: row?.status ?? null }
}

/**
 * `cleanup` — ALWAYS, whatever happened: destroy the login sandbox (bounded, logged, never thrown —
 * the platform reclaims an idle one anyway) and null what the person no longer needs (the URL, the
 * device code, any sealed code). An active row past this point (a Workflow that lost track of it)
 * is settled `failed`.
 */
export async function loginCleanupStep(scope: LoginStepScope): Promise<{ destroyed: boolean }> {
  let destroyed = false
  const sandbox = scope.sandbox(loginSandboxName(scope.params.loginId))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      sandbox.destroy(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('destroy did not answer')), LOGIN_DESTROY_MS)
      }),
    ])
    destroyed = true
  } catch (err) {
    scope.logger?.warn({ err, loginId: scope.params.loginId }, 'agent login: destroy failed')
  } finally {
    clearTimeout(timer)
  }
  await transition(scope, AGENT_LOGIN_ACTIVE_STATUSES, {
    status: 'failed',
    error: 'The sign-in stopped before it finished. Start it again.',
    finishedAt: scope.now(),
  })
  await scope.db
    .update(agentLogins)
    .set({ verificationUrl: null, userCode: null, codeSealed: null, updatedAt: scope.now() })
    .where(
      and(eq(agentLogins.tenantId, scope.params.tenantId), eq(agentLogins.id, scope.params.loginId))
    )
  return { destroyed }
}
