/**
 * The Platform → Coding agents tab (§18.22): which coding agents sessions may run, each one's
 * model, and whose account it bills — `launch_settings.session_policy.runtimes`, the ONE place
 * these switches live (there is no deployment var for them).
 *
 * - `sessionAgentsStatus` — every runtime as the card draws it: the resolved policy (fail-closed
 *   defaults filled in, `isDefault` when nothing is stored for it) plus readiness: whether Launch's
 *   key for it is set (the sealed credential, else the Worker secret — never the value), how many
 *   people have connected a personal account, and the image it needs. Both sandbox hosts run
 *   every agent on either account, so the host is not a readiness question
 *   (`sessions/sandbox-host.ts` is the Session sandbox section beside it).
 * - `updateSessionAgents` — merges whole per-runtime entries into the stored policy, keeping every
 *   other field (budgets, limits, the default runtime), and refuses a result with nothing enabled
 *   (409 `session_agents_none_enabled`). Claude Code's model is mirrored onto the policy's own
 *   `model`, which is what a policy without `runtimes` has always meant by it.
 *
 * A change reaches NEW sessions only: each session froze its policy at create.
 */
import {
  AGENT_ACCOUNT_LABELS,
  AGENT_RUNTIME_LABELS,
  AGENT_RUNTIME_MODELS,
  AGENT_RUNTIMES,
  type AgentRuntimeId,
} from '@launch/shared/launch-agents'
import {
  type RuntimePolicy,
  resolveSessionPolicy,
  runtimePolicyOf,
  type SessionPolicy,
  sessionPolicySchema,
} from '@launch/shared/launch-sessions'
import {
  AGENT_RUNTIME_MIN_IMAGE,
  AGENT_RUNTIME_PLATFORM_KEY,
  SESSION_AGENTS_NONE_ENABLED,
  type SessionAgentStatus,
  type SessionAgentsStatus,
  type SessionAgentsUpdate,
  type SetupCredential,
} from '@launch/shared/launch-setup'
import { count, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { agentCredentials } from '../../../db/schema'
import { ConflictError } from '../../utils/core/errors'
import { runtimeOffer } from '../sessions/credentials/resolve'
import { getSetting, putSetting } from './credentials'

/** The Worker secret each platform key falls back to — only whether it is set is ever read. */
function secretSet(cfg: AppConfig, kind: 'anthropic_api_key' | 'openai_api_key'): boolean {
  return kind === 'anthropic_api_key' ? Boolean(cfg.ANTHROPIC_API_KEY) : Boolean(cfg.OPENAI_API_KEY)
}

/** People with a personal account per runtime, in the organisation the admin is acting for. */
async function connectedAccounts(
  db: Database,
  tenantId: string | null
): Promise<Record<AgentRuntimeId, number>> {
  const counts = Object.fromEntries(AGENT_RUNTIMES.map(r => [r, 0])) as Record<
    AgentRuntimeId,
    number
  >
  if (!tenantId) return counts
  const rows = await db
    .select({ runtime: agentCredentials.runtime, n: count() })
    .from(agentCredentials)
    .where(eq(agentCredentials.tenantId, tenantId))
    .groupBy(agentCredentials.runtime)
  for (const row of rows) counts[row.runtime] = Number(row.n)
  return counts
}

export async function sessionAgentsStatus(
  db: Database,
  cfg: AppConfig,
  credentials: readonly SetupCredential[],
  tenantId: string | null
): Promise<SessionAgentsStatus> {
  const stored = await getSetting(db, 'session_policy')
  const policy = resolveSessionPolicy(stored)
  const accounts = await connectedAccounts(db, tenantId)
  const runtimes = AGENT_RUNTIMES.map((runtime): SessionAgentStatus => {
    const rp = runtimePolicyOf(policy, runtime)
    const keyKind = AGENT_RUNTIME_PLATFORM_KEY[runtime]
    const credentialSet = credentials.some(c => c.kind === keyKind && c.set)
    const offered = AGENT_RUNTIME_MODELS[runtime]
    return {
      runtime,
      label: AGENT_RUNTIME_LABELS[runtime],
      accountLabel: AGENT_ACCOUNT_LABELS[runtime],
      enabled: rp.enabled,
      model: rp.model,
      credentialMode: rp.credentialMode,
      isDefault: !policy.runtimes?.[runtime],
      models: offered.includes(rp.model) ? [...offered] : [rp.model, ...offered],
      platformKey: {
        kind: keyKind,
        source: credentialSet ? 'credential' : secretSet(cfg, keyKind) ? 'secret' : null,
      },
      connectedAccounts: accounts[runtime],
      minImage: AGENT_RUNTIME_MIN_IMAGE[runtime],
    }
  })
  return { runtimes }
}

export interface SessionAgentsChange {
  /** The effective entry before (stored, or the code default), per runtime that changed. */
  before: Partial<Record<AgentRuntimeId, RuntimePolicy>>
  after: Partial<Record<AgentRuntimeId, RuntimePolicy>>
}

/** Merge `update` into `session_policy.runtimes`; null when nothing changed. */
export async function updateSessionAgents(
  db: Database,
  update: SessionAgentsUpdate,
  userId: string
): Promise<SessionAgentsChange | null> {
  const stored = await getSetting(db, 'session_policy')
  const current = resolveSessionPolicy(stored)
  const runtimes = { ...(current.runtimes ?? {}) }
  const before: SessionAgentsChange['before'] = {}
  const after: SessionAgentsChange['after'] = {}
  for (const runtime of AGENT_RUNTIMES) {
    const next = update.runtimes[runtime]
    if (!next) continue
    const prev = runtimePolicyOf(current, runtime)
    const unchanged =
      current.runtimes?.[runtime] &&
      prev.enabled === next.enabled &&
      prev.model === next.model &&
      prev.credentialMode === next.credentialMode
    if (unchanged) continue
    before[runtime] = prev
    after[runtime] = next
    runtimes[runtime] = next
  }
  if (Object.keys(after).length === 0) return null

  const policy: SessionPolicy = {
    ...current,
    runtimes,
    ...(runtimes.claude_code ? { model: runtimes.claude_code.model } : {}),
  }
  if (!AGENT_RUNTIMES.some(r => runtimeOffer(policy, r).enabled)) {
    throw new ConflictError(
      'Keep at least one coding agent on, or nobody can start a session.',
      SESSION_AGENTS_NONE_ENABLED
    )
  }
  // Store what was stored plus the change — never the code defaults the resolve filled in, so a
  // later default change still reaches the fields nobody set.
  const parsed = sessionPolicySchema.partial().safeParse(stored)
  const base = parsed.success ? parsed.data : {}
  await putSetting(
    db,
    'session_policy',
    { ...base, runtimes, ...(runtimes.claude_code ? { model: runtimes.claude_code.model } : {}) },
    userId
  )
  return { before, after }
}
