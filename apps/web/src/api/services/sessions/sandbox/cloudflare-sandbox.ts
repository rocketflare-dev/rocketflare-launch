/**
 * `CloudflareSandbox` — the `SandboxPort` over the Sandbox SDK (`@cloudflare/sandbox` 0.12.10,
 * stable): `getSandbox(env.SESSION_SANDBOX, name)` → `exec`, `startProcess` + `streamProcessLogs`
 * + `killProcess`, `waitForPort` (on the process), `writeFile` / `readFile`, `setAllowedHosts`,
 * `containerFetch(req, port)` and `destroy()`. Used by BOTH backends — locally the container is
 * `wrangler dev`'s own, which honours the same egress settings (checked in slice 3b:
 * `outboundByHost`, `interceptHttps`, `enableInternet = false` and a runtime `setAllowedHosts` all
 * behave as deployed; `docs/SESSIONS-LOCAL.md`).
 *
 * This is one of the TWO files that import the SDK (the other is
 * `durable-objects/session-sandbox.ts`). Everything else sees `SandboxPort`.
 *
 * Choices worth knowing:
 *
 * - **`sleepAfter` is a backstop, not the idle policy.** The Workflow suspends an idle session
 *   itself (`idleSuspendMinutes`, default 30), keeps its container for `SESSION_WARM_KEEP_MINUTES`
 *   (`warm.ts`) and then destroys it; the SDK's own sleep (`SESSION_SANDBOX_SLEEP_AFTER`, longer
 *   than the warm window — a config test pins it) only reaps a container whose Workflow died. When
 *   it does fire, the Durable Object's `onStop` marks a `ready` session `suspended` (and forgets a
 *   kept container), so the next wake boots again instead of talking to an empty container.
 * - **`start` is bounded per attempt and retried once after a reset** (`START_ATTEMPT_MS`): a
 *   start on the same Durable Object seconds after a `destroy` was seen to never answer under
 *   `wrangler dev` (docs/SESSIONS-LOCAL.md § A start that never answers). The container boots
 *   first (`exec('true')`, under the class's own base allow-list) and the allow-list is applied
 *   after, so a runtime `setAllowedHosts` is never the first thing sent to a container that may
 *   still be going away.
 * - **Every command runs in its own `bash -c`** (S7 finding 7): `exec` shares ONE persistent shell
 *   per sandbox, and a bare `exit` in a command would end it for every later command. It starts
 *   with `ulimit -c 0`: no crash leaves a multi-gigabyte core file in the checkout.
 * - **A rollout surfaces as `SandboxInterruptedError`.** The SDK raises
 *   `OperationInterruptedError` / `SessionTerminatedError` (or a platform message about the runtime
 *   being replaced) when the container goes away under a command; the error is matched by NAME and
 *   message, never `instanceof`, so the test alias of the SDK need not carry the classes.
 * - `streamLogs` parses the SDK's SSE log stream itself (`data: {type, data, exitCode}` frames) —
 *   small, and testable without the SDK.
 */
import { getSandbox } from '@cloudflare/sandbox'
import type { AppConfig } from '../../../../config'
import type { SessionSandbox } from '../../../durable-objects/session-sandbox'
import {
  type SandboxBackup,
  type SandboxBackupOptions,
  SandboxBackupUnavailableError,
  type SandboxExecOptions,
  type SandboxExecResult,
  SandboxInterruptedError,
  type SandboxLogEvent,
  type SandboxPort,
  type SandboxProcess,
  SandboxProcessExitedError,
  type SandboxStartOptions,
  type SandboxWaitForPortOptions,
  sessionAllowedHosts,
} from '../ports'
import { backupEgressHosts, backupObjectKeys, workspaceBackupMode } from '../workspace-backup'

/**
 * The SDK's own idle sleep — a backstop for a dead Workflow, well past the idle policy AND the
 * warm window (`SESSION_WARM_KEEP_MINUTES`, `warm.ts`): a config test keeps it longer.
 */
export const SESSION_SANDBOX_SLEEP_AFTER = '90m'

/** One attempt at booting the container and applying the allow-list. */
export const START_ATTEMPT_MS = 100_000
/** Attempts before `start` gives up; a reset (`destroy`) runs between them. */
export const START_ATTEMPTS = 2
/** How long the reset between two start attempts may take. */
const START_RESET_MS = 30_000

/** One start attempt that did not answer in time. */
export class SandboxStartTimeoutError extends Error {
  constructor(ms: number) {
    super(`The session container did not start within ${Math.round(ms / 1000)} s`)
    this.name = 'SandboxStartTimeoutError'
  }
}

/** `work`, or a {@link SandboxStartTimeoutError} after `ms` (the work itself cannot be cancelled). */
async function attempt<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = work()
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SandboxStartTimeoutError(ms)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
    promise.catch(() => {})
  }
}

/** Default command timeout when a caller gives none (`pnpm install` on a cold store is ~20 s). */
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000

export interface CloudflareSandboxOptions {
  cfg: AppConfig
  /** `BACKUP_BUCKET` — where the SDK keeps workspace backups; what `deleteBackup` deletes from. */
  backupBucket?: R2Bucket
  /** Tests: a shorter {@link START_ATTEMPT_MS}. */
  startAttemptMs?: number
}

/** Quote one argument for `bash -c '…'`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Every command and process starts with core dumps OFF (`RLIMIT_CORE` 0, inherited by everything
 * it runs). A process that crashed under amd64 emulation on an ARM Mac left a 5.8 GB `core` and a
 * 5.7 GB `qemu_<prog>_<date>_<pid>.core` in the checkout (QEMU user mode writes the guest's core
 * itself, and only when `RLIMIT_CORE` allows it; `setrlimit(RLIMIT_CORE)` passes through to the
 * host process). The image cannot set a limit — Docker's `--ulimit` is a run option the platform
 * owns — so it is set here, where every command enters.
 */
export const NO_CORE_DUMPS = 'ulimit -c 0 2>/dev/null'

/**
 * `command` wrapped so an `exit` in it ends a subshell, never the sandbox's session shell — and
 * with core dumps off ({@link NO_CORE_DUMPS}).
 */
export function inSubshell(command: string): string {
  return `bash -c ${shellQuote(`${NO_CORE_DUMPS}\n${command}`)}`
}

/** `waitForPort`'s script exits with this when the `pidFile` process is gone. */
export const PROCESS_EXITED_CODE = 3

const waitSeconds = (opts: SandboxWaitForPortOptions) =>
  Math.max(1, Math.ceil((opts.timeoutMs ?? 120_000) / 1000))

/**
 * The port poller: the SDK waits on a PROCESS, so a port is waited for with a tiny loop of its own
 * (a dev server started by an earlier step, or a resumed one, can be waited on too). With
 * `pidFile` it also checks, every half second, that the process which should open the port is
 * alive — a dev server that crashed fails the wait at once instead of after `timeoutMs`.
 */
export function waitForPortScript(port: number, opts: SandboxWaitForPortOptions = {}): string {
  const url = `http://127.0.0.1:${port}${opts.path ?? '/'}`
  const probe = opts.path
    ? `code=$(curl -s -o /dev/null -w "%{http_code}" -m 2 ${shellQuote(url)}); [ "\${code:0:1}" = "2" ]`
    : `curl -s -o /dev/null -m 2 ${shellQuote(url)}`
  const alive = opts.pidFile
    ? `pid=$(cat ${shellQuote(opts.pidFile)} 2>/dev/null); if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then exit ${PROCESS_EXITED_CODE}; fi; `
    : ''
  return `for i in $(seq 1 ${waitSeconds(opts) * 2}); do if ${probe}; then exit 0; fi; ${alive}sleep 0.5; done; exit 1`
}

const INTERRUPTED_NAMES = new Set(['OperationInterruptedError', 'SessionTerminatedError'])
const INTERRUPTED_MESSAGE =
  /interrupted while the platform|updating the sandbox runtime|runtime_replaced|container stopped while/i

/** The SDK's "the container went away under you" errors, as `SandboxInterruptedError`. */
export function mapSandboxError(err: unknown): unknown {
  if (err instanceof SandboxInterruptedError) return err
  const name = err instanceof Error ? err.name : ''
  const message = err instanceof Error ? err.message : String(err)
  if (INTERRUPTED_NAMES.has(name) || INTERRUPTED_MESSAGE.test(message)) {
    return new SandboxInterruptedError(message)
  }
  return err
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    throw mapSandboxError(err)
  }
}

interface RawLogEvent {
  type?: string
  data?: string
  exitCode?: number | null
}

/**
 * The SDK's process-log SSE stream (`data: <LogEvent JSON>` frames, blank-line separated) as
 * `SandboxLogEvent`s: `stdout` / `stderr` chunks in order, then ONE `exit`. An `error` frame is
 * the process failing to run — reported as exit 1 with its message on stderr.
 *
 * `signal` stops the read HERE, by cancelling the reader: it never crosses into the SDK, whose stub
 * is an RPC proxy that cannot serialise an `AbortSignal` (workerd's DataCloneError).
 */
export async function* parseLogStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncIterable<SandboxLogEvent> {
  const reader = stream.getReader()
  const onAbort = () => {
    reader.cancel().catch(() => {})
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const decoder = new TextDecoder()
  let buffer = ''
  let exited = false
  const toEvents = (frame: string): SandboxLogEvent[] => {
    const data = frame
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) return []
    let event: RawLogEvent
    try {
      event = JSON.parse(data) as RawLogEvent
    } catch {
      return []
    }
    if (event.type === 'stdout' || event.type === 'stderr') {
      return event.data ? [{ type: event.type, data: event.data }] : []
    }
    if (event.type === 'exit') return [{ type: 'exit', exitCode: event.exitCode ?? 0 }]
    if (event.type === 'error') {
      return [
        { type: 'stderr', data: event.data ?? 'the process failed' },
        { type: 'exit', exitCode: 1 },
      ]
    }
    return []
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (signal?.aborted) return
      if (value) buffer += decoder.decode(value, { stream: true })
      let at = buffer.indexOf('\n\n')
      while (at >= 0) {
        for (const event of toEvents(buffer.slice(0, at))) {
          if (exited) break
          if (event.type === 'exit') exited = true
          yield event
        }
        buffer = buffer.slice(at + 2)
        at = buffer.indexOf('\n\n')
      }
      if (done) break
    }
    for (const event of toEvents(buffer)) {
      if (exited) break
      if (event.type === 'exit') exited = true
      yield event
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

export class CloudflareSandbox implements SandboxPort {
  constructor(
    private readonly ns: DurableObjectNamespace<SessionSandbox>,
    readonly name: string,
    readonly opts: CloudflareSandboxOptions
  ) {}

  /** `ctx.containerId` in the outbound handlers: the Durable Object id of `getSandbox(ns, name)`. */
  get id(): string {
    return this.ns.idFromName(this.name).toString()
  }

  private get sandbox() {
    return getSandbox(this.ns, this.name, { sleepAfter: SESSION_SANDBOX_SLEEP_AFTER })
  }

  async start(opts: SandboxStartOptions = {}): Promise<void> {
    const hosts = sessionAllowedHosts(opts.extraAllowedHosts)
    const attemptMs = this.opts.startAttemptMs ?? START_ATTEMPT_MS
    await mapped(async () => {
      for (let n = 1; ; n++) {
        try {
          await attempt(attemptMs, async () => {
            // The first command boots the container; `true` is the cheapest one. It boots under
            // the class's own allow-list (the base hosts, `SessionSandbox.allowedHosts`) or this
            // session's previous one, and nothing of ours runs in it before the next line.
            const probe = await this.sandbox.exec('true')
            if (probe.exitCode !== 0) throw new Error('The session container did not start')
            await this.sandbox.setAllowedHosts(hosts)
          })
          return
        } catch (err) {
          if (!(err instanceof SandboxStartTimeoutError) || n >= START_ATTEMPTS) throw err
          // A start that never answers (seen right after a destroy): drop whatever the Durable
          // Object still holds about the old container, then try once more.
          await attempt(START_RESET_MS, () => this.sandbox.destroy()).catch(() => {})
        }
      }
    })
  }

  exec(command: string, opts: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    return mapped(async () => {
      const result = await this.sandbox.exec(inSubshell(command), {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      })
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    })
  }

  startProcess(command: string, opts: SandboxExecOptions = {}): Promise<SandboxProcess> {
    return mapped(async () => {
      const proc = await this.sandbox.startProcess(inSubshell(command), {
        cwd: opts.cwd,
        env: opts.env,
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
        // Keep the record after exit, so a stream that attaches late still sees the `exit`.
        autoCleanup: false,
      })
      return { id: proc.id }
    })
  }

  async *streamLogs(
    processId: string,
    opts: { signal?: AbortSignal } = {}
  ): AsyncIterable<SandboxLogEvent> {
    let stream: ReadableStream<Uint8Array>
    try {
      // No `signal` here: the stub is RPC and cannot carry one. `parseLogStream` honours it.
      stream = await this.sandbox.streamProcessLogs(processId)
    } catch (err) {
      throw mapSandboxError(err)
    }
    try {
      yield* parseLogStream(stream, opts.signal)
    } catch (err) {
      if (opts.signal?.aborted) return
      throw mapSandboxError(err)
    }
  }

  kill(processId: string, signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' = 'SIGTERM'): Promise<void> {
    return mapped(() => this.sandbox.killProcess(processId, signal))
  }

  async waitForPort(port: number, opts: SandboxWaitForPortOptions = {}): Promise<void> {
    const result = await this.exec(waitForPortScript(port, opts), {
      timeoutMs: (waitSeconds(opts) + 30) * 1000,
    })
    if (result.exitCode === PROCESS_EXITED_CODE) {
      throw new SandboxProcessExitedError(
        `The process that should open port ${port} exited before it answered`
      )
    }
    if (result.exitCode !== 0) {
      throw new Error(`Port ${port}${opts.path ?? ''} did not answer within ${waitSeconds(opts)}s`)
    }
  }

  writeFile(path: string, content: string): Promise<void> {
    return mapped(async () => {
      const dir = path.slice(0, path.lastIndexOf('/'))
      if (dir) await this.sandbox.mkdir(dir, { recursive: true })
      await this.sandbox.writeFile(path, content)
    })
  }

  readFile(path: string): Promise<string | null> {
    return mapped(async () => {
      const exists = await this.sandbox.exists(path)
      if (!exists.exists) return null
      const file = await this.sandbox.readFile(path)
      return file.content
    })
  }

  setAllowedHosts(hosts: readonly string[]): Promise<void> {
    return mapped(() => this.sandbox.setAllowedHosts([...hosts]))
  }

  fetch(port: number, req: Request): Promise<Response> {
    // A WebSocket upgrade (Vite HMR) cannot cross `containerFetch` — an RPC, which carries no
    // socket. `wsConnect` sends it through the Durable Object's own `fetch`, which upgrades.
    if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.sandbox.wsConnect(req, port)
    }
    return this.sandbox.containerFetch(req, port)
  }

  async destroy(): Promise<void> {
    try {
      await this.sandbox.destroy()
    } catch (err) {
      // Already gone is success: destroy is called on every end AND every failure (S7 finding 9).
      const mappedErr = mapSandboxError(err)
      if (mappedErr instanceof SandboxInterruptedError) return
      throw mappedErr
    }
  }

  // ---- workspace backups (`workspace-backup.ts`) ----------------------------------------------

  get backupHosts(): readonly string[] {
    return backupEgressHosts(this.opts.cfg)
  }

  async backup(opts: SandboxBackupOptions): Promise<SandboxBackup> {
    const mode = workspaceBackupMode(this.opts.cfg)
    if (mode === 'off' || !this.opts.backupBucket) throw new SandboxBackupUnavailableError()
    return mapped(async () => {
      const handle = await this.sandbox.createBackup({
        dir: opts.dir,
        ttl: opts.ttlSeconds,
        ...(opts.name ? { name: opts.name } : {}),
        // node_modules and .dev.vars are git-ignored and are the point of the backup.
        gitignore: false,
        ...(mode === 'binding' ? { localBucket: true } : {}),
      })
      return {
        id: handle.id,
        dir: handle.dir,
        ...(handle.localBucket ? { localBucket: true } : {}),
      }
    })
  }

  async restore(backup: SandboxBackup): Promise<void> {
    if (!this.opts.backupBucket) throw new SandboxBackupUnavailableError()
    await mapped(async () => {
      const result = await this.sandbox.restoreBackup({
        id: backup.id,
        dir: backup.dir,
        ...(backup.localBucket ? { localBucket: true } : {}),
      })
      if (!result.success) throw new Error(`The backup ${backup.id} could not be restored`)
    })
  }

  async deleteBackup(backup: SandboxBackup): Promise<void> {
    await this.opts.backupBucket?.delete(backupObjectKeys(backup.id))
  }
}
