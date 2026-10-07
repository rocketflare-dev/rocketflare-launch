/**
 * Which runtime a new session runs and whose account it bills (§18.22) — decided ONCE, at create,
 * and frozen on the row (`sessions.runtime`, `credential_source`, `agent_credential_id`, and the
 * runtime's model as `policy.model`).
 *
 * Three layers, narrowest wins (nothing about runtimes is a deployment var, and both sandbox hosts
 * run every runtime on either account):
 *
 * 1. **The session policy** (`runtimePolicyOf`) — the platform setting Settings → Coding
 *    agents tab edits: enabled, model, `credentialMode`. Fail-closed when nothing is stored:
 *    Claude Code on Launch's key, and Pi (rocketflare-launch#14), which spends no key at all.
 * 2. **What the Worker can run** ({@link RuntimeReadiness}, {@link runtimeReadiness}): a runtime
 *    whose platform "key" is a BINDING (Pi: Workers AI, `AGENT_RUNTIME_PLATFORM_KEY`) is on offer
 *    only where that binding is bound — whatever the policy says. Absent readiness = not bound.
 * 3. **The request** (`runtime?`, `credential?`), checked against both. A request naming no
 *    runtime gets the policy's default when it can RUN for this caller — Launch's account for it
 *    is ready (its key set, or its binding bound), or the caller's own account for it is
 *    connected — else the first enabled runtime that can, else (nothing can) the old rule: the
 *    default while enabled, else the first enabled. So a zero-key install with Workers AI bound
 *    starts Pi sessions, and an admin's stored policy stays authoritative: a runtime it turned off
 *    is never chosen.
 *
 * Refusals, all BEFORE any write: 409 `session_runtime_disabled` (the runtime is not on offer),
 * 409 `agent_credential_not_allowed` (a personal account was asked for where none may be used),
 * 409 `agent_credential_required` (this runtime bills personal accounts only, or the caller's is
 * not connected / needs a reconnect / expired).
 */
import {
  AGENT_ACCOUNT_LABELS,
  AGENT_LOGIN_NEEDS_CODE,
  AGENT_RUNTIME_LABELS,
  AGENT_RUNTIMES,
  type AgentRuntimeId,
  type AgentRuntimeOption,
  agentAccountLabel,
  agentRuntimeHasAccounts,
  type SessionCredentialMode,
  type SessionCredentialSource,
} from '@launch/shared/launch-agents'
import {
  defaultRuntimeOf,
  runtimePolicyOf,
  type SessionPolicy,
} from '@launch/shared/launch-sessions'
import { AGENT_RUNTIME_PLATFORM_KEY } from '@launch/shared/launch-setup'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import type { AgentCredentialRow } from '../../../../db/schema'
import type { AppBindings } from '../../../types'
import { ConflictError } from '../../../utils/core/errors'
import { resolveModelKey, resolveOpenAiKey } from '../model-key'
import { getForUser } from './store'

/**
 * What this Worker can run beyond the policy: per runtime, whether Launch's own account for it is
 * usable right now — its key set (the sealed credential or the Worker secret), or, for a runtime
 * whose platform "key" is a binding (Pi), that binding bound. Never a key value.
 */
export type RuntimeReadiness = Record<AgentRuntimeId, boolean>

/** Is the Workers AI binding bound (Pi's only way to a model)? */
export function workersAiBound(env: Partial<Pick<AppBindings, 'AI'>> | undefined): boolean {
  return Boolean(env?.AI)
}

/** {@link RuntimeReadiness} for this Worker — reads whether keys are set, never returns one. */
export async function runtimeReadiness(
  db: Database,
  cfg: AppConfig,
  env: Partial<Pick<AppBindings, 'AI'>> | undefined
): Promise<RuntimeReadiness> {
  const ready = {} as RuntimeReadiness
  for (const runtime of AGENT_RUNTIMES) {
    const kind = AGENT_RUNTIME_PLATFORM_KEY[runtime]
    ready[runtime] =
      kind === 'workers_ai'
        ? workersAiBound(env)
        : kind === 'anthropic_api_key'
          ? (await resolveModelKey(db, cfg)) !== null
          : (await resolveOpenAiKey(db, cfg)) !== null
  }
  return ready
}

/** A runtime whose platform account is a binding (Pi): it cannot run at all without it. */
const bindingBacked = (runtime: AgentRuntimeId) =>
  AGENT_RUNTIME_PLATFORM_KEY[runtime] === 'workers_ai'

/** One runtime as the policy offers it. */
export interface RuntimeOffer {
  runtime: AgentRuntimeId
  enabled: boolean
  /** Null: the agent's own default. */
  model: string | null
  platformAllowed: boolean
  userAllowed: boolean
  credentialMode: SessionCredentialMode
  /** A personal account may be connected for it: it is on offer and its mode allows one. */
  userCredentials: boolean
}

/**
 * One runtime as the policy offers it — and, for a binding-backed runtime (Pi), as the Worker can:
 * with its binding unbound (or `readiness` not given) it is not on offer at all.
 */
export function runtimeOffer(
  policy: SessionPolicy,
  runtime: AgentRuntimeId,
  readiness: Partial<RuntimeReadiness> = {}
): RuntimeOffer {
  const rp = runtimePolicyOf(policy, runtime)
  const platformAllowed = rp.credentialMode !== 'user'
  // A runtime with no personal accounts (Pi) never bills one, whatever a stored entry says.
  const userAllowed = rp.credentialMode !== 'platform' && agentRuntimeHasAccounts(runtime)
  const enabled = rp.enabled && (!bindingBacked(runtime) || readiness[runtime] === true)
  return {
    runtime,
    enabled,
    model: rp.model,
    platformAllowed,
    userAllowed,
    credentialMode: rp.credentialMode,
    userCredentials: enabled && userAllowed,
  }
}

/** Every runtime, for `GET /api/me/agent-credentials` (the Profile panel and the session picker). */
export function runtimeOptions(
  policy: SessionPolicy,
  readiness: Partial<RuntimeReadiness> = {}
): AgentRuntimeOption[] {
  return AGENT_RUNTIMES.map(runtime => {
    const offer = runtimeOffer(policy, runtime, readiness)
    return {
      runtime,
      label: AGENT_RUNTIME_LABELS[runtime],
      accountLabel: AGENT_ACCOUNT_LABELS[runtime],
      enabled: offer.enabled,
      credentialMode: offer.credentialMode,
      userCredentials: offer.userCredentials,
      needsCode: AGENT_LOGIN_NEEDS_CODE[runtime] === true,
    }
  })
}

/** What {@link defaultRuntimeFor} knows about the caller beyond the policy. */
export interface DefaultRuntimeContext {
  /** {@link runtimeReadiness}: Launch's own account per runtime. Absent: not judged. */
  readiness?: Partial<RuntimeReadiness>
  /** The runtimes the caller has a usable personal account for. */
  connected?: ReadonlySet<AgentRuntimeId>
  /** Whose account the request asked for: only that one makes a runtime runnable. */
  credential?: SessionCredentialSource
}

/**
 * The runtime a session naming none runs: the policy's default while it is on offer AND can run
 * for this caller (Launch's account for it is ready, or the caller's own is connected), else the
 * first enabled runtime that can — Pi on a zero-key install — else the first that is merely on
 * offer (an admin may have turned Claude Code off and Codex on; its turn then says which key is
 * missing). With none on offer, the default — which `resolveSessionCredential` then refuses.
 */
export function defaultRuntimeFor(
  policy: SessionPolicy,
  ctx: DefaultRuntimeContext = {}
): AgentRuntimeId {
  const readiness = ctx.readiness ?? {}
  const preferred = defaultRuntimeOf(policy)
  const offered = (r: AgentRuntimeId) => runtimeOffer(policy, r, readiness)
  const canRun = (r: AgentRuntimeId) => {
    const offer = offered(r)
    if (!offer.enabled) return false
    // Only judged when readiness is known: without it, everything on offer "can run", as before.
    if (!ctx.readiness) return true
    const onPlatform = offer.platformAllowed && readiness[r] === true
    const onOwn = offer.userAllowed && ctx.connected?.has(r) === true
    if (ctx.credential === 'platform') return onPlatform
    if (ctx.credential === 'user') return onOwn
    return onPlatform || onOwn
  }
  if (canRun(preferred)) return preferred
  const runnable = AGENT_RUNTIMES.find(canRun)
  if (runnable) return runnable
  if (offered(preferred).enabled) return preferred
  return AGENT_RUNTIMES.find(r => offered(r).enabled) ?? preferred
}

export interface ResolvedSessionCredential {
  runtime: AgentRuntimeId
  source: SessionCredentialSource
  /** The personal credential a `user` session bills; null for `platform`. */
  credentialId: string | null
  /** The policy to freeze on the row: the chosen runtime's model as `model`. */
  policy: SessionPolicy
}

export async function resolveSessionCredential(
  db: Database,
  input: {
    policy: SessionPolicy
    tenantId: string
    userId: string
    request: { runtime?: AgentRuntimeId; credential?: SessionCredentialSource }
    /** {@link runtimeReadiness}; absent: no binding-backed runtime (Pi) is on offer. */
    readiness?: RuntimeReadiness
    now?: Date
  }
): Promise<ResolvedSessionCredential> {
  const { readiness } = input
  const runtime =
    input.request.runtime ??
    defaultRuntimeFor(input.policy, {
      readiness,
      credential: input.request.credential,
      connected: readiness
        ? await connectedRuntimes(db, input.tenantId, input.userId, input.now)
        : undefined,
    })
  const offer = runtimeOffer(input.policy, runtime, readiness)
  const label = AGENT_RUNTIME_LABELS[runtime]
  const account = agentAccountLabel(runtime)
  if (!offer.enabled) {
    throw new ConflictError(
      `${label} sessions are not available on this deployment`,
      'session_runtime_disabled',
      { runtime }
    )
  }
  const source: SessionCredentialSource =
    input.request.credential ?? (offer.platformAllowed ? 'platform' : 'user')
  if (source === 'user' && !offer.userAllowed) {
    throw new ConflictError(
      `${label} sessions cannot use a personal account here`,
      'agent_credential_not_allowed',
      { runtime }
    )
  }
  if (source === 'platform' && !offer.platformAllowed) {
    throw new ConflictError(
      `${label} sessions bill your own ${account}. Connect it on the Home page first.`,
      'agent_credential_required',
      { runtime }
    )
  }
  // The model the egress will allow: the chosen runtime's. Claude Code's default IS `policy.model`,
  // so a policy without `runtimes` freezes exactly what it always did.
  const policy: SessionPolicy =
    offer.model === input.policy.model ? input.policy : { ...input.policy, model: offer.model }

  if (source === 'platform') return { runtime, source, credentialId: null, policy }

  const credential = await getForUser(db, input.tenantId, input.userId, runtime)
  if (!usableCredential(credential, input.now ?? new Date())) {
    throw new ConflictError(
      credential
        ? `Reconnect your ${account} on the Home page before starting a session on it.`
        : `Connect your ${account} on the Home page before starting a session on it.`,
      'agent_credential_required',
      { runtime }
    )
  }
  return { runtime, source, credentialId: credential.id, policy }
}

/** A personal credential a session may start on: active and unexpired. */
function usableCredential(
  credential: AgentCredentialRow | null,
  now: Date
): credential is AgentCredentialRow {
  return Boolean(
    credential &&
      credential.status === 'active' &&
      !(credential.expiresAt && credential.expiresAt.getTime() <= now.getTime())
  )
}

/** The runtimes the caller has a usable personal account for (the default-runtime choice). */
async function connectedRuntimes(
  db: Database,
  tenantId: string,
  userId: string,
  now: Date = new Date()
): Promise<Set<AgentRuntimeId>> {
  const connected = new Set<AgentRuntimeId>()
  for (const runtime of AGENT_RUNTIMES) {
    if (!agentRuntimeHasAccounts(runtime)) continue
    if (usableCredential(await getForUser(db, tenantId, userId, runtime), now)) {
      connected.add(runtime)
    }
  }
  return connected
}
