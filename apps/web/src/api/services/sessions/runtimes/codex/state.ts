/**
 * Where Codex keeps a conversation (§18.22-B): its ROLLOUT file,
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDThh-mm-ss>-<thread id>.jsonl`, copied by the
 * checkpoint to R2 at `sessions/<id>/codex.jsonl` (`transcript_key`) and put back by the
 * `transcript#K` step before `codex exec resume <thread>` needs it.
 *
 * **No stored path is needed to put it back.** Codex 0.160 finds a thread's rollout by walking
 * `$CODEX_HOME/sessions/` for a file NAMED `rollout-<timestamp>-<thread id>[_<rollout id>].jsonl`
 * at any depth (`rollout/src/list.rs`, `find_thread_path_by_id_from_filenames` — its SQLite index
 * is empty in a fresh container, so it falls back to the walk), newest timestamp first. So:
 *
 * - `locate` (the checkpoint, in the container the turn ran in) asks the container for the newest
 *   rollout of the thread wherever Codex put it;
 * - `restorePath` (a fresh container) is a canonical name under `sessions/launch/` with the epoch
 *   as its timestamp — a valid rollout name Codex finds by thread id and appends to on resume;
 * - `checkCommand` passes when ANY non-empty rollout of the thread exists, so the turn's
 *   "is the conversation there?" check holds in the container that wrote it (original path) and in
 *   one that restored it (canonical path) alike.
 *
 * (`sessions.runtime_state` is therefore not used for the path — it carries the usage totals,
 * `stream.ts`.)
 */
import type { SessionRow } from '../../../../../db/schema'
import type { RuntimeStateFiles } from '../types'
import { CODEX_THREAD_ID_RE } from './command'
import { CODEX_SESSIONS_DIR } from './config'

/** The R2 key of a session's Codex rollout. */
export const codexRolloutKeyFor = (sessionId: string) => `sessions/${sessionId}/codex.jsonl`

/** Where a restore writes a thread's rollout back (a name Codex's own lookup accepts). */
export const codexRestorePath = (threadId: string) =>
  `${CODEX_SESSIONS_DIR}/launch/rollout-1970-01-01T00-00-00-${threadId}.jsonl`

const threadOf = (row: Pick<SessionRow, 'claudeSessionId'>): string | null =>
  row.claudeSessionId && CODEX_THREAD_ID_RE.test(row.claudeSessionId) ? row.claudeSessionId : null

/** `find` the thread's non-empty rollouts, newest first (by mtime). `threadId` is a checked UUID. */
export function codexFindRolloutCommand(threadId: string): string {
  return `find ${CODEX_SESSIONS_DIR} -type f -name 'rollout-*-${threadId}*.jsonl' -size +0c -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2-`
}

/** The thread id a rollout path (`…-<uuid>.jsonl`) names, or null. */
export function threadIdOfRolloutPath(path: string): string | null {
  const match =
    /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:_[^/]*)?\.jsonl$/.exec(
      path
    )
  return match?.[1] ?? null
}

export const codexState: RuntimeStateFiles = {
  key: codexRolloutKeyFor,
  contentType: 'application/x-ndjson',
  async locate(sandbox, row) {
    const thread = threadOf(row)
    if (!thread) return null
    const found = await sandbox.exec(codexFindRolloutCommand(thread), { timeoutMs: 15_000 })
    const path = found.exitCode === 0 ? found.stdout.trim().split('\n')[0]?.trim() : ''
    return path?.startsWith(`${CODEX_SESSIONS_DIR}/`) && threadIdOfRolloutPath(path) === thread
      ? path
      : null
  },
  restorePath(row) {
    const thread = threadOf(row)
    return thread ? codexRestorePath(thread) : null
  },
  checkCommand(path) {
    const thread = threadIdOfRolloutPath(path)
    // Not a rollout path Launch made: fall back to the plain check on the file itself.
    if (!thread || !CODEX_THREAD_ID_RE.test(thread)) return `test -s ${path}`
    return `test -n "$(${codexFindRolloutCommand(thread)})"`
  },
}
