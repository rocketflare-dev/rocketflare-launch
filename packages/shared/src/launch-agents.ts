/**
 * Agent runtimes and personal AI accounts (`docs/CONCEPTS.md` §18.22): which coding agent a session
 * runs (`AGENT_RUNTIMES` — Claude Code, Codex), whose account it bills (`SESSION_CREDENTIAL_SOURCES`:
 * Launch's own key, or the session creator's personal account), and the relayed sign-in that
 * connects a personal account (`agent_logins`, driven by `AgentLoginWorkflow`).
 *
 * - **No credential ever appears in a schema here.** `agentCredentialSchema` says whether, when and
 *   how a personal account is connected; the sealed secret never leaves the server. A login's
 *   `verificationUrl` and `userCode` are what the PERSON needs to finish the provider's own flow —
 *   neither is a credential — and the code a person pastes back is accepted, sealed and never
 *   echoed.
 * - Which runtimes sessions may run, their models and whose account they bill is a PLATFORM
 *   SETTING — `launch_settings.session_policy.runtimes`, edited on the Setup page's Coding agents
 *   card (`PUT /api/platform/setup/session-agents`), never a deployment var. It fails closed: with
 *   nothing stored, Claude Code on Launch's key and nothing else (`runtimePolicyOf`).
 * - `AGENT_LOGIN_CODE_EVENT` is golden-tested against Cloudflare's event-type rule
 *   (`/^[A-Za-z0-9_-]{1,100}$/` — a `.` is `workflow.invalid_event_type`).
 */
import { z } from 'zod'
import { priceFor } from './ai/pricing'

// ---- runtimes ----------------------------------------------------------------------------------

/** The coding agents a session can run. Mirrors `sessions.runtime` — append-only. */
export const AGENT_RUNTIMES = ['claude_code', 'codex'] as const
export const agentRuntimeSchema = z.enum(AGENT_RUNTIMES)
export type AgentRuntimeId = z.infer<typeof agentRuntimeSchema>

/** The runtime a session without one (every row before runtimes existed) runs. */
export const DEFAULT_AGENT_RUNTIME: AgentRuntimeId = 'claude_code'

/** What a person reads for each runtime. */
export const AGENT_RUNTIME_LABELS: Record<AgentRuntimeId, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
}

/** Whose API a runtime's sessions on Launch's account spend — the pricing table's provider. */
export const AGENT_RUNTIME_PROVIDERS: Record<AgentRuntimeId, 'anthropic' | 'openai'> = {
  claude_code: 'anthropic',
  codex: 'openai',
}

/**
 * The models the Setup page offers for each runtime, first = the suggestion. Every one is priced
 * in `ai/pricing` (a config test pins it): a session's budget is money, so a model without a price
 * could never be held to one. A stored model outside the list still works while it is priced.
 */
export const AGENT_RUNTIME_MODELS: Record<AgentRuntimeId, readonly string[]> = {
  claude_code: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5'],
  codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'],
}

/** A model a runtime may be set to: one the pricing table can put a price on. */
export function isPricedRuntimeModel(runtime: AgentRuntimeId, model: string): boolean {
  return priceFor(AGENT_RUNTIME_PROVIDERS[runtime], model) !== null
}

/** The personal account each runtime can bill. */
export const AGENT_ACCOUNT_LABELS: Record<AgentRuntimeId, string> = {
  claude_code: 'Claude subscription',
  codex: 'ChatGPT plan',
}

/**
 * Whether the runtime's sign-in hands the person a code to paste BACK into Launch (Claude's
 * `setup-token`), or only shows them a code to type at the provider (Codex's device flow).
 */
export const AGENT_LOGIN_NEEDS_CODE: Record<AgentRuntimeId, boolean> = {
  claude_code: true,
  codex: false,
}

/**
 * `sessions.runtime_state` — what a runtime needs between turns beyond the resume id (kept in
 * `sessions.claude_session_id`, read through `resumeIdOf`): Codex's rollout file path. Server-only.
 */
export const agentRuntimeStateSchema = z
  .object({ rolloutPath: z.string().optional() })
  .passthrough()
export type AgentRuntimeState = z.infer<typeof agentRuntimeStateSchema>

// ---- credentials -------------------------------------------------------------------------------

/**
 * How a runtime's sessions are billed (`runtimePolicySchema.credentialMode`): `platform` — Launch's
 * own key only; `user` — the creator's personal account only; `user_or_platform` — the creator
 * chooses at start.
 */
export const SESSION_CREDENTIAL_MODES = ['platform', 'user', 'user_or_platform'] as const
export const sessionCredentialModeSchema = z.enum(SESSION_CREDENTIAL_MODES)
export type SessionCredentialMode = z.infer<typeof sessionCredentialModeSchema>

/** Whose account ONE session bills — fixed at create. Mirrors `sessions.credential_source`. */
export const SESSION_CREDENTIAL_SOURCES = ['platform', 'user'] as const
export const sessionCredentialSourceSchema = z.enum(SESSION_CREDENTIAL_SOURCES)
export type SessionCredentialSource = z.infer<typeof sessionCredentialSourceSchema>

/** What a personal credential is. Mirrors `agent_credentials.kind` — append-only. */
export const AGENT_CREDENTIAL_KINDS = [
  /** Claude: the long-lived inference token `claude setup-token` prints. */
  'claude_oauth_token',
  /** Codex: the ChatGPT-plan `auth.json` `codex login --device-auth` writes. */
  'codex_chatgpt_auth',
] as const
export const agentCredentialKindSchema = z.enum(AGENT_CREDENTIAL_KINDS)
export type AgentCredentialKind = z.infer<typeof agentCredentialKindSchema>

/** `needs_login`: the provider refused it (revoked, expired, a refresh reused) — reconnect. */
export const AGENT_CREDENTIAL_STATUSES = ['active', 'needs_login'] as const
export const agentCredentialStatusSchema = z.enum(AGENT_CREDENTIAL_STATUSES)
export type AgentCredentialStatus = z.infer<typeof agentCredentialStatusSchema>

/**
 * `agent_credentials.metadata` — non-secret facts only (the plan, the account's email, a
 * fingerprint). Scalars, so nothing structured can smuggle a value in (`credentialMetadataSchema`'s
 * rule).
 */
export const agentCredentialMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
)
export type AgentCredentialMetadata = z.infer<typeof agentCredentialMetadataSchema>

/** A personal credential as the API may speak of it: never the value. */
export const agentCredentialSchema = z.object({
  id: z.string().uuid(),
  runtime: agentRuntimeSchema,
  kind: agentCredentialKindSchema,
  status: agentCredentialStatusSchema,
  metadata: agentCredentialMetadataSchema,
  expiresAt: z.coerce.date().nullable(),
  lastUsedAt: z.coerce.date().nullable(),
  /** A session holds it right now (Codex: one `auth.json` is never used twice at once). */
  inUse: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type AgentCredential = z.infer<typeof agentCredentialSchema>

/** A Claude token this close to its expiry is flagged in the UI. */
export const AGENT_CREDENTIAL_EXPIRY_WARNING_DAYS = 30

// ---- logins ------------------------------------------------------------------------------------

/**
 * Mirrors `agent_logins.status`. `starting` → `awaiting_user` (the provider's URL, and for Codex
 * the code to type there, are on the row) → `submitting` (Claude: the pasted code is on its way
 * into the sandbox) → `finishing` (waiting for the CLI to write the credential) → `succeeded`, or
 * `failed` / `cancelled` / `expired` from any active status.
 */
export const AGENT_LOGIN_STATUSES = [
  'starting',
  'awaiting_user',
  'submitting',
  'finishing',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const
export const agentLoginStatusSchema = z.enum(AGENT_LOGIN_STATUSES)
export type AgentLoginStatus = z.infer<typeof agentLoginStatusSchema>

/** One active login per (person, runtime): the partial unique index renders this list. */
export const AGENT_LOGIN_ACTIVE_STATUSES = [
  'starting',
  'awaiting_user',
  'submitting',
  'finishing',
] as const satisfies readonly AgentLoginStatus[]

export function isActiveAgentLoginStatus(status: AgentLoginStatus): boolean {
  return (AGENT_LOGIN_ACTIVE_STATUSES as readonly AgentLoginStatus[]).includes(status)
}

/** How long a login may take, start to finish, before the sweep expires it. */
export const AGENT_LOGIN_TTL_MS = 15 * 60_000

/** `step.waitForEvent` type the code route wakes the login with. The row carries the code. */
export const AGENT_LOGIN_CODE_EVENT = 'agent-login-code'

/**
 * `AGENT_LOGIN_WORKFLOW.create({ id: loginId, params })` — ids, and where the login sandbox runs
 * (`launch_settings.session_sandbox_host` when the sign-in started, frozen for its whole run —
 * `SESSION_SANDBOX_HOSTS` in `launch-setup.ts`; absent = `local`).
 */
export const agentLoginParamsSchema = z.object({
  loginId: z.string().uuid(),
  tenantId: z.string().uuid(),
  sandboxHost: z.enum(['local', 'remote']).optional(),
})
export type AgentLoginParams = z.infer<typeof agentLoginParamsSchema>

/** A relayed sign-in, as the polling modal reads it. No secret, no sealed code. */
export const agentLoginSchema = z.object({
  id: z.string().uuid(),
  runtime: agentRuntimeSchema,
  status: agentLoginStatusSchema,
  /** The provider's own sign-in page — open it in a new tab. */
  verificationUrl: z.string().nullable(),
  /** Codex's device code, typed AT the provider. Never Claude's code (that one comes back here). */
  userCode: z.string().nullable(),
  /** The person must paste a code back (`AGENT_LOGIN_NEEDS_CODE`). */
  needsCode: z.boolean(),
  error: z.string().nullable(),
  expiresAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable(),
})
export type AgentLogin = z.infer<typeof agentLoginSchema>

// ---- requests ----------------------------------------------------------------------------------

/** `POST /api/me/agent-logins`. */
export const startAgentLoginRequestSchema = z.object({ runtime: agentRuntimeSchema })
export type StartAgentLoginRequest = z.infer<typeof startAgentLoginRequestSchema>

/** `POST /api/me/agent-logins/:id/code` — what the provider showed the person. Sealed at once. */
export const submitAgentLoginCodeRequestSchema = z.object({
  code: z.string().trim().min(1).max(4096),
})
export type SubmitAgentLoginCodeRequest = z.infer<typeof submitAgentLoginCodeRequestSchema>

/** `/api/me/agent-credentials/:runtime` and the like. */
export const agentRuntimeParamSchema = z.object({ runtime: agentRuntimeSchema })

// ---- responses ---------------------------------------------------------------------------------

/** One runtime as this deployment offers it to the caller. */
export const agentRuntimeOptionSchema = z.object({
  runtime: agentRuntimeSchema,
  label: z.string(),
  accountLabel: z.string(),
  /** The session policy (the Platform → Coding agents tab) has it on. */
  enabled: z.boolean(),
  /** The policy's mode: who may pay for its sessions. */
  credentialMode: sessionCredentialModeSchema,
  /** A personal account may be connected for it: enabled, and its mode allows one. */
  userCredentials: z.boolean(),
  needsCode: z.boolean(),
})
export type AgentRuntimeOption = z.infer<typeof agentRuntimeOptionSchema>

/** `GET /api/me/agent-credentials` — what the Profile panel and the session picker draw. */
export const agentAccountsResponseSchema = z.object({
  runtimes: z.array(agentRuntimeOptionSchema),
  credentials: z.array(agentCredentialSchema),
  /** The caller's logins still in flight (at most one per runtime). */
  logins: z.array(agentLoginSchema),
})
export type AgentAccountsResponse = z.infer<typeof agentAccountsResponseSchema>

/** `POST /api/me/agent-logins` (202), `GET /:id`, `POST /:id/code`, `POST /:id/cancel`. */
export const agentLoginResponseSchema = z.object({ login: agentLoginSchema })
export type AgentLoginResponse = z.infer<typeof agentLoginResponseSchema>

/**
 * The session picker's decision, pure: show it only when there is a choice to make — more than
 * one enabled runtime, or one that may bill a personal account.
 */
export function agentPickerVisible(runtimes: readonly AgentRuntimeOption[]): boolean {
  const enabled = runtimes.filter(r => r.enabled)
  return enabled.length > 1 || enabled.some(r => r.credentialMode !== 'platform')
}
