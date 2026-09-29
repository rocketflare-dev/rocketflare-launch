/**
 * Bounded waits for the session steps (Launch P3, "never hang silently"): every call a step makes
 * into the sandbox or a vendor gets a deadline, and a call that passes it fails the step with a
 * sentence the page can show — "Preparing the app's database: the sandbox did not answer
 * setAllowedHosts within 90 s" — instead of leaving the session on a spinner for ever.
 *
 * - `withDeadline(label, ms, work)` races one promise against a timer. It cannot CANCEL the work
 *   (a Durable Object RPC has no abort); the step fails, and `cleanup` destroys the container,
 *   which ends whatever was still running in it.
 * - `boundedSandbox(port, phase, limits)` is the `SandboxPort` every step body receives
 *   (`sandboxFor` in `steps.ts`): each call carries its deadline — a command gets its own
 *   `timeoutMs` plus a grace, because the SDK is supposed to stop it first and only a stuck RPC
 *   should reach ours. `streamLogs` (a turn's whole life) and `fetch` (the preview) pass through.
 * - The numbers are `SESSION_CALL_LIMITS`; the Workflow's tests pass smaller ones through
 *   `overrides.limits`.
 */
import type {
  SandboxExecOptions,
  SandboxExecResult,
  SandboxPort,
  SandboxProcess,
  SandboxStartOptions,
  SandboxWaitForPortOptions,
} from './ports'

/** How long each kind of call may take before the step gives up on it. */
export interface SessionCallLimits {
  /** Boot the container (the SDK's own start budget is ~2 min). */
  startMs: number
  /** Short control calls: the allow-list, files, kill. */
  controlMs: number
  /** Added to a command's own `timeoutMs` (the SDK should stop it first). */
  execGraceMs: number
  /** A command with no `timeoutMs` of its own. */
  execDefaultMs: number
  /** No command waits longer than this, whatever its own `timeoutMs` (tests shrink it). */
  execMaxMs: number
  destroyMs: number
  /** One workspace backup or restore (an archive of the checkout and its `node_modules`). */
  backupMs: number
  /** One vendor operation from a step (a Neon branch, a role reset, a delete). */
  vendorMs: number
  /** How often a boot step checks whether the person asked to end the session. */
  endPollMs: number
  /** How often a boot step says it is alive (`sessions.last_activity_at`, the reconcile's clock). */
  heartbeatMs: number
  /**
   * How often a long BACKGROUND command (the install, the kit bootstrap — `background-command.ts`)
   * has its files read. Its deadline is its own (`BOOTSTRAP_TIMEOUTS`), capped by `execMaxMs`.
   */
  commandPollMs: number
  /**
   * Not a call's budget but the loop's own clocks, here so tests shrink them the same way: the
   * checkpoint debounce and its cap (`SESSION_CHECKPOINT_DEBOUNCE_MS` / `_MAX_DEFER_MS`,
   * `checkpoint.ts`, the defaults when absent).
   */
  checkpointDebounceMs?: number
  checkpointMaxDeferMs?: number
  /**
   * Caps each ship-gate command's own deadline (`gate.ts` `SHIP_GATE_COMMANDS`); absent = the
   * command's. Tests shrink it to drive a gate step past its deadline.
   */
  gateMaxMs?: number
}

export const SESSION_CALL_LIMITS: SessionCallLimits = {
  startMs: 4 * 60_000,
  controlMs: 90_000,
  execGraceMs: 60_000,
  execDefaultMs: 10 * 60_000,
  execMaxMs: 20 * 60_000,
  destroyMs: 3 * 60_000,
  backupMs: 10 * 60_000,
  vendorMs: 5 * 60_000,
  endPollMs: 10_000,
  heartbeatMs: 30_000,
  commandPollMs: 2_500,
}

/** A bounded call that did not come back in time. */
export class SessionStepTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not answer within ${formatSeconds(ms)}`)
    this.name = 'SessionStepTimeoutError'
  }
}

function formatSeconds(ms: number): string {
  if (ms >= 120_000 && ms % 60_000 === 0) return `${ms / 60_000} min`
  const s = ms / 1000
  return `${Number(s.toFixed(2))} s`
}

/** `work` or a {@link SessionStepTimeoutError} after `ms`, whichever comes first. */
export async function withDeadline<T>(
  label: string,
  ms: number,
  work: Promise<T> | (() => Promise<T>)
): Promise<T> {
  const promise = typeof work === 'function' ? work() : work
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SessionStepTimeoutError(label, ms)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
    // The loser keeps running; never let its late rejection go unhandled.
    promise.catch(() => {})
  }
}

/**
 * The first two words of what a command RUNS, for a timeout's sentence: past the `mkdir -p … &&`
 * and `flock -w N <lock>` wrappers (`serialised` in `rocketflare-dev.ts`), so a stuck install
 * reads `exec pnpm install`, not `exec mkdir -p`.
 */
export function commandName(command: string): string {
  const bare = command
    .replace(/^mkdir -p \S+ && /, '')
    .replace(/^flock -w \d+ \S+ /, '')
    .replace(/^set -e\n/, '')
  return bare.split(/\s+/).slice(0, 2).join(' ')
}

/** `port` with a deadline on every bounded call — see the header. */
export function boundedSandbox(
  port: SandboxPort,
  phase: string | undefined,
  limits: SessionCallLimits = SESSION_CALL_LIMITS
): SandboxPort {
  const label = (call: string) =>
    phase ? `${phase}: the sandbox (${call})` : `The sandbox (${call})`
  return {
    get name() {
      return port.name
    },
    get id() {
      return port.id
    },
    start: (opts?: SandboxStartOptions) =>
      withDeadline(label('start'), limits.startMs, () => port.start(opts)),
    exec: (command: string, opts?: SandboxExecOptions): Promise<SandboxExecResult> =>
      withDeadline(
        label(`exec ${commandName(command)}`),
        Math.min((opts?.timeoutMs ?? limits.execDefaultMs) + limits.execGraceMs, limits.execMaxMs),
        () => port.exec(command, opts)
      ),
    startProcess: (command: string, opts?: SandboxExecOptions): Promise<SandboxProcess> =>
      withDeadline(label('startProcess'), limits.controlMs, () => port.startProcess(command, opts)),
    streamLogs: (processId, opts) => port.streamLogs(processId, opts),
    kill: (processId, signal) =>
      withDeadline(label('kill'), limits.controlMs, () => port.kill(processId, signal)),
    waitForPort: (p: number, opts?: SandboxWaitForPortOptions) =>
      withDeadline(
        label(`waitForPort ${p}`),
        Math.min((opts?.timeoutMs ?? 120_000) + limits.execGraceMs, limits.execMaxMs),
        () => port.waitForPort(p, opts)
      ),
    writeFile: (path, content) =>
      withDeadline(label('writeFile'), limits.controlMs, () => port.writeFile(path, content)),
    readFile: path => withDeadline(label('readFile'), limits.controlMs, () => port.readFile(path)),
    setAllowedHosts: hosts =>
      withDeadline(label('setAllowedHosts'), limits.controlMs, () => port.setAllowedHosts(hosts)),
    fetch: (p, req) => port.fetch(p, req),
    destroy: () => withDeadline(label('destroy'), limits.destroyMs, () => port.destroy()),
    get backupHosts() {
      return port.backupHosts
    },
    backup: opts => withDeadline(label('backup'), limits.backupMs, () => port.backup(opts)),
    restore: backup => withDeadline(label('restore'), limits.backupMs, () => port.restore(backup)),
    deleteBackup: backup =>
      withDeadline(label('deleteBackup'), limits.controlMs, () => port.deleteBackup(backup)),
  }
}
