/**
 * Pi as an `AgentRuntime` (rocketflare-launch#14, `docs/CONCEPTS.md` §18.22-C) — the one runtime
 * of `placement: 'durable-object'`. Its agent loop is Cloudflare's Pi harness (`pi-durable`) in the
 * session's `PiSessionAgent` Durable Object (`agent.ts`, logic in `core.ts`), its model Workers AI
 * through the Worker's `AI` binding — so it needs no key at all — and its hands the five
 * `launch-workspace` tools (`workspace.ts`), which run in the session's container like everything
 * else.
 *
 * `runTurn` drives the object from the turn step, which keeps every rule a turn has:
 *
 * 1. **Start** the turn on the object (`startTurn`, idempotent on `<sessionId>:<turn>`): the
 *    session's Workers AI model (`policy.model`, else `DEFAULT_PI_MODEL`), the system note as the
 *    conversation's instructions, the checkout. A message with images fails the turn, saying so:
 *    Pi cannot read them yet.
 * 2. **Drain** what pi committed every `flushMs` (`drain(operation, cursor)` — pi's entry ids are
 *    the cursor), each mapping into the sink exactly as a CLI's line would be: `text`, `tool.start`,
 *    `tool.end`, `error` — the same `session_events` Claude Code's turn writes.
 * 3. **Watch**, between drains: the timeout (→ `timeout`), the cancel flag every `cancelPollMs`
 *    (→ `cancelled`), the heartbeat, the boot marker every `probeMs` (a container gone under the
 *    turn → `container_lost` / `rollout`) — each stop ABORTS the object's run, then drains once
 *    more so what it had already done (and spent) is recorded.
 * 4. **Meter**: Pi's model calls go from the object to Workers AI past no proxy, so a Pi turn
 *    ALWAYS meters itself (`turn-meter.ts`, provider `workers_ai`): every response's usage priced as
 *    it lands, checked against the budget headroom read at the start, and the turn stopped with
 *    the same `budget.reached` event and sentence as a self-metered CLI turn; recorded at the end
 *    (`recordSessionUsage`, feature `session`), whatever ended it.
 *
 * The conversation lives in the object, so a Pi turn never resumes "a file": the row's resume id
 * is a marker (`pi:<sessionId>`) that says there is one, which is what lets the checkpoint copy it
 * (`state.read` → `exportTranscript`, `sessions/<id>/pi.json`) and `transcript#K` put it back
 * (`state.restore` → `importTranscript` — a no-op when the object still holds it). A turn on a row
 * with no resume id starts the object's conversation over. No login, no personal account.
 */
import { DEFAULT_PI_MODEL, type SessionUsage } from '@launch/shared/launch-sessions'
import { checkContainer } from '../../boot-marker'
import { type BudgetHeadroom, budgetHeadroom } from '../../budget'
import { CLAUDE_RESULT_TEXT_MAX, clipStrings, SESSION_WORKDIR } from '../../claude-stream'
import { redactModelKeys, redactModelKeyText } from '../../model-key'
import { SandboxInterruptedError } from '../../ports'
import { createTurnMeter, recordTurnUsage, type TurnMeter } from '../../turn-meter'
import type {
  AgentRuntime,
  RuntimeContext,
  RuntimeLineMapping,
  RuntimeStateStore,
  RuntimeTurnOutcome,
  RuntimeTurnStop,
  TurnContext,
  TurnInput,
  TurnSink,
} from '../types'
import { type PiAgentPort, type PiSettlement, piOperationId } from './protocol'

/** The resume id a Pi session's row carries once it has a conversation (in the object). */
export const piResumeId = (sessionId: string) => `pi:${sessionId}`

/** The R2 key of a session's exported Pi conversation. */
export const piTranscriptKeyFor = (sessionId: string) => `sessions/${sessionId}/pi.json`

/**
 * How long drains may keep failing (the object restarting under a deploy, a reset) before the
 * turn gives up on it — the object resumes pi's run by itself, so a drain that comes back
 * finds everything it missed.
 */
export const PI_DRAIN_GIVE_UP_MS = 60_000

/** Why Pi has nothing to run on. */
export const PI_NOT_BOUND_MESSAGE =
  'Pi is not available on this deployment: the Worker has no PI_SESSION_AGENT binding'

/** A message with images: Pi v1 reads text only. */
export const PI_NO_IMAGES_MESSAGE =
  'Pi cannot read images yet. Send the message without them, or start a Claude Code session.'

const emptyOutcome = (): RuntimeTurnOutcome => ({
  result: null,
  stop: null,
  failure: null,
  output: false,
})

/** The turn's usage from what was metered, as `turn.end` reports it. */
function sessionUsageOf(meter: TurnMeter): SessionUsage | null {
  const entries = meter.entries()
  if (entries.length === 0) return null
  const total = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 }
  for (const { usage } of entries) {
    total.tokensIn += usage.inputTokens
    total.tokensOut += usage.outputTokens
    total.cacheRead += usage.cacheReadTokens ?? 0
    total.cacheWrite += usage.cacheWriteTokens ?? 0
  }
  return total
}

/** The object, or null when this Worker has none bound. */
const agentOf = (ctx: RuntimeContext): PiAgentPort | null => ctx.piAgent ?? null

export async function runPiTurn(
  ctx: TurnContext,
  input: TurnInput,
  sink: TurnSink
): Promise<RuntimeTurnOutcome> {
  const out = emptyOutcome()
  const { session: row, sandbox } = ctx
  const agent = agentOf(ctx)
  if (!agent) {
    out.failure = PI_NOT_BOUND_MESSAGE
    return out
  }
  if (input.attachments.length > 0) {
    out.failure = PI_NO_IMAGES_MESSAGE
    return out
  }
  const model = input.model ?? DEFAULT_PI_MODEL
  const operationId = piOperationId(row.id, ctx.turn)
  // Launch's account, always: no proxy sees Pi's calls, so the turn meters itself (header §4).
  const meter = createTurnMeter(model, { provider: 'workers_ai', billing: 'metered' })
  let headroom: BudgetHeadroom
  let resumed = false
  try {
    // `host` (a remote sandbox): the tools' git still needs its grant. Never a model grant.
    await ctx.egress.prepareGit(sandbox, row)
    headroom = await budgetHeadroom(ctx.db, row, new Date(ctx.now()))
    const started = await agent.startTurn({
      sessionId: row.id,
      turn: ctx.turn,
      operationId,
      message: input.message,
      model,
      systemNote: await input.systemNote(),
      cwd: ctx.cwd ?? SESSION_WORKDIR,
      sandboxHost: row.sandboxHost === 'remote' ? 'remote' : 'local',
      fresh: !row.claudeSessionId,
    })
    resumed = started.resumed
  } catch (err) {
    if (err instanceof SandboxInterruptedError) out.stop = 'rollout'
    else {
      ctx.logger?.warn({ err, sessionId: row.id }, 'session turn: could not start Pi')
      out.failure = 'Pi could not be started for this turn'
    }
    return out
  }
  // The row named a conversation the object no longer holds (a resume with nothing to restore):
  // the turn runs as a new one, and the person is told — as for a CLI.
  if (row.claudeSessionId && !resumed) await sink.forgetConversation()
  // The conversation now lives in the object: say so on the row (at once, as a CLI's id is).
  if (row.claudeSessionId !== piResumeId(row.id) || !resumed) {
    await sink.apply({ events: [], resumeId: piResumeId(row.id), result: null })
  }

  const startedAt = ctx.now()
  let cursor = 0
  let settled: PiSettlement | null = null
  let overBudget = false
  let drainFailingSince: number | null = null
  let lastBeat = startedAt
  let lastCancelPoll = startedAt
  let lastProbe = startedAt
  let silentProbes = 0

  const apply = async (mappings: RuntimeLineMapping[]) => {
    for (const mapping of mappings) {
      await sink.apply(mapping)
      if (mapping.events.length > 0) {
        out.output = true
        out.firstOutputAt ??= ctx.now()
      }
      meter.observe(mapping)
    }
  }

  /** One drain: apply what it brought; false when the object could not be asked. */
  const drainOnce = async (): Promise<boolean> => {
    try {
      const drained = await agent.drain(operationId, cursor)
      drainFailingSince = null
      await apply(drained.items.map(item => item.mapping))
      cursor = drained.items.at(-1)?.seq ?? cursor
      if (drained.settled) settled = drained.settled
      return true
    } catch (err) {
      drainFailingSince ??= ctx.now()
      ctx.logger?.warn({ err, sessionId: row.id }, 'session turn: Pi drain failed')
      return false
    }
  }

  /** Stop the object's run (a Stop, the timeout, the budget, a lost container). */
  const halt = async () => {
    await agent
      .abort()
      .catch(err => ctx.logger?.warn({ err, sessionId: row.id }, 'session turn: Pi abort failed'))
  }

  const stopForBudget = () => {
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
  }

  let stop: RuntimeTurnStop | null = null
  for (;;) {
    await drainOnce()
    // A turn pi already finished is over, whatever it cost: the next one meets the budget check.
    if (settled) break
    if (meter.runningCostMicrocents() >= headroom.microcents) {
      stopForBudget()
      break
    }
    if (drainFailingSince !== null && ctx.now() - drainFailingSince >= PI_DRAIN_GIVE_UP_MS) {
      out.failure = 'Launch lost the connection to Pi'
      break
    }
    if (sink.pending > 0) await sink.flush()
    await ctx.sleep(ctx.flushMs)
    const now = ctx.now()
    if (now - startedAt >= ctx.timeoutMs) {
      stop = 'timeout'
      break
    }
    if (now - lastBeat >= ctx.heartbeatMs) {
      lastBeat = now
      await ctx.heartbeat(now)
    }
    if (now - lastCancelPoll >= ctx.cancelPollMs) {
      lastCancelPoll = now
      if (await ctx.cancelRequested()) {
        stop = 'cancelled'
        break
      }
    }
    if (ctx.bootId && now - lastProbe >= ctx.probeMs) {
      lastProbe = now
      const verdict = await checkContainer(sandbox, ctx.bootId, ctx.probeCallMs)
      if (verdict === 'ours') silentProbes = 0
      else if (verdict === 'unknown') {
        silentProbes += 1
        if (silentProbes >= ctx.probeFailures) stop = 'container_lost'
      } else stop = verdict === 'interrupted' ? 'rollout' : 'container_lost'
      if (stop) {
        ctx.logger?.warn({ sessionId: row.id, verdict }, 'session turn: the container is gone')
        break
      }
    }
  }

  if (!settled) {
    // Whatever stopped the turn, the object's run stops too — then one last drain, so what it had
    // already done is in the log and what it had already spent is metered.
    await halt()
    await drainOnce()
  }
  out.stop = stop
  if (sink.pending > 0) await sink.flush()
  // Before `turn.ts` reads the row's total back: the turn's cost IS this write.
  await recordTurnUsage(ctx.db, row, meter).catch(err =>
    ctx.logger?.error({ err, sessionId: row.id }, 'session turn: could not record usage')
  )
  if (stop || overBudget || out.failure) return out

  const verdict = settled as PiSettlement | null
  if (verdict?.status === 'done') {
    out.result = {
      subtype: 'success',
      isError: false,
      durationMs: Math.max(0, Math.round(ctx.now() - startedAt)),
      usage: sessionUsageOf(meter),
      text:
        verdict.text !== undefined
          ? redactModelKeys(clipStrings(verdict.text, CLAUDE_RESULT_TEXT_MAX))
          : null,
    }
  } else {
    const reason = verdict?.reason ? `: ${verdict.reason}` : ''
    out.failure = clipStrings(redactModelKeyText(`Pi did not finish the turn${reason}`), 1_000)
  }
  return out
}

/** The conversation, as the object exports it (`sessions/<id>/pi.json`). */
export const piState: RuntimeStateStore = {
  key: piTranscriptKeyFor,
  contentType: 'application/json',
  async read(ctx) {
    const agent = agentOf(ctx)
    return agent ? agent.exportTranscript() : null
  },
  restorable: row => row.claudeSessionId === piResumeId(row.id),
  async restore(ctx, content) {
    const agent = agentOf(ctx)
    return agent ? agent.importTranscript(content) : false
  },
}

export const piRuntime: AgentRuntime = {
  id: 'pi',
  label: 'Pi',
  provider: 'workers_ai',
  placement: 'durable-object',
  // Nothing in the checkout: Pi's rules are its tools' (`workspace.ts`).
  workspaceFiles: () => [],
  runTurn: runPiTurn,
  async cancel(ctx) {
    // No object bound, nothing of a Pi turn can be running.
    await agentOf(ctx)?.abort()
  },
  state: piState,
}
