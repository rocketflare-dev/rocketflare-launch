/**
 * A turn process's output that survives a dropped log stream (session 7291f986: a remote sandbox's
 * `logStream` crossing the wrangler dev binding dropped 20 s into a silent `tsc`, with Claude Code
 * still running). `reattachingLogs` is `sandbox.streamLogs` that, when the stream throws — or ends
 * with no `exit` — while nobody stopped reading, asks the turn's pid (`turnProcessAlive`) and
 * attaches again, at most {@link TURN_LOG_REATTACHES} times a turn:
 *
 * - **Exactly once.** The Sandbox SDK (0.12.10, the container's `GET /api/process/:id/stream`)
 *   answers every attach with the process's WHOLE output so far — its accumulated stdout as one
 *   chunk, then its stderr — and then the live chunks; a process that has ended gets that and its
 *   `exit` (`startProcess` keeps the record: `autoCleanup: false`). So each stream's first
 *   `stdout` / `stderr` characters up to what the turn already read are skipped, and the rest goes
 *   on to the parser mid-line if need be. Characters, not bytes: both sides hold the same decoded
 *   string, chunked differently.
 * - **Only a live or finished process.** `alive` re-attaches; `exited` re-attaches once more for
 *   what it printed last and its exit code; a container that does not answer (`unknown`), a
 *   re-attach to an exited process that fails too, or the reconnects used up throws the stream's
 *   last error — the turn fails as it always did ("lost the connection"). A stream that merely
 *   ENDED without an `exit` is retried the same way, and when that runs out it just ends, as it
 *   always did (the turn may already have its result).
 * - **Stopping wins.** The turn's watchers keep running across a re-attach (the turn's reader is
 *   one `AbortSignal` throughout): a Stop, the timeout, the budget or a lost container aborts it,
 *   and an aborted wait never attaches again.
 */
import type { Logger } from '../../../../utils/core/logger'
import { SandboxInterruptedError, type SandboxLogEvent, type SandboxPort } from '../../ports'
import { turnProcessAlive } from './kill'

/** How many times one turn re-attaches to its process's output before it gives up. */
export const TURN_LOG_REATTACHES = 3
/** The wait before the n-th re-attach is n times this. */
export const TURN_LOG_REATTACH_BACKOFF_MS = 500

export interface ReattachOptions {
  /** The turn's reader: aborted, it stops reading and never attaches again. */
  signal: AbortSignal
  /** The turn's own sleep (`TurnContext.sleep`). */
  sleep: (ms: number) => Promise<void>
  /** The bound on the liveness question (`TurnContext.probeCallMs`). */
  probeCallMs: number
  logger?: Logger
  sessionId: string
  /** After each re-attach is decided, with the turn's count so far. */
  onReattach?: (reattaches: number) => void
  maxReattaches?: number
  backoffMs?: number
}

/** The stream ended with no `exit` while the turn was still reading: a drop, not an end. */
class LogStreamEndedError extends Error {
  constructor() {
    super('the log stream ended without the process exit')
    this.name = 'LogStreamEndedError'
  }
}

/**
 * `sandbox.streamLogs(processId)` — every chunk once, in order, then the `exit` — re-attached
 * after a drop as the header says. Throws the stream's own error when it gives up, and
 * `SandboxInterruptedError` as soon as the container is replaced.
 */
export async function* reattachingLogs(
  sandbox: SandboxPort,
  processId: string,
  opts: ReattachOptions
): AsyncIterable<SandboxLogEvent> {
  const { signal } = opts
  const max = opts.maxReattaches ?? TURN_LOG_REATTACHES
  const backoff = opts.backoffMs ?? TURN_LOG_REATTACH_BACKOFF_MS
  // Characters of each stream already handed on — what a re-attach's replay skips.
  const read = { stdout: 0, stderr: 0 }
  let reattaches = 0
  let exitedBefore = false
  for (;;) {
    const skip = { ...read }
    let dropped: unknown
    try {
      for await (const event of sandbox.streamLogs(processId, { signal })) {
        if (event.type === 'exit') {
          yield event
          return
        }
        const behind = Math.min(skip[event.type], event.data.length)
        skip[event.type] -= behind
        const data = behind > 0 ? event.data.slice(behind) : event.data
        if (!data) continue
        read[event.type] += data.length
        yield { type: event.type, data }
      }
      if (signal.aborted) return
      dropped = new LogStreamEndedError()
    } catch (err) {
      if (err instanceof SandboxInterruptedError || signal.aborted) throw err
      dropped = err
    }

    // A process that had already exited when we re-attached and still cannot be read is gone.
    // A stream that only ENDED early ends the read as it always did (the turn may have its result).
    if (exitedBefore || reattaches >= max) {
      if (dropped instanceof LogStreamEndedError) return
      throw dropped
    }
    reattaches += 1
    opts.logger?.warn(
      { err: dropped, sessionId: opts.sessionId, processId, reattach: reattaches, max },
      'session turn: the log stream dropped; re-attaching'
    )
    await abortableSleep(opts.sleep, backoff * reattaches, signal)
    if (signal.aborted) return
    const verdict = await turnProcessAlive(sandbox, opts.probeCallMs)
    if (signal.aborted) return
    if (verdict === 'unknown') {
      if (dropped instanceof LogStreamEndedError) return
      throw dropped
    }
    exitedBefore = verdict === 'exited'
    opts.onReattach?.(reattaches)
  }
}

/** `sleep(ms)`, cut short by `signal`. */
function abortableSleep(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal
): Promise<void> {
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
