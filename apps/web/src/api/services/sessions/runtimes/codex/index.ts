/**
 * Codex as an `AgentRuntime` (§18.22-B): `codex exec --json` per turn, `… resume <thread>` after
 * the first (`command.ts`), `$CODEX_HOME` written before every turn (`config.ts`), its JSONL mapped
 * onto the same `session_events` (`stream.ts`), its rollout file checkpointed like Claude's
 * transcript (`state.ts`), and both billing modes — Launch's OpenAI key swapped in at the egress
 * (`egress/openai.ts`), or a person's ChatGPT plan through a claimed `auth.json` (`credentials.ts`,
 * `egress/chatgpt.ts`, `egress/openai-auth.ts`), connected by a relayed device-code sign-in
 * (`login.ts`).
 *
 * Off until an admin turns it on (the session policy's `runtimes.codex`, the Setup page's Coding
 * agents card — `runtimePolicyOf` fails closed); the sandbox host (`SESSION_SANDBOX_HOST=remote`) never runs it (`supportsHostEgress`).
 */
import type { AgentRuntime } from '../types'
import { buildCodexCommand } from './command'
import { codexBeforeTurnFiles, codexTurnEnv } from './config'
import { leaseCodexUserCredential } from './credentials'
import { codexLoginDriver } from './login'
import { codexState } from './state'
import { createCodexStreamParser } from './stream'

export const codexRuntime: AgentRuntime = {
  id: 'codex',
  label: 'Codex',
  provider: 'openai',
  buildCommand: buildCodexCommand,
  turnEnv: ({ source }) => codexTurnEnv(source),
  createParser: (turn, ctx) => createCodexStreamParser(turn, { runtimeState: ctx?.runtimeState }),
  // Never re-run a turn without its thread: the turn checks the rollout is there before it resumes
  // (`state.checkCommand`), and a failed resume says why in its own output — retrying fresh would
  // throw a conversation away over a transient failure.
  resumeRefused: () => false,
  workspaceFiles: () => [],
  beforeTurnFiles: ({ model, systemNote }) => codexBeforeTurnFiles({ model, systemNote }),
  state: codexState,
  supportsHostEgress: false,
  login: codexLoginDriver,
  userLease: leaseCodexUserCredential,
}
