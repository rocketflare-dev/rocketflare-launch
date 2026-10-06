/**
 * A process runtime's turn process, by pid: the command records its pid and `exec`s into the CLI
 * (`turnProcessCommand`), so Launch can stop a process it no longer reads — SIGTERM, a grace, then
 * SIGKILL (`turnKillScript`, `terminateTurnProcess`) — and the salvage can stop an orphaned one
 * (`processRuntime(…).cancel`). Moved here from `sessions/turn.ts` unchanged
 * (rocketflare-launch#13), which re-exports the names its importers always used.
 */
import type { Logger } from '../../../../utils/core/logger'
import { SandboxInterruptedError, type SandboxPort } from '../../ports'
import { SESSION_LAUNCH_DIR } from '../../rocketflare-dev'

/**
 * The turn's CLI pid: the command writes `$$` and `exec`s into the CLI, so it IS that pid (the dev
 * server's `DEV_PID_FILE` pattern). What {@link terminateTurnProcess} signals directly.
 */
export const TURN_PID_FILE = `${SESSION_LAUNCH_DIR}/turn.pid`
/** Between SIGTERM and SIGKILL, when Launch stops a turn's process it no longer reads. */
export const TURN_KILL_GRACE_SECONDS = 5
/** The bound on each call {@link terminateTurnProcess} makes: it never holds the turn up longer. */
export const TURN_KILL_CALL_MS = 30_000

/** The process a turn starts: its pid recorded, then `exec` into the CLI. */
export function turnProcessCommand(cliCommand: string): string {
  return `mkdir -p ${SESSION_LAUNCH_DIR} && echo $$ > ${TURN_PID_FILE} && exec ${cliCommand}`
}

/**
 * SIGTERM the recorded pid (and its children), wait up to `graceSeconds`, then SIGKILL whatever is
 * left. Signals by pid rather than through the SDK because the SDK's `killProcess` drops its
 * signal argument (0.12.10 sends a bare `DELETE /api/process/:id`), so it can neither escalate nor
 * be told apart from a polite stop.
 */
export function turnKillScript(
  graceSeconds = TURN_KILL_GRACE_SECONDS,
  pidFile = TURN_PID_FILE
): string {
  const ticks = Math.max(1, graceSeconds * 2)
  return [
    `pid=$(cat ${pidFile} 2>/dev/null)`,
    '[ -n "$pid" ] || exit 0',
    'kill -0 "$pid" 2>/dev/null || exit 0',
    'pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null',
    `for i in $(seq 1 ${ticks}); do kill -0 "$pid" 2>/dev/null || exit 0; sleep 0.5; done`,
    'pkill -KILL -P "$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null',
    'echo killed',
  ].join('; ')
}

/**
 * Is the turn's recorded pid still running? Prints `alive` or `exited` (no pid file counts as
 * exited) — what a turn asks before it re-attaches to a log stream that dropped (`logs.ts`).
 */
export function turnAliveScript(pidFile = TURN_PID_FILE): string {
  return [
    `pid=$(cat ${pidFile} 2>/dev/null)`,
    'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo alive; else echo exited; fi',
  ].join('; ')
}

/**
 * {@link turnAliveScript}'s answer, bounded by `callMs`: `unknown` when the container did not
 * answer (or answered something else). A replaced container throws `SandboxInterruptedError`.
 */
export async function turnProcessAlive(
  sandbox: SandboxPort,
  callMs: number
): Promise<'alive' | 'exited' | 'unknown'> {
  try {
    const result = await bounded(callMs, () =>
      sandbox.exec(turnAliveScript(), { timeoutMs: callMs })
    )
    const said = result.stdout.trim()
    return said === 'alive' || said === 'exited' ? said : 'unknown'
  } catch (err) {
    if (err instanceof SandboxInterruptedError) throw err
    return 'unknown'
  }
}

/** `work`, or a rejection after `ms` (the work itself cannot be cancelled — it is an RPC). */
export async function bounded<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = work()
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
    promise.catch(() => {})
  }
}

/**
 * Stop a turn's CLI process that Launch has stopped READING — a lost log stream, or a
 * cancel/timeout whose reader was aborted — so it cannot run on for minutes spending tokens and
 * editing the workspace. Best effort, bounded, logged; never throws. `signalled`: the SDK kill was
 * already sent (a cancel), so only the pid escalation runs.
 */
export async function terminateTurnProcess(
  sandbox: SandboxPort,
  processId: string,
  opts: {
    logger?: Logger
    sessionId: string
    reason: string
    signalled?: boolean
    callMs?: number
  }
): Promise<void> {
  const callMs = opts.callMs ?? TURN_KILL_CALL_MS
  const log = { sessionId: opts.sessionId, processId, reason: opts.reason }
  if (!opts.signalled) {
    try {
      await bounded(callMs, () => sandbox.kill(processId, 'SIGTERM'))
    } catch (err) {
      if (err instanceof SandboxInterruptedError) return
      opts.logger?.warn({ err, ...log }, 'session turn: kill failed')
    }
  }
  try {
    const result = await bounded(callMs, () =>
      sandbox.exec(turnKillScript(), { timeoutMs: (TURN_KILL_GRACE_SECONDS + 15) * 1000 })
    )
    if (result.stdout.includes('killed')) {
      opts.logger?.warn(log, 'session turn: Claude Code ignored SIGTERM and was SIGKILLed')
    } else {
      opts.logger?.info(log, 'session turn: stopped the Claude Code process')
    }
  } catch (err) {
    if (err instanceof SandboxInterruptedError) return
    opts.logger?.warn({ err, ...log }, 'session turn: could not stop the Claude Code process')
  }
}

/**
 * Stop an ORPHANED turn's process — one whose Workflow instance was lost (the salvage step): the
 * same kill script by pid. Resolves when the container ran it, which ends with nothing of the turn
 * left (or found nothing to stop); throws when the container could not be asked.
 */
export async function stopOrphanedTurnProcess(
  sandbox: SandboxPort,
  logger?: Logger
): Promise<void> {
  const result = await sandbox.exec(turnKillScript(), {
    timeoutMs: (TURN_KILL_GRACE_SECONDS + 15) * 1000,
  })
  if (result.stdout.includes('killed')) {
    logger?.warn({}, 'session salvage: the orphaned turn ignored SIGTERM and was SIGKILLed')
  }
  if (result.exitCode !== 0) {
    throw new Error(`the kill script exited with code ${result.exitCode}`)
  }
}
