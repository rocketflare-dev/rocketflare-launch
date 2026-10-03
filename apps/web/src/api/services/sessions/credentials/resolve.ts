/**
 * Which runtime a new session runs and whose account it bills (§18.22) — decided ONCE, at create,
 * and frozen on the row (`sessions.runtime`, `credential_source`, `agent_credential_id`, and the
 * runtime's model as `policy.model`).
 *
 * Three layers, narrowest wins:
 *
 * 1. **The deployment** (`config.ts`): `SESSION_RUNTIMES` (default `claude_code`) — which runtimes
 *    exist at all; `SESSION_USER_CREDENTIALS` (default none) — which may bill a personal account;
 *    `SESSION_SANDBOX_HOST=remote` — only a runtime that `supportsHostEgress`, on Launch's key.
 * 2. **The session policy** (`runtimePolicyOf`): enabled, model, `credentialMode`.
 * 3. **The request** (`runtime?`, `credential?`), checked against the two above.
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
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { ConflictError } from '../../../utils/core/errors'
import { runtimeFor } from '../runtimes'
import { getForUser } from './store'

/** The deployment's side of the decision, read from config. */
export interface RuntimeFlags {
  runtimes: readonly AgentRuntimeId[]
  userCredentials: readonly AgentRuntimeId[]
  /** `SESSION_SANDBOX_HOST=remote`: the `host` egress mode. */
  hostEgress: boolean
}

/** The flags `loadConfig` defaults to: Claude Code on Launch's key, nothing else. */
export const DEFAULT_RUNTIME_FLAGS: RuntimeFlags = {
  runtimes: ['claude_code'],
  userCredentials: [],
  hostEgress: false,
}

export function runtimeFlagsOf(cfg: AppConfig | undefined): RuntimeFlags {
  if (!cfg) return DEFAULT_RUNTIME_FLAGS
  return {
    runtimes: cfg.SESSION_RUNTIMES,
    userCredentials: cfg.SESSION_USER_CREDENTIALS,
    hostEgress: cfg.SESSION_SANDBOX_HOST === 'remote',
  }
}

/** One runtime as this deployment and policy offer it. */
export interface RuntimeOffer {
  runtime: AgentRuntimeId
  enabled: boolean
  model: string
  platformAllowed: boolean
  userAllowed: boolean
  /** The policy's mode narrowed by the flags. */
  credentialMode: SessionCredentialMode
  /** The deployment lets a personal account be connected for it at all. */
  userCredentials: boolean
}

export function runtimeOffer(
  flags: RuntimeFlags,
  policy: SessionPolicy,
  runtime: AgentRuntimeId
): RuntimeOffer {
  const rp = runtimePolicyOf(policy, runtime)
  const deployed =
    flags.runtimes.includes(runtime) &&
    (!flags.hostEgress || runtimeFor(runtime).supportsHostEgress)
  const userCredentials = flags.userCredentials.includes(runtime) && !flags.hostEgress
  const platformAllowed = rp.credentialMode !== 'user'
  const userAllowed = rp.credentialMode !== 'platform' && userCredentials
  const enabled = deployed && rp.enabled && (platformAllowed || userAllowed)
  return {
    runtime,
    enabled,
    model: rp.model,
    platformAllowed,
    userAllowed,
    credentialMode:
      platformAllowed && userAllowed ? 'user_or_platform' : userAllowed ? 'user' : 'platform',
    userCredentials,
  }
}

/** Every runtime, for `GET /api/me/agent-credentials` (the Profile panel and the session picker). */
export function runtimeOptions(flags: RuntimeFlags, policy: SessionPolicy): AgentRuntimeOption[] {
  return AGENT_RUNTIMES.map(runtime => {
    const offer = runtimeOffer(flags, policy, runtime)
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
    flags: RuntimeFlags
    policy: SessionPolicy
    tenantId: string
    userId: string
    request: { runtime?: AgentRuntimeId; credential?: SessionCredentialSource }
    now?: Date
  }
): Promise<ResolvedSessionCredential> {
  const runtime = input.request.runtime ?? defaultRuntimeOf(input.policy)
  const offer = runtimeOffer(input.flags, input.policy, runtime)
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
