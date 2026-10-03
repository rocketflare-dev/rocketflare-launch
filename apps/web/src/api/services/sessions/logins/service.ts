/**
 * The relayed sign-in as the ROUTES drive it (§18.22, `routes/me-agents.ts`). A route never runs a
 * login: it writes the row (or a compare-and-set on it) and starts or wakes `AgentLoginWorkflow`,
 * which re-reads the row and does the work in a sandbox.
 *
 * - `startLogin`: 503 `agent_logins_not_configured` without the Workflow binding, 409
 *   `agent_logins_disabled` when the session policy (the Setup page's Coding agents card) does not
 *   let this runtime bill a personal account, 409 `agent_login_in_progress` when
 *   one is already active (the partial unique index decides — two clicks are one login) — all
 *   before any write that sticks; then the `starting` row and `create({ id: loginId })`.
 * - `submitLoginCode`: a compare-and-set `awaiting_user → submitting` that SEALS the code onto the
 *   row, then `sendEvent(AGENT_LOGIN_CODE_EVENT)` with an empty payload — the row carries the code,
 *   never the wire. 409 `agent_login_not_waiting` otherwise.
 * - `cancelLogin`: a compare-and-set from any active status to `cancelled`, then a wake so a
 *   Workflow waiting on the code notices; its `cleanup` destroys the sandbox.
 *
 * Every read is the caller's own: tenant AND user in the predicate, so another person's login is
 * the same 404 as a missing one.
 */
import {
  AGENT_LOGIN_ACTIVE_STATUSES,
  AGENT_LOGIN_CODE_EVENT,
  AGENT_LOGIN_NEEDS_CODE,
  AGENT_LOGIN_TTL_MS,
  AGENT_RUNTIME_LABELS,
  type AgentLogin,
  type AgentLoginParams,
  type AgentRuntimeId,
} from '@launch/shared/launch-agents'
import type { SessionPolicy } from '@launch/shared/launch-sessions'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { type AgentLoginRow, agentLogins } from '../../../../db/schema'
import { encryptToken } from '../../../auth/oauth-encryption'
import type { AppBindings } from '../../../types'
import {
  ConflictError,
  isUniqueViolation,
  NotFoundError,
  ServiceUnavailableError,
} from '../../../utils/core/errors'
import { type AuditActor, recordAudit } from '../../launch/audit'
import type { WarnLogger } from '../chat'
import { type RuntimeFlags, runtimeOffer } from '../credentials/resolve'

/** The row as the polling modal reads it. No sealed code, no sandbox id. */
export function toAgentLogin(row: AgentLoginRow): AgentLogin {
  return {
    id: row.id,
    runtime: row.runtime,
    status: row.status,
    verificationUrl: row.verificationUrl,
    userCode: row.userCode,
    needsCode: AGENT_LOGIN_NEEDS_CODE[row.runtime],
    error: row.error,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  }
}

/** The Workflow binding, or 503 `agent_logins_not_configured` — checked BEFORE any write. */
export function requireLoginWorkflow(env: AppBindings): Workflow {
  const workflow = (env as { AGENT_LOGIN_WORKFLOW?: Workflow }).AGENT_LOGIN_WORKFLOW
  if (!workflow) {
    throw new ServiceUnavailableError(
      'Connecting personal AI accounts is not configured on this deployment',
      'agent_logins_not_configured'
    )
  }
  return workflow
}

/**
 * 409 `agent_logins_disabled` unless this runtime may bill a personal account — the session
 * policy's Coding agents setting (off unless an admin turned it on), not a deployment var.
 */
export function assertLoginsEnabled(
  flags: RuntimeFlags,
  policy: SessionPolicy,
  runtime: AgentRuntimeId
): void {
  const offer = runtimeOffer(flags, policy, runtime)
  if (!offer.enabled || !offer.userAllowed) {
    throw new ConflictError(
      `${AGENT_RUNTIME_LABELS[runtime]} sessions do not use personal accounts here. An admin can allow them on the Setup page.`,
      'agent_logins_disabled',
      { runtime }
    )
  }
}

/** The caller's own login, or the SAME 404 as a missing one. */
export async function getOwnLogin(
  db: Database,
  tenantId: string,
  userId: string,
  loginId: string
): Promise<AgentLoginRow> {
  const [row] = await db
    .select()
    .from(agentLogins)
    .where(
      and(
        eq(agentLogins.tenantId, tenantId),
        eq(agentLogins.userId, userId),
        eq(agentLogins.id, loginId)
      )
    )
    .limit(1)
  if (!row) throw new NotFoundError('Login not found', 'agent_login_not_found')
  return row
}

/** The caller's logins still in flight, newest first. */
export async function listActiveLogins(
  db: Database,
  tenantId: string,
  userId: string
): Promise<AgentLoginRow[]> {
  return db
    .select()
    .from(agentLogins)
    .where(
      and(
        eq(agentLogins.tenantId, tenantId),
        eq(agentLogins.userId, userId),
        inArray(agentLogins.status, [...AGENT_LOGIN_ACTIVE_STATUSES])
      )
    )
    .orderBy(desc(agentLogins.createdAt))
}

export interface StartLoginInput {
  tenantId: string
  userId: string
  runtime: AgentRuntimeId
  actor: AuditActor
  now?: Date
}

/** See the header. The `starting` row, with its Workflow started. */
export async function startLogin(
  db: Database,
  workflow: Workflow,
  input: StartLoginInput
): Promise<AgentLoginRow> {
  const now = input.now ?? new Date()
  let row: AgentLoginRow | undefined
  try {
    ;[row] = await db
      .insert(agentLogins)
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        runtime: input.runtime,
        status: 'starting',
        expiresAt: new Date(now.getTime() + AGENT_LOGIN_TTL_MS),
      })
      .returning()
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(
        `A ${AGENT_RUNTIME_LABELS[input.runtime]} sign-in is already in progress`,
        'agent_login_in_progress'
      )
    }
    throw err
  }
  if (!row) throw new Error('startLogin: insert returned no row')

  const params: AgentLoginParams = { loginId: row.id, tenantId: input.tenantId }
  try {
    await workflow.create({ id: row.id, params })
  } catch (err) {
    // Nothing will ever drive it: settle it now so it does not hold the one-active slot.
    await db
      .update(agentLogins)
      .set({ status: 'failed', error: 'The sign-in could not be started', finishedAt: now })
      .where(and(eq(agentLogins.tenantId, input.tenantId), eq(agentLogins.id, row.id)))
    throw new ServiceUnavailableError(
      `The sign-in could not be started: ${err instanceof Error ? err.message : String(err)}`,
      'agent_login_start_failed'
    )
  }
  const [started] = await db
    .update(agentLogins)
    .set({ instanceId: row.id })
    .where(and(eq(agentLogins.tenantId, input.tenantId), eq(agentLogins.id, row.id)))
    .returning()
  await recordAudit(db, {
    ...input.actor,
    tenantId: input.tenantId,
    action: 'agent_login.started',
    targetType: 'agent_login',
    targetId: row.id,
    summary: { after: { runtime: input.runtime } },
  })
  return started ?? row
}

/** Wake the login's Workflow to re-read its row. Never throws (the row is already the truth). */
export async function wakeLogin(
  workflow: Workflow,
  row: Pick<AgentLoginRow, 'id' | 'instanceId'>,
  logger?: WarnLogger
): Promise<boolean> {
  try {
    const instance = await workflow.get(row.instanceId ?? row.id)
    await instance.sendEvent({ type: AGENT_LOGIN_CODE_EVENT, payload: {} })
    return true
  } catch (err) {
    logger?.warn({ err, loginId: row.id }, 'agent login: could not wake the workflow')
    return false
  }
}

/** Seal the pasted code onto the row and wake the Workflow (see the header). */
export async function submitLoginCode(
  db: Database,
  cfg: AppConfig,
  workflow: Workflow,
  row: AgentLoginRow,
  code: string,
  opts: { logger?: WarnLogger; now?: Date } = {}
): Promise<AgentLoginRow> {
  if (!AGENT_LOGIN_NEEDS_CODE[row.runtime]) {
    throw new ConflictError('This sign-in does not take a code', 'agent_login_not_waiting')
  }
  const sealed = await encryptToken(cfg, code)
  const now = opts.now ?? new Date()
  const [updated] = await db
    .update(agentLogins)
    .set({ status: 'submitting', codeSealed: sealed, updatedAt: now })
    .where(
      and(
        eq(agentLogins.tenantId, row.tenantId),
        eq(agentLogins.id, row.id),
        eq(agentLogins.status, 'awaiting_user')
      )
    )
    .returning()
  if (!updated) {
    throw new ConflictError('This sign-in is not waiting for a code', 'agent_login_not_waiting', {
      status: row.status,
    })
  }
  await wakeLogin(workflow, updated, opts.logger)
  return updated
}

/** Stop an active login (see the header). 409 `agent_login_finished` when it already ended. */
export async function cancelLogin(
  db: Database,
  workflow: Workflow | undefined,
  row: AgentLoginRow,
  opts: { logger?: WarnLogger; now?: Date } = {}
): Promise<AgentLoginRow> {
  const now = opts.now ?? new Date()
  const [updated] = await db
    .update(agentLogins)
    .set({ status: 'cancelled', codeSealed: null, finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(agentLogins.tenantId, row.tenantId),
        eq(agentLogins.id, row.id),
        inArray(agentLogins.status, [...AGENT_LOGIN_ACTIVE_STATUSES])
      )
    )
    .returning()
  if (!updated) {
    throw new ConflictError('This sign-in has already finished', 'agent_login_finished', {
      status: row.status,
    })
  }
  if (workflow) await wakeLogin(workflow, updated, opts.logger)
  return updated
}
