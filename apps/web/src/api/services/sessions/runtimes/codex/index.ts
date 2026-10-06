/**
 * Codex as an `AgentRuntime` (§18.22-B): `codex exec --json` per turn, `… resume <thread>` after
 * the first (`command.ts`), `$CODEX_HOME` written before every turn (`config.ts`), its JSONL mapped
 * onto the same `session_events` (`stream.ts`), its rollout file checkpointed like Claude's
 * transcript (`state.ts`), and both billing modes — Launch's OpenAI key swapped in at the egress
 * (`egress/openai.ts`), or a person's ChatGPT plan through a claimed `auth.json` (`credentials.ts`;
 * `chatgpt.com` reached directly, the refresh through `egress/openai-auth.ts`), connected by a relayed device-code sign-in
 * (`login.ts`).
 *
 * Off until an admin turns it on (the session policy's `runtimes.codex`, Settings → Coding
 * agents tab — `runtimePolicyOf` fails closed). It runs on either sandbox host: the remote one's
 * handlers forward its two proxied hosts from the turn's egress grant (`egress/host.ts`).
 */
import { processRuntime } from '../process'
import type { CliAdapter } from '../types'
import { buildCodexCommand } from './command'
import { codexBeforeTurnFiles, codexTurnEnv } from './config'
import { leaseCodexUserCredential } from './credentials'
import { codexLoginDriver } from './login'
import { codexState } from './state'
import { createCodexStreamParser } from './stream'

/** Codex's half of the seam: what its process is (`processRuntime` drives it). */
export const codexCli: CliAdapter = {
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
  // On a person's ChatGPT plan its model calls go to `chatgpt.com` directly (ChatGPT blocks the
  // Workers runtime, `egress/registry.ts`), so no proxy meters them: the turn does.
  selfMetered: source => source === 'user',
  workspaceFiles: () => [],
  beforeTurnFiles: ({ model, systemNote }) => codexBeforeTurnFiles({ model, systemNote }),
  state: codexState,
  login: codexLoginDriver,
  userLease: leaseCodexUserCredential,
}

/** Codex as an `AgentRuntime`: its CLI, as a process in the container. */
export const codexRuntime = processRuntime(codexCli)
