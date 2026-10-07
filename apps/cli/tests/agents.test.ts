/**
 * `launch agents …` (issue #6), in-process against a fake fetch: --json prints the parsed body,
 * 403 exits 3, 404 exits 1, and `logs --follow` polls `/agui` until a terminal event — printing
 * only what is new each time, exit 1 on RUN_ERROR, exit 0 on RUN_FINISHED or a parked run.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  runAgentsCancel,
  runAgentsInterrupts,
  runAgentsList,
  runAgentsLogs,
  runAgentsRun,
  runAgentsRuns,
  runAgentsStart,
} from '../src/commands/agents'
import { EXIT_ERROR, EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
import {
  captureError,
  jsonResponse,
  mockFetch,
  TENANT_ID,
  TEST_KEY,
  tempStore,
  testContext,
  USER_ID,
} from './helpers'

const SERVER = 'http://server.test'
const RUN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const EVENT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

async function loggedInStore() {
  const t = await tempStore()
  cleanups.push(t.cleanup)
  await t.store.save({ serverUrl: SERVER, apiKey: TEST_KEY, tenantId: TENANT_ID, tenantName: 'A' })
  return t.store
}

const run = (over: Record<string, unknown> = {}) => ({
  id: RUN,
  tenantId: TENANT_ID,
  agentKey: 'research-topic',
  status: 'succeeded',
  input: { topic: 'x' },
  output: { summary: 'done' },
  error: null,
  requestedByUserId: USER_ID,
  instanceId: RUN,
  attempt: 1,
  startedAt: '2026-10-01T10:00:00.000Z',
  finishedAt: '2026-10-01T10:00:05.000Z',
  cancelRequestedAt: null,
  createdAt: '2026-10-01T09:59:59.000Z',
  ...over,
})

const page = (items: unknown[]) => ({
  items,
  pagination: { page: 1, pageSize: 25, total: items.length, totalPages: 1 },
})

const forbidden = () =>
  jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403)

describe('agents ls / runs', () => {
  it('ls --json prints the registry; runs forwards its filters', async () => {
    const store = await loggedInStore()
    const registry = {
      items: [
        {
          key: 'research-topic',
          title: 'Research',
          description: 'Looks things up',
          promptKey: 'research-topic',
          exclusive: false,
          approvers: 'requester',
        },
      ],
    }
    const { fetch, calls } = mockFetch({
      '/api/agents': () => jsonResponse(registry),
      '/api/agents/runs': () => jsonResponse(page([run()])),
    })
    const a = await testContext({ store, fetch, json: true })
    await runAgentsList(a.ctx)
    expect(JSON.parse(a.out.content())).toEqual(registry)

    const b = await testContext({ store, fetch })
    await runAgentsRuns(b.ctx, { agent: 'research-topic', status: 'failed', limit: 5 })
    expect(Object.fromEntries(calls[1]?.url.searchParams ?? [])).toEqual({
      agentKey: 'research-topic',
      status: 'failed',
      pageSize: '5',
    })
    expect(b.out.content()).toContain(RUN)
    expect(b.out.content()).toContain('5.0s')
  })

  it('403 → exit 3', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({ '/api/agents/runs': forbidden })
    const { ctx } = await testContext({ store, fetch })
    expect(exitCodeFor(await captureError(runAgentsRuns(ctx)))).toBe(EXIT_FORBIDDEN)
  })
})

describe('agents run <id>', () => {
  const detail = run({
    status: 'failed',
    output: null,
    error: 'model refused',
    events: [
      {
        id: EVENT,
        runId: RUN,
        seq: 1,
        type: 'step',
        data: { key: 'search', label: 'Searching', status: 'running' },
        at: '2026-10-01T10:00:01.000Z',
      },
      {
        id: EVENT,
        runId: RUN,
        seq: 2,
        type: 'step',
        data: { key: 'search', label: 'Searching', status: 'error', detail: 'no hits' },
        at: '2026-10-01T10:00:02.000Z',
      },
    ],
    interrupts: [],
    artifacts: [],
  })

  it('prints status, the latest step state, the error and the trace with its tokens', async () => {
    const store = await loggedInStore()
    const trace = {
      traceId: 'f'.repeat(32),
      name: 'agent research-topic',
      status: 'error',
      startedAt: '2026-10-01T10:00:00.000Z',
      endedAt: '2026-10-01T10:00:05.000Z',
      durationMs: 5000,
      spanCount: 3,
      errorCount: 1,
      inputTokens: 120,
      outputTokens: 40,
      runId: RUN,
      conversationId: null,
      userId: USER_ID,
      traceUrl: null,
      models: [],
    }
    const { fetch, calls } = mockFetch({
      [`/api/agents/runs/${RUN}`]: () => jsonResponse(detail),
      '/api/traces': () => jsonResponse(page([trace])),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runAgentsRun(ctx, RUN)
    const text = out.content()
    expect(text).toContain('failed')
    expect(text).toContain('Searching — no hits')
    expect(text).not.toContain('…')
    expect(text).toContain('Error: model refused')
    expect(text).toContain('120→40 tokens')
    expect(text).toContain(`launch traces show ${'f'.repeat(32)}`)
    expect(calls[1]?.url.searchParams.get('runId')).toBe(RUN)
  })

  it('a member (403 on traces) still sees the run; --json is the run body alone', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      [`/api/agents/runs/${RUN}`]: () => jsonResponse(detail),
      '/api/traces': forbidden,
    })
    const a = await testContext({ store, fetch })
    await runAgentsRun(a.ctx, RUN)
    expect(a.out.content()).toContain(`launch traces show ${RUN}`)

    const b = await testContext({ store, fetch, json: true })
    await runAgentsRun(b.ctx, RUN)
    expect(JSON.parse(b.out.content())).toEqual(detail)
    expect(calls).toHaveLength(3) // --json skips the trace lookup
  })

  it('404 → exit 1', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({})
    const { ctx } = await testContext({ store, fetch })
    const error = await captureError(runAgentsRun(ctx, RUN))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
  })
})

const head = [
  { type: 'RUN_STARTED', threadId: RUN, runId: RUN },
  { type: 'STATE_SNAPSHOT', snapshot: { runId: RUN, status: 'running' } },
]
const step = (label: string, status: string) => ({
  type: 'CUSTOM',
  name: 'kit.agent.step',
  value: { key: label, label, status },
})

describe('agents logs <id>', () => {
  it('prints the projection as lines; --json the body', async () => {
    const store = await loggedInStore()
    const body = {
      events: [
        ...head,
        step('Searching', 'running'),
        { type: 'TOOL_CALL_START', toolCallId: EVENT, toolCallName: 'search_knowledge' },
        { type: 'TOOL_CALL_ARGS', toolCallId: EVENT, delta: '{"q":"x"}' },
        { type: 'TOOL_CALL_RESULT', messageId: EVENT, toolCallId: EVENT, content: '{"hits":0}' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: EVENT, delta: 'Nothing found.' },
        { type: 'RUN_FINISHED', threadId: RUN, runId: RUN, result: null },
      ],
      lastSeq: 4,
    }
    const { fetch } = mockFetch({ [`/api/agents/runs/${RUN}/agui`]: () => jsonResponse(body) })
    const a = await testContext({ store, fetch })
    await runAgentsLogs(a.ctx, RUN)
    const text = a.out.content()
    expect(text).toContain('… Searching')
    expect(text).toContain('→ search_knowledge')
    expect(text).toContain('in:  {"q":"x"}')
    expect(text).toContain('Nothing found.')
    expect(text).toContain('✓ finished')

    const b = await testContext({ store, fetch, json: true })
    await runAgentsLogs(b.ctx, RUN)
    expect(JSON.parse(b.out.content())).toEqual(body)
  })

  it('--follow prints only new events each poll and exits 1 on RUN_ERROR', async () => {
    const store = await loggedInStore()
    const bodies = [
      { events: [...head, step('Searching', 'running')], lastSeq: 1 },
      { events: [...head, step('Searching', 'running')], lastSeq: 1 },
      {
        events: [
          ...head,
          step('Searching', 'running'),
          step('Searching', 'error'),
          { type: 'RUN_ERROR', message: 'model refused', code: 'agent_run_failed' },
        ],
        lastSeq: 2,
      },
    ]
    let i = 0
    const { fetch, calls } = mockFetch({
      [`/api/agents/runs/${RUN}/agui`]: () => jsonResponse(bodies[Math.min(i++, 2)]),
    })
    const sleeps: number[] = []
    const { ctx, out } = await testContext({ store, fetch })
    const error = await captureError(
      runAgentsLogs(ctx, RUN, { follow: true, pollMs: 7, sleep: async ms => void sleeps.push(ms) })
    )
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toContain('failed: model refused')
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([7, 7])
    const text = out.content()
    expect(text.match(/… Searching/g)).toHaveLength(1)
    expect(text).toContain('✗ Searching')
    expect(text).toContain('✗ model refused (agent_run_failed)')
  })

  it('--follow stops (exit 0) when the run parks on a question; --json prints one document', async () => {
    const store = await loggedInStore()
    const parked = {
      events: [
        ...head,
        {
          type: 'RUN_FINISHED',
          threadId: RUN,
          runId: RUN,
          outcome: { type: 'interrupt', interrupts: [{ id: EVENT, reason: 'confirmation' }] },
        },
      ],
      lastSeq: 3,
    }
    const { fetch } = mockFetch({ [`/api/agents/runs/${RUN}/agui`]: () => jsonResponse(parked) })
    const a = await testContext({ store, fetch })
    await runAgentsLogs(a.ctx, RUN, { follow: true, sleep: async () => {} })
    expect(a.out.content()).toContain('waiting on 1 answer(s)')
    expect(a.out.content()).toContain('launch agents interrupts')

    const b = await testContext({ store, fetch, json: true })
    await runAgentsLogs(b.ctx, RUN, { follow: true, sleep: async () => {} })
    expect(JSON.parse(b.out.content())).toEqual(parked)
  })
})

describe('agents interrupts / cancel / start', () => {
  it('interrupts --json prints the inbox page', async () => {
    const store = await loggedInStore()
    const inbox = page([
      {
        id: EVENT,
        tenantId: TENANT_ID,
        runId: RUN,
        key: 'confirm-send',
        kind: 'approval',
        reason: 'confirmation',
        message: 'Send the email?',
        toolCallId: null,
        responseSchema: null,
        spec: { kind: 'approval', message: 'Send the email?' },
        status: 'pending',
        payload: null,
        resolvedByUserId: null,
        resolvedAt: null,
        expiresAt: null,
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-01T10:00:00.000Z',
        run: {
          id: RUN,
          agentKey: 'research-topic',
          status: 'awaiting_input',
          requestedByUserId: USER_ID,
          createdAt: '2026-10-01T09:59:59.000Z',
        },
        canAnswer: true,
      },
    ])
    const { fetch, calls } = mockFetch({ '/api/agents/interrupts': () => jsonResponse(inbox) })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runAgentsInterrupts(ctx, { status: 'pending' })
    expect(calls[0]?.url.searchParams.get('status')).toBe('pending')
    expect(JSON.parse(out.content())).toEqual(inbox)
  })

  it('cancel posts and says what happened; 404 → exit 1', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      [`/api/agents/runs/${RUN}/cancel`]: () =>
        jsonResponse(run({ status: 'running', cancelRequestedAt: '2026-10-01T10:00:03.000Z' })),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runAgentsCancel(ctx, RUN)
    expect(calls[0]?.init.method).toBe('POST')
    expect(out.content()).toContain('Cancel requested')

    const missing = await testContext({ store, fetch: mockFetch({}).fetch })
    expect(exitCodeFor(await captureError(runAgentsCancel(missing.ctx, RUN)))).toBe(EXIT_ERROR)
  })

  it('start posts { agentKey, input } and refuses non-JSON input before any request', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/agents/runs': () =>
        jsonResponse({ ...run({ status: 'queued' }), deduplicated: false }, 202),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runAgentsStart(ctx, 'research-topic', { data: '{"topic":"cats"}' })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      agentKey: 'research-topic',
      input: { topic: 'cats' },
    })
    expect(out.content()).toContain(`agents logs ${RUN} --follow`)

    const bad = await captureError(runAgentsStart(ctx, 'research-topic', { data: '{nope' }))
    expect(exitCodeFor(bad)).toBe(EXIT_ERROR)
    expect(calls).toHaveLength(1)
  })

  it('start reads --data @file / -, keeps --input as a deprecated alias, and checks the agent key', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/agents/runs': () =>
        jsonResponse({ ...run({ status: 'queued' }), deduplicated: false }, 202),
    })
    const { ctx, log } = await testContext({ store, fetch })
    await runAgentsStart(ctx, 'research-topic', {
      data: '@in.json',
      readFile: async () => '{"topic":"file"}',
    })
    await runAgentsStart(ctx, 'research-topic', { input: '{"topic":"old"}' })
    expect(calls.map(c => JSON.parse(String(c.init.body)).input)).toEqual([
      { topic: 'file' },
      { topic: 'old' },
    ])
    expect(log.lines.join('\n')).toContain('--input is deprecated')
    expect(
      exitCodeFor(
        await captureError(runAgentsStart(ctx, 'research-topic', { data: '{}', input: '{}' }))
      )
    ).toBe(EXIT_ERROR)
    expect(exitCodeFor(await captureError(runAgentsStart(ctx, 'no-such-agent', {})))).toBe(
      EXIT_ERROR
    )
    expect(calls).toHaveLength(2)
  })
})
