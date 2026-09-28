/**
 * FakeSandbox — an in-memory `SandboxPort` (Launch P3, `services/sessions/ports.ts`): what every
 * session test hands the Workflow, the turn runner and the preview gateway instead of a container.
 * Nothing runs; commands are SCRIPTED by regex, and everything done to the sandbox is recorded.
 *
 * ```ts
 * const sandbox = new FakeSandbox({ name: session.id })
 *   .onExec(/git clone/, { exitCode: 0 })
 *   .onExec(/pnpm install/, (cmd) => ({ stdout: 'done' }))
 *   .onProcess(/pnpm dev/, { lines: ['ready'], ports: [5173, 8787], hang: true })
 *   .onProcess(/claude -p/, claudeStreamJson({ text: 'Done.' }))   // tests/helpers/fake-anthropic.ts
 *   .onPort(5173, req => new Response('<h1>app</h1>', { headers: { 'content-type': 'text/html' } }))
 * ```
 *
 * - `onExec(match, result | fn)` — the first matching script answers `exec` (`{ exitCode: 0,
 *   stdout: '', stderr: '' }` filled in); an unscripted command succeeds with no output. `match` is a
 *   RegExp or a substring.
 * - `onProcess(match, lines[] | { lines, exitCode?, hang?, ports? })` — what a background process
 *   prints: `streamLogs` yields each line as one `stdout` chunk (`line + '\n'`), then `exit`
 *   (`exitCode`, default 0). `hang: true` keeps it running after the lines until `kill` (exit 137)
 *   — a dev server, or a turn a test cancels. `ports` open when the process starts.
 * - `onPort(port, handler)` / `openPort(port)` — a port `waitForPort` finds and `fetch(port, req)`
 *   answers (a closed port: `waitForPort` rejects, `fetch` is a 502).
 * - `interruptNext()` — a ROLLOUT: the next `exec` throws `SandboxInterruptedError`, or the next
 *   `streamLogs` yields its first chunk and then throws it. The container is gone afterwards, so
 *   files, ports and processes are wiped (`interruptions` counts them) — resume must clone again.
 * - `failNext(method, error)` — the next call of `method` throws `error` once.
 * - `hangNext(method)` — the next call of `method` never answers (a stuck Durable Object RPC): what
 *   the steps' deadlines (`services/sessions/deadline.ts`) are for.
 * - `recreate()` — the container died and came back EMPTY (Docker's OOM killer on a laptop): files,
 *   ports and processes are gone, no error is thrown. The boot marker check is what notices.
 * - `waitForPort(port, { pidFile })` rejects with `SandboxProcessExitedError` when the port is closed
 *   and no hanging process is alive (a dev server that exited).
 * - `backup({ dir })` snapshots the files under `dir` (kept in `backups` by id — they survive
 *   `destroy` and `recreate`, as R2 would), `restore(handle)` puts them back (`restores`),
 *   `deleteBackup` forgets one (`deletedBackups`); `backupHosts` is settable (`presigned` mode).
 *   `backupsOff()` makes `backup` throw `SandboxBackupUnavailableError`.
 *
 * Inspect: `execs` (`{ command, opts, result }`), `processes` (`{ id, command, opts, killed,
 * exitCode }`), `killed` (process ids, in order), `files` (path → text), `ports`, `allowedHosts`,
 * `started` / `startCount`, `destroyed` / `destroyCount`, `fetches` (`{ port, url, method }`).
 */
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
  SESSION_BASE_ALLOWED_HOSTS,
} from '@/api/services/sessions/ports'

export type Match = RegExp | string

export type ExecScript =
  | Partial<SandboxExecResult>
  | ((
      command: string,
      opts?: SandboxExecOptions
    ) => Partial<SandboxExecResult> | Promise<Partial<SandboxExecResult>>)

export interface ProcessScript {
  lines: readonly string[]
  exitCode?: number
  /** Keep running after the lines until killed (then exit 137). */
  hang?: boolean
  /** Ports that open when the process starts (a dev server). */
  ports?: readonly number[]
}

export interface FakeProcessRecord {
  id: string
  command: string
  opts?: SandboxExecOptions
  script: ProcessScript
  killed: boolean
  exitCode: number | null
}

type PortHandler = (req: Request) => Response | Promise<Response>

type Method =
  | 'start'
  | 'exec'
  | 'startProcess'
  | 'streamLogs'
  | 'kill'
  | 'waitForPort'
  | 'writeFile'
  | 'readFile'
  | 'setAllowedHosts'
  | 'fetch'
  | 'destroy'
  | 'backup'
  | 'restore'

const matches = (m: Match, text: string) =>
  typeof m === 'string' ? text.includes(m) : m.test(text)

export class FakeSandbox implements SandboxPort {
  readonly name: string
  readonly id: string
  readonly execs: { command: string; opts?: SandboxExecOptions; result: SandboxExecResult }[] = []
  readonly processes: FakeProcessRecord[] = []
  readonly killed: string[] = []
  readonly files = new Map<string, string>()
  readonly ports = new Map<number, PortHandler | null>()
  readonly fetches: { port: number; url: string; method: string }[] = []
  allowedHosts: string[] = [...SESSION_BASE_ALLOWED_HOSTS]
  started = false
  startCount = 0
  destroyed = false
  destroyCount = 0
  interruptions = 0
  /** Every backup taken, by id: the files under its `dir`, as they were. */
  readonly backups = new Map<string, { dir: string; files: Map<string, string> }>()
  readonly restores: string[] = []
  readonly deletedBackups: string[] = []
  /** The allow-list each backup and restore ran under (the R2 host in `presigned` mode). */
  readonly backupAllowedHosts: string[][] = []
  backupHosts: readonly string[] = []
  private backupsEnabled = true

  private readonly execScripts: { match: Match; script: ExecScript }[] = []
  private readonly processScripts: { match: Match; script: ProcessScript }[] = []
  private readonly failures = new Map<Method, Error>()
  private readonly hangs = new Set<Method>()
  recreations = 0
  private readonly killWaiters = new Map<string, () => void>()
  private interruptArmed = false
  private nextPid = 1

  constructor(opts: { name?: string; id?: string } = {}) {
    this.name = opts.name ?? crypto.randomUUID()
    this.id = opts.id ?? `fake-sandbox-${this.name}`
  }

  // ---- scripting -------------------------------------------------------------------------------

  onExec(match: Match, script: ExecScript): this {
    this.execScripts.push({ match, script })
    return this
  }

  onProcess(match: Match, script: readonly string[] | ProcessScript): this {
    this.processScripts.push({
      match,
      script: Array.isArray(script)
        ? { lines: script as readonly string[] }
        : (script as ProcessScript),
    })
    return this
  }

  onPort(port: number, handler: PortHandler): this {
    this.ports.set(port, handler)
    return this
  }

  openPort(port: number): this {
    if (!this.ports.has(port)) this.ports.set(port, null)
    return this
  }

  interruptNext(): this {
    this.interruptArmed = true
    return this
  }

  failNext(method: Method, error: Error): this {
    this.failures.set(method, error)
    return this
  }

  hangNext(method: Method): this {
    this.hangs.add(method)
    return this
  }

  backupsOff(): this {
    this.backupsEnabled = false
    return this
  }

  /** The container died and came back empty — see the header. */
  recreate(): this {
    this.recreations++
    this.files.clear()
    this.ports.clear()
    for (const p of this.processes) {
      if (p.exitCode === null) {
        p.exitCode = -1
        this.killWaiters.get(p.id)?.()
      }
    }
    return this
  }

  // ---- SandboxPort -----------------------------------------------------------------------------

  private async guard(method: Method): Promise<void> {
    if (this.hangs.has(method)) {
      this.hangs.delete(method)
      await new Promise<never>(() => {})
    }
    const failure = this.failures.get(method)
    if (failure) {
      this.failures.delete(method)
      throw failure
    }
  }

  /** The platform replaced the container: everything in it is gone. */
  private interrupt(): never {
    this.interruptArmed = false
    this.interruptions++
    this.files.clear()
    this.ports.clear()
    for (const p of this.processes) if (p.exitCode === null) p.exitCode = -1
    for (const wake of this.killWaiters.values()) wake()
    throw new SandboxInterruptedError()
  }

  async start(opts: SandboxStartOptions = {}): Promise<void> {
    await this.guard('start')
    this.started = true
    this.destroyed = false
    this.startCount++
    if (opts.extraAllowedHosts?.length) {
      this.allowedHosts = [...new Set([...this.allowedHosts, ...opts.extraAllowedHosts])]
    }
  }

  async exec(command: string, opts?: SandboxExecOptions): Promise<SandboxExecResult> {
    await this.guard('exec')
    if (this.interruptArmed) this.interrupt()
    const script = this.execScripts.find(s => matches(s.match, command))?.script
    const partial = typeof script === 'function' ? await script(command, opts) : (script ?? {})
    const result: SandboxExecResult = { exitCode: 0, stdout: '', stderr: '', ...partial }
    this.execs.push({ command, opts, result })
    return result
  }

  async startProcess(command: string, opts?: SandboxExecOptions): Promise<SandboxProcess> {
    await this.guard('startProcess')
    const script = this.processScripts.find(s => matches(s.match, command))?.script ?? { lines: [] }
    const id = `proc-${this.nextPid++}`
    this.processes.push({ id, command, opts, script, killed: false, exitCode: null })
    for (const port of script.ports ?? []) this.openPort(port)
    return { id }
  }

  async *streamLogs(
    processId: string,
    opts: { signal?: AbortSignal } = {}
  ): AsyncIterable<SandboxLogEvent> {
    await this.guard('streamLogs')
    const proc = this.processes.find(p => p.id === processId)
    if (!proc) throw new Error(`FakeSandbox: no process ${processId}`)
    const interrupting = this.interruptArmed
    let first = true
    for (const line of proc.script.lines) {
      if (opts.signal?.aborted || proc.killed) break
      yield { type: 'stdout', data: `${line}\n` }
      if (interrupting && first) this.interrupt()
      first = false
    }
    if (interrupting) this.interrupt()
    if (proc.script.hang && !proc.killed && proc.exitCode === null) {
      await new Promise<void>(resolve => {
        this.killWaiters.set(processId, resolve)
        // An already-aborted reader (a cancel mid-stream) must not wait for an event that fired.
        if (opts.signal?.aborted) resolve()
        else opts.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      this.killWaiters.delete(processId)
      if (opts.signal?.aborted && !proc.killed) return
    }
    if (proc.exitCode === -1) throw new SandboxInterruptedError()
    proc.exitCode ??= proc.killed ? 137 : (proc.script.exitCode ?? 0)
    yield { type: 'exit', exitCode: proc.exitCode }
  }

  async kill(processId: string): Promise<void> {
    await this.guard('kill')
    const proc = this.processes.find(p => p.id === processId)
    if (!proc) return
    proc.killed = true
    this.killed.push(processId)
    this.killWaiters.get(processId)?.()
  }

  async waitForPort(port: number, opts: SandboxWaitForPortOptions = {}): Promise<void> {
    await this.guard('waitForPort')
    const alive = this.processes.some(p => p.script.hang && !p.killed && p.exitCode === null)
    if (!this.ports.has(port) && opts.pidFile && !alive) {
      throw new SandboxProcessExitedError(
        `The process that should open port ${port} exited before it answered`
      )
    }
    if (!this.ports.has(port)) {
      throw new Error(
        `FakeSandbox: port ${port} never opened (timeout ${opts.timeoutMs ?? 'default'})`
      )
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.guard('writeFile')
    this.files.set(path, content)
  }

  async readFile(path: string): Promise<string | null> {
    await this.guard('readFile')
    return this.files.get(path) ?? null
  }

  async setAllowedHosts(hosts: readonly string[]): Promise<void> {
    await this.guard('setAllowedHosts')
    this.allowedHosts = [...hosts]
  }

  async fetch(port: number, req: Request): Promise<Response> {
    await this.guard('fetch')
    this.fetches.push({ port, url: req.url, method: req.method })
    if (!this.ports.has(port))
      return new Response(`FakeSandbox: port ${port} is closed`, { status: 502 })
    const handler = this.ports.get(port)
    return handler ? handler(req) : new Response('ok', { status: 200 })
  }

  async backup(opts: SandboxBackupOptions): Promise<SandboxBackup> {
    await this.guard('backup')
    if (!this.backupsEnabled) throw new SandboxBackupUnavailableError()
    this.backupAllowedHosts.push([...this.allowedHosts])
    const id = crypto.randomUUID()
    const files = new Map<string, string>()
    for (const [path, content] of this.files) {
      if (path === opts.dir || path.startsWith(`${opts.dir}/`)) files.set(path, content)
    }
    this.backups.set(id, { dir: opts.dir, files })
    return { id, dir: opts.dir, localBucket: true }
  }

  async restore(backup: SandboxBackup): Promise<void> {
    await this.guard('restore')
    const saved = this.backups.get(backup.id)
    if (!saved) throw new Error(`FakeSandbox: no backup ${backup.id}`)
    this.backupAllowedHosts.push([...this.allowedHosts])
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(`${backup.dir}/`)) this.files.delete(path)
    }
    for (const [path, content] of saved.files) this.files.set(path, content)
    this.restores.push(backup.id)
  }

  async deleteBackup(backup: SandboxBackup): Promise<void> {
    this.backups.delete(backup.id)
    this.deletedBackups.push(backup.id)
  }

  async destroy(): Promise<void> {
    await this.guard('destroy')
    this.destroyed = true
    this.started = false
    this.destroyCount++
    this.files.clear()
    this.ports.clear()
    for (const p of this.processes) {
      if (p.exitCode === null) {
        p.killed = true
        this.killWaiters.get(p.id)?.()
      }
    }
  }
}
