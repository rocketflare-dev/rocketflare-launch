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
 * - `onProcess(match, lines[] | { lines, exitCode?, hang?, ports?, waitForFile?, thenLines? })` —
 *   what a background process prints (or `fn(command)`, the script for each start — a turn that
 *   answers differently the second time): `streamLogs` yields each line as one `stdout` chunk
 *   (`line + '\n'`), then `exit` (`exitCode`, default 0). `hang: true` keeps it running after the
 *   lines until `kill` (exit 137) — a dev server, or a turn a test cancels. `ports` open when the
 *   process starts. `waitForFile` (§18.22) blocks after `lines` until that path is written, then
 *   prints `thenLines` — a CLI waiting on input (the login relay's `in` file).
 * - `onPort(port, handler)` / `openPort(port)` — a port `waitForPort` finds and `fetch(port, req)`
 *   answers (a closed port: `waitForPort` rejects, `fetch` is a 502).
 * - `onBackground(match, script | fn)` — a long command run through `runInBackground`
 *   (`services/sessions/background-command.ts`: the install, the kit bootstrap). The fake speaks its
 *   file protocol: the run's `<name>.pid` / `.log` / `.exit` live in `files`, `kill -0 <pid>` answers
 *   from the run, and the group kill ends it (exit 143). A script object is `{ log?, exitCode?, hang? }`:
 *   `log` as an ARRAY reveals one more chunk at each read of the log file, and the exit file is
 *   written once the last chunk has been read (deterministic progress, no timers); `hang` never
 *   ends on its own — `finishBackground(name, …)` or the kill ends it. A function
 *   `(command, opts) => { log?, stdout?, stderr?, exitCode? }` (sync or async) ends the run when it
 *   returns; throwing synchronously makes `startProcess` throw, rejecting later is a runner that
 *   died without an exit code. An unscripted background command succeeds with an empty log. Runs
 *   are recorded in `backgroundRuns`, NOT in `processes`.
 * - `interruptNext()` — a ROLLOUT: the next `exec` throws `SandboxInterruptedError`, or the next
 *   `streamLogs` yields its first chunk and then throws it. The container is gone afterwards, so
 *   files, ports and processes are wiped (`interruptions` counts them) — resume must clone again.
 * - `failNext(method, error)` — the next call of `method` throws `error` once.
 * - `dropStreamNext({ after?, process?, error? })` — the next `streamLogs` yields `after` chunks
 *   (default 0), then its connection drops (throws `error`, default "Network connection lost").
 *   The process itself: `running` (default) runs on, `exited` ran to its end while nobody read,
 *   `vanished` is gone with its record (a re-attach throws). Each call queues one more drop;
 *   `streamDrops` counts them. Like the SDK (0.12.10), every `streamLogs` replays the process's
 *   output from its FIRST line, and an ended process replays it and its `exit` — and the turn's
 *   liveness question (`turnAliveScript`) is answered from the latest turn process: `alive` while
 *   it runs, else `exited` (a script matching it wins).
 * - `hangNext(method)` — the next call of `method` never answers (a stuck Durable Object RPC): what
 *   the steps' deadlines (`services/sessions/deadline.ts`) are for.
 * - `recreate()` — the container died and came back EMPTY (Docker's OOM killer on a laptop): files,
 *   ports and processes are gone, no error is thrown. The boot marker check is what notices.
 * - `die()` — the container died under a running process the way it does DEPLOYED (session
 *   d9124cbb, out of memory in a `pnpm build`): the process's log stream neither errors nor ends —
 *   it goes QUIET until the reader aborts — and whatever calls in next finds a fresh, EMPTY
 *   container (files, ports and background runs gone, no boot marker). `deaths` counts them.
 * - `waitForPort(port, { pidFile })` rejects with `SandboxProcessExitedError` when the port is closed
 *   and no hanging process is alive (a dev server that exited). `followedBy` probes are checked after
 *   `port`, in order; every call is recorded in `portWaits`.
 * - `backup({ dir, excludes? })` snapshots the files under `dir`, less `excludes` (kept in
 *   `backups` by id — they survive `destroy` and `recreate`, as R2 would, and the map is shared
 *   between sandboxes when the constructor is given one), `restore(handle)` puts them back (`restores`),
 *   `deleteBackup` forgets one (`deletedBackups`); `backupHosts` is settable (`presigned` mode).
 *   `backupsOff()` makes `backup` throw `SandboxBackupUnavailableError`.
 *
 * Inspect: `commands` (every `exec` and `startProcess` command, in order), `execs` (`{ command,
 * opts, result }`), `backgroundRuns` (`{ name, command, opts, pid, runId, exitCode, killed }`), `processes` (`{ id, command, opts, killed,
 * exitCode }`), `killed` (process ids, in order), `files` (path → text), `binaryFiles` (path →
 * bytes, `writeFileBytes`), `ports`, `allowedHosts`,
 * `started` / `startCount`, `destroyed` / `destroyCount`, `fetches` (`{ port, url, method }`).
 */
import {
  BACKGROUND_MARKER,
  parseBackgroundRunner,
} from '@/api/services/sessions/background-command'
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
import { TURN_PID_FILE, turnAliveScript } from '@/api/services/sessions/runtimes/process/kill'

export type Match = RegExp | string

export type ExecScript =
  | Partial<SandboxExecResult>
  | ((
      command: string,
      opts?: SandboxExecOptions
    ) => Partial<SandboxExecResult> | Promise<Partial<SandboxExecResult>>)

export interface ProcessScript {
  lines: readonly string[]
  /**
   * §18.22: after `lines`, wait until this file is written (`writeFile`) — a CLI blocked on input,
   * like a login relay tailing its `in` file — then print `thenLines`. A kill or an aborted reader
   * ends the wait.
   */
  waitForFile?: string
  /** Printed once `waitForFile` exists. */
  thenLines?: readonly string[]
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
  /** Its container died under it (`die()`): its stream goes quiet, a kill reaches nothing. */
  silenced?: boolean
  /** Gone with its record (`dropStreamNext({ process: 'vanished' })`): nothing to attach to. */
  vanished?: boolean
}

/** One scripted log-stream drop (`dropStreamNext`). */
export interface StreamDrop {
  /** Chunks the stream yields before it drops. */
  after?: number
  /** What the process does meanwhile (default `running`). */
  process?: 'running' | 'exited' | 'vanished'
  error?: Error
}

export interface BackgroundScript {
  /** What it prints: one string, or chunks revealed one per read of the log (see the header). */
  log?: string | readonly string[]
  exitCode?: number
  /** Never ends on its own: `finishBackground` or a kill ends it. */
  hang?: boolean
}

export type BackgroundScriptFn = (
  command: string,
  opts?: SandboxExecOptions
) =>
  | (Omit<BackgroundScript, 'hang'> & { stdout?: string; stderr?: string })
  | Promise<Omit<BackgroundScript, 'hang'> & { stdout?: string; stderr?: string }>

export interface FakeBackgroundRun {
  /** `install`, `bootstrap` — the file name under the run's directory. */
  name: string
  /** `<dir>/<name>`. */
  base: string
  /** The whole runner script (it contains the real command). */
  command: string
  opts?: SandboxExecOptions
  pid: number
  runId: string
  exitCode: number | null
  killed: boolean
}

interface LiveRun {
  record: FakeBackgroundRun
  chunks: readonly string[]
  shown: number
  finalExit: number | null
}

type PortHandler = (req: Request) => Response | Promise<Response>

/** One stored backup: the directory and the files under it (minus `excludes`), as they were. */
export interface FakeBackup {
  dir: string
  files: Map<string, string>
}

type Method =
  | 'start'
  | 'exec'
  | 'startProcess'
  | 'streamLogs'
  | 'kill'
  | 'waitForPort'
  | 'writeFile'
  | 'writeFileBytes'
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
  readonly backgroundRuns: FakeBackgroundRun[] = []
  /** Every `exec` and `startProcess` command, in the order they were called. */
  readonly commands: string[] = []
  readonly killed: string[] = []
  readonly files = new Map<string, string>()
  /** What `writeFileBytes` wrote (an image), path → bytes. */
  readonly binaryFiles = new Map<string, Uint8Array>()
  readonly ports = new Map<number, PortHandler | null>()
  readonly fetches: { port: number; url: string; method: string }[] = []
  /** Every `waitForPort` call, in order (the dev stack's is ONE call: `:8787`, then `:5173`). */
  readonly portWaits: { port: number; opts: SandboxWaitForPortOptions }[] = []
  allowedHosts: string[] = [...SESSION_BASE_ALLOWED_HOSTS]
  started = false
  startCount = 0
  destroyed = false
  destroyCount = 0
  interruptions = 0
  /** Log streams dropped by `dropStreamNext`. */
  streamDrops = 0
  /**
   * Every backup taken, by id: the files under its `dir`, as they were. Shared between sandboxes
   * when the constructor is handed one (`createFakeSessionPorts` does): R2 is one bucket, so a
   * prebuild one container saved restores into another (issue #16).
   */
  readonly backups: Map<string, FakeBackup>
  readonly restores: string[] = []
  readonly deletedBackups: string[] = []
  /** The allow-list each backup and restore ran under (the R2 host in `presigned` mode). */
  readonly backupAllowedHosts: string[][] = []
  backupHosts: readonly string[] = []
  private backupsEnabled = true

  private readonly execScripts: { match: Match; script: ExecScript }[] = []
  private readonly processScripts: {
    match: Match
    script: ProcessScript | ((command: string) => ProcessScript)
  }[] = []
  private readonly backgroundScripts: {
    match: Match
    script: BackgroundScript | BackgroundScriptFn
  }[] = []
  private readonly liveRuns = new Map<string, LiveRun>()
  private nextBackgroundPid = 4000
  private readonly failures = new Map<Method, Error>()
  private readonly hangs = new Set<Method>()
  recreations = 0
  deaths = 0
  private readonly killWaiters = new Map<string, () => void>()
  private readonly fileWaiters = new Map<string, (() => void)[]>()
  private interruptArmed = false
  private readonly drops: StreamDrop[] = []
  private nextPid = 1

  constructor(opts: { name?: string; id?: string; backups?: Map<string, FakeBackup> } = {}) {
    this.name = opts.name ?? crypto.randomUUID()
    this.id = opts.id ?? `fake-sandbox-${this.name}`
    this.backups = opts.backups ?? new Map()
  }

  // ---- scripting -------------------------------------------------------------------------------

  onExec(match: Match, script: ExecScript): this {
    this.execScripts.push({ match, script })
    return this
  }

  onProcess(
    match: Match,
    script: readonly string[] | ProcessScript | ((command: string) => ProcessScript)
  ): this {
    this.processScripts.push({
      match,
      script: Array.isArray(script)
        ? { lines: script as readonly string[] }
        : (script as ProcessScript | ((command: string) => ProcessScript)),
    })
    return this
  }

  onBackground(match: Match, script: BackgroundScript | BackgroundScriptFn): this {
    this.backgroundScripts.push({ match, script })
    return this
  }

  /** End a live background run by name (the latest with that name), as if it exited. */
  finishBackground(name: string, result: { exitCode?: number; log?: string } = {}): this {
    const run = [...this.liveRuns.values()].reverse().find(r => r.record.name === name)
    if (!run) throw new Error(`FakeSandbox: no live background run ${name}`)
    if (result.log !== undefined) this.files.set(`${run.record.base}.log`, result.log)
    this.endRun(run, result.exitCode ?? 0)
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

  dropStreamNext(drop: StreamDrop = {}): this {
    this.drops.push(drop)
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
    this.liveRuns.clear()
    this.files.clear()
    this.binaryFiles.clear()
    this.ports.clear()
    for (const p of this.processes) {
      if (p.exitCode === null) {
        p.exitCode = -1
        this.killWaiters.get(p.id)?.()
      }
    }
    return this
  }

  /** The container died under its running processes — see the header. */
  die(): this {
    this.deaths++
    this.liveRuns.clear()
    this.files.clear()
    this.binaryFiles.clear()
    this.ports.clear()
    for (const p of this.processes) {
      if (p.exitCode === null) {
        p.silenced = true
        this.killWaiters.get(p.id)?.()
      }
    }
    return this
  }

  /** A dead container's stream: nothing more, ever — until the reader stops reading. */
  private quiet(signal?: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      if (!signal) return
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => resolve(), { once: true })
    })
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
    this.liveRuns.clear()
    this.files.clear()
    this.binaryFiles.clear()
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
    this.commands.push(command)
    const own = this.backgroundControl(command)
    if (own) {
      const result: SandboxExecResult = { exitCode: own.exitCode, stdout: '', stderr: '' }
      this.execs.push({ command, opts, result })
      return result
    }
    const script = this.execScripts.find(s => matches(s.match, command))?.script
    if (!script && command === turnAliveScript()) {
      const result = {
        exitCode: 0,
        stdout: `${this.turnAlive() ? 'alive' : 'exited'}\n`,
        stderr: '',
      }
      this.execs.push({ command, opts, result })
      return result
    }
    const partial = typeof script === 'function' ? await script(command, opts) : (script ?? {})
    const result: SandboxExecResult = { exitCode: 0, stdout: '', stderr: '', ...partial }
    this.execs.push({ command, opts, result })
    return result
  }

  async startProcess(command: string, opts?: SandboxExecOptions): Promise<SandboxProcess> {
    await this.guard('startProcess')
    this.commands.push(command)
    if (command.startsWith(BACKGROUND_MARKER)) return this.startBackground(command, opts)
    const found = this.processScripts.find(s => matches(s.match, command))?.script
    const script = typeof found === 'function' ? found(command) : (found ?? { lines: [] })
    const id = `proc-${this.nextPid++}`
    this.processes.push({ id, command, opts, script, killed: false, exitCode: null })
    for (const port of script.ports ?? []) this.openPort(port)
    return { id }
  }

  /** The latest turn process (its command records `TURN_PID_FILE`) is still running. */
  private turnAlive(): boolean {
    const proc = [...this.processes].reverse().find(p => p.command.includes(TURN_PID_FILE))
    return Boolean(
      proc && proc.exitCode === null && !proc.killed && !proc.silenced && !proc.vanished
    )
  }

  async *streamLogs(
    processId: string,
    opts: { signal?: AbortSignal } = {}
  ): AsyncIterable<SandboxLogEvent> {
    await this.guard('streamLogs')
    const proc = this.processes.find(p => p.id === processId)
    if (!proc || proc.vanished) throw new Error(`FakeSandbox: no process ${processId}`)
    const drop = this.drops.shift()
    if (!drop) return yield* this.replay(proc, opts)
    let shown = 0
    if ((drop.after ?? 0) > 0) {
      for await (const event of this.replay(proc, opts)) {
        yield event
        if (event.type === 'exit') return
        if (++shown >= (drop.after ?? 0)) break
      }
    }
    this.streamDrops++
    if (drop.process === 'exited') proc.exitCode ??= proc.script.exitCode ?? 0
    if (drop.process === 'vanished') proc.vanished = true
    throw drop.error ?? new Error('Network connection lost')
  }

  /** The process's output from its first line (the SDK's replay), then live, then its `exit`. */
  private async *replay(
    proc: FakeProcessRecord,
    opts: { signal?: AbortSignal }
  ): AsyncIterable<SandboxLogEvent> {
    const processId = proc.id
    const interrupting = this.interruptArmed
    let first = true
    for (const line of proc.script.lines) {
      if (proc.silenced) return void (await this.quiet(opts.signal))
      if (opts.signal?.aborted || proc.killed) break
      yield { type: 'stdout', data: `${line}\n` }
      if (interrupting && first) this.interrupt()
      first = false
    }
    if (interrupting) this.interrupt()
    const waitFor = proc.script.waitForFile
    if (waitFor && !proc.killed && !opts.signal?.aborted) {
      if (!this.files.has(waitFor)) {
        await new Promise<void>(resolve => {
          const waiters = this.fileWaiters.get(waitFor) ?? []
          waiters.push(resolve)
          this.fileWaiters.set(waitFor, waiters)
          this.killWaiters.set(processId, resolve)
          opts.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        this.killWaiters.delete(processId)
      }
      if (!proc.killed && !opts.signal?.aborted) {
        for (const line of proc.script.thenLines ?? []) yield { type: 'stdout', data: `${line}\n` }
      }
    }
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
    if (proc.silenced) return void (await this.quiet(opts.signal))
    if (proc.exitCode === -1) throw new SandboxInterruptedError()
    proc.exitCode ??= proc.killed ? 137 : (proc.script.exitCode ?? 0)
    yield { type: 'exit', exitCode: proc.exitCode }
  }

  async kill(processId: string): Promise<void> {
    await this.guard('kill')
    const proc = this.processes.find(p => p.id === processId)
    if (!proc || proc.silenced) return
    proc.killed = true
    this.killed.push(processId)
    this.killWaiters.get(processId)?.()
  }

  async waitForPort(port: number, opts: SandboxWaitForPortOptions = {}): Promise<void> {
    await this.guard('waitForPort')
    this.portWaits.push({ port, opts })
    const alive = this.processes.some(p => p.script.hang && !p.killed && p.exitCode === null)
    // `port`, then each of `then`, in order — the first closed one is what the wait is stuck on.
    for (const probe of [port, ...(opts.followedBy ?? []).map(p => p.port)]) {
      if (!this.ports.has(probe) && opts.pidFile && !alive) {
        throw new SandboxProcessExitedError(
          `The process that should open port ${probe} exited before it answered`
        )
      }
      if (!this.ports.has(probe)) {
        throw new Error(
          `FakeSandbox: port ${probe} never opened (timeout ${opts.timeoutMs ?? 'default'})`
        )
      }
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.guard('writeFile')
    this.files.set(path, content)
    const waiters = this.fileWaiters.get(path)
    if (waiters) {
      this.fileWaiters.delete(path)
      for (const wake of waiters) wake()
    }
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
    await this.guard('writeFileBytes')
    this.binaryFiles.set(path, bytes)
  }

  async readFile(path: string): Promise<string | null> {
    await this.guard('readFile')
    this.revealChunk(path)
    return this.files.get(path) ?? null
  }

  // ---- background runs (`runInBackground`'s file protocol) ---------------------------------------

  private startBackground(command: string, opts?: SandboxExecOptions): SandboxProcess {
    const parsed = parseBackgroundRunner(command)
    if (!parsed) throw new Error('FakeSandbox: an unreadable background runner')
    const { base, runId } = parsed
    const name = base.slice(base.lastIndexOf('/') + 1)
    const found = this.backgroundScripts.find(s => matches(s.match, command))?.script ?? {}
    // A function that throws synchronously: the SDK's `startProcess` failed.
    const outcome = typeof found === 'function' ? found(command, opts) : null
    for (const suffix of ['.exit', '.log', '.pid']) this.files.delete(`${base}${suffix}`)
    const record: FakeBackgroundRun = {
      name,
      base,
      command,
      opts,
      pid: this.nextBackgroundPid++,
      runId,
      exitCode: null,
      killed: false,
    }
    this.backgroundRuns.push(record)
    this.files.set(`${base}.pid`, `${record.pid} ${runId}\n`)
    this.files.set(`${base}.log`, '')
    const run: LiveRun = { record, chunks: [], shown: 0, finalExit: null }
    this.liveRuns.set(runId, run)
    const settle = (
      result: Omit<BackgroundScript, 'hang'> & { stdout?: string; stderr?: string }
    ) => {
      // Killed, or the container was wiped under it: nothing left to write into.
      if (record.exitCode !== null || !this.liveRuns.has(runId)) return
      const log =
        result.log ??
        [result.stdout, result.stderr].filter((part): part is string => Boolean(part)).join('\n')
      this.startChunks(run, typeof log === 'string' ? [log] : log, result.exitCode ?? 0)
    }
    if (outcome instanceof Promise) {
      outcome.then(settle, () => {
        // The runner died: no exit file, and `kill -0` says it is gone.
        this.liveRuns.delete(runId)
      })
    } else if (outcome) {
      settle(outcome)
    } else {
      const script = found as BackgroundScript
      if (!script.hang) {
        const log = script.log ?? ''
        this.startChunks(run, typeof log === 'string' ? [log] : log, script.exitCode ?? 0)
      } else if (script.log !== undefined) {
        this.files.set(
          `${base}.log`,
          typeof script.log === 'string' ? script.log : script.log.join('')
        )
      }
    }
    return { id: `bg-${record.pid}` }
  }

  /** `chunks` appear one per read of the log; the exit follows the last. One chunk ends it now. */
  private startChunks(run: LiveRun, chunks: readonly string[], exitCode: number): void {
    run.finalExit = exitCode
    if (chunks.length <= 1) {
      this.files.set(`${run.record.base}.log`, chunks[0] ?? '')
      this.endRun(run, exitCode)
      return
    }
    run.chunks = chunks
    run.shown = 0
  }

  private revealChunk(path: string): void {
    for (const run of this.liveRuns.values()) {
      if (path !== `${run.record.base}.log` || run.chunks.length === 0) continue
      if (!this.files.has(path)) return
      run.shown = Math.min(run.shown + 1, run.chunks.length)
      this.files.set(path, run.chunks.slice(0, run.shown).join(''))
      if (run.shown === run.chunks.length && run.finalExit !== null) {
        this.endRun(run, run.finalExit)
      }
      return
    }
  }

  private endRun(run: LiveRun, exitCode: number): void {
    run.record.exitCode = exitCode
    this.liveRuns.delete(run.record.runId)
    // A container that was wiped under the run keeps no files to write into.
    if (this.files.has(`${run.record.base}.pid`)) {
      this.files.set(`${run.record.base}.exit`, `${run.record.runId} ${exitCode}\n`)
    }
  }

  /** `kill -0 <pid>` and the group kill, answered for a background run's pid. */
  private backgroundControl(command: string): { exitCode: number } | null {
    const alive = /^kill -0 (\d+) /.exec(command)
    if (alive) {
      const pid = Number(alive[1])
      const live = [...this.liveRuns.values()].some(r => r.record.pid === pid)
      return { exitCode: live ? 0 : 1 }
    }
    const kill = /^kill -TERM -- -(\d+)/.exec(command)
    if (kill) {
      const pid = Number(kill[1])
      const run = [...this.liveRuns.values()].find(r => r.record.pid === pid)
      if (run) {
        run.record.killed = true
        this.endRun(run, 143)
      }
      return { exitCode: 0 }
    }
    return null
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
    const excluded = (path: string) =>
      (opts.excludes ?? []).some(
        rel => path === `${opts.dir}/${rel}` || path.startsWith(`${opts.dir}/${rel}/`)
      )
    for (const [path, content] of this.files) {
      if ((path === opts.dir || path.startsWith(`${opts.dir}/`)) && !excluded(path)) {
        files.set(path, content)
      }
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
    this.liveRuns.clear()
    this.files.clear()
    this.binaryFiles.clear()
    this.ports.clear()
    for (const p of this.processes) {
      if (p.exitCode === null) {
        p.killed = true
        this.killWaiters.get(p.id)?.()
      }
    }
  }
}
