/**
 * A long command in a session's container, run in the BACKGROUND and polled — never one blocking
 * `exec` (Launch P3; the kit's install and bootstrap, `rocketflare-dev.ts` `sessionBootstrap`).
 *
 * Why (measured on real Cloudflare containers, 2026-09-29, docs/CONCEPTS.md §18.10):
 *
 * 1. **The Sandbox SDK serialises every call to a sandbox behind a running `exec`**: during a 25 s
 *    exec, `readFile`, `startProcess` and another `exec` all waited for it. A long exec cannot be
 *    watched, and a step RETRY's short exec queues behind the first attempt's orphaned one.
 * 2. **Over the sandbox host's service binding a long blocking exec RPC was dropped** after ~7 min
 *    ("Peer closed WebSocket: 1006"): the result was lost while the command kept running.
 * 3. **While a background process runs, every call answers at once** — `startProcess` in 0.3 s,
 *    `readFile` of its log shows its output live.
 *
 * So `runInBackground` starts the command with `startProcess` and polls its files with short calls.
 * Under `dir` (`SESSION_LAUNCH_DIR`) it keeps, per `name`:
 *
 * - `<name>.log` — stdout and stderr together;
 * - `<name>.pid` — `<pid> <runId>`: the pid of the command's own PROCESS GROUP (it runs under
 *   `setsid -w`), so a kill reaches `flock`, `pnpm` and every child;
 * - `<name>.exit` — `<runId> <exit code>`, written ATOMICALLY (tmp + `mv`) by the runner when the
 *   command ends. The run id is what keeps a late write from an earlier run from answering this one.
 *
 * **Idempotent across a Workflow step retry**: when `<name>.pid` names a live process whose run has
 * no exit file yet, the call ATTACHES to it (polls its files) instead of starting a second copy;
 * otherwise (none, finished, dead) it clears the files and starts fresh. A FINISHED run is never
 * reused: the same name runs again for a different database (a prepare run, then the session's own
 * bootstrap, in one container).
 *
 * An attached run gets the whole `timeoutMs` again from the moment it is attached to: when it
 * started is not recorded, and the step's own timeout bounds the total anyway.
 *
 * Every `pollMs` (more often while the run is young: {@link backgroundPollInterval}) it reads the
 * exit file and the log; `onProgress` gets `progressOf(log)` (default:
 * the last non-empty line) only when that CHANGES. Past `timeoutMs` it kills the process group and
 * throws {@link BackgroundCommandTimeoutError} with the log; an aborted `signal` does the same at
 * the next poll and throws {@link BackgroundCommandAbortedError}. A run whose files vanish (the container
 * was replaced — the log Launch wrote before the start counts, so a command that printed nothing
 * yet is covered too), whose process is gone without an exit code, or whose container `replaced`
 * says is no longer the run's (asked after a failed poll and with each liveness check) throws
 * {@link BackgroundCommandLostError}. A poll that fails is retried up to {@link MAX_POLL_FAILURES}
 * times in a row, because one dropped RPC must not fail a 10-minute install.
 *
 * Credentials stay in `env` (the database URI as `LAUNCH_DB_URL`; the ship gate's `DATABASE_URL`,
 * minted lazily — see `env`): nothing here puts one in a command line, and the log is the caller's
 * to redact (`tailOf`).
 */
import { type SandboxExecOptions, SandboxInterruptedError, type SandboxPort } from './sandbox-port'

/** How often a running command's files are read once it has run a while. */
export const BACKGROUND_POLL_MS = 2_500
/**
 * Issue #15 / epic #7: a young run is read more often — every {@link BACKGROUND_FAST_POLL_MS} for
 * its first {@link BACKGROUND_FAST_WINDOW_MS}, then every {@link BACKGROUND_MID_POLL_MS} until
 * {@link BACKGROUND_MID_WINDOW_MS}, then every `pollMs` ({@link backgroundPollInterval}). A boot's
 * install and kit bootstrap (20-25 s each, measured locally; longer on a real container) then end
 * inside the half-second window and are noticed within 0.5 s rather than up to 2.5 s after, and
 * one that takes a minute or two within 1 s. A poll is two short `readFile`s, so the first two
 * minutes cost at most 150 polls; a command running for many minutes (the ship gate) settles to
 * one every 2.5 s.
 */
export const BACKGROUND_FAST_POLL_MS = 500
export const BACKGROUND_FAST_WINDOW_MS = 30_000
export const BACKGROUND_MID_POLL_MS = 1_000
export const BACKGROUND_MID_WINDOW_MS = 120_000

/** The wait before the next poll of a run polled for `elapsedMs`; never longer than `pollMs`. */
export function backgroundPollInterval(elapsedMs: number, pollMs: number): number {
  if (elapsedMs < BACKGROUND_FAST_WINDOW_MS) return Math.min(pollMs, BACKGROUND_FAST_POLL_MS)
  if (elapsedMs < BACKGROUND_MID_WINDOW_MS) return Math.min(pollMs, BACKGROUND_MID_POLL_MS)
  return pollMs
}
/** Every Nth poll also asks whether the process is still alive (a runner that died writes no exit). */
export const LIVENESS_EVERY_POLLS = 8
/** Consecutive failed polls before the run is given up on. */
export const MAX_POLL_FAILURES = 3
/** How long a kill waits for the process group to leave after SIGTERM before it sends SIGKILL. */
export const KILL_GRACE_SECONDS = 5
/** Bytes of log `progressOf` sees (the tail): a progress line is always near the end. */
const PROGRESS_WINDOW = 4_096

/** The first line of every runner script — how a test's `FakeSandbox` recognises one. */
export const BACKGROUND_MARKER = ': launch-background'

export interface BackgroundCommandOptions {
  /** A plain token (`install`, `bootstrap`): its files are `<dir>/<name>.{log,pid,exit}`. */
  name: string
  /** Absolute, shell-safe: where the files live (`SESSION_LAUNCH_DIR`). */
  dir: string
  /** What runs — as a shell command line, under `bash -c` in its own process group. */
  command: string
  cwd?: string
  /**
   * The command's environment — where a credential goes, never into `command`. A FUNCTION is
   * called only when a run is STARTED, never when the call attaches to one an earlier attempt left
   * going: a credential minted for the run (the ship gate's database password, `gate.ts`) is then
   * minted once per run, and a retried step never resets it under the process still using it.
   */
  env?: Record<string, string> | (() => Promise<Record<string, string>>)
  /**
   * Abort the run: the next poll kills its process group and throws
   * {@link BackgroundCommandAbortedError} (the ship gate, when the session is ended mid-step).
   */
  signal?: AbortSignal
  /** The overall deadline; past it the process group is killed. */
  timeoutMs: number
  /** Poll interval ({@link BACKGROUND_POLL_MS}). */
  pollMs?: number
  /** Test hook. */
  sleep?: (ms: number) => Promise<void>
  /** Called with `progressOf(log)` whenever it changes (and is not null). Its errors are ignored. */
  onProgress?: (progress: string) => void | Promise<void>
  /** What in the log is progress; default {@link lastMeaningfulLine}. */
  progressOf?: (log: string) => string | null
  /**
   * Is the container still the one the run was started in? Asked after a poll that FAILED and
   * with every liveness check ({@link LIVENESS_EVERY_POLLS}); `true` ends the wait at once with
   * {@link BackgroundCommandLostError}. The session steps answer it from the boot marker
   * (`boot-marker.ts`): a replaced container's calls may fail, or stall, rather than answer
   * "no such file", and without it such a run was waited on until its deadline. Its own errors
   * count as "not known" (false).
   */
  replaced?: () => Promise<boolean>
}

export interface BackgroundCommandResult {
  exitCode: number
  /** The whole log: stdout and stderr, interleaved as written. */
  stdout: string
  /** True when this call attached to a run an earlier attempt started. */
  attached: boolean
}

/** The command passed its deadline; it was killed. `log` is what it printed (unredacted). */
export class BackgroundCommandTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
    readonly log: string
  ) {
    super(`${command} did not finish within ${formatDuration(timeoutMs)}`)
    this.name = 'BackgroundCommandTimeoutError'
  }
}

/** The caller aborted the run (`signal`); its process group was killed. `log` is unredacted. */
export class BackgroundCommandAbortedError extends Error {
  constructor(
    readonly command: string,
    readonly log: string
  ) {
    super(`${command} was stopped`)
    this.name = 'BackgroundCommandAbortedError'
  }
}

/** The command's process or files are gone and it recorded no exit code. */
export class BackgroundCommandLostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackgroundCommandLostError'
  }
}

/** `10 min`, `90 s`, `0.06 s`. */
export function formatDuration(ms: number): string {
  if (ms >= 120_000 && ms % 60_000 === 0) return `${ms / 60_000} min`
  return `${Number((ms / 1000).toFixed(2))} s`
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes in a command's output
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

/** The last non-blank line, colour codes stripped, at most 200 characters. */
export function lastMeaningfulLine(log: string): string | null {
  const lines = log.replace(ANSI, '').split(/\r?\n|\r/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (line) return line.slice(0, 200)
  }
  return null
}

export interface BackgroundFiles {
  log: string
  pid: string
  exit: string
}

export function backgroundFiles(dir: string, name: string): BackgroundFiles {
  const base = `${dir}/${name}`
  return { log: `${base}.log`, pid: `${base}.pid`, exit: `${base}.exit` }
}

const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/
const SAFE_DIR = /^\/[A-Za-z0-9._/-]{1,200}$/

/** POSIX single-quoting. */
function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * The script `startProcess` runs: clear the old files, run `command` under `setsid -w` (its own
 * process group, whose leader writes the pid file) with its output in the log, then record
 * `<runId> <code>` atomically. The first line is {@link BACKGROUND_MARKER}.
 */
export function backgroundRunnerScript(opts: {
  dir: string
  name: string
  runId: string
  command: string
}): string {
  const f = backgroundFiles(opts.dir, opts.name)
  const inner = `echo "$$ ${opts.runId}" > ${f.pid}\n${opts.command}`
  return [
    `${BACKGROUND_MARKER} ${opts.dir}/${opts.name} ${opts.runId}`,
    `mkdir -p ${opts.dir}`,
    // Not the log: it is emptied before the start (and truncated here), so it never vanishes.
    `rm -f ${f.exit} ${f.exit}.tmp ${f.pid}`,
    `setsid -w bash -c ${quote(inner)} > ${f.log} 2>&1 < /dev/null`,
    'code=$?',
    `echo "${opts.runId} $code" > ${f.exit}.tmp && mv -f ${f.exit}.tmp ${f.exit}`,
  ].join('\n')
}

/** `{ base, runId }` of a runner script, or null — what a `FakeSandbox` reads. */
export function parseBackgroundRunner(command: string): { base: string; runId: string } | null {
  const m = new RegExp(`^${BACKGROUND_MARKER} (\\S+) (\\S+)$`, 'm').exec(command)
  return m?.[1] && m[2] ? { base: m[1], runId: m[2] } : null
}

/** A shell test: exit 0 when process `pid` is alive. */
export const aliveCommand = (pid: number) => `kill -0 ${pid} 2>/dev/null`

/** SIGTERM the process group `pid` leads, then SIGKILL whatever is left after the grace. */
export function killGroupCommand(pid: number, graceSeconds = KILL_GRACE_SECONDS): string {
  return [
    `kill -TERM -- -${pid} 2>/dev/null || kill -TERM ${pid} 2>/dev/null`,
    `for i in $(seq 1 ${Math.max(1, graceSeconds * 2)}); do kill -0 -- -${pid} 2>/dev/null || exit 0; sleep 0.5; done`,
    `kill -KILL -- -${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null; exit 0`,
  ].join('\n')
}

const parsePid = (text: string | null) => {
  const m = /^(\d+) (\S+)/.exec(text?.trim() ?? '')
  return m?.[1] && m[2] ? { pid: Number(m[1]), runId: m[2] } : null
}

/** The exit code in `<runId> <code>` when it is THIS run's; otherwise null. */
const exitCodeOf = (text: string | null, runId: string): number | null => {
  const m = /^(\S+) (-?\d+)/.exec(text?.trim() ?? '')
  return m?.[1] === runId && m[2] !== undefined ? Number(m[2]) : null
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function isAlive(sandbox: SandboxPort, pid: number): Promise<boolean> {
  const result = await sandbox.exec(aliveCommand(pid), { timeoutMs: 15_000 })
  return result.exitCode === 0
}

/**
 * Whether `<dir>/<name>` names a run that is still going — what {@link runInBackground} would
 * ATTACH to rather than start. The ship gate asks before it probes the database, so a retried step
 * never mints a new password under a suite still running on the old one.
 */
export async function backgroundRunLive(
  sandbox: SandboxPort,
  dir: string,
  name: string
): Promise<boolean> {
  const files = backgroundFiles(dir, name)
  const previous = parsePid(await sandbox.readFile(files.pid))
  return (
    !!previous &&
    exitCodeOf(await sandbox.readFile(files.exit), previous.runId) === null &&
    (await isAlive(sandbox, previous.pid))
  )
}

/** See the header. */
export async function runInBackground(
  sandbox: SandboxPort,
  opts: BackgroundCommandOptions
): Promise<BackgroundCommandResult> {
  if (!SAFE_NAME.test(opts.name)) throw new Error(`runInBackground: unsafe name ${opts.name}`)
  if (!SAFE_DIR.test(opts.dir)) throw new Error(`runInBackground: unsafe dir ${opts.dir}`)
  const files = backgroundFiles(opts.dir, opts.name)
  const pollMs = opts.pollMs ?? BACKGROUND_POLL_MS
  const sleep = opts.sleep ?? realSleep
  const progressOf = opts.progressOf ?? lastMeaningfulLine

  // ---- attach to a live run, or start one ----
  let runId: string
  let pid: number | null = null
  let processId: string | null = null
  let attached = false
  let logWritten = false
  const previous = parsePid(await sandbox.readFile(files.pid))
  if (
    previous &&
    exitCodeOf(await sandbox.readFile(files.exit), previous.runId) === null &&
    (await isAlive(sandbox, previous.pid))
  ) {
    runId = previous.runId
    pid = previous.pid
    attached = true
  } else {
    runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    // An earlier run's log must not be read as this one's progress before the runner truncates it.
    // Once written, the log never vanishes while the run lives (the runner truncates, never
    // removes it): a later read that finds NO log is a replaced container, even when the command
    // printed nothing yet (a silent `pnpm install`).
    logWritten = await sandbox.writeFile(files.log, '').then(
      () => true,
      () => false
    )
    const env = typeof opts.env === 'function' ? await opts.env() : opts.env
    const execOpts: SandboxExecOptions = {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(env ? { env } : {}),
    }
    const proc = await sandbox.startProcess(
      backgroundRunnerScript({ dir: opts.dir, name: opts.name, runId, command: opts.command }),
      execOpts
    )
    processId = proc.id
  }

  // ---- poll ----
  const polledFrom = Date.now()
  const deadline = polledFrom + opts.timeoutMs
  let lastProgress: string | null = null
  let lastLog = ''
  let seenFiles = logWritten
  let failures = 0
  let polls = 0
  const report = async (log: string) => {
    if (!opts.onProgress) return
    const progress = progressOf(log.length > PROGRESS_WINDOW ? log.slice(-PROGRESS_WINDOW) : log)
    if (progress === null || progress === lastProgress) return
    lastProgress = progress
    try {
      await opts.onProgress(progress)
    } catch {
      // Progress is a courtesy; it never fails the command.
    }
  }

  const replacedNow = async () => (opts.replaced ? opts.replaced().catch(() => false) : false)
  const lostToReplacement = () =>
    new BackgroundCommandLostError(
      `${opts.name}: the container was replaced under it — it is not the one the run started in`
    )

  for (;;) {
    try {
      const exitText = await sandbox.readFile(files.exit)
      const log = await sandbox.readFile(files.log)
      failures = 0
      if (log !== null) lastLog = log
      const exitCode = exitCodeOf(exitText, runId)
      if (exitCode !== null) {
        await report(lastLog)
        return { exitCode, stdout: lastLog, attached }
      }
      if (log !== null) {
        seenFiles = true
        await report(log)
      } else if (seenFiles) {
        throw new BackgroundCommandLostError(
          `${opts.name}: its files are gone — the container was replaced under it`
        )
      }
      polls++
      if (polls % LIVENESS_EVERY_POLLS === 0) {
        if (await replacedNow()) throw lostToReplacement()
        pid ??= parsePid(await sandbox.readFile(files.pid))?.pid ?? null
        if (pid !== null && !(await isAlive(sandbox, pid))) {
          // It may have ended between the two reads: one more look at the exit file.
          const late = exitCodeOf(await sandbox.readFile(files.exit), runId)
          if (late !== null) {
            const finalLog = (await sandbox.readFile(files.log)) ?? lastLog
            await report(finalLog)
            return { exitCode: late, stdout: finalLog, attached }
          }
          throw new BackgroundCommandLostError(
            `${opts.name}: its process stopped without recording an exit code`
          )
        }
      }
    } catch (err) {
      if (err instanceof BackgroundCommandLostError || err instanceof SandboxInterruptedError) {
        throw err
      }
      // A call that fails may be the container going away: ask before retrying the poll.
      if (await replacedNow()) throw lostToReplacement()
      if (++failures >= MAX_POLL_FAILURES) throw err
    }
    const left = deadline - Date.now()
    if (left <= 0 || opts.signal?.aborted) {
      pid ??= parsePid(await sandbox.readFile(files.pid).catch(() => null))?.pid ?? null
      if (pid !== null) {
        await sandbox
          .exec(killGroupCommand(pid), { timeoutMs: (KILL_GRACE_SECONDS + 15) * 1000 })
          .catch(() => {})
      } else if (processId) {
        await sandbox.kill(processId).catch(() => {})
      }
      const log = (await sandbox.readFile(files.log).catch(() => null)) ?? lastLog
      if (left > 0) throw new BackgroundCommandAbortedError(opts.name, log)
      throw new BackgroundCommandTimeoutError(opts.name, opts.timeoutMs, log)
    }
    const interval = backgroundPollInterval(Date.now() - polledFrom, pollMs)
    await abortableSleep(sleep, Math.min(interval, left), opts.signal)
  }
}

/** `sleep(ms)`, cut short when `signal` aborts (the next poll then kills the run). */
function abortableSleep(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!signal) return sleep(ms)
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>(resolve => {
    const done = () => {
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    sleep(ms).then(done, done)
  })
}
