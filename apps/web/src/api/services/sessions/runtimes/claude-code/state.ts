/**
 * Where Claude Code keeps a conversation: its own transcript,
 * `~/.claude/projects/<cwd, non-alphanumerics → '-'>/<claude_session_id>.jsonl`, copied by the
 * checkpoint to R2 at `sessions/<id>/claude.jsonl` (`transcript_key`) and put back by the
 * `transcript#K` step before `--resume` needs it. The P3 behaviour, moved behind `RuntimeStateFiles`
 * unchanged (`checkpoint.ts` re-exports the two helpers it always exported).
 */
import type { SessionRow } from '../../../../../db/schema'
import { claudeTranscriptPath } from '../../rocketflare-dev'
import type { RuntimeStateFiles } from '../types'

/** Claude Code's per-project directory name for `cwd`. */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** The R2 key of a session's transcript. */
export function transcriptKeyFor(sessionId: string): string {
  return `sessions/${sessionId}/claude.jsonl`
}

/** A Claude session id that is safe as a path segment (and as a `--resume` argument). */
export const CLAUDE_SESSION_ID_RE = /^[A-Za-z0-9-]+$/

const safeId = (row: Pick<SessionRow, 'claudeSessionId'>): string | null =>
  row.claudeSessionId && CLAUDE_SESSION_ID_RE.test(row.claudeSessionId) ? row.claudeSessionId : null

/** `test -s` on the transcript `--resume` needs: exit 1 = missing or empty. */
export const transcriptCheckCommand = (claudeSessionId: string) =>
  `test -s ${claudeTranscriptPath(claudeSessionId)}`

export const claudeState: RuntimeStateFiles = {
  key: transcriptKeyFor,
  contentType: 'application/x-ndjson',
  async locate(_sandbox, row, { cwd, home }) {
    const id = safeId(row)
    return id ? `${home}/.claude/projects/${claudeProjectDir(cwd)}/${id}.jsonl` : null
  },
  restorePath(row) {
    const id = safeId(row)
    return id ? claudeTranscriptPath(id) : null
  },
  checkCommand: path => `test -s ${path}`,
}
