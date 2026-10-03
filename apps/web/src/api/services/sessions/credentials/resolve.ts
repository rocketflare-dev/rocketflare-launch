/**
 * Which runtime a new session runs and whose account it bills (§18.22) — decided ONCE, at create,
 * and frozen on the row (`sessions.runtime`, `credential_source`, `agent_credential_id`, and the
 * runtime's model as `policy.model`).
 *
 * Two layers, narrowest wins (nothing about runtimes is a deployment var, and both sandbox hosts
 * run every runtime on either account):
 *
 * 1. **The session policy** (`runtimePolicyOf`) — the platform setting the Platform → Coding
 *    agents tab edits: enabled, model, `credentialMode`. Fail-closed when nothing is stored:
 *    Claude Code on Launch's key, nothing else.
 * 2. **The request** (`runtime?`, `credential?`), checked against the policy. A request naming
 *    no runtime gets the policy's default, or the first enabled runtime when that one is off.
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
  type SessionCredentialMode,
  type SessionCredentialSource,
} from '@launch/shared/launch-agents'
import {
  defaultRuntimeOf,
  runtimePolicyOf,
  type SessionPolicy,
} from '@launch/shared/launch-sessions'
import type { Database } from '../../../../db/client'
import { ConflictError } from '../../../utils/core/errors'
import { getForUser } from './store'

/** One runtime as the policy offers it. */
export interface RuntimeOffer {
  runtime: AgentRuntimeId
  enabled: boolean
  model: string
  platformAllowed: boolean
  userAllowed: boolean
  credentialMode: SessionCredentialMode
  /** A personal account may be connected for it: it is on offer and its mode allows one. */
  userCredentials: boolean
}

export function runtimeOffer(policy: SessionPolicy, runtime: AgentRuntimeId): RuntimeOffer {
  const rp = runtimePolicyOf(policy, runtime)
  const platformAllowed = rp.credentialMode !== 'user'
  const userAllowed = rp.credentialMode !== 'platform'
  const enabled = rp.enabled
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
export function runtimeOptions(policy: SessionPolicy): AgentRuntimeOption[] {
  return AGENT_RUNTIMES.map(runtime => {
    const offer = runtimeOffer(policy, runtime)
    return {
      runtime,
      label: AGENT_RUNTIME_LABELS[runtime],
      accountLabel: AGENT_ACCOUNT_LABELS[runtime],
      enabled: offer.enabled,
      credentialMode: offer.credentialMode,
      userCredentials: offer.userCredentials,
      needsCode: AGENT_LOGIN_NEEDS_CODE[runtime],
    }
  })
}

/**
 * The runtime a session naming none runs: the policy's default while it is on offer, else the
 * first runtime that is (an admin may have turned Claude Code off and Codex on). With none on
 * offer, the default — which `resolveSessionCredential` then refuses.
 */
export function defaultRuntimeFor(policy: SessionPolicy): AgentRuntimeId {
  const preferred = defaultRuntimeOf(policy)
  if (runtimeOffer(policy, preferred).enabled) return preferred
  return AGENT_RUNTIMES.find(r => runtimeOffer(policy, r).enabled) ?? preferred
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
    now?: Date
  }
): Promise<ResolvedSessionCredential> {
  const runtime = input.request.runtime ?? defaultRuntimeFor(input.policy)
  const offer = runtimeOffer(input.policy, runtime)
  const label = AGENT_RUNTIME_LABELS[runtime]
  const account = AGENT_ACCOUNT_LABELS[runtime]
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
      `${label} sessions bill your own ${account}. Connect it in Profile first.`,
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
  const now = input.now ?? new Date()
  if (
    !credential ||
    credential.status !== 'active' ||
    (credential.expiresAt && credential.expiresAt.getTime() <= now.getTime())
  ) {
    throw new ConflictError(
      credential
        ? `Reconnect your ${account} in Profile before starting a session on it.`
        : `Connect your ${account} in Profile before starting a session on it.`,
      'agent_credential_required',
      { runtime }
    )
  }
  return { runtime, source, credentialId: credential.id, policy }
}
