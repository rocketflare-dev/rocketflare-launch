/**
 * The agent-runtime registry (§18.22): `runtimeFor(id)` / `runtimeOf(row)` are the ONE way the
 * session code reaches a runtime — never a `if (runtime === 'codex')` branch outside `runtimes/`.
 * A row without a runtime (none exists since the 0036 migration defaulted the column, but a
 * hand-built fixture may lack one) is Claude Code. Claude Code and Codex are `processRuntime(cli)`
 * (`process/`); Pi (#14, `pi/`) is the runtime of the other placement, a Durable Object — one more
 * entry here, and `runtimeFor` / `runtimeOf` stay the only way in.
 */
import { type AgentRuntimeId, DEFAULT_AGENT_RUNTIME } from '@launch/shared/launch-agents'
import type { SessionRow } from '../../../../db/schema'
import { claudeCodeRuntime } from './claude-code'
import { codexRuntime } from './codex'
import { piRuntime } from './pi'
import type { AgentRuntime } from './types'

export type * from './types'

export const AGENT_RUNTIME_REGISTRY: Record<AgentRuntimeId, AgentRuntime> = {
  claude_code: claudeCodeRuntime,
  codex: codexRuntime,
  pi: piRuntime,
}

export function runtimeFor(id: AgentRuntimeId | null | undefined): AgentRuntime {
  return AGENT_RUNTIME_REGISTRY[id ?? DEFAULT_AGENT_RUNTIME] ?? claudeCodeRuntime
}

export function runtimeOf(row: Partial<Pick<SessionRow, 'runtime'>>): AgentRuntime {
  return runtimeFor(row.runtime)
}

/**
 * The id the next turn resumes — Claude's session id or Codex's thread id. It lives in
 * `sessions.claude_session_id` (the column kept its P3 name; see the schema).
 */
export function resumeIdOf(row: Pick<SessionRow, 'claudeSessionId'>): string | null {
  return row.claudeSessionId
}
