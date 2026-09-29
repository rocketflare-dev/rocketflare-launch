/**
 * Checkpoint a session (Launch P3, plan §1.8): the branch is the durable state, so once a turn has
 * changed the workspace — debounced: {@link SESSION_CHECKPOINT_DEBOUNCE_MS} after the latest turn,
 * at most {@link SESSION_CHECKPOINT_MAX_DEFER_MS} after the first unsaved change — and always
 * before a suspend or an end, and inside a ship, Launch commits what Claude Code changed, pushes
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
 * - **Nothing huge is staged.** Before `git add`, the checkout's exclude file is made to carry the
 *   core-dump names ({@link CORE_DUMP_EXCLUDES}; the repo step writes them too, this covers a
 *   restored workspace), and every untracked or modified file over {@link CHECKPOINT_MAX_FILE_BYTES}
 *   is left out of the commit by a pathspec exclusion — never deleted — and named in an `error`
 *   event ("saved, but left out …") and in `skipped`. A crash under emulation once left 11 GB of
 *   core files in the checkout, and `git add -A` timed out hashing them (it would otherwise have
 *   committed and pushed them).
 * - **Never the dev setup.** After `git add`, {@link DEV_SETUP_GUARD_SCRIPT} checks the staged
 *   wrangler tomls and `worker-configuration.d.ts` for the kit's offline `[ai]` toggle; a hit
 *   throws `CheckpointError('guard', …)` before the commit — nothing is committed or pushed, and a
 *   ship stops at its save. The session's dev setup lives in git-ignored files
 *   (`rocketflare-dev.ts`), so this only fires on a regression; the exclude file also carries
 *   {@link SESSION_DEV_EXCLUDES}.
 *
 * A failing git command throws `CheckpointError` with the command's output tail (the sandbox holds
 * no secret, so there is none in it); a command that did not answer in time (`GIT_TIMEOUT_MS`)
 * throws one that says so, naming the step. Either way the caller (`checkpointStep`) records an
 * `error` event and the session carries on from the previous checkpoint.
 */
import {
  SESSION_SHORT_ID_RE,
  type SessionEventInput,
  sessionBranchName,
} from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type SessionRow, sessions, users } from '../../../db/schema'
import { NotFoundError } from '../../utils/core/errors'
import type { StorageService } from '../storage'
import { appendSessionEvents } from './event-log'
import {
  type SandboxExecResult,
  SandboxInterruptedError,
  type SandboxPort,
  type SessionEgressPort,
} from './ports'
import {
  SESSION_DEV_EXCLUDES,
  SESSION_HOME,
  SESSION_WORKSPACE,
  WORKER_TYPES,
  WRANGLER_STAGING_TOML,
  WRANGLER_TOML,
} from './rocketflare-dev'

/** Where the Workflow clones the app's repo inside the sandbox (`SESSION_WORKSPACE`). */
export const SESSION_REPO_DIR = SESSION_WORKSPACE
/** `$HOME` of the user Claude Code runs as in the session image (`SESSION_HOME`). */
export const SESSION_CLAUDE_HOME = SESSION_HOME
/** Where the commit message is written (a file, so no message is ever parsed by a shell). */
const COMMIT_MESSAGE_PATH = '/tmp/launch-commit-message.txt'
/** Where the scan writes `git add`'s pathspec (NUL-separated: `.` then one exclusion per big file). */
const ADD_PATHSPEC_PATH = '/tmp/launch-checkpoint-pathspec'
/** Each git command's timeout. */
export const GIT_TIMEOUT_MS = 120_000
/** No single file over this is ever staged by a checkpoint (it is named in an event instead). */
export const CHECKPOINT_MAX_FILE_BYTES = 50 * 1024 * 1024
/**
 * Core dumps, in the checkout's `.git/info/exclude` (never the app's `.gitignore`): `core` as a
 * FILE only (`!core/` keeps a directory of that name — `src/core/` is ordinary code), a pid-suffixed
 * `core.<pid>` (not `core.ts`), and QEMU's `qemu_<prog>_<date>_<pid>.core`. Order matters.
 */
export const CORE_DUMP_EXCLUDES = [
  'core',
  '!core/',
  'core.[0-9]*',
  '*.core',
  'qemu_*.core',
] as const

const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * The scan before `git add`: drop a stale `index.lock`, make sure the exclude file carries
 * {@link CORE_DUMP_EXCLUDES} (in order, each once), then list every untracked or modified file over `maxBytes` as
 * `large\t<bytes>\t<path>` and write `git add`'s pathspec — `.` minus each of them, literally.
 */
export function checkpointScanScript(maxBytes = CHECKPOINT_MAX_FILE_BYTES): string {
  return [
    'set -e',
    'mkdir -p .git/info',
    // A git that an earlier, timed-out checkpoint left behind dies without removing its lock, and
    // every later `git add` would fail on it. Stale = no git running at all, or older than any
    // checkpoint command may run (5 min) — a git the model started keeps a young lock alive.
    'if [ -f .git/index.lock ] && { ! pgrep -x git >/dev/null 2>&1 || [ -n "$(find .git/index.lock -mmin +5 2>/dev/null)" ]; }; then rm -f .git/index.lock; fi',
    `for p in ${[...CORE_DUMP_EXCLUDES, ...SESSION_DEV_EXCLUDES].map(q).join(' ')}; do grep -qxF -- "$p" .git/info/exclude 2>/dev/null || printf '%s\\n' "$p" >> .git/info/exclude; done`,
    `printf '.\\0' > ${ADD_PATHSPEC_PATH}`,
    "git ls-files -z --others --modified --exclude-standard | while IFS= read -r -d '' f; do",
    '  if [ ! -f "$f" ] || [ -L "$f" ]; then continue; fi',
    '  s=$(stat -c %s -- "$f" 2>/dev/null || stat -f %z -- "$f")',
    `  if [ "$s" -gt ${maxBytes} ]; then`,
    `    printf ':(exclude,literal)%s\\0' "$f" >> ${ADD_PATHSPEC_PATH}`,
    `    printf 'large\\t%s\\t%s\\n' "$s" "$f"`,
    '  fi',
    'done',
  ].join('\n')
}

/**
 * The dev-setup guard, run on what `git add` staged: prints `ai-off\t<path>` for each tracked file
 * whose staged content carries the kit's OFFLINE `[ai]` toggle where HEAD's does not — a wrangler
 * toml whose live `[ai]` became the kit's commented `# [ai]`, and `worker-configuration.d.ts`
 * losing its `AI: Ai;` while the staged `wrangler.toml` still declares `[ai]` (types generated
 * from a toggled toml). A session's dev setup never writes those files (`rocketflare-dev.ts`), so
 * a hit is a regression, and the checkpoint refuses it rather than let it reach a PR — merging the
 * toggle would take Workers AI out of the app's production.
 */
export const DEV_SETUP_GUARD_SCRIPT = [
  `for f in ${[WRANGLER_TOML, WRANGLER_STAGING_TOML].map(q).join(' ')}; do`,
  `  if git show "HEAD:$f" 2>/dev/null | grep -qE '^\\[ai\\][[:space:]]*$' && git show ":$f" 2>/dev/null | grep -qE '^# \\[ai\\][[:space:]]*$'; then printf 'ai-off\\t%s\\n' "$f"; fi`,
  'done',
  `t=${q(WORKER_TYPES)}`,
  `if git show "HEAD:$t" 2>/dev/null | grep -qE '^[[:space:]]*AI: Ai;' && ! git show ":$t" 2>/dev/null | grep -qE '^[[:space:]]*AI: Ai;' && git show ${q(`:${WRANGLER_TOML}`)} 2>/dev/null | grep -qE '^\\[ai\\][[:space:]]*$'; then printf 'ai-off\\t%s\\n' "$t"; fi`,
  'exit 0',
].join('\n')

/** The guard's `ai-off` lines. */
export function parseDevSetupDrift(stdout: string): string[] {
  return [...stdout.matchAll(/^ai-off\t(.+)$/gm)].map(m => m[1] ?? '')
}

/** The checkpoint's refusal when the guard fires. */
export function devSetupDriftMessage(files: readonly string[]): string {
  return `refused to commit the session's offline [ai] toggle in ${files.join(', ')} — local dev setup, not the agent's change (merged, it would take Workers AI out of the app's production). Nothing was committed or pushed. Put the files back with \`git checkout HEAD -- ${files.join(' ')}\` (or ask Claude to), then save again; this is a Launch bug worth reporting.`
}

/** `git add -A` over the scan's pathspec: everything but the files it left out. */
export const CHECKPOINT_ADD_COMMAND = `git add -A --pathspec-from-file=${ADD_PATHSPEC_PATH} --pathspec-file-nul`

/** A file the checkpoint did not stage, and why. */
export interface SkippedFile {
  path: string
  bytes: number
}

/** The scan's `large` lines. */
export function parseLargeFiles(stdout: string): SkippedFile[] {
  const out: SkippedFile[] = []
  for (const match of stdout.matchAll(/^large\t(\d+)\t(.*)$/gm)) {
    out.push({ bytes: Number(match[1]), path: match[2] ?? '' })
  }
  return out
}

/** `5.8 GB`, `73 MB`. */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/** The `error` event's sentence for the files a checkpoint left out. */
export function skippedFilesMessage(files: readonly SkippedFile[], maxBytes: number): string {
  const names = files
    .slice(0, 10)
    .map(f => `${f.path} (${formatBytes(f.bytes)})`)
    .join(', ')
  const more = files.length > 10 ? ` and ${files.length - 10} more` : ''
  return `Saved, but left out ${files.length === 1 ? 'a file' : `${files.length} files`} over ${formatBytes(maxBytes)} that git should not hold: ${names}${more}. They are still in the workspace; delete them, or ask Claude to.`
}

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
  /** Appends the "left out" `error` event; default: straight to the session's log. */
  emit?: (events: SessionEventInput[]) => Promise<void>
  /** Overrides {@link CHECKPOINT_MAX_FILE_BYTES}. */
  maxFileBytes?: number
  /** `host` (a remote sandbox): the host is granted a fresh token before the push. Absent = `proxied`. */
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
  /** Files over the size limit that were NOT staged (named in an `error` event). */
  skipped: SkippedFile[]
}

// ---- debounced checkpoints (the Workflow's loop) -----------------------------------------------

/**
 * A turn that changed the workspace does not checkpoint at once: the Workflow waits until the
 * session has been quiet this long after the latest turn (a message inside the window runs, and
 * the window starts again from ITS end) — so a burst of messages is one commit and one push, not
 * one per message. `suspend#N`, `end#N` and a ship still checkpoint first, whatever the debounce.
 */
export const SESSION_CHECKPOINT_DEBOUNCE_MS = 30_000
/**
 * The debounce's cap: a session that has held unsaved changes this long checkpoints straight after
 * its next turn, however busy the conversation — a steady stream of messages never defers a save
 * past it.
 */
export const SESSION_CHECKPOINT_MAX_DEFER_MS = 5 * 60_000
/** The dirty check's own budget: it is `git status`, so anything slower is treated as changed. */
export const WORKSPACE_CHANGED_TIMEOUT_MS = 30_000

/**
 * What the turn step runs after a turn: the checkout's HEAD, then `dirty` or `clean` from
 * `git status --porcelain` (untracked files included — a new file is a change; ignored ones are
 * not). `set -e` makes either git failing a non-zero exit; `GIT_OPTIONAL_LOCKS=0` keeps the status
 * from taking `index.lock` under a git the model left running.
 */
export const WORKSPACE_CHANGED_SCRIPT = [
  'set -e',
  'git rev-parse HEAD',
  's=$(git status --porcelain --untracked-files=normal)',
  'if [ -n "$s" ]; then echo dirty; else echo clean; fi',
].join('\n')

/**
 * Did the workspace move away from the last checkpoint? True when anything is uncommitted (a
 * modified, added, deleted or untracked file) or when HEAD is not the row's `head_sha` (the turn
 * committed itself, or an earlier checkpoint was cut off before its push). FAIL SAFE: a command
 * that fails, times out or answers something unexpected is `true` — a checkpoint that finds
 * nothing to do costs a `git add`, a missed one costs the person's work.
 */
export async function workspaceChanged(
  sandbox: SandboxPort,
  headSha: string | null,
  opts: { repoDir?: string; timeoutMs?: number } = {}
): Promise<boolean> {
  try {
    const result = await sandbox.exec(WORKSPACE_CHANGED_SCRIPT, {
      cwd: opts.repoDir ?? SESSION_REPO_DIR,
      // The checkpoint's own conventions (`gitEnv` below): no prompt, the turn's HOME.
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', HOME: SESSION_HOME },
      timeoutMs: opts.timeoutMs ?? WORKSPACE_CHANGED_TIMEOUT_MS,
    })
    if (result.exitCode !== 0) return true
    const [head, state] = result.stdout.trim().split('\n')
    if (!head || !/^[0-9a-f]{40}$/.test(head.trim())) return true
    if (state?.trim() === 'clean') return head.trim() !== headSha
    return true
  } catch {
    return true
  }
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
    // The same HOME the turn runs with (`claudeTurnEnv`): git's global config and credentials.
    HOME: SESSION_HOME,
  }
  const run = async (step: string, command: string) => {
    try {
      return await deps.sandbox.exec(command, { cwd, env: gitEnv, timeoutMs: GIT_TIMEOUT_MS })
    } catch (err) {
      if (err instanceof SandboxInterruptedError) throw err
      // The SDK's own words for a timeout vary; say which step, and that it did not answer.
      const detail = err instanceof Error ? err.message : String(err)
      const timedOut = /timed? ?out/i.test(detail)
      throw new CheckpointError(
        step,
        timedOut
          ? `\`${command.split('\n')[0]?.slice(0, 120)}\` did not finish within ${GIT_TIMEOUT_MS / 1000} s (${detail.slice(0, 200)})`
          : detail.slice(0, 600)
      )
    }
  }
  const git = async (step: string, command: string, allowExit: number[] = [0]) => {
    const result = await run(step, command)
    if (!allowExit.includes(result.exitCode)) throw new CheckpointError(step, outputTail(result))
    return result
  }

  const maxBytes = deps.maxFileBytes ?? CHECKPOINT_MAX_FILE_BYTES
  const skipped = parseLargeFiles((await git('scan', checkpointScanScript(maxBytes))).stdout)
  await git('add', CHECKPOINT_ADD_COMMAND)
  if (skipped.length > 0) {
    const emit =
      deps.emit ??
      (events => appendSessionEvents(db, { id: session.id, tenantId: session.tenantId }, events))
    await emit([
      {
        type: 'error',
        turn: session.turnCount,
        data: {
          message: skippedFilesMessage(skipped, maxBytes),
          details: { skipped: skipped.slice(0, 50), maxFileBytes: maxBytes },
        },
      },
    ])
  }
  const drift = parseDevSetupDrift((await git('guard', DEV_SETUP_GUARD_SCRIPT)).stdout)
  if (drift.length > 0) throw new CheckpointError('guard', devSetupDriftMessage(drift))
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
    const first = await run('push', push)
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

  return { committed, pushed, headSha: head, transcriptKey, skipped }
}
