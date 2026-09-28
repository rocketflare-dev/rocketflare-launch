/**
 * Checkpoint a session (Launch P3, plan §1.8): the branch is the durable state, so after every turn
 * (and before a suspend, and inside a ship) Launch commits what Claude Code changed, pushes
 * `session/<short>`, and copies Claude's transcript to R2 — so a destroyed sandbox loses nothing.
 *
 * **Stable signature — the Workflow (slice 3b) calls this from its `checkpoint#N` / `suspend#N`
 * steps, and `ship()` calls it before opening the PR:**
 *
 * ```ts
 * checkpoint(db, { cfg, sandbox, storage, now? }, { tenantId, sessionId }, { message?, repoDir?, claudeHome? })
 *   → Promise<CheckpointResult>   // { committed, pushed, headSha, transcriptKey }
 * ```
 *
 * - `storage` is `createR2Storage(env.FILES)`; null skips the transcript (a test, or no bucket).
 * - `repoDir` defaults to `SESSION_REPO_DIR` (`/workspace/app`) — where the Workflow clones.
 * - The commit's author and committer are Launch (`launch@<APP_URL host>`), with the session's
 *   creator as `Co-Authored-By` — the person asked for the change, Launch made the commit. Hooks
 *   are skipped (`--no-verify`): the ship gate is where the checks run.
 * - Nothing staged → no commit; the push still happens when the checkout's HEAD is not the row's
 *   `head_sha` (a checkpoint cut off between commit and push, retried).
 * - The push goes through the GitHub egress handler (`egress/github.ts`), which injects the token
 *   and refuses any ref but the session's branch. A push that fails TRANSIENTLY
 *   (`TRANSIENT_PUSH_RE`: "Repository not found" — a token GitHub had not settled that outlasted
 *   the proxy's own retries — a 5xx or 429, a dropped connection) is tried once more after
 *   `PUSH_RETRY_DELAY_MS`: the push is idempotent (the same sha to the same ref), and the step
 *   that runs a checkpoint has no retry of its own — a failed one is an error the person reads. A
 *   rejection (non-fast-forward, Launch's own 403) is final and not retried.
 * - The transcript is Claude Code's own `~/.claude/projects/<cwd, non-alphanumerics → '-'>/
 *   <claude_session_id>.jsonl`, stored at `sessions/<id>/claude.jsonl` (`transcript_key`); resume
 *   writes it back before `--resume`.
 * - Writes `head_sha`, `transcript_key` and `last_activity_at`, tenant-first. No status change: the
 *   caller owns the transition. Idempotent — safe as a retried Workflow step.
 *
 * A failing git command throws `CheckpointError` with the command's output tail (the sandbox holds
 * no secret, so there is none in it).
 */
import { SESSION_SHORT_ID_RE, sessionBranchName } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type SessionRow, sessions, users } from '../../../db/schema'
import { NotFoundError } from '../../utils/core/errors'
import type { StorageService } from '../storage'
import type { SandboxExecResult, SandboxPort, SessionEgressPort } from './ports'
import { SESSION_HOME, SESSION_WORKSPACE } from './rocketflare-dev'

/** Where the Workflow clones the app's repo inside the sandbox (`SESSION_WORKSPACE`). */
export const SESSION_REPO_DIR = SESSION_WORKSPACE
/** `$HOME` of the user Claude Code runs as in the session image (`SESSION_HOME`). */
export const SESSION_CLAUDE_HOME = SESSION_HOME
/** Where the commit message is written (a file, so no message is ever parsed by a shell). */
const COMMIT_MESSAGE_PATH = '/tmp/launch-commit-message.txt'
/** How long a transiently failed push waits before its one retry. */
export const PUSH_RETRY_DELAY_MS = 3000
/** git's output for a failure worth one more try — never a rejection of the ref itself. */
export const TRANSIENT_PUSH_RE =
  /Repository not found|returned error: (401|404|429|5\d\d)|Could not resolve host|Failed to connect|Connection (reset|timed out)|early EOF|RPC failed|remote end hung up/i

export class CheckpointError extends Error {
  constructor(
    readonly step: string,
    readonly output: string
  ) {
    super(`Checkpoint failed at ${step}: ${output}`)
    this.name = 'CheckpointError'
  }
}

export interface CheckpointDeps {
  cfg: AppConfig
  sandbox: SandboxPort
  /** `createR2Storage(env.FILES)`; null skips the transcript copy. */
  storage: StorageService | null
  now?: () => Date
  /** The wait before a transiently failed push's retry (tests pass a recorder). */
  sleep?: (ms: number) => Promise<void>
  /** `direct` (a remote sandbox): git gets a fresh token before the push. Absent = `proxied`. */
  egress?: SessionEgressPort
}

export interface CheckpointOptions {
  /** The commit's subject; defaults to `Launch session <short>: turn <n>`. */
  message?: string
  repoDir?: string
  claudeHome?: string
}

export interface CheckpointResult {
  /** A new commit was made (there were changes). */
  committed: boolean
  /** The branch was pushed. */
  pushed: boolean
  /** The checkout's HEAD after the checkpoint. */
  headSha: string | null
  /** The transcript's R2 key, when one was copied. */
  transcriptKey: string | null
}

/** Claude Code's per-project directory name for `cwd`. */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** The R2 key of a session's transcript. */
export function transcriptKeyFor(sessionId: string): string {
  return `sessions/${sessionId}/claude.jsonl`
}

/** The last `max` characters of a command's output, for an error or an event. */
export function outputTail(result: Pick<SandboxExecResult, 'stdout' | 'stderr'>, max = 4000) {
  const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  return text.length > max ? `…${text.slice(-max)}` : text
}

/** The commit identity: Launch itself, at APP_URL's host. */
export function launchGitIdentity(cfg: AppConfig): { name: string; email: string } {
  return { name: 'Launch', email: `launch@${new URL(cfg.APP_URL).hostname}` }
}

/** The commit message: subject, the session line, then the person as co-author. */
export function commitMessage(
  subject: string,
  session: Pick<SessionRow, 'shortId'>,
  coAuthor: { name: string; email: string } | null
): string {
  const lines = [
    subject.replace(/\s+/g, ' ').trim().slice(0, 200),
    '',
    `Launch session ${session.shortId}`,
  ]
  if (coAuthor) {
    lines.push('', `Co-Authored-By: ${coAuthor.name.replace(/[<>\n]/g, '')} <${coAuthor.email}>`)
  }
  return `${lines.join('\n')}\n`
}

async function loadSession(db: Database, tenantId: string, sessionId: string) {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId)))
    .limit(1)
  if (!row) throw new NotFoundError('Session not found', 'session_not_found')
  return row
}

export async function checkpoint(
  db: Database,
  deps: CheckpointDeps,
  ref: { tenantId: string; sessionId: string },
  opts: CheckpointOptions = {}
): Promise<CheckpointResult> {
  const now = deps.now ?? (() => new Date())
  const session = await loadSession(db, ref.tenantId, ref.sessionId)
  if (!SESSION_SHORT_ID_RE.test(session.shortId)) {
    throw new CheckpointError('branch', `unexpected short id ${session.shortId}`)
  }
  const branch = sessionBranchName(session.shortId)
  const cwd = opts.repoDir ?? SESSION_REPO_DIR
  const identity = launchGitIdentity(deps.cfg)
  const gitEnv = {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_TERMINAL_PROMPT: '0',
  }
  const git = async (step: string, command: string, allowExit: number[] = [0]) => {
    const result = await deps.sandbox.exec(command, { cwd, env: gitEnv, timeoutMs: 120_000 })
    if (!allowExit.includes(result.exitCode)) throw new CheckpointError(step, outputTail(result))
    return result
  }

  await git('add', 'git add -A')
  const staged = await git('diff', 'git diff --cached --quiet', [0, 1])
  let committed = false
  if (staged.exitCode === 1) {
    const [creator] = session.createdByUserId
      ? await db
          .select({ name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, session.createdByUserId))
          .limit(1)
      : []
    const subject = opts.message ?? `Launch session ${session.shortId}: turn ${session.turnCount}`
    await deps.sandbox.writeFile(
      COMMIT_MESSAGE_PATH,
      commitMessage(subject, session, creator ?? null)
    )
    await git('commit', `git commit --no-verify --quiet -F ${COMMIT_MESSAGE_PATH}`)
    committed = true
  }
  const head = (await git('rev-parse', 'git rev-parse HEAD')).stdout.trim() || null

  let pushed = false
  if (committed || (head && head !== session.headSha)) {
    const push = `git push --quiet origin HEAD:refs/heads/${branch}`
    await deps.egress?.prepareGit(deps.sandbox, session)
    const first = await deps.sandbox.exec(push, { cwd, env: gitEnv, timeoutMs: 120_000 })
    if (first.exitCode !== 0) {
      if (!TRANSIENT_PUSH_RE.test(outputTail(first))) {
        throw new CheckpointError('push', outputTail(first))
      }
      const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
      await sleep(PUSH_RETRY_DELAY_MS)
      await git('push', push)
    }
    pushed = true
  }

  let transcriptKey: string | null = null
  if (deps.storage && session.claudeSessionId && /^[A-Za-z0-9-]+$/.test(session.claudeSessionId)) {
    const home = opts.claudeHome ?? SESSION_CLAUDE_HOME
    const path = `${home}/.claude/projects/${claudeProjectDir(cwd)}/${session.claudeSessionId}.jsonl`
    const transcript = await deps.sandbox.readFile(path)
    if (transcript !== null) {
      transcriptKey = transcriptKeyFor(session.id)
      await deps.storage.put(transcriptKey, transcript, {
        contentType: 'application/x-ndjson',
        metadata: { sessionId: session.id, claudeSessionId: session.claudeSessionId },
      })
    }
  }

  await db
    .update(sessions)
    .set({
      headSha: head ?? session.headSha,
      transcriptKey: transcriptKey ?? session.transcriptKey,
      lastActivityAt: now(),
      updatedAt: now(),
    })
    .where(and(eq(sessions.tenantId, session.tenantId), eq(sessions.id, session.id)))

  return { committed, pushed, headSha: head, transcriptKey }
}
