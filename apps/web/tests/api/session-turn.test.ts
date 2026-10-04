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
import {
  CONTAINER_LOST_BEFORE_TURN_MESSAGE,
  CONTAINER_LOST_MESSAGE,
  SESSION_BOOT_MARKER,
} from '@/api/services/sessions/boot-marker'
import { handleAnthropic, MODEL_KEY_PLACEHOLDER } from '@/api/services/sessions/egress/anthropic'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import {
  CONVERSATION_LOST_MESSAGE,
  createShipTurnRunner,
  type RunTurnOptions,
  runTurn,
  TURN_PID_FILE,
  terminateTurnProcess,
  transcriptCheckCommand,
  turnKillScript,
  turnStepConfig,
} from '@/api/services/sessions/turn'
import { auditEvents, type SessionRow, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { claudeStreamJson, createFakeAnthropic } from '../helpers/fake-anthropic'
import { createFakeCloud } from '../helpers/fake-cloud'
import { FakeSandbox } from '../helpers/fake-sandbox'
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
    expect(proc?.command).toContain('--model claude-sonnet-5')
    expect(proc?.command).not.toContain('--resume')
    // The session-system-note, filled in: where it is, and only targeted checks — never the gate.
    expect(proc?.command).toContain('--append-system-prompt')
    expect(proc?.command).toContain('inside a Launch coding session on')
    expect(proc?.command).toContain(`session/${row.shortId}`)
    expect(proc?.command).toContain('Never run the full gate')
    expect(proc?.command).not.toContain('{{')
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
          body: JSON.stringify({ model: 'claude-sonnet-5', stream: true }),
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
    // --append-system-prompt does not survive --resume: the resumed turn carries the note again.
    expect(sandbox.processes[1]?.command).toContain('--append-system-prompt')
    const events = await eventsOf(row)
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i + 1))
    const ends = events.filter(e => e.type === 'turn.end')
    expect(ends.map(e => e.turn)).toEqual([1, 2])
    expect(ends[1]?.data).toMatchObject({ costMicrocents: cost })
    expect((await reload(row)).turnCount).toBe(2)
  })

  it('a message that switches the model: the claim moves it onto the policy, the command and turn.start name it, and the proxy refuses the old one', async () => {
    const sandboxId = `fake-sandbox-${crypto.randomUUID()}`
    const { row } = await readySession({ sandboxId, pendingModel: 'claude-opus-5-5' })
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ sessionId: 'claude-sess-m', text: 'Done.' }))
    )
    expect((await runTurn(db, ports, row, FAST)).status).toBe('completed')

    const after = await reload(row)
    expect(after.pendingModel).toBeNull()
    expect(after.policy.model).toBe('claude-opus-5-5')
    // The rest of the snapshot is untouched.
    expect({ ...after.policy, model: row.policy.model }).toEqual(row.policy)
    expect(ports.sandboxes.get(row.id)?.processes[0]?.command).toContain('--model claude-opus-5-5')
    const start = (await eventsOf(row)).find(e => e.type === 'turn.start')
    expect(start?.data).toEqual({ turn: 1, model: 'claude-opus-5-5' })

    // The proxy re-reads the policy on every call: the new model passes, the old one is refused.
    const anthropic = createFakeAnthropic()
    const env = createTestEnv({ ANTHROPIC_API_KEY: 'sk-ant-api03-test-0000000000000000' })
    const call = (model: string) =>
      handleAnthropic(
        new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': MODEL_KEY_PLACEHOLDER },
          body: JSON.stringify({ model, stream: true }),
        }),
        env,
        { containerId: sandboxId },
        anthropic
      )
    const old = await call(row.policy.model)
    expect(old.status).toBe(403)
    await old.text()
    expect(anthropic.requests).toHaveLength(0)
    const current = await call('claude-opus-5-5')
    expect(current.status).toBe(200)
    await current.text()
    expect(anthropic.requests).toHaveLength(1)

    // The next turn, asking for nothing, stays on the switched model.
    await db
      .update(sessions)
      .set({ pendingMessage: 'And the subtitle' })
      .where(eq(sessions.id, row.id))
    await runTurn(db, ports, row, FAST)
    expect(ports.sandboxes.get(row.id)?.processes[1]?.command).toContain('--model claude-opus-5-5')
    const starts = (await eventsOf(row)).filter(e => e.type === 'turn.start')
    expect(starts.map(e => e.data)).toEqual([
      { turn: 1, model: 'claude-opus-5-5' },
      { turn: 2, model: 'claude-opus-5-5' },
    ])
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
    // The fake reports the killed process's exit, so there is nothing to escalate.
    expect(sandbox?.execs).toEqual([])
    const events = await eventsOf(row)
    expect(events.at(-1)).toMatchObject({
      type: 'turn.interrupted',
      data: { turn: 1, reason: 'cancelled' },
    })
    expect(events.map(e => e.type)).not.toContain('turn.end')
    expect(await reload(row)).toMatchObject({ status: 'ready', cancelRequestedAt: null })
  })

  it('a cancel whose exit Launch never sees is escalated by pid (SIGTERM → grace → SIGKILL)', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ text: 'Working on it', hang: true }))
    )
    const sb = ports.sandbox(row.id) as FakeSandbox
    // The SDK's kill "succeeds" but the process keeps running (the aborted reader sees no exit).
    sb.kill = async id => void sb.killed.push(id)
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
    expect(outcome).toMatchObject({ status: 'interrupted', reason: 'cancelled' })
    expect(sb.killed).toEqual([sb.processes[0]?.id]) // the SDK kill once, not twice
    expect(sb.execs.map(e => e.command)).toEqual([turnKillScript()])
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

  it('a lost log stream kills the process it can no longer read: turn.failed, back to ready', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts().script(sb =>
      sb
        .onProcess(/claude -p/, claudeStreamJson({ text: 'Working on it', hang: true }))
        .failNext('streamLogs', new Error('Network connection lost'))
    )
    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome.status).toBe('failed')
    const sandbox = ports.sandboxes.get(row.id)
    const proc = sandbox?.processes[0]
    expect(
      proc?.command.startsWith(`mkdir -p /workspace/.launch && echo $$ > ${TURN_PID_FILE}`)
    ).toBe(true)
    expect(proc?.command).toContain('&& exec claude -p ')
    // SIGTERM through the SDK, then the pid escalation (SIGTERM → grace → SIGKILL) in the box.
    expect(sandbox?.killed).toEqual([proc?.id])
    expect(sandbox?.execs.map(e => e.command)).toEqual([turnKillScript()])
    const last = (await eventsOf(row)).at(-1)
    expect(last).toMatchObject({
      type: 'turn.failed',
      data: { message: 'Launch lost the connection to Claude Code in the sandbox' },
    })
    expect((await reload(row)).status).toBe('ready')
  })

  it('stopping the process is bounded: a kill that never answers does not hold the turn', async () => {
    const sandbox = new FakeSandbox().hangNext('kill').hangNext('exec')
    const started = Date.now()
    await terminateTurnProcess(sandbox, 'proc-1', {
      sessionId: 's',
      reason: 'read-failed',
      callMs: 20,
    })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('a finished or rolled-out turn stops nothing', async () => {
    const done = await readySession()
    const ok = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ text: 'Done.' }))
    )
    await runTurn(db, ok, done.row, FAST)
    expect(ok.sandboxes.get(done.row.id)?.killed).toEqual([])
    expect(ok.sandboxes.get(done.row.id)?.execs).toEqual([])

    const rolled = await readySession()
    const gone = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ text: 'x' })).interruptNext()
    )
    await runTurn(db, gone, rolled.row, FAST)
    expect(gone.sandboxes.get(rolled.row.id)?.killed).toEqual([])
    expect(gone.sandboxes.get(rolled.row.id)?.execs).toEqual([])
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

describe('runTurn: a container that died under the session (its boot marker)', () => {
  const BOOT = 'boot-1'
  const withMarker = (sb: FakeSandbox) => sb.files.set(SESSION_BOOT_MARKER, BOOT)
  /** A fake clock the loops' sleeps move; `at(ms, fn)` runs `fn` once the clock passes `ms`. */
  function fakeTime() {
    let clock = 0
    const due: { ms: number; fn: () => void }[] = []
    return {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms
        for (const d of due.splice(0)) {
          if (clock >= d.ms) d.fn()
          else due.push(d)
        }
        await tick()
      },
      at: (ms: number, fn: () => void) => due.push({ ms, fn }),
      get clock() {
        return clock
      },
    }
  }
  const LONG = { cancelPollMs: 2_000, flushMs: 250, timeoutMs: 90 * 60_000, probeMs: 30_000 }

  it('a container that dies mid-turn (the stream goes quiet, the marker is gone) ends the turn at the next probe: container_lost → suspended', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts().script(sb =>
      withMarker(sb.onProcess(/claude -p/, claudeStreamJson({ text: 'Building…', hang: true })))
    )
    const time = fakeTime()
    // The container dies at 2 minutes: the stream goes quiet (no error, no end), and whatever
    // calls in next finds a fresh, empty container.
    time.at(120_000, () => ports.sandboxes.get(row.id)?.die())
    const outcome = await runTurn(db, ports, row, { ...FAST, ...LONG, ...time, bootId: BOOT })

    expect(outcome).toMatchObject({ status: 'interrupted', reason: 'container_lost', turn: 1 })
    // Promptly — within a probe of the death, not at the 90-minute timeout.
    expect(time.clock).toBeLessThan(120_000 + 2 * LONG.probeMs)
    const last = (await eventsOf(row)).at(-1)
    expect(last).toMatchObject({
      type: 'turn.interrupted',
      data: { turn: 1, reason: 'container_lost', message: CONTAINER_LOST_MESSAGE },
    })
    expect(SESSION_EVENT_DATA['turn.interrupted'].safeParse(last?.data).success).toBe(true)
    const after = await reload(row)
    expect(after.status).toBe('suspended')
    expect(after.suspendedAt).not.toBeNull()
    // Nothing to kill in a container that is gone.
    const sandbox = ports.sandboxes.get(row.id)
    expect(sandbox?.killed).toEqual([])
    expect(sandbox?.execs).toEqual([])
  })

  it('a container that stops answering is judged lost after TURN_LIVENESS_MAX_FAILURES silent probes', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts().script(sb =>
      withMarker(sb.onProcess(/claude -p/, claudeStreamJson({ hang: true })))
    )
    const time = fakeTime()
    let reads = 0
    time.at(60_000, () => {
      const sandbox = ports.sandboxes.get(row.id)
      if (!sandbox) return
      sandbox.readFile = async () => {
        reads += 1
        throw new Error('HTTP error! status: 500')
      }
    })
    const outcome = await runTurn(db, ports, row, {
      ...FAST,
      ...LONG,
      ...time,
      bootId: BOOT,
      probeFailures: 3,
    })
    expect(outcome).toMatchObject({ status: 'interrupted', reason: 'container_lost' })
    expect(reads).toBe(3)
    expect((await reload(row)).status).toBe('suspended')
  })

  it('a live container is probed and left alone: the turn runs to its end', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts().script(sb =>
      withMarker(sb.onProcess(/claude -p/, claudeStreamJson({ hang: true })))
    )
    const time = fakeTime()
    const outcome = await runTurn(db, ports, row, {
      ...FAST,
      ...LONG,
      ...time,
      timeoutMs: 10 * 60_000,
      bootId: BOOT,
    })
    // Ten minutes of probes found the marker every time: only the timeout ended it.
    expect(outcome).toMatchObject({ status: 'interrupted', reason: 'timeout' })
    expect((await reload(row)).status).toBe('ready')
  })

  it('a lost log stream on a container that came back empty is container_lost, not "lost the connection"', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts().script(sb =>
      withMarker(
        sb
          .onProcess(/claude -p/, claudeStreamJson({ text: 'x', hang: true }))
          .failNext('streamLogs', new Error('Network connection lost'))
      )
    )
    ports.script(sb => {
      const original = sb.streamLogs.bind(sb)
      sb.streamLogs = (id, opts) => {
        sb.files.delete(SESSION_BOOT_MARKER)
        return original(id, opts)
      }
    })
    const outcome = await runTurn(db, ports, row, { ...FAST, bootId: BOOT })
    expect(outcome).toMatchObject({ status: 'interrupted', reason: 'container_lost' })
    expect(ports.sandboxes.get(row.id)?.killed).toEqual([])
    expect((await reload(row)).status).toBe('suspended')
  })

  it('a turn on a container without its boot marker never starts: the message kept, suspended with a resume requested', async () => {
    const { row } = await readySession({ turnCount: 3 })
    const ports = createFakeSessionPorts()
    const outcome = await runTurn(db, ports, row, { ...FAST, bootId: BOOT })

    expect(outcome).toEqual({
      status: 'interrupted',
      sessionId: row.id,
      turn: 3,
      reason: 'container_lost',
      costMicrocents: 0,
    })
    expect(ports.sandboxes.get(row.id)?.processes).toHaveLength(0)
    expect(ports.sandboxes.get(row.id)?.commands).toEqual([])
    const after = await reload(row)
    expect(after).toMatchObject({
      status: 'suspended',
      requestedAction: 'resume',
      pendingMessage: 'Change the Home heading',
      turnCount: 3,
      containerKeptAt: null,
    })
    expect((await eventsOf(row)).map(e => [e.type, e.data])).toEqual([
      ['error', { message: CONTAINER_LOST_BEFORE_TURN_MESSAGE }],
    ])
  })

  it('a turn on its own container runs as before; an unanswered check is not evidence', async () => {
    const { row } = await readySession()
    const ports = createFakeSessionPorts().script(sb =>
      withMarker(sb.onProcess(/claude -p/, claudeStreamJson({ text: 'Done.' })))
    )
    expect(await runTurn(db, ports, row, { ...FAST, bootId: BOOT })).toMatchObject({
      status: 'completed',
    })

    const { row: busy } = await readySession()
    const slow = createFakeSessionPorts().script(sb =>
      withMarker(
        sb
          .onProcess(/claude -p/, claudeStreamJson({ text: 'Done.' }))
          .failNext('readFile', new Error('HTTP error! status: 503'))
      )
    )
    expect(await runTurn(db, slow, busy, { ...FAST, bootId: BOOT })).toMatchObject({
      status: 'completed',
    })
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

describe('runTurn: a conversation that cannot be resumed never breaks the session', () => {
  /** What Claude Code prints for `--resume <id>` when that session is not there. */
  const REFUSED_RESUME = [
    JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 0,
      session_id: 'claude-fresh-by-the-cli',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }),
  ]

  it('a --resume that ends at once (error_during_execution, no tokens, nothing said) is retried ONCE as a new conversation', async () => {
    const { row } = await readySession({ claudeSessionId: 'claude-lost-1' })
    const ports = createFakeSessionPorts().script(sb =>
      sb
        .onProcess(/--resume claude-lost-1/, { lines: REFUSED_RESUME, exitCode: 1 })
        .onProcess(/claude -p/, claudeStreamJson({ sessionId: 'claude-new-1', text: 'Done.' }))
    )
    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome).toMatchObject({ status: 'completed', turn: 1 })

    const sandbox = ports.sandboxes.get(row.id) as FakeSandbox
    expect(sandbox.processes.map(p => p.command.includes('--resume'))).toEqual([true, false])
    const events = await eventsOf(row)
    expect(events.map(e => e.type)).toEqual([
      'user.message',
      'turn.start',
      'error',
      'text',
      'turn.end',
    ])
    expect(events[2]?.data).toEqual({ message: CONVERSATION_LOST_MESSAGE })
    expect(events.at(-1)?.data).toMatchObject({ result: 'success' })
    expect(await reload(row)).toMatchObject({ status: 'ready', claudeSessionId: 'claude-new-1' })
  })

  it('a turn that did work before failing is NOT re-run', async () => {
    const { row } = await readySession({ claudeSessionId: 'claude-kept-1' })
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(
        /claude -p/,
        claudeStreamJson({
          sessionId: 'claude-kept-1',
          text: 'Halfway.',
          subtype: 'error_during_execution',
        })
      )
    )
    await runTurn(db, ports, row, FAST)
    const sandbox = ports.sandboxes.get(row.id) as FakeSandbox
    expect(sandbox.processes).toHaveLength(1)
    expect((await eventsOf(row)).map(e => e.type)).not.toContain('error')
    expect((await reload(row)).claudeSessionId).toBe('claude-kept-1')
  })

  it('a transcript the container does not hold: no --resume at all, the id forgotten, and the person told', async () => {
    const { row } = await readySession({ claudeSessionId: 'claude-lost-2' })
    const ports = createFakeSessionPorts().script(sb =>
      sb
        .onExec(transcriptCheckCommand('claude-lost-2'), { exitCode: 1 })
        .onProcess(/claude -p/, claudeStreamJson({ sessionId: 'claude-new-2', text: 'Done.' }))
    )
    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome).toMatchObject({ status: 'completed' })
    const sandbox = ports.sandboxes.get(row.id) as FakeSandbox
    expect(sandbox.processes).toHaveLength(1)
    expect(sandbox.processes[0]?.command).not.toContain('--resume')
    const errors = (await eventsOf(row)).filter(e => e.type === 'error')
    expect(errors.map(e => e.data)).toEqual([{ message: CONVERSATION_LOST_MESSAGE }])
    expect((await reload(row)).claudeSessionId).toBe('claude-new-2')
  })
})
