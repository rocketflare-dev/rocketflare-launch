/**
 * `RemoteSandbox` — the `SandboxPort` over the sandbox host Worker (`SESSION_SANDBOX_HOST=remote`,
 * development only): a laptop's `wrangler dev` reaches a REAL Cloudflare container through a
 * remote service binding (`SANDBOX_HOST`) instead of running one on local Docker under amd64
 * emulation (`docs/SESSIONS-LOCAL.md` § Real containers from a laptop).
 *
 * On the other side of the binding the host runs `CloudflareSandbox` — the same adapter Launch
 * uses in-process — so the SDK is driven identically; this class only moves calls across:
 *
 * - **Every answer is a `HostResult`**, and a failure comes back as `{ name, message }` and is
 *   rebuilt here as the port's own error class, because an exception crossing a remote binding
 *   keeps its message but not reliably its name — and the steps branch on the name
 *   (`SandboxInterruptedError` → a rollout).
 * - **No `AbortSignal` crosses** (workerd: `DataCloneError`). `streamLogs` fetches the SDK's raw
 *   SSE stream (`logStream`; a `ReadableStream` crosses RPC) and parses it HERE with
 *   `parseLogStream`, which honours the signal by cancelling the reader on this side.
 * - **The preview** (`fetch`) is the binding's `fetch`, not RPC — the one path that can carry a
 *   WebSocket upgrade (Vite HMR) — naming the sandbox and port in two headers the host strips.
 * - **`id` is `remote:<name>`** (`remoteSandboxId`): a Durable Object id depends on its namespace,
 *   which this side cannot compute for the host's class.
 * - **Backups are off** (`backupHosts` is empty and the host has no `BACKUP_BUCKET`): a cold resume
 *   clones and installs, which is cheap on native hardware.
 */
import {
  type HostResult,
  PREVIEW_HEADERS,
  remoteSandboxId,
  type SandboxHostBinding,
} from '../sandbox-host/protocol'
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
} from '../sandbox-port'
import { parseLogStream, SandboxStartTimeoutError } from './cloudflare-sandbox'

/** A failure the host reported, as the port's own error class where it has one. */
export function hostError(error: { name: string; message: string }): Error {
  switch (error.name) {
    case 'SandboxInterruptedError':
      return new SandboxInterruptedError(error.message)
    case 'SandboxProcessExitedError':
      return new SandboxProcessExitedError(error.message)
    case 'SandboxBackupUnavailableError':
      return new SandboxBackupUnavailableError(error.message)
    case 'SandboxStartTimeoutError': {
      const err = new SandboxStartTimeoutError(0)
      err.message = error.message
      return err
    }
    default: {
      const err = new Error(error.message)
      err.name = error.name || 'Error'
      return err
    }
  }
}

/** The value of a host answer, or its error thrown as the port's class. */
export async function unwrap<T>(call: Promise<HostResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw hostError(result.error)
  return result.value
}

export class RemoteSandbox implements SandboxPort {
  readonly backupHosts: readonly string[] = []

  constructor(
    private readonly host: SandboxHostBinding,
    readonly name: string
  ) {}

  get id(): string {
    return remoteSandboxId(this.name)
  }

  async start(opts: SandboxStartOptions = {}): Promise<void> {
    await unwrap(this.host.start(this.name, opts))
  }

  exec(command: string, opts: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    return unwrap(this.host.exec(this.name, command, opts))
  }

  startProcess(command: string, opts: SandboxExecOptions = {}): Promise<SandboxProcess> {
    return unwrap(this.host.startProcess(this.name, command, opts))
  }

  async *streamLogs(
    processId: string,
    opts: { signal?: AbortSignal } = {}
  ): AsyncIterable<SandboxLogEvent> {
    // The signal stays on THIS side: it cancels our reader, which cancels the stream's source.
    const stream = await unwrap(this.host.logStream(this.name, processId))
    try {
      yield* parseLogStream(stream, opts.signal)
    } catch (err) {
      if (opts.signal?.aborted) return
      throw err
    }
  }

  async kill(processId: string, signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' = 'SIGTERM') {
    await unwrap(this.host.kill(this.name, processId, signal))
  }

  async waitForPort(port: number, opts: SandboxWaitForPortOptions = {}): Promise<void> {
    await unwrap(this.host.waitForPort(this.name, port, opts))
  }

  async writeFile(path: string, content: string): Promise<void> {
    await unwrap(this.host.writeFile(this.name, path, content))
  }

  readFile(path: string): Promise<string | null> {
    return unwrap(this.host.readFile(this.name, path))
  }

  async setAllowedHosts(hosts: readonly string[]): Promise<void> {
    await unwrap(this.host.setAllowedHosts(this.name, [...hosts]))
  }

  fetch(port: number, req: Request): Promise<Response> {
    const headers = new Headers(req.headers)
    headers.set(PREVIEW_HEADERS.sandbox, this.name)
    headers.set(PREVIEW_HEADERS.port, String(port))
    return this.host.fetch(new Request(req, { headers }))
  }

  async destroy(): Promise<void> {
    await unwrap(this.host.destroy(this.name))
  }

  backup(opts: SandboxBackupOptions): Promise<SandboxBackup> {
    return unwrap(this.host.backup(this.name, opts))
  }

  async restore(backup: SandboxBackup): Promise<void> {
    await unwrap(this.host.restore(this.name, backup))
  }

  async deleteBackup(backup: SandboxBackup): Promise<void> {
    await unwrap(this.host.deleteBackup(this.name, backup))
  }
}
