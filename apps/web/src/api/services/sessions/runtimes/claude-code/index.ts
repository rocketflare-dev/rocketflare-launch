/**
 * Claude Code as a `CliAdapter` (§18.22), run by `processRuntime` — the P3 behaviour, byte for
 * byte: the command is `buildClaudeCommand` (with images: `buildClaudeTurnInputScript` first, the
 * message on stdin), the environment `claudeTurnEnv`, the parser `createClaudeStreamParser`
 * (its `claudeSessionId` becomes the generic `resumeId`), the workspace file the boot always wrote
 * (`.claude/settings.local.json`), and the transcript the checkpoint always copied. Nothing here
 * decides anything new: `claude-stream.ts` and its tests are unchanged, and
 * `tests/config/agent-runtime-claude.test.ts` pins the equivalence.
 */
import {
  buildClaudeCommand,
  buildClaudeTurnInputScript,
  claudeTurnEnv,
  createClaudeStreamParser,
} from '../../claude-stream'
import { claudeSettingsLocal, SESSION_WORKSPACE } from '../../rocketflare-dev'
import { processRuntime } from '../process'
import type { CliAdapter, RuntimeRunSummary } from '../types'
import { leaseClaudeUserCredential } from './credentials'
import { claudeLoginDriver } from './login'
import { claudeState } from './state'

/**
 * A `--resume` that Claude Code refused: a `result` of `error_during_execution` with no tokens at
 * all and nothing said — what it prints when the session it was told to resume does not exist.
 * A turn that did any work (tokens, text, a tool) is never re-run.
 */
export function claudeResumeRefused(run: RuntimeRunSummary): boolean {
  if (run.stop || run.output || run.result?.subtype !== 'error_during_execution') return false
  const u = run.result.usage
  return !u || u.tokensIn + u.tokensOut + u.cacheRead + u.cacheWrite === 0
}

/** Claude Code's half of the seam: what its process is (`processRuntime` drives it). */
export const claudeCli: CliAdapter = {
  id: 'claude_code',
  label: 'Claude Code',
  provider: 'anthropic',
  buildCommand: input =>
    buildClaudeCommand({
      message: input.message,
      model: input.model,
      resumeSessionId: input.resumeId,
      systemNote: input.systemNote,
      attachments: input.attachments,
    }),
  // With images the message goes in on stdin, as a stream-json line written first.
  turnInputCommand: input =>
    input.attachments?.length
      ? buildClaudeTurnInputScript({ message: input.message, attachments: input.attachments })
      : null,
  turnEnv: ({ model, source }) => claudeTurnEnv(model, source),
  createParser(turn) {
    const parser = createClaudeStreamParser(turn)
    const adapt = (mappings: ReturnType<typeof parser.push>) =>
      mappings.map(mapping => ({ ...mapping, resumeId: mapping.claudeSessionId }))
    return {
      push: chunk => adapt(parser.push(chunk)),
      end: () => adapt(parser.end()),
    }
  },
  resumeRefused: claudeResumeRefused,
  workspaceFiles: () => [
    { path: `${SESSION_WORKSPACE}/.claude/settings.local.json`, content: claudeSettingsLocal() },
  ],
  state: claudeState,
  login: claudeLoginDriver,
  userLease: leaseClaudeUserCredential,
}

/** Claude Code as an `AgentRuntime`: its CLI, as a process in the container. */
export const claudeCodeRuntime = processRuntime(claudeCli)
