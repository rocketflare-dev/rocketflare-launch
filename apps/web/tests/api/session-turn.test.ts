/**
 * One chat turn (`services/sessions/turn.ts` `runTurn`, Launch P3 slice 3c), driven directly the way
 * the Workflow's `turn#N` step will: a `sessions` row with a pending message, a `FakeSandbox` whose
 * `claude -p` prints scripted stream-json (`claudeStreamJson`), and the step's own DB client.
 *
 * Covers the event order, the resume id, batching, the metered cost, a cancel (the process is
 * killed), the timeout, a rollout (`SandboxInterruptedError` → `suspended`), a process that dies
 * without a result, the budget gate (→ `blocked`, nothing started) and that no key or placeholder
 * ever lands in an event. The clock and the timers are injected; `tick` yields to the event loop so
 * the watch loops do not starve the stream.
 */
import { SESSION_EVENT_DATA, usdToMicrocents } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { handleAnthropic, MODEL_KEY_PLACEHOLDER } from '@/api/services/sessions/egress/anthropic'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import {
  createShipTurnRunner,
  type RunTurnOptions,
  runTurn,
  turnStepConfig,
} from '@/api/services/sessions/turn'
import { auditEvents, type SessionRow, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { claudeStreamJson, createFakeAnthropic } from '../helpers/fake-anthropic'
import { createFakeCloud } from '../helpers/fake-cloud'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import { createFakeSessionPorts, insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))
const FAST: RunTurnOptions = { sleep: tick, cancelPollMs: 5, flushMs: 5 }

async function readySession(overrides: Parameters<typeof insertSession>[2] = {}) {
  const f = await seedSessionApp(db, createFakeCloud())
  const row = await insertSession(db, f, {
    status: 'ready',
    pendingMessage: 'Change the Home heading',
    ...overrides,
  })
  return { f, row }
}

async function reload(row: SessionRow): Promise<SessionRow> {
  const [latest] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
  if (!latest) throw new Error('gone')
  return latest
}

const eventsOf = (row: SessionRow) => listSessionEvents(db, row.tenantId, row.id)

describe('runTurn: a turn that finishes', () => {
  it('writes user.message → turn.start → tools → text → turn.end in order, and goes back to ready', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(
        /claude -p/,
        claudeStreamJson({
          sessionId: 'claude-sess-1',
          tools: [
            { name: 'Read', input: { file_path: 'src/ui/pages/Home.tsx' }, result: '<h1>Hi</h1>' },
            { name: 'Edit', input: { file_path: 'src/ui/pages/Home.tsx' }, result: 'ok' },
          ],
          text: 'Changed the heading.',
          usage: { input: 6, output: 115, cacheRead: 40131, cacheWrite: 4865 },
        })
      )
    )

    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome).toEqual({
      status: 'completed',
      sessionId: row.id,
      turn: 1,
      costMicrocents: 0,
    })

    const events = await eventsOf(row)
    expect(events.map(e => e.type)).toEqual([
      'user.message',
      'turn.start',
      'tool.start',
      'tool.end',
      'tool.start',
      'tool.end',
      'text',
      'turn.end',
    ])
    expect(events.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(events.every(e => e.turn === 1)).toBe(true)
    for (const e of events) {
      expect(SESSION_EVENT_DATA[e.type].safeParse(e.data).success, e.type).toBe(true)
    }
    expect(events[0]?.data).toEqual({
      text: 'Change the Home heading',
      userId: row.createdByUserId,
    })
    expect(events.at(-1)?.data).toEqual({
      turn: 1,
      result: 'success',
      durationMs: 6500,
      usage: { tokensIn: 6, tokensOut: 115, cacheRead: 40131, cacheWrite: 4865 },
      costMicrocents: 0,
    })

    const after = await reload(row)
    expect(after).toMatchObject({
      status: 'ready',
      turnCount: 1,
      pendingMessage: null,
      claudeSessionId: 'claude-sess-1',
    })

    // The process ran the policy's model in the checkout with the placeholder only.
    const sandbox = ports.sandboxes.get(row.id)
    const proc = sandbox?.processes[0]
    expect(proc?.command).toContain("claude -p 'Change the Home heading'")
    expect(proc?.command).toContain('--model claude-sonnet-4-5')
    expect(proc?.command).not.toContain('--resume')
    expect(proc?.opts?.cwd).toBe('/workspace/app')
    expect(proc?.opts?.env?.ANTHROPIC_API_KEY).toBe(MODEL_KEY_PLACEHOLDER)
  })

  it('the next turn resumes Claude’s session and continues the seq; the turn’s cost is what was metered', async () => {
    const sandboxId = `fake-sandbox-${crypto.randomUUID()}`
    const { row } = await readySession({ sandboxId, claudeSessionId: 'claude-sess-9' })
    const anthropic = createFakeAnthropic({ usage: { input: 1000, output: 500 } })
    const env = createTestEnv({ ANTHROPIC_API_KEY: 'sk-ant-api03-test-0000000000000000' })
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ sessionId: 'claude-sess-9', text: 'Done.' }))
    )
    // The container's model call goes through the proxy while the process runs.
    const sandbox = ports.sandbox(row.id) as FakeSandbox
    const start = sandbox.startProcess.bind(sandbox)
    sandbox.startProcess = async (command, opts) => {
      const res = await handleAnthropic(
        new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': MODEL_KEY_PLACEHOLDER },
          body: JSON.stringify({ model: 'claude-sonnet-4-5', stream: true }),
        }),
        env,
        { containerId: sandboxId },
        anthropic
      )
      await res.text()
      return start(command, opts)
    }

    await runTurn(db, ports, row, FAST)
    await db
      .update(sessions)
      .set({ pendingMessage: 'And the subtitle' })
      .where(eq(sessions.id, row.id))
    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome.status).toBe('completed')
    const cost = (outcome as { costMicrocents: number }).costMicrocents
    expect(cost).toBeGreaterThan(0)

    expect(sandbox.processes[1]?.command).toContain('--resume claude-sess-9')
    const events = await eventsOf(row)
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i + 1))
    const ends = events.filter(e => e.type === 'turn.end')
    expect(ends.map(e => e.turn)).toEqual([1, 2])
    expect(ends[1]?.data).toMatchObject({ costMicrocents: cost })
    expect((await reload(row)).turnCount).toBe(2)
  })

  it('writes a long burst in batches, in order', async () => {
    const { row } = await readySession()
    const texts = Array.from({ length: 60 }, (_, i) => `line ${i}`)
    const lines = texts.map(text =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
    )
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, {
        lines: [...lines, JSON.stringify({ type: 'result', subtype: 'success', session_id: 's' })],
      })
    )
    await runTurn(db, ports, row, { ...FAST, flushEvery: 7 })
    const events = await eventsOf(row)
    expect(
      events.filter(e => e.type === 'text').map(e => (e.data as { text: string }).text)
    ).toEqual(texts)
    expect(events.at(-1)?.type).toBe('turn.end')
  })

  it('never writes the placeholder or a key into an event', async () => {
    const { row } = await readySession({
      pendingMessage: `my key is sk-ant-api03-leaked-by-a-person-000`,
    })
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(
        /claude -p/,
        claudeStreamJson({
          tools: [
            {
              name: 'Bash',
              input: { command: 'env' },
              result: `ANTHROPIC_API_KEY=${MODEL_KEY_PLACEHOLDER}\nHOME=/root`,
            },
          ],
          text: `The key is ${MODEL_KEY_PLACEHOLDER}`,
        })
      )
    )
    await runTurn(db, ports, row, FAST)
    const text = JSON.stringify(await eventsOf(row))
    expect(text).not.toContain(MODEL_KEY_PLACEHOLDER)
    expect(text).not.toContain('sk-ant-')
    expect(text).toContain('[redacted]')
  })
})

describe('runTurn: a turn that does not finish', () => {
  it('a cancel kills the process: turn.interrupted { cancelled }, back to ready', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ text: 'Working on it', hang: true }))
    )
    // The route's write, once the turn is running (the claim clears any earlier one).
    const sb = ports.sandbox(row.id)
    const start = sb.startProcess.bind(sb)
    sb.startProcess = async (command, opts) => {
      const proc = await start(command, opts)
      await db
        .update(sessions)
        .set({ cancelRequestedAt: new Date() })
        .where(and(eq(sessions.id, row.id), eq(sessions.status, 'working')))
      return proc
    }
    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome).toMatchObject({ status: 'interrupted', reason: 'cancelled', turn: 1 })
    const sandbox = ports.sandboxes.get(row.id)
    expect(sandbox?.killed).toEqual([sandbox?.processes[0]?.id])
    const events = await eventsOf(row)
    expect(events.at(-1)).toMatchObject({
      type: 'turn.interrupted',
      data: { turn: 1, reason: 'cancelled' },
    })
    expect(events.map(e => e.type)).not.toContain('turn.end')
    expect(await reload(row)).toMatchObject({ status: 'ready', cancelRequestedAt: null })
  })

  it('the turn timeout kills the process: turn.interrupted { timeout }', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ hang: true }))
    )
    let clock = 0
    const outcome = await runTurn(db, ports, row, {
      ...FAST,
      now: () => clock,
      sleep: async ms => {
        clock += ms
        await tick()
      },
      cancelPollMs: 2_000,
      flushMs: 250,
      timeoutMs: 10_000,
    })
    expect(outcome).toMatchObject({ status: 'interrupted', reason: 'timeout' })
    expect(ports.sandboxes.get(row.id)?.killed).toHaveLength(1)
    expect((await eventsOf(row)).at(-1)?.data).toEqual({ turn: 1, reason: 'timeout' })
    expect((await reload(row)).status).toBe('ready')
  })

  it('a running turn writes the heartbeat the reconcile reads, only while working', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ hang: true }))
    )
    const base = Date.parse('2030-01-01T00:00:00Z')
    let clock = base
    const beats: number[] = []
    await runTurn(db, ports, row, {
      ...FAST,
      now: () => clock,
      sleep: async ms => {
        clock += ms
        await tick()
        const current = await reload(row)
        if (current.status === 'working' && current.lastActivityAt) {
          beats.push(current.lastActivityAt.getTime() - base)
        }
      },
      cancelPollMs: 2_000,
      flushMs: 250,
      heartbeatMs: 4_000,
      timeoutMs: 10_000,
    })
    // The claim's own write is 0; the watcher moves it every 4 s while the process runs.
    expect(beats.some(ms => ms >= 4_000 && ms < 10_000)).toBe(true)
    expect((await reload(row)).status).toBe('ready')
  })

  it('a rollout mid-turn: turn.interrupted { rollout } and the session is suspended', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ text: 'x' })).interruptNext()
    )
    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome).toMatchObject({ status: 'interrupted', reason: 'rollout' })
    expect((await eventsOf(row)).at(-1)).toMatchObject({
      type: 'turn.interrupted',
      data: { reason: 'rollout' },
    })
    const after = await reload(row)
    expect(after.status).toBe('suspended')
    expect(after.suspendedAt).not.toBeNull()
  })

  it('a process that exits without a result is turn.failed', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, { lines: ['not json at all'], exitCode: 1 })
    )
    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome.status).toBe('failed')
    const last = (await eventsOf(row)).at(-1)
    expect(last?.type).toBe('turn.failed')
    expect(JSON.stringify(last?.data)).toContain('code 1')
    expect((await reload(row)).status).toBe('ready')
  })

  it('a process that will not start is turn.failed, not a thrown step', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts().script(sb =>
      sb.failNext('startProcess', new Error('container unreachable'))
    )
    expect((await runTurn(db, ports, row, FAST)).status).toBe('failed')
    expect((await eventsOf(row)).map(e => e.type)).toEqual([
      'user.message',
      'turn.start',
      'turn.failed',
    ])
  })
})

describe('runTurn: the gates before a turn', () => {
  it('over budget: blocked, budget.reached, audited, the message kept, nothing started', async () => {
    const { row } = await readySession({ costMicrocents: usdToMicrocents(10) })
    const ports = createFakeSessionPorts()
    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome).toEqual({ status: 'blocked', sessionId: row.id, scope: 'session' })
    expect(ports.sandboxes.get(row.id)?.processes ?? []).toHaveLength(0)
    const events = await eventsOf(row)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'budget.reached',
      data: {
        scope: 'session',
        spentMicrocents: usdToMicrocents(10),
        capMicrocents: usdToMicrocents(10),
      },
    })
    const after = await reload(row)
    expect(after).toMatchObject({ status: 'blocked', pendingMessage: 'Change the Home heading' })
    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, row.tenantId), eq(auditEvents.targetId, row.id)))
    expect(audits.map(a => a.action)).toEqual(['session.budget.reached'])

    // Blocked again: no second event, no second audit.
    await runTurn(db, ports, after, FAST)
    expect(await eventsOf(row)).toHaveLength(1)
  })

  it('nothing pending, or not ready: skipped, nothing written', async () => {
    const ports = createFakeSessionPorts()
    const { row: idle } = await readySession({ pendingMessage: null })
    expect((await runTurn(db, ports, idle, FAST)).status).toBe('skipped')
    const { row: booting } = await readySession({ status: 'booting' })
    expect((await runTurn(db, ports, booting, FAST)).status).toBe('skipped')
    expect(await eventsOf(idle)).toHaveLength(0)
    expect(await eventsOf(booting)).toHaveLength(0)
  })

  it('at maxTurns: rejected, the message dropped, an error event', async () => {
    const { row } = await readySession({ turnCount: 100 })
    const outcome = await runTurn(db, createFakeSessionPorts(), row, FAST)
    expect(outcome).toEqual({ status: 'rejected', sessionId: row.id, reason: 'max_turns' })
    expect((await reload(row)).pendingMessage).toBeNull()
    expect((await eventsOf(row))[0]?.type).toBe('error')
  })

  it('the step config: no retries, and a timeout past the turn’s own', () => {
    expect(turnStepConfig({ maxTurnMinutes: 20 })).toEqual({
      retries: { limit: 0, delay: '1 second' },
      timeout: '22 minutes',
    })
  })
})

describe('the ship turn (createShipTurnRunner, for slice 3d’s ship())', () => {
  const SHIP_JSON = JSON.stringify({ title: 'Change the heading', body: 'What changed.' })

  it('runs Launch’s prompt as a turn while shipping: no user.message, status untouched, the answer returned', async () => {
    const { row } = await readySession({
      status: 'shipping',
      pendingMessage: null,
      claudeSessionId: 'claude-sess-2',
      turnCount: 3,
    })
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ sessionId: 'claude-sess-2', text: SHIP_JSON }))
    )
    const ship = createShipTurnRunner(db, ports, FAST)
    const result = await ship({ message: 'Run the gate, then print JSON', session: row })
    expect(result).toEqual({ outcome: 'completed', turn: 4, text: SHIP_JSON })

    const events = await eventsOf(row)
    expect(events.map(e => e.type)).toEqual(['turn.start', 'text', 'turn.end'])
    expect(events.every(e => e.turn === 4)).toBe(true)
    expect(await reload(row)).toMatchObject({ status: 'shipping', turnCount: 4 })
    const proc = (ports.sandboxes.get(row.id) as FakeSandbox).processes[0]
    expect(proc?.command).toContain("claude -p 'Run the gate, then print JSON'")
    expect(proc?.command).toContain('--resume claude-sess-2')
  })

  it('a failed gate, a cancel and a rollout come back as outcomes; over budget never starts', async () => {
    const failing = await readySession({ status: 'shipping', pendingMessage: null })
    const failPorts = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ subtype: 'error_max_turns', text: 'gave up' }))
    )
    expect(
      await createShipTurnRunner(db, failPorts, FAST)({ message: 'go', session: failing.row })
    ).toMatchObject({ outcome: 'failed', text: 'gave up' })

    const rolled = await readySession({ status: 'shipping', pendingMessage: null })
    const rollPorts = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ text: 'x' })).interruptNext()
    )
    const rollout = await createShipTurnRunner(
      db,
      rollPorts,
      FAST
    )({
      message: 'go',
      session: rolled.row,
    })
    expect(rollout.outcome).toBe('interrupted')
    expect((await reload(rolled.row)).status).toBe('shipping')

    const cancelled = await readySession({ status: 'shipping', pendingMessage: null })
    const cancelPorts = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ hang: true }))
    )
    const sb = cancelPorts.sandbox(cancelled.row.id) as FakeSandbox
    const start = sb.startProcess.bind(sb)
    sb.startProcess = async (command, opts) => {
      const proc = await start(command, opts)
      await db
        .update(sessions)
        .set({ cancelRequestedAt: new Date() })
        .where(eq(sessions.id, cancelled.row.id))
      return proc
    }
    const cancel = await createShipTurnRunner(
      db,
      cancelPorts,
      FAST
    )({
      message: 'go',
      session: cancelled.row,
    })
    expect(cancel.outcome).toBe('cancelled')

    const broke = await readySession({
      status: 'shipping',
      pendingMessage: null,
      costMicrocents: usdToMicrocents(10),
    })
    const brokePorts = createFakeSessionPorts()
    expect(
      await createShipTurnRunner(db, brokePorts, FAST)({ message: 'go', session: broke.row })
    ).toEqual({ outcome: 'failed', turn: 0 })
    expect(brokePorts.sandboxes.get(broke.row.id)?.processes ?? []).toHaveLength(0)
    expect((await eventsOf(broke.row)).map(e => e.type)).toEqual(['budget.reached'])
  })
})
