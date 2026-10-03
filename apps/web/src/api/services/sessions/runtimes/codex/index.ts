/**
 * Codex as an `AgentRuntime` (§18.22-B): `codex exec --json` per turn, `codex exec resume <thread>`
 * after the first, its JSONL mapped onto the same `session_events`, its rollout file checkpointed
 * like Claude's transcript, and both billing modes — Launch's OpenAI key at the egress, or a
 * person's ChatGPT plan through a leased `auth.json`.
 *
 * **Stream B owns this directory** (`command.ts`, `config.ts`, `stream.ts`, `state.ts`,
 * `credentials.ts`, `login.ts`). Until it lands every member that would run Codex throws
 * `NotWiredError` by name — and `SESSION_RUNTIMES` (default `claude_code`) keeps the runtime out of
 * every deployment that has not opted in.
 */
import { NotWiredError } from '../../ports'
import type { AgentRuntime, RuntimeStateFiles } from '../types'
import { leaseCodexUserCredential } from './credentials'
import { codexLoginDriver } from './login'

const notWired = (what: string) => new NotWiredError(`Codex ${what}`, 'B')

const codexState: RuntimeStateFiles = {
  key: sessionId => `sessions/${sessionId}/codex.jsonl`,
  contentType: 'application/x-ndjson',
  locate: async () => {
    throw notWired('conversation state')
  },
  restorePath: () => {
    throw notWired('conversation state')
  },
  checkCommand: path => `test -s ${path}`,
}

export const codexRuntime: AgentRuntime = {
  id: 'codex',
  label: 'Codex',
  provider: 'openai',
  buildCommand: () => {
    throw notWired('turns')
  },
  turnEnv: () => {
    throw notWired('turns')
  },
  createParser: () => {
    throw notWired('output')
  },
  resumeRefused: () => false,
  workspaceFiles: () => [],
  state: codexState,
  supportsHostEgress: false,
  login: codexLoginDriver,
  userLease: leaseCodexUserCredential,
}
