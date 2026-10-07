/**
 * Which coding agent a new session starts with (§18.22) — the ONE decision behind both start
 * buttons on the app page (the header's Build it and the Sessions tab's Start session), pure:
 *
 * - **The menu** (`agentChoiceOptions`) lists every ENABLED runtime once per account that may pay
 *   for it — a `user_or_platform` runtime twice (Launch's, then the person's) — each with its
 *   billing line ("Launch pays · Workers AI", "Billed to your Claude subscription").
 * - **The current choice** (`resolveAgentChoice`) is the person's remembered one while the
 *   deployment still offers it, else the server's default for them (`defaultRuntime` from
 *   `GET /api/me/agent-credentials` — what a start naming no runtime would run), else the first
 *   enabled runtime. Null when there is no choice to make (`agentPickerVisible`): the button is
 *   then the plain one and the request is the P3 one, `{}`.
 * - **The request** (`startRequestFor`) carries the runtime, and whose account only when the
 *   person may choose it.
 *
 * The remembered choice is one string in localStorage (`runtime:credential`, per user — and per
 * server, since storage is per origin), parsed and validated on read.
 */
import {
  AGENT_RUNTIME_PROVIDERS,
  AGENT_RUNTIMES,
  type AgentAccountsResponse,
  type AgentRuntimeId,
  type AgentRuntimeOption,
  agentPickerVisible,
  type SessionCredentialSource,
} from '@launch/shared/launch-agents'
import type { CreateSessionRequest } from '@launch/shared/launch-sessions'

/** The agent and the account a new session runs on. */
export interface AgentChoice {
  runtime: AgentRuntimeId
  credential: SessionCredentialSource
}

/** One line of the start button's menu. */
export interface AgentChoiceOption {
  choice: AgentChoice
  /** The agent's name ("Claude Code"). */
  label: string
  /** Who pays ("Launch pays · Anthropic API", "Billed to your Claude subscription"). */
  billing: string
}

/** The localStorage key of a person's remembered choice. */
export const agentChoiceStorageKey = (userId: string) => `launch.sessions.agent.${userId}`

/** What Launch's own account for a runtime spends, as a person reads it. */
const PLATFORM_BILLING: Record<(typeof AGENT_RUNTIME_PROVIDERS)[AgentRuntimeId], string> = {
  anthropic: 'Anthropic API',
  openai: 'OpenAI API',
  workers_ai: 'Workers AI',
}

/** `runtime:credential` — the stored form. Pure. */
export function formatAgentChoice(choice: AgentChoice): string {
  return `${choice.runtime}:${choice.credential}`
}

/** The stored form back, or null for anything that is not one. Pure. */
export function parseAgentChoice(raw: string | null | undefined): AgentChoice | null {
  if (!raw) return null
  const [runtime, credential, ...rest] = raw.split(':')
  if (rest.length > 0) return null
  if (!(AGENT_RUNTIMES as readonly string[]).includes(runtime ?? '')) return null
  if (credential !== 'platform' && credential !== 'user') return null
  return { runtime: runtime as AgentRuntimeId, credential }
}

/** Whether the caller's own account for the runtime is connected and usable. Pure. */
function connected(accounts: AgentAccountsResponse, runtime: AgentRuntimeId): boolean {
  return accounts.credentials.some(c => c.runtime === runtime && c.status === 'active')
}

/** Who pays for a session on `credential`, in one line. Pure. */
export function billingLine(
  option: Pick<AgentRuntimeOption, 'runtime' | 'accountLabel'>,
  credential: SessionCredentialSource,
  isConnected = true
): string {
  if (credential === 'platform') {
    return `Launch pays · ${PLATFORM_BILLING[AGENT_RUNTIME_PROVIDERS[option.runtime]]}`
  }
  const account = option.accountLabel ?? 'personal account'
  return isConnected
    ? `Billed to your ${account}`
    : `Billed to your ${account} · connect it on Home first`
}

/** The accounts that may pay for a runtime, Launch's first. Pure. */
function credentialsFor(option: AgentRuntimeOption): SessionCredentialSource[] {
  if (option.credentialMode === 'platform') return ['platform']
  if (option.credentialMode === 'user') return ['user']
  return ['platform', 'user']
}

/** Every choice the start button's menu offers, in the runtimes' order. Pure. */
export function agentChoiceOptions(accounts: AgentAccountsResponse): AgentChoiceOption[] {
  return accounts.runtimes
    .filter(r => r.enabled)
    .flatMap(option =>
      credentialsFor(option).map(credential => ({
        choice: { runtime: option.runtime, credential },
        label: option.label,
        billing: billingLine(option, credential, connected(accounts, option.runtime)),
      }))
    )
}

/**
 * The account a runtime bills when the person has not said: the only one it allows, else (either
 * may pay) their own when it is connected — they connected it to use it — else Launch's. Pure.
 */
export function defaultCredentialFor(
  accounts: AgentAccountsResponse,
  option: AgentRuntimeOption
): SessionCredentialSource {
  if (option.credentialMode === 'platform') return 'platform'
  if (option.credentialMode === 'user') return 'user'
  return connected(accounts, option.runtime) ? 'user' : 'platform'
}

/**
 * The choice a start button acts on: the remembered one while it is still on offer (its account
 * re-decided when the policy no longer allows the remembered one), else the server's default
 * runtime for this person, else the first enabled. Null when there is no choice to make. Pure.
 */
export function resolveAgentChoice(
  accounts: AgentAccountsResponse | undefined,
  remembered: AgentChoice | null
): AgentChoice | null {
  if (!accounts || !agentPickerVisible(accounts.runtimes)) return null
  const enabled = accounts.runtimes.filter(r => r.enabled)
  const find = (runtime: AgentRuntimeId | undefined) => enabled.find(r => r.runtime === runtime)
  const kept = find(remembered?.runtime)
  if (kept && remembered && credentialsFor(kept).includes(remembered.credential)) return remembered
  const option = kept ?? find(accounts.defaultRuntime) ?? enabled[0]
  if (!option) return null
  return { runtime: option.runtime, credential: defaultCredentialFor(accounts, option) }
}

/** Is this menu line the current choice? Pure. */
export function sameChoice(a: AgentChoice | null, b: AgentChoice): boolean {
  return a !== null && a.runtime === b.runtime && a.credential === b.credential
}

/**
 * The start request for a choice — `{}` when there is no choice to make (the P3 request,
 * unchanged), else the runtime and, when the person may choose, whose account. Pure.
 */
export function startRequestFor(
  accounts: AgentAccountsResponse | undefined,
  choice: AgentChoice | null
): CreateSessionRequest {
  if (!accounts || !choice || !agentPickerVisible(accounts.runtimes)) return {}
  const option = accounts.runtimes.find(r => r.runtime === choice.runtime && r.enabled)
  if (!option) return {}
  if (option.credentialMode === 'platform') return { runtime: option.runtime }
  if (option.credentialMode === 'user') return { runtime: option.runtime, credential: 'user' }
  return { runtime: option.runtime, credential: choice.credential }
}
