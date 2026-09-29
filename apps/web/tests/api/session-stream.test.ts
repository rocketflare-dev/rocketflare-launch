/**
 * `GET /api/sessions/:id/agui/stream` (Launch P3, slice 3c) — the live AG-UI tail of a session's
 * event log, and its projection.
 *
 * Split as the run stream's suite is: the ROUTE through the real Hono app for everything before
 * the first frame (404 for another tenant or a hidden session, 400 for a garbage cursor) and for
 * sessions that close at once (ended, shipped, failed); the LOOP as a plain function over a
 * recording sink with `{ now, sleep }` injected.
 */
import { RUN_STREAM_IDLE_CAP_MS, RUN_STREAM_POLL_MS } from '@launch/shared/ai/agents'
import { AguiEventType, type KitAguiEvent, kitAguiEventSchema } from '@launch/shared/ai/agui'
import {
  SESSION_CUSTOM_EVENTS,
  type SessionEventType,
  sessionCustomEventValueSchema,
} from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'
import {
  createSessionProjector,
  projectSessionToAgui,
} from '@/api/services/sessions/agui-projection'
import { toSessionEvent } from '@/api/services/sessions/event-log'
import { type SessionStreamSink, sessionStreamBody } from '@/api/services/sessions/session-stream'
import type { Database } from '@/db/client'
import { type SessionRow, sessionEvents } from '@/db/schema'
import { splitSseFrames } from '../helpers/ai'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { request } from '../helpers/request'
import { insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

async function addEvents(
  row: SessionRow,
  events: { type: SessionEventType; turn?: number; data: unknown }[],
  from = 1
) {
  await db.insert(sessionEvents).values(
    events.map((e, i) => ({
      sessionId: row.id,
      tenantId: row.tenantId,
      seq: from + i,
      turn: e.turn ?? 1,
      type: e.type,
      data: e.data,
    }))
  )
}

/** One finished turn: 7 rows. */
const TURN = [
  { type: 'user.message', data: { text: 'Change the heading', userId: null } },
  { type: 'turn.start', data: { turn: 1 } },
  { type: 'tool.start', data: { name: 'Edit', input: { file_path: 'a.tsx' }, toolCallId: 't1' } },
  { type: 'tool.end', data: { name: 'Edit', result: 'ok', isError: false, toolCallId: 't1' } },
  { type: 'text', data: { text: 'Changed.' } },
  { type: 'turn.end', data: { turn: 1, result: 'success', costMicrocents: 12 } },
  { type: 'preview.ready', turn: 0, data: { port: 5173 } },
] as const satisfies readonly { type: SessionEventType; turn?: number; data: unknown }[]

function recordingSink() {
  const chunks: string[] = []
  const decoder = new TextDecoder()
  return {
    chunks,
    aborted: false as boolean,
    async write(chunk: Uint8Array | string) {
      chunks.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk))
    },
    text: () => chunks.join(''),
  } satisfies SessionStreamSink & Record<string, unknown>
}

const eventsOf = (text: string): KitAguiEvent[] =>
  splitSseFrames(text)
    .filter(f => f.data)
    .map(f => kitAguiEventSchema.parse(JSON.parse(f.data)))

describe('the session projection', () => {
  it('maps a turn onto AG-UI, and the facts AG-UI has no event for onto launch.session.event', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ready' })
    await addEvents(row, [...TURN])
    const rows = (await db.select().from(sessionEvents)).filter(r => r.sessionId === row.id)
    rows.sort((a, b) => a.seq - b.seq)
    const events = projectSessionToAgui({ id: row.id, status: 'ready' }, rows.map(toSessionEvent))
    for (const e of events) expect(kitAguiEventSchema.safeParse(e).success).toBe(true)
    expect(events.map(e => (e.type === 'CUSTOM' ? `CUSTOM:${e.name}` : e.type))).toEqual([
      'RUN_STARTED',
      'STATE_SNAPSHOT',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'STEP_STARTED',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'STEP_FINISHED',
      `CUSTOM:${SESSION_CUSTOM_EVENTS.event}`,
      `CUSTOM:${SESSION_CUSTOM_EVENTS.event}`,
    ])
    // The user's message is a user-role message; the result pairs with its call.
    expect(events[2]).toMatchObject({ role: 'user' })
    const start = events.find(e => e.type === AguiEventType.TOOL_CALL_START)
    const result = events.find(e => e.type === AguiEventType.TOOL_CALL_RESULT)
    expect(result).toMatchObject({ toolCallId: (start as { toolCallId: string }).toolCallId })
    expect(events.at(-1)).toMatchObject({
      value: { type: 'preview.ready', data: { port: 5173 }, seq: 7 },
    })
    // Every CUSTOM value parses as the shared contract's row.
    for (const e of events.filter(e => e.type === AguiEventType.CUSTOM)) {
      expect(sessionCustomEventValueSchema.safeParse((e as { value: unknown }).value).success).toBe(
        true
      )
    }
    // Two projections of one log are byte-identical.
    expect(
      JSON.stringify(
        projectSessionToAgui({ id: row.id, status: 'ready' }, rows.map(toSessionEvent))
      )
    ).toBe(JSON.stringify(events))
  })

  it('a running step row for an OPEN step is progress: its detail, and no second STEP_STARTED', () => {
    const p = createSessionProjector({ id: 'x', status: 'booting' })
    let seq = 0
    const step = (status: string, detail?: string) =>
      p.push({
        id: crypto.randomUUID(),
        sessionId: 'x',
        seq: ++seq,
        turn: 0,
        type: 'step',
        data: { key: 'bootstrap', label: 'Installing and seeding', status, detail },
        at: new Date(),
      } as never)
    const frames = [
      ...step('running'),
      ...step('running', '✔ 4/10 database'),
      ...step('done'),
      ...step('running'),
    ]
    expect(frames.map(f => f.type)).toEqual([
      'STEP_STARTED',
      'CUSTOM',
      'CUSTOM',
      'STEP_FINISHED',
      'CUSTOM',
      'STEP_STARTED',
      'CUSTOM',
    ])
    expect(frames[2]).toMatchObject({ value: { status: 'running', detail: '✔ 4/10 database' } })
  })

  it('ends only with the SESSION: RUN_FINISHED when shipped or ended, RUN_ERROR when failed', () => {
    const p = createSessionProjector({ id: 'x', status: 'ready' })
    expect(p.finish({ id: 'x', status: 'ready' })).toEqual([])
    expect(p.finish({ id: 'x', status: 'suspended' })).toEqual([])
    expect(p.finish({ id: 'x', status: 'ended' })[0]).toMatchObject({ type: 'RUN_FINISHED' })
    expect(p.finish({ id: 'x', status: 'shipped' })[0]).toMatchObject({ type: 'RUN_FINISHED' })
    expect(p.finish({ id: 'x', status: 'failed', error: 'boom' })[0]).toEqual({
      type: 'RUN_ERROR',
      message: 'boom',
      code: 'session_failed',
    })
  })
})

describe('sessionStreamBody', () => {
  it('from 0: the head, every row with its id on the LAST frame of its group, then the terminal', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ended' })
    await addEvents(row, [...TURN])
    const sink = recordingSink()
    const outcome = await sessionStreamBody(
      { db, tenantId: row.tenantId, session: row, afterSeq: 0 },
      sink,
      { sleep: async () => {} }
    )
    expect(outcome).toBe('terminal')
    const frames = splitSseFrames(sink.text())
    // user.message is START → CONTENT → END: only END carries the id.
    const texts = frames.filter(fr => fr.data.includes('TEXT_MESSAGE'))
    expect(texts.slice(0, 3).map(fr => fr.id)).toEqual([null, null, '1'])
    expect(frames.map(fr => fr.id).filter(Boolean)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
    ])
    const events = eventsOf(sink.text())
    expect(events[0]?.type).toBe('RUN_STARTED')
    expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED', result: { status: 'ended' } })
    // No cursor on the terminal frame.
    expect(frames.at(-1)?.id).toBeNull()
  })

  it('afterSeq resumes after the cursor: no head, no replay', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'shipped' })
    await addEvents(row, [...TURN])
    const sink = recordingSink()
    await sessionStreamBody({ db, tenantId: row.tenantId, session: row, afterSeq: 5 }, sink, {
      sleep: async () => {},
    })
    const frames = splitSseFrames(sink.text())
    expect(frames.map(fr => fr.id).filter(Boolean)).toEqual(['6', '7'])
    const events = eventsOf(sink.text())
    expect(events.map(e => e.type)).not.toContain('RUN_STARTED')
    expect(events.map(e => e.type)).not.toContain('TEXT_MESSAGE_START')
  })

  it('a live session with nothing new closes at the idle cap with NO terminal event', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ready' })
    let clock = 0
    const sink = recordingSink()
    const outcome = await sessionStreamBody(
      { db, tenantId: row.tenantId, session: row, afterSeq: 0 },
      sink,
      {
        now: () => clock,
        sleep: async ms => {
          clock += Math.max(ms, RUN_STREAM_IDLE_CAP_MS / 4)
        },
      }
    )
    expect(outcome).toBe('idle_cap')
    const types = eventsOf(sink.text()).map(e => e.type)
    expect(types).not.toContain('RUN_ERROR')
    expect(types).not.toContain('RUN_FINISHED')
    expect(sink.text()).toContain(': ping')
  })

  it('picks up rows written while it waits', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'working' })
    const sink = recordingSink()
    let ticks = 0
    const outcome = await sessionStreamBody(
      { db, tenantId: row.tenantId, session: row, afterSeq: 0 },
      sink,
      {
        sleep: async ms => {
          expect(ms).toBe(RUN_STREAM_POLL_MS)
          ticks++
          if (ticks === 1) await addEvents(row, [{ type: 'text', data: { text: 'hello' } }])
          if (ticks === 2) sink.aborted = true
        },
      }
    )
    expect(outcome).toBe('aborted')
    expect(eventsOf(sink.text()).find(e => e.type === 'TEXT_MESSAGE_CONTENT')).toMatchObject({
      delta: 'hello',
    })
  })

  it('its own failure throws to the route (which logs and closes) — it never writes RUN_ERROR', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ready' })
    const broken = new Proxy(db, {
      get(target, prop) {
        if (prop === 'select') {
          return () => {
            throw new Error('database went away')
          }
        }
        return Reflect.get(target, prop)
      },
    }) as Database
    const sink = recordingSink()
    await expect(
      sessionStreamBody({ db: broken, tenantId: row.tenantId, session: row, afterSeq: 0 }, sink, {
        sleep: async () => {},
      })
    ).rejects.toThrow('database went away')
    expect(eventsOf(sink.text()).map(e => e.type)).toEqual(['RUN_STARTED', 'STATE_SNAPSHOT'])
  })
})

describe('GET /api/sessions/:id/agui/stream', () => {
  it('streams a settled session through the app and closes', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, {
      status: 'failed',
      error: 'The sandbox would not start',
    })
    await addEvents(row, [...TURN])
    const res = await request(`/api/sessions/${row.id}/agui/stream`, { headers: f.cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const events = eventsOf(await res.text())
    expect(events[0]?.type).toBe('RUN_STARTED')
    expect(events.at(-1)).toEqual({
      type: 'RUN_ERROR',
      message: 'The sandbox would not start',
      code: 'session_failed',
    })
  })

  it('?afterSeq= beats Last-Event-ID; a garbage cursor is a 400, a garbage header is ignored', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ended' })
    await addEvents(row, [...TURN])
    const both = await request(`/api/sessions/${row.id}/agui/stream?afterSeq=6`, {
      headers: { ...f.cookie, 'Last-Event-ID': '2' },
    })
    expect(
      splitSseFrames(await both.text())
        .map(fr => fr.id)
        .filter(Boolean)
    ).toEqual(['7'])
    const header = await request(`/api/sessions/${row.id}/agui/stream`, {
      headers: { ...f.cookie, 'Last-Event-ID': '5' },
    })
    expect(
      splitSseFrames(await header.text())
        .map(fr => fr.id)
        .filter(Boolean)
    ).toEqual(['6', '7'])
    const garbageHeader = await request(`/api/sessions/${row.id}/agui/stream`, {
      headers: { ...f.cookie, 'Last-Event-ID': 'x' },
    })
    expect(eventsOf(await garbageHeader.text())[0]?.type).toBe('RUN_STARTED')
    const bad = await request(`/api/sessions/${row.id}/agui/stream?afterSeq=banana`, {
      headers: f.cookie,
    })
    expect(bad.status).toBe(400)
  })

  it('another tenant’s session, or one the caller may not see, is a 404 before any frame', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const row = await insertSession(db, f, { status: 'ended' })

    const other = await createTestTenantWithUser(db, 'owner')
    const otherCookie = sessionCookieHeader(
      await createTestSession(db, other.user.id, other.tenant.id)
    )
    const cross = await request(`/api/sessions/${row.id}/agui/stream`, { headers: otherCookie })
    expect(cross.status).toBe(404)
    expect(await cross.json()).toMatchObject({ code: 'session_not_found' })

    const colleague = await createTestUser(db)
    await linkUserToTenant(db, colleague.id, f.tenant.id, 'member')
    const hidden = await request(`/api/sessions/${row.id}/agui/stream`, {
      headers: sessionCookieHeader(await createTestSession(db, colleague.id, f.tenant.id)),
    })
    expect(hidden.status).toBe(404)
    expect((await request(`/api/sessions/${row.id}/agui/stream`)).status).toBe(401)
    expect(
      (await request('/api/sessions/not-a-uuid/agui/stream', { headers: f.cookie })).status
    ).toBe(404)
    // The env is irrelevant to reads: no Workflow binding needed to watch.
    const noWorkflow = await request(
      `/api/sessions/${row.id}/agui/stream`,
      { headers: f.cookie },
      { env: createTestEnv({ SESSION_WORKFLOW: undefined }) }
    )
    expect(noWorkflow.status).toBe(200)
    await noWorkflow.text()
  })
})
