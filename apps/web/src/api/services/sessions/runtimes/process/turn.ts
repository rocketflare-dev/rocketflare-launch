/**
 * One turn of a process runtime (rocketflare-launch#13) — the container driver `processRuntime(cli)`
 * runs as its `runTurn`, extracted from `turn.ts` unchanged. `turn.ts` claims the turn and writes
 * its closing event; everything between — the CLI process — is here:
 *
 * 1. **The images** go from R2 into the container (`attachments.ts`' `stageAttachments`, to
 *    `/workspace/.launch/attachments/`, outside the checkout) once — before the resume retry, which
 *    reuses them. An image that cannot be loaded fails the turn with a sentence.
 * 2. **A resume that cannot work never breaks the session**: when the container answers that the
 *    conversation file is missing (the CLI's `state.checkCommand`), or the CLI refuses the resume
 *    (`cli.resumeRefused` — Claude Code's `error_during_execution` with no tokens and nothing
 *    said), the sink forgets the conversation (an `error` event says so) and the turn runs (again,
 *    once) as a new one.
 * 3. **Grant, lease, start**: the egress grant (`egress.prepareGit`, `egress.turnEnv`; `host` meters
 *    the turn itself, `turn-meter.ts`), the credential lease (released in a `finally`), the CLI's
 *    `beforeTurnFiles` and the lease's files, its `turnInputCommand` (Claude with images: the
 *    stream-json input), then `startProcess(turnProcessCommand(cli.buildCommand(…)))` with the
 *    shared env, the CLI's placeholders, the lease's env and the egress's.
 * 4. **Read** `streamLogs` through the CLI's parser into the sink — every mapping at once, a flush
 *    every `flushMs` or `flushEvery` events — and **watch**, concurrently: the cancel flag and the
 *    timeout every `cancelPollMs` (→ SDK kill, `cancelled` / `timeout`), the heartbeat every
 *    `heartbeatMs`, the boot marker every `probeMs` (a dead container's stream does not end, it goes
 *    quiet → `container_lost`), and under self-metering the running cost against the budget.
 * 5. **Never leave it running**: a process Launch stopped reading without an `exit` is stopped by
 *    pid (`terminateTurnProcess`) — not after a rollout or a lost container: that one is gone.
 */

import type { Logger } from '../../../../utils/core/logger'
import { AttachmentsUnavailableError, stageAttachments } from '../../attachments'
import { checkContainer } from '../../boot-marker'
import { type BudgetHeadroom, budgetHeadroom } from '../../budget'
import { clipStrings, SESSION_WORKDIR } from '../../claude-stream'
import {
  CredentialBusyError,
  CredentialNeedsLoginError,
  CredentialPortMissingError,
} from '../../credentials/errors'
import { ModelKeyMissingError, redactModelKeyText } from '../../model-key'
import {
  NotWiredError,
  SandboxInterruptedError,
  type SandboxPort,
  type SessionEgressPort,
} from '../../ports'
import { sessionSharedEnv } from '../../rocketflare-dev'
import { createTurnMeter, recordTurnUsage, type TurnMeter } from '../../turn-meter'
import type {
  AgentRuntime,
  CliAdapter,
  RuntimeAttachment,
  RuntimeStreamParser,
  RuntimeTurnOutcome,
  TurnContext,
  TurnCredentialLease,
  TurnInput,
  TurnSink,
} from '../types'
import { bounded, TURN_KILL_CALL_MS, terminateTurnProcess, turnProcessCommand } from './kill'

/** How long writing a turn's input (the images' stream-json line) may take in the container. */
export const TURN_INPUT_TIMEOUT_MS = 60_000

/** A sentence for `turn.failed`, safe to store and show. */
const failureText = (text: string) => clipStrings(redactModelKeyText(text), 1_000)

const emptyOutcome = (): RuntimeTurnOutcome => ({
  result: null,
  stop: null,
  failure: null,
  output: false,
})

/**
 * Does the turn meter ITSELF from the CLI's own output (`turn-meter.ts`)? Under `host`, always —
 * the host's handlers cannot reach the database. Under `proxied`, only when the CLI says its turn
 * on this credential reaches the provider where no proxy sees it (`cli.selfMetered` — Codex on a
 * person's ChatGPT plan). Every other proxied turn is metered per request by its proxy, and
 * metering it here as well would count it twice.
 */
export function selfMetered(
  mode: SessionEgressPort['mode'],
  cli: Pick<CliAdapter, 'selfMetered'>,
  row: Pick<TurnContext['session'], 'credentialSource'>
): boolean {
  if (mode === 'host') return true
  return cli.selfMetered?.(row.credentialSource) ?? false
}

/** `runTurn` of `processRuntime(cli)`; `runtime` is the runtime itself (what the lease is for). */
export async function runProcessTurn(
  cli: CliAdapter,
  runtime: AgentRuntime,
  ctx: TurnContext,
  input: TurnInput,
  sink: TurnSink
): Promise<RuntimeTurnOutcome> {
  const { sandbox, session: row } = ctx

  // The images go into the container once, before the run (and its resume retry) reads them.
  const staged = await stageTurnAttachments(sandbox, row.id, input, ctx)
  if ('stop' in staged) return staged

  // A conversation to resume whose file is not in the container (a resume that had nothing to
  // restore, a turn that died before any checkpoint): the CLI's resume would fail every turn from
  // now on, so start a fresh conversation instead — the code is all in the checkout.
  let resumeId = row.claudeSessionId
  if (resumeId && (await conversationMissing(sandbox, cli, row, ctx.logger))) {
    await sink.forgetConversation()
    resumeId = null
  }
  // Each attempt sees the row with the conversation it resumes (none, once forgotten).
  const attempt = (resume: string | null) =>
    streamTurn(
      cli,
      runtime,
      { ...ctx, session: { ...row, claudeSessionId: resume } },
      input,
      sink,
      staged.attachments
    )
  let run = await attempt(resumeId)
  if (resumeId && cli.resumeRefused(run)) {
    // The conversation was there but the CLI would not resume it (Claude Code: an
    // `error_during_execution` with no tokens and nothing said): the same turn once more, new.
    ctx.logger?.warn(
      { sessionId: row.id, turn: ctx.turn },
      'session turn: --resume ended at once with nothing done; retrying without it'
    )
    await sink.forgetConversation()
    run = await attempt(null)
  }
  return run
}

/**
 * Put the message's images into the container (`stageAttachments`), or the outcome that ends the
 * turn when they cannot be: a rollout, or a failure with a sentence for the person.
 */
async function stageTurnAttachments(
  sandbox: SandboxPort,
  sessionId: string,
  input: TurnInput,
  ctx: TurnContext
): Promise<{ attachments: RuntimeAttachment[] } | RuntimeTurnOutcome> {
  try {
    return {
      attachments: await stageAttachments(sandbox, ctx.storage, sessionId, input.attachments),
    }
  } catch (err) {
    const out = emptyOutcome()
    if (err instanceof SandboxInterruptedError) out.stop = 'rollout'
    else if (err instanceof AttachmentsUnavailableError) out.failure = err.message
    else {
      ctx.logger?.warn({ err, sessionId }, 'session turn: could not stage the images')
      out.failure = new AttachmentsUnavailableError().message
    }
    return out
  }
}

/**
 * True only when the container ANSWERED that the conversation file the resume needs is missing or
 * empty; a check that failed (the container busy, a rollout on its way) is not evidence, and the
 * turn resumes as asked — `cli.resumeRefused` still catches a resume that cannot work.
 */
async function conversationMissing(
  sandbox: SandboxPort,
  cli: CliAdapter,
  row: TurnContext['session'],
  logger?: Logger
): Promise<boolean> {
  const path = cli.state.restorePath(row)
  if (!path) return true
  try {
    const result = await bounded(TURN_KILL_CALL_MS, () =>
      sandbox.exec(cli.state.checkCommand(path), { timeoutMs: 15_000 })
    )
    return result.exitCode === 1
  } catch (err) {
    logger?.warn({ err }, 'session turn: could not check the transcript; resuming as asked')
    return false
  }
}

/**
 * Start the process, read it to its end, and hand the sink what it says; meanwhile watch for a
 * cancel and the timeout. Resolves when the process has ended (or was killed, or the container
 * went away). `ctx.session.claudeSessionId` is the conversation this attempt resumes;
 * `attachments` the message's images, already in the container.
 */
async function streamTurn(
  cli: CliAdapter,
  runtime: AgentRuntime,
  ctx: TurnContext,
  input: TurnInput,
  sink: TurnSink,
  attachments: RuntimeAttachment[]
): Promise<RuntimeTurnOutcome> {
  const out = emptyOutcome()
  // `host` (a remote sandbox): the host is granted the turn's model credential and a fresh token
  // (the process keeps the CLI's placeholders), and the turn meters itself against what the budget
  // has left (`turn-meter.ts`) — a personal account has no money budget, so it is only recorded.
  // `proxied`: none of it, except for a CLI that reaches its provider past the proxies
  // ({@link selfMetered}).
  try {
    return await streamGrantedTurn(cli, runtime, ctx, input, sink, attachments, out)
  } finally {
    await ctx.egress
      .endTurn?.(ctx.sandbox, ctx.session)
      .catch(err =>
        ctx.logger?.warn(
          { err, sessionId: ctx.session.id },
          'session turn: could not revoke the turn grant'
        )
      )
  }
}

/** The turn once the egress may be granted: grant, lease, run. */
async function streamGrantedTurn(
  cli: CliAdapter,
  runtime: AgentRuntime,
  ctx: TurnContext,
  input: TurnInput,
  sink: TurnSink,
  attachments: RuntimeAttachment[],
  out: RuntimeTurnOutcome
): Promise<RuntimeTurnOutcome> {
  const { sandbox, session: row } = ctx
  let egressEnv: Record<string, string>
  let meter: TurnMeter | null = null
  let headroom: BudgetHeadroom = {
    microcents: Number.POSITIVE_INFINITY,
    scope: 'session',
    spentMicrocents: 0,
    capMicrocents: 0,
  }
  try {
    await ctx.egress.prepareGit(sandbox, row)
    egressEnv = await ctx.egress.turnEnv(sandbox, row)
    if (selfMetered(ctx.egress.mode, cli, row)) {
      const subscription = row.credentialSource === 'user'
      meter = createTurnMeter(input.model, {
        provider: cli.provider,
        billing: subscription ? 'subscription' : 'metered',
      })
      if (!subscription) headroom = await budgetHeadroom(ctx.db, row, new Date(ctx.now()))
    }
  } catch (err) {
    if (err instanceof SandboxInterruptedError) out.stop = 'rollout'
    else if (err instanceof ModelKeyMissingError || err instanceof CredentialNeedsLoginError) {
      out.failure = err.message
    } else {
      ctx.logger?.warn({ err, sessionId: row.id }, 'session turn: could not prepare the sandbox')
      out.failure = 'Launch could not give the sandbox its credentials for this turn'
    }
    return out
  }

  // §18.22: the turn's credential. Platform: nothing (the egress swaps Launch's key in). A personal
  // account: the runtime's lease, released in the `finally` below whatever happens.
  let lease: TurnCredentialLease
  try {
    lease = await ctx.credentials.lease(row, sandbox, runtime)
  } catch (err) {
    if (err instanceof SandboxInterruptedError) out.stop = 'rollout'
    else out.failure = leaseFailure(err, cli, row.id, ctx.logger)
    return out
  }
  try {
    return await runLeasedTurn(cli, ctx, input, sink, attachments, {
      out,
      lease,
      egressEnv,
      meter,
      headroom,
    })
  } finally {
    await lease
      .release()
      .catch(err =>
        ctx.logger?.warn(
          { err, sessionId: row.id },
          'session turn: could not release the credential'
        )
      )
  }
}

/** A lease that would not come: a sentence safe for `turn.failed`, never the credential. */
function leaseFailure(err: unknown, cli: CliAdapter, sessionId: string, logger?: Logger) {
  if (
    err instanceof CredentialNeedsLoginError ||
    err instanceof CredentialBusyError ||
    err instanceof CredentialPortMissingError ||
    err instanceof NotWiredError
  ) {
    return err.message
  }
  logger?.warn({ err, sessionId }, 'session turn: could not lease the credential')
  return `Launch could not get ${cli.label} its credential for this turn`
}

/** What `streamGrantedTurn` hands the leased half of the turn. */
interface LeasedTurn {
  out: RuntimeTurnOutcome
  lease: TurnCredentialLease
  egressEnv: Record<string, string>
  meter: TurnMeter | null
  headroom: BudgetHeadroom
}

/** The turn once its credential is leased: start, read, watch, end. */
async function runLeasedTurn(
  cli: CliAdapter,
  ctx: TurnContext,
  input: TurnInput,
  sink: TurnSink,
  attachments: RuntimeAttachment[],
  leased: LeasedTurn
): Promise<RuntimeTurnOutcome> {
  const { sandbox, session: row } = ctx
  const { out, lease, egressEnv, meter, headroom } = leased
  let parser: RuntimeStreamParser
  let processId: string
  try {
    parser = cli.createParser(ctx.turn, { runtimeState: row.runtimeState ?? null })
    const systemNote = await input.systemNote()
    const files = [
      ...(cli.beforeTurnFiles?.({ model: input.model, systemNote, source: lease.source }) ?? []),
      ...lease.files,
    ]
    for (const file of files) await sandbox.writeFile(file.path, file.content)
    const command = {
      message: input.message,
      model: input.model,
      resumeId: row.claudeSessionId,
      systemNote,
      attachments,
    }
    // What the command reads besides its argv (Claude with images: the stream-json input).
    const turnInput = cli.turnInputCommand?.(command)
    if (turnInput) {
      const written = await sandbox.exec(turnInput, { timeoutMs: TURN_INPUT_TIMEOUT_MS })
      if (written.exitCode !== 0) {
        ctx.logger?.warn(
          { sessionId: row.id, exitCode: written.exitCode, stderr: written.stderr.slice(0, 500) },
          'session turn: could not write the turn input'
        )
        out.failure = new AttachmentsUnavailableError().message
        return out
      }
    }
    const proc = await sandbox.startProcess(turnProcessCommand(cli.buildCommand(command)), {
      cwd: ctx.cwd ?? SESSION_WORKDIR,
      env: {
        ...sessionSharedEnv(),
        ...cli.turnEnv({ model: input.model, source: lease.source }),
        ...lease.env,
        ...egressEnv,
      },
    })
    processId = proc.id
  } catch (err) {
    if (err instanceof SandboxInterruptedError) out.stop = 'rollout'
    else if (err instanceof NotWiredError) out.failure = err.message
    else {
      ctx.logger?.warn({ err, sessionId: row.id }, `session turn: could not start ${cli.label}`)
      out.failure = `${cli.label} could not be started in the sandbox`
    }
    return out
  }

  // Everything below waits on `done` as well as its timer, so the turn ends when the process does.
  let finished = false
  let markDone: () => void = () => {}
  const done = new Promise<void>(resolve => {
    markDone = resolve
  })
  const pause = (ms: number) => Promise.race([ctx.sleep(ms), done])
  const reader = new AbortController()
  const startedAt = ctx.now()

  let overBudget = false
  const stop = async (reason: 'cancelled' | 'timeout') => {
    if (out.stop || overBudget || finished) return
    out.stop = reason
    try {
      await sandbox.kill(processId, 'SIGTERM')
    } catch (err) {
      ctx.logger?.warn({ err, sessionId: row.id }, 'session turn: kill failed')
    }
    // Stop READING too: a killed process's last lines are not worth waiting for.
    reader.abort()
  }

  let lastBeat = startedAt
  const watcher = (async () => {
    while (!finished) {
      await pause(ctx.cancelPollMs)
      if (finished) return
      if (ctx.now() - startedAt >= ctx.timeoutMs) return stop('timeout')
      if (ctx.now() - lastBeat >= ctx.heartbeatMs) {
        lastBeat = ctx.now()
        // A failed beat is not a failed turn: the next one tries again.
        await ctx.heartbeat(lastBeat)
      }
      if (await ctx.cancelRequested()) return stop('cancelled')
    }
  })()

  const flusher = (async () => {
    while (!finished) {
      await pause(ctx.flushMs)
      if (sink.pending > 0) await sink.flush()
    }
  })()

  /** The container is gone (`boot-marker.ts`): stop reading — there is nothing left to kill. */
  const lose = (verdict: 'replaced' | 'interrupted' | 'silent') => {
    if (out.stop || overBudget || finished) return
    ctx.logger?.warn({ sessionId: row.id, verdict }, 'session turn: the container is gone')
    out.stop = verdict === 'interrupted' ? 'rollout' : 'container_lost'
    reader.abort()
  }

  // Liveness: a dead container's log stream does not end, it goes quiet. Its own loop, so a slow
  // probe never delays the cancel poll or the heartbeat.
  const bootId = ctx.bootId
  const prober = (async () => {
    if (!bootId) return
    let silent = 0
    while (!finished) {
      await pause(ctx.probeMs)
      if (finished) return
      const verdict = await checkContainer(sandbox, bootId, ctx.probeCallMs)
      if (finished) return
      if (verdict === 'ours') silent = 0
      else if (verdict === 'unknown') {
        silent += 1
        ctx.logger?.warn(
          { sessionId: row.id, silent },
          'session turn: the container did not answer the liveness probe'
        )
        if (silent >= ctx.probeFailures) return lose('silent')
      } else return lose(verdict)
    }
  })()

  /**
   * Self-metered only: the turn's running cost reached the headroom — stop reading and say why;
   * the process itself is stopped below by `terminateTurnProcess` (SIGTERM, then SIGKILL by pid).
   */
  const stopForBudget = async () => {
    if (out.stop || overBudget || finished || !meter) return
    overBudget = true
    sink.append({
      type: 'budget.reached',
      turn: ctx.turn,
      data: {
        spentMicrocents: headroom.spentMicrocents + meter.runningCostMicrocents(),
        capMicrocents: headroom.capMicrocents,
        scope: headroom.scope,
      },
    })
    out.failure =
      headroom.scope === 'session'
        ? 'This turn was stopped: the session reached its budget. Ask an app owner to extend it.'
        : "This turn was stopped: this app's coding sessions reached their monthly budget."
    reader.abort()
  }

  let exitCode: number | null = null
  let stderrTail = ''
  const apply = async (mappings: ReturnType<RuntimeStreamParser['push']>) => {
    for (const mapping of mappings) {
      await sink.apply(mapping)
      if (mapping.result) out.result = mapping.result
      if (mapping.events.length > 0) {
        out.output = true
        out.firstOutputAt ??= ctx.now()
      }
      if (meter) {
        meter.observe(mapping)
        if (meter.runningCostMicrocents() >= headroom.microcents) await stopForBudget()
      }
    }
    if (sink.pending >= ctx.flushEvery) await sink.flush()
  }

  let readFailed = false
  let exited = false
  try {
    for await (const event of sandbox.streamLogs(processId, { signal: reader.signal })) {
      if (event.type === 'stdout') await apply(parser.push(event.data))
      else if (event.type === 'stderr') stderrTail = (stderrTail + event.data).slice(-2_000)
      else if (event.type === 'exit') {
        exited = true
        exitCode = event.exitCode
      }
    }
    await apply(parser.end())
  } catch (err) {
    if (err instanceof SandboxInterruptedError) out.stop = 'rollout'
    else if (!out.stop && !overBudget) {
      readFailed = true
      ctx.logger?.warn({ err, sessionId: row.id }, 'session turn: reading the process failed')
      out.failure = `Launch lost the connection to ${cli.label} in the sandbox`
    }
  } finally {
    finished = true
    markDone()
  }
  const [watched, flushed, probed] = await Promise.allSettled([watcher, flusher, prober])
  if (watched.status === 'rejected') {
    ctx.logger?.warn({ err: watched.reason, sessionId: row.id }, 'session turn: watch failed')
  }
  if (probed.status === 'rejected') {
    ctx.logger?.warn({ err: probed.reason, sessionId: row.id }, 'session turn: probe failed')
  }

  // A stream that failed, or ended with no exit and no result: was it the container that went?
  // Then say so (and suspend) rather than "lost the connection" on a session with nothing in it.
  if (bootId && !out.stop && !overBudget && !exited && (readFailed || !out.result)) {
    const verdict = await checkContainer(sandbox, bootId, ctx.probeCallMs)
    if (verdict === 'replaced' || verdict === 'interrupted') {
      out.stop = verdict === 'interrupted' ? 'rollout' : 'container_lost'
      out.failure = null
      readFailed = false
    }
  }

  // Launch has stopped reading a process that may still be running: stop it too, or it spends
  // tokens and edits the workspace unseen. Not after a rollout or a lost container (it is gone)
  // and not after an `exit` (it is over); a cancel/timeout already sent the SDK kill, so only
  // escalate. A self-metered turn that reached its budget stops here too (the SDK kill, then the pid).
  const cutOff = out.stop === 'cancelled' || out.stop === 'timeout'
  const gone = out.stop === 'rollout' || out.stop === 'container_lost'
  if (!gone && !exited && (readFailed || cutOff || overBudget || !out.result)) {
    await terminateTurnProcess(sandbox, processId, {
      logger: ctx.logger,
      sessionId: row.id,
      reason: readFailed
        ? 'read-failed'
        : cutOff
          ? (out.stop as string)
          : overBudget
            ? 'budget'
            : 'stream-ended',
      signalled: cutOff,
    })
  }
  if (flushed.status === 'rejected') throw flushed.reason

  if (meter) {
    // Before `turn.ts` reads the row's total back: the turn's cost IS this write.
    await recordTurnUsage(ctx.db, row, meter).catch(err =>
      ctx.logger?.error({ err, sessionId: row.id }, 'session turn: could not record usage')
    )
  }

  // A `result` line is the end of the turn whatever the exit code; no `result` is a failure.
  if (!out.stop && !out.failure && !out.result) {
    const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : ''
    const code = exitCode === null ? '' : ` with code ${exitCode}`
    out.failure = failureText(`${cli.label} exited${code} before finishing the turn${detail}`)
  }
  return out
}
