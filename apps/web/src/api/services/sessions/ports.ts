/**
 * The coding sessions' PORTS (Launch P3, `docs/plans/p3-sessions.md` §3a): everything a session
 * needs from the outside world, as four interfaces, so the Workflow, the routes and the egress
 * handlers are written — and tested — against fakes (`tests/helpers/fake-sandbox.ts`,
 * `tests/helpers/fake-anthropic.ts`, the FakeCloud) and never against Cloudflare, Neon, GitHub or
 * Anthropic.
 *
 * | Port             | What it is                                             | Adapters (`SESSION_BACKEND`)             |
 * |------------------|--------------------------------------------------------|------------------------------------------|
 * | `SandboxPort`    | one session's container: commands, processes, files, ports | `sandbox/cloudflare-sandbox.ts` (both) |
 * | `SessionDbPort`  | the app's prepared `dev` database and a branch of it per session | `db/neon-session-db.ts` (both: always a real Neon branch) |
 * | `RepoHostPort`   | where the repo lives: git auth for the egress handler, PRs, CI checks | `repo/github-repo-host.ts` (cloud) · `repo/local-repo-host.ts` (local) |
 * | `ModelUpstream`  | where the model proxy sends a keyed request            | the global `fetch` (Anthropic)           |
 *
 * **`defaultSessionPorts(env, cfg)` is the ONE place the ports are bound to adapters.** The
 * adapter modules exist from slice 3a on as stubs that throw `NotWiredError`, each owned by the
 * slice that fills it in (3b: sandbox and db, 3d: repo) — so a slice replaces the body of its own
 * file and this one never changes. Tests never reach `defaultSessionPorts`: the Workflow takes
 * `overrides.ports` and the route suites mock this module.
 *
 * Two rules every adapter keeps:
 *
 * - **No secret crosses a port into a step result or an event.** `SessionBranch.uri` and
 *   `GitAuth.token` are secrets: the caller seals them onto the row (`encryptToken`) or uses them
 *   and drops them.
 * - **The Sandbox SDK is imported in exactly two files**: the Durable Object class
 *   (`durable-objects/session-sandbox.ts`) and `sandbox/cloudflare-sandbox.ts`. Everything else
 *   sees `SandboxPort`.
 */
import type {
  AppSessionDb,
  PrChecks,
  SessionDb,
  SessionPolicy,
} from '@launch/shared/launch-sessions'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { AppBindings } from '../../types'
import { NeonSessionDb } from './db/neon-session-db'
import { GitHubRepoHost } from './repo/github-repo-host'
import { LocalRepoHost } from './repo/local-repo-host'
import { CloudflareSandbox } from './sandbox/cloudflare-sandbox'

// ---- errors ------------------------------------------------------------------------------------

/**
 * A port method whose adapter a later slice builds. Thrown by the 3a stubs so a call that arrives
 * too early fails by NAME rather than by `undefined is not a function`.
 */
export class NotWiredError extends Error {
  constructor(what: string, slice: '3b' | '3c' | '3d') {
    super(`${what} is not wired yet (P3 slice ${slice}, docs/plans/p3-sessions.md)`)
    this.name = 'NotWiredError'
  }
}

/**
 * The container was replaced under a running command — a deploy that touched the image or the
 * `[[containers]]` block (S7 finding 8: "interrupted while the platform was updating the sandbox
 * runtime"). The adapter maps the SDK's error to this; the turn step turns it into
 * `turn.interrupted { reason: 'rollout' }` and the session goes `suspended`.
 */
export class SandboxInterruptedError extends Error {
  constructor(message = 'The sandbox was replaced while a command was running (a rollout)') {
    super(message)
    this.name = 'SandboxInterruptedError'
  }
}

/**
 * The container the step is talking to is not the one the boot prepared: its boot marker
 * (`SESSION_BOOT_MARKER`, written by `sandbox.start`) is gone or different, so the container was
 * recreated under the session — on a laptop almost always Docker's VM running out of memory and
 * killing the sandbox's control server (the SDK then answers `HTTP error! status: 500` and the
 * next call boots an EMPTY container). The step fails with this sentence instead of working on an
 * empty `/workspace` (docs/SESSIONS-LOCAL.md § Memory).
 */
export class SandboxRestartedError extends Error {
  constructor(phase: string) {
    super(
      `The session container stopped while ${phase.charAt(0).toLowerCase()}${phase.slice(1)} and came back empty` +
        ' — on a laptop this is usually Docker running out of memory (docs/SESSIONS-LOCAL.md § Memory).' +
        ' Start a new session.'
    )
    this.name = 'SandboxRestartedError'
  }
}

/** A background process (the app's dev server) exited while a step waited on it. */
export class SandboxProcessExitedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxProcessExitedError'
  }
}

// ---- SandboxPort -------------------------------------------------------------------------------

export interface SandboxExecOptions {
  cwd?: string
  /** Non-secret variables only: a sandbox never holds a credential (plan §1.4, §1.5). */
  env?: Record<string, string>
  timeoutMs?: number
}

export interface SandboxExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SandboxProcess {
  /** The SDK's process id — what `streamLogs` and `kill` take. */
  id: string
}

/**
 * One chunk of a background process's output, in order, then ONE `exit`. Chunks are raw output,
 * not lines: `claude-stream.ts` (3c) does the line splitting, because a stream-json line can
 * arrive in pieces.
 */
export type SandboxLogEvent =
  | { type: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; exitCode: number }

export interface SandboxWaitForPortOptions {
  path?: string
  timeoutMs?: number
  pidFile?: string
}

export interface SandboxStartOptions {
  /**
   * Hosts the container may reach, on top of the Durable Object's base allow-list
   * (`SESSION_BASE_ALLOWED_HOSTS`).
   */
  extraAllowedHosts?: string[]
}

/**
 * A directory backup (the Sandbox SDK's `DirectoryBackup` handle): serialisable, stored on the
 * session row, and restorable into ANY later container of the same image.
 */
export interface SandboxBackup {
  id: string
  dir: string
  /** Made through the Durable Object and the R2 binding (`binding` mode, `wrangler dev`). */
  localBucket?: boolean
}

export interface SandboxBackupOptions {
  /** Absolute, under `/workspace` — `SESSION_WORKSPACE`. */
  dir: string
  /** When the SDK treats it as expired (R2 lifecycle rules delete the object itself). */
  ttlSeconds: number
  name?: string
}

/** Workspace backups are off (`SESSION_WORKSPACE_BACKUP=off`, or no `BACKUP_BUCKET`). */
export class SandboxBackupUnavailableError extends Error {
  constructor(message = 'Workspace backups are off') {
    super(message)
    this.name = 'SandboxBackupUnavailableError'
  }
}

/**
 * One session's container (`SessionSandbox`, reached with `getSandbox(env.SESSION_SANDBOX, name)`).
 * `:3000` belongs to the SDK's control server inside a sandbox (S7): the app's dev UI is `:5173`.
 */
export interface SandboxPort {
  /** The Sandbox name — the session id, lower-case (`getSandbox`'s id). */
  readonly name: string
  /**
   * The id the platform hands the outbound handlers as `ctx.containerId`: the Durable Object id,
   * `env.SESSION_SANDBOX.idFromName(name).toString()`. Stored as `sessions.sandbox_id` BEFORE the
   * container starts, so the first model call already resolves to its session.
   */
  readonly id: string
  /** Boot the container (the first `exec` would too) and apply the allow-list. Idempotent. */
  start(opts?: SandboxStartOptions): Promise<void>
  /** Run to completion. Wrap anything that might `exit` in `bash -c` (S7 finding 7). */
  exec(command: string, opts?: SandboxExecOptions): Promise<SandboxExecResult>
  /** Start in the background (`pnpm dev`, a Claude Code turn). */
  startProcess(command: string, opts?: SandboxExecOptions): Promise<SandboxProcess>
  /**
   * The process's output as it arrives, ending with its `exit`. Throws `SandboxInterruptedError`
   * when the container is replaced mid-stream. `signal` stops READING; it does not kill.
   */
  streamLogs(processId: string, opts?: { signal?: AbortSignal }): AsyncIterable<SandboxLogEvent>
  /** Kill a background process (a cancelled or timed-out turn). */
  kill(processId: string, signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT'): Promise<void>
  /**
   * Resolve once `port` answers (`path` returns 2xx when given); throws after `timeoutMs`. With
   * `pidFile` (a file holding the pid of the process that should open the port), throws
   * `SandboxProcessExitedError` as soon as that process is gone instead of waiting out the time.
   */
  waitForPort(port: number, opts?: SandboxWaitForPortOptions): Promise<void>
  writeFile(path: string, content: string): Promise<void>
  /** The file's text, or null when it does not exist. */
  readFile(path: string): Promise<string | null>
  /** Replace the runtime allow-list (base hosts included — pass the whole list). */
  setAllowedHosts(hosts: readonly string[]): Promise<void>
  /** Proxy one request to a port inside the container (`containerFetch`) — the preview. */
  fetch(port: number, req: Request): Promise<Response>
  /** Tear the container down. Idempotent; ALWAYS called on end and on failure (S7 finding 9). */
  destroy(): Promise<void>
  /**
   * The hosts a backup or restore needs on the allow-list — the R2 endpoint when the container
   * moves the archive itself (`presigned`); none when it moves through the Durable Object.
   */
  readonly backupHosts: readonly string[]
  /** Archive `dir` into R2 (`createBackup`). Throws `SandboxBackupUnavailableError` when off. */
  backup(opts: SandboxBackupOptions): Promise<SandboxBackup>
  /** Put a backup back into `backup.dir` (`restoreBackup`), replacing what is there. */
  restore(backup: SandboxBackup): Promise<void>
  /** Delete a backup's objects. Idempotent: an already-gone backup is success. */
  deleteBackup(backup: SandboxBackup): Promise<void>
}

/** The hosts a session reaches with internet off (`enableInternet = false`, plan §3b). */
export const SESSION_BASE_ALLOWED_HOSTS = [
  'registry.npmjs.org',
  'github.com',
  'codeload.github.com',
  // Must be allow-listed for its outbound handler to run at all (S7: otherwise the proxy answers 520).
  'api.anthropic.com',
] as const

/**
 * The allow-list a session's container runs with: the base, plus `extra` — the exact hosts of the
 * Neon endpoint the container's database lives on (`sessionDbEgressHosts`) once it has one. Never
 * a wildcard, and the same on a laptop: nothing in the container talks to the laptop (the git and
 * model handlers run in Launch's Worker).
 */
export function sessionAllowedHosts(extra: readonly string[] = []): string[] {
  return [...new Set([...SESSION_BASE_ALLOWED_HOSTS, ...extra])]
}

// ---- SessionDbPort -----------------------------------------------------------------------------

/** The app as the database and repo ports need it — resolved by the caller, tenant-first. */
export interface SessionAppRef {
  id: string
  tenantId: string
  slug: string
  repoOwner: string
  repoName: string
  defaultBranch: string
  /** The app's Neon project (`app_environments.neon.projectId`); null when it has none. */
  neonProjectId: string | null
  /** `apps.session_db` as it stands. */
  sessionDb: AppSessionDb | null
}

/** A session's database: the non-secret description and its connection string (a SECRET). */
export interface SessionBranch {
  db: SessionDb
  /** Seal it onto `sessions.db_uri_sealed`; never return it from a step or put it in an event. */
  uri: string
}

export interface SessionDbPort {
  /**
   * Make sure the app has a `dev` database to branch from — Neon: a `dev` branch created
   * `init_source: 'schema-only'` from `main` with role `session_owner` (made in SQL) and an empty
   * `session_app`. Returns what `apps.session_db` should now say (status `none`
   * until a prepare run has migrated and seeded it). Idempotent.
   */
  ensureDev(app: SessionAppRef): Promise<AppSessionDb>
  /** A branch of `dev` for one session, with `session_owner`'s password reset on it. */
  createBranch(app: SessionAppRef, session: { id: string; shortId: string }): Promise<SessionBranch>
  /** Delete a session's branch. Idempotent: an already-gone branch is success. */
  deleteBranch(app: SessionAppRef, db: SessionDb): Promise<void>
  /** The `dev` database's connection string, for the prepare run (a SECRET). */
  devUriFor(app: SessionAppRef): Promise<string>
}

// ---- RepoHostPort ------------------------------------------------------------------------------

export interface RepoRef {
  owner: string
  repo: string
}

/** What the GitHub egress handler injects: an installation token scoped to ONE repo. A SECRET. */
export interface GitAuth {
  token: string
  expiresAt: Date
}

export interface OpenPullRequestInput {
  /** `session/<shortId>`. */
  head: string
  /** The branch it merges into — the app's default branch. */
  base: string
  title: string
  body: string
}

export interface RepoHostPort {
  /** Where an intercepted git smart-HTTP request really goes: `https://github.com` or `SESSION_LOCAL_GIT_URL`. */
  gitUpstream(repo: RepoRef): string
  /**
   * A token for the one repo (`contents: write`, `pull_requests: write`, 1 hour) — or null when the
   * host needs none (local). The caller seals it onto `github_token_sealed` and re-mints it when
   * under 10 minutes remain.
   */
  gitAuth(repo: RepoRef): Promise<GitAuth | null>
  /** Open (or find the open) PR for `head`. Local: records `local://…` and a synthetic number. */
  openPullRequest(
    repo: RepoRef,
    input: OpenPullRequestInput
  ): Promise<{ number: number; url: string }>
  /** The PR head's CI, check runs plus the combined status, folded (`prChecksSchema`). */
  getChecks(repo: RepoRef, input: { prNumber: number; headSha: string }): Promise<PrChecks>
}

// ---- ModelUpstream -----------------------------------------------------------------------------

/**
 * Where the model proxy sends a request after swapping in the real key. A port only so a test can
 * hand in `fake-anthropic.ts` and assert the placeholder never reaches upstream.
 */
export interface ModelUpstream {
  fetch(req: Request): Promise<Response>
}

// ---- the bundle --------------------------------------------------------------------------------

export interface SessionPorts {
  /** The sandbox named `name` (a session id; `prepare-<appId>` for a prepare run). */
  sandbox(name: string): SandboxPort
  /** The database port, over the step's own DB client (it reads the sealed Neon credential). */
  sessionDb(db: Database): SessionDbPort
  /** The repo host, over the step's own DB client (it reads the sealed GitHub App credential). */
  repoHost(db: Database): RepoHostPort
  model: ModelUpstream
}

/** What a caller needs besides the ports to act on a session: the policy it runs under. */
export interface SessionRuntimeContext {
  cfg: AppConfig
  policy: SessionPolicy
}

/**
 * The real adapters for this Worker, per `SESSION_BACKEND` (`local` only under
 * `APP_ENV=development` — `loadConfig` refuses it elsewhere). The sandbox and the database are the
 * same in both: locally the container is `wrangler dev`'s own, and a session's database is ALWAYS
 * a real Neon branch of the app's project, reached directly from the container. `local` swaps
 * only the repo host (the local git server).
 */
export function defaultSessionPorts(env: AppBindings, cfg: AppConfig): SessionPorts {
  const local = cfg.SESSION_BACKEND === 'local'
  return {
    sandbox: name =>
      new CloudflareSandbox(env.SESSION_SANDBOX, name, { cfg, backupBucket: env.BACKUP_BUCKET }),
    sessionDb: db => new NeonSessionDb(db, cfg),
    repoHost: db => (local ? new LocalRepoHost(cfg) : new GitHubRepoHost(db, cfg)),
    model: { fetch: req => fetch(req) },
  }
}
