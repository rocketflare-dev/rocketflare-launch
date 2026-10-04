/**
 * Codex's turn command (§18.22-B). One message is one process, like Claude Code's:
 *
 * ```
 * codex exec --json -s danger-full-access --skip-git-repo-check -m <policy model> '<message>' < /dev/null
 * codex exec --json -s danger-full-access --skip-git-repo-check -m <policy model> resume <thread> '<message>' < /dev/null
 * codex exec --json -s danger-full-access --skip-git-repo-check -i <image> … -m <policy model> [resume <thread>] '<message>' < /dev/null
 * ```
 *
 * - The global flags come BEFORE `resume`: Codex 0.160 rejects `-s` / `-C` after it (spike S-B1).
 *   `danger-full-access` because the SANDBOX is the boundary (egress allow-list, placeholder key,
 *   its own database branch) and Codex's own Landlock/seccomp sandbox cannot nest inside it;
 *   `config.toml` says the same (`sandbox_mode`) and never asks for approval.
 * - `--skip-git-repo-check`: a session's checkout is a git repo, but a turn must never stop on the
 *   check if it is not (a fresh app before its first commit).
 * - `-m` is the session POLICY's model — the only one the egress lets through.
 * - `< /dev/null`: with a prompt AND a piped stdin, `codex exec` reads stdin to its end and appends
 *   it to the prompt (`exec/src/lib.rs`, `OptionalAppend`) — an open pipe that never closes would
 *   hang the turn.
 * - The message is shell-quoted (`shellQuote`), never interpolated: it is user text. One starting
 *   with `-` gets a leading space so the CLI cannot read it as a flag.
 * - Images: `-i <path>` per image, among the global flags BEFORE `resume` (where `-s` must be too)
 *   and each followed by another flag — `-i` takes several values, so one right before the
 *   message would read the message as a file. The paths are the turn's staged files
 *   (`attachments.ts`), checked to be plain tokens.
 * - The system note is NOT on the command line: Codex has no `--append-system-prompt`, so it is
 *   `$CODEX_HOME/AGENTS.md`, written before every turn (`config.ts`).
 */
import { shellQuote } from '../../claude-stream'
import type { RuntimeCommandInput } from '../types'

/** Ids and model names are plain tokens — the same rule as Claude's command. */
const SAFE_TOKEN = /^[A-Za-z0-9._:@/-]{1,200}$/

/** A Codex thread id (a UUID, v7 in practice) — what `resume` takes and the rollout file is named by. */
export const CODEX_THREAD_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** The shell command for one Codex turn. Throws on a model or thread id that is not a plain token. */
export function buildCodexCommand(input: RuntimeCommandInput): string {
  if (!SAFE_TOKEN.test(input.model)) throw new Error('buildCodexCommand: invalid model id')
  const parts = ['codex', 'exec', '--json', '-s', 'danger-full-access', '--skip-git-repo-check']
  for (const attachment of input.attachments ?? []) {
    if (!SAFE_TOKEN.test(attachment.path)) throw new Error('buildCodexCommand: invalid image path')
    parts.push('-i', attachment.path)
  }
  parts.push('-m', input.model)
  if (input.resumeId) {
    if (!CODEX_THREAD_ID_RE.test(input.resumeId)) {
      throw new Error('buildCodexCommand: invalid thread id')
    }
    parts.push('resume', input.resumeId)
  }
  const message = input.message.startsWith('-') ? ` ${input.message}` : input.message
  parts.push(shellQuote(message), '< /dev/null')
  return parts.join(' ')
}
