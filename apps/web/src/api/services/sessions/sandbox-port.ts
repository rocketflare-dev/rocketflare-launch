/**
 * The `SandboxPort` half of `ports.ts` (Launch P3): the interface one session's container is
 * driven through, its errors, and the egress allow-list. A LEAF — it imports nothing — so the
 * sandbox host Worker (`src/sandbox-host/`, a session on the remote sandbox host) can bundle the adapter
 * and the Durable Object without Launch's database, config or vendor adapters. `ports.ts`
 * re-exports all of it; import from there everywhere else.
 */

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
  /**
   * Paths under `dir` (mksquashfs wildcard patterns, relative to it) left out of the archive —
   * issue #16's prebuild drops anything session-specific. Absent: everything (a session's own
   * backup keeps `.dev.vars`).
   */
  excludes?: readonly string[]
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
   * Every call starts from the process's FIRST output (the SDK replays what it has accumulated,
   * then streams live; an ended process replays and exits) — what a re-attach after a dropped
   * stream relies on (`runtimes/process/logs.ts`).
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
  /** Write raw bytes (an image) — the SDK's `writeFile` with `encoding: 'base64'`. */
  writeFileBytes(path: string, bytes: Uint8Array): Promise<void>
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
  // §18.22-B: Codex's hosts (`OPENAI_EGRESS_HOSTS`, `egress/refuse.ts` — spelled out because this
  // file is a leaf). `api.openai.com` and `auth.openai.com` have their handlers in
  // `egress/registry.ts` (and on the sandbox host); `chatgpt.com` is a DELIBERATE pass-through —
  // ChatGPT blocks requests from the Workers runtime, so a ChatGPT plan's container reaches it
  // directly with the person's own token (`DIRECT_CODEX_HOSTS`, only under `SESSION_EGRESS=open`).
  'api.openai.com',
  'chatgpt.com',
  'auth.openai.com',
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

/**
 * How a session container reaches the internet (`SESSION_EGRESS`, `config.ts`):
 *
 * - `allowlist` — internet off and the allow-list above; every outbound connection goes through
 *   the egress interception. The spec's model (spec/03), and the default: a missing or unknown
 *   value is `allowlist`.
 * - `open` — internet on, no allow-list; only the model and git hosts are intercepted, for their
 *   credentials. The deployed tomls say `open` for now, because the interception never ends a
 *   container's stream after a WebSocket closes, so the database's scripts never exit
 *   (docs/plans/sandbox-websocket-close.md).
 *
 * Reads `env` structurally, not through `loadConfig`: the sandbox host Worker bundles the Durable
 * Object that calls this without Launch's config.
 */
export type SessionEgressMode = 'allowlist' | 'open'

export function sessionEgressMode(env: unknown): SessionEgressMode {
  const value = (env as { SESSION_EGRESS?: unknown } | null | undefined)?.SESSION_EGRESS
  return typeof value === 'string' && value.trim() === 'open' ? 'open' : 'allowlist'
}
