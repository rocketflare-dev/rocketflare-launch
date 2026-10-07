/**
 * `launch agents answer|steer` (issue #6): the answer is built per question kind from flags,
 * validated with the same `interruptPayloadSchema(spec)` the route uses (exit 1 listing issues,
 * before any request), and someone answering first is the server's 409 → exit 1.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { runAgentsAnswer, runAgentsSteer } from '../src/commands/agents'
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
const ASK = '12345678-cccc-4ddd-8eee-ffffffffffff'
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

const ask = (spec: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id: ASK,
  tenantId: TENANT_ID,
  runId: RUN,
  key: 'ask-1',
  kind: spec.kind,
  reason: 'input_required',
  message: spec.message,
  toolCallId: null,
  responseSchema: null,
  spec,
  status: 'pending',
  payload: null,
  expiresAt: null,
  resolvedAt: null,
  resolvedByUserId: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
})

const runWith = (interrupts: unknown[]) => ({
  id: RUN,
  tenantId: TENANT_ID,
  agentKey: 'research-topic',
  status: 'awaiting_input',
  input: {},
  output: null,
  error: null,
  requestedByUserId: USER_ID,
  instanceId: RUN,
  attempt: 1,
  startedAt: '2026-10-01T10:00:00.000Z',
  finishedAt: null,
  cancelRequestedAt: null,
  createdAt: '2026-10-01T09:59:59.000Z',
  events: [],
  interrupts,
  artifacts: [],
})

const bodyOf = (init: RequestInit) => JSON.parse(String(init.body))

async function setup(spec: Record<string, unknown>, answer?: () => Response) {
  const store = await loggedInStore()
  const interrupt = ask(spec)
  const { fetch, calls } = mockFetch({
    [`/api/agents/runs/${RUN}`]: () => jsonResponse(runWith([interrupt])),
    [`/api/agents/runs/${RUN}/interrupts/${ASK}`]: (_url, init) =>
      answer
        ? answer()
        : jsonResponse({
            ...interrupt,
            status: bodyOf(init).status,
            payload: bodyOf(init).payload,
          }),
  })
  return { store, fetch, calls }
}

const posted = (calls: { init: RequestInit }[]) => calls.filter(c => c.init.method === 'POST')

describe('agents answer', () => {
  it('approval: --approve with a note; --json prints the resolved ask', async () => {
    const { store, fetch, calls } = await setup({
      kind: 'approval',
      message: 'Send this email?',
      tool: { name: 'send_email', input: { to: 'a@b.c' }, allowEdits: false },
    })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runAgentsAnswer(ctx, RUN, undefined, { approve: true, note: 'ok' })
    expect(bodyOf(posted(calls)[0]?.init ?? {})).toEqual({
      status: 'resolved',
      payload: { note: 'ok' },
    })
    expect(JSON.parse(out.content()).status).toBe('resolved')
  })

  it('approval: an edit the ask does not allow exits 1 before any POST', async () => {
    const { store, fetch, calls } = await setup({
      kind: 'approval',
      message: 'Send?',
      tool: { name: 'send_email', input: {}, allowEdits: false },
    })
    const { ctx } = await testContext({ store, fetch })
    const error = await captureError(
      runAgentsAnswer(ctx, RUN, undefined, { approve: true, editedInput: '{"to":"x"}' })
    )
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toMatch(/editedInput: this approval does not allow editing/)
    expect(posted(calls)).toHaveLength(0)
  })

  it('choice: --choice must be an offered option', async () => {
    const spec = {
      kind: 'choice',
      message: 'Which customer?',
      options: [
        { value: 'acme', label: 'Acme' },
        { value: 'globex', label: 'Globex' },
      ],
    }
    const { store, fetch, calls } = await setup(spec)
    const { ctx } = await testContext({ store, fetch })
    const bad = await captureError(runAgentsAnswer(ctx, RUN, ASK, { choice: 'initech' }))
    expect(bad.message).toMatch(/must be one of the offered options/)
    await runAgentsAnswer(ctx, RUN, 'ask-1', { choice: 'globex' })
    expect(bodyOf(posted(calls)[0]?.init ?? {})).toEqual({
      status: 'resolved',
      payload: { value: 'globex' },
    })
  })

  it('input: --text; --reject declines with a note', async () => {
    const { store, fetch, calls } = await setup({ kind: 'input', message: 'Subject line?' })
    const { ctx, out } = await testContext({ store, fetch })
    await runAgentsAnswer(ctx, RUN, ASK.slice(0, 8), { text: 'Hello' })
    expect(bodyOf(posted(calls)[0]?.init ?? {}).payload).toEqual({ text: 'Hello' })
    await runAgentsAnswer(ctx, RUN, undefined, { reject: true, note: 'not now' })
    expect(bodyOf(posted(calls)[1]?.init ?? {})).toEqual({
      status: 'cancelled',
      payload: { note: 'not now' },
    })
    expect(out.content()).toContain('Declined: Subject line?')
  })

  it('form: --field values are typed per field and checked', async () => {
    const spec = {
      kind: 'form',
      message: 'Details?',
      fields: [
        { name: 'count', label: 'How many', type: 'number', required: true },
        { name: 'urgent', label: 'Urgent', type: 'boolean' },
        {
          name: 'tier',
          label: 'Tier',
          type: 'select',
          options: [{ value: 'gold', label: 'Gold' }],
        },
      ],
    }
    const { store, fetch, calls } = await setup(spec)
    const { ctx } = await testContext({ store, fetch })
    await runAgentsAnswer(ctx, RUN, undefined, {
      field: ['count=3', 'urgent=yes', 'tier=gold'],
    })
    expect(bodyOf(posted(calls)[0]?.init ?? {}).payload).toEqual({
      values: { count: 3, urgent: true, tier: 'gold' },
    })
    const missing = await captureError(
      runAgentsAnswer(ctx, RUN, undefined, { field: ['urgent=no'] })
    )
    expect(missing.message).toMatch(/values\.count/)
    const unknown = await captureError(runAgentsAnswer(ctx, RUN, undefined, { field: ['nope=1'] }))
    expect(unknown.message).toMatch(/no field "nope"/)
    expect(posted(calls)).toHaveLength(1)
  })

  it('no answer flag prints the question and how to answer, exit 1', async () => {
    const { store, fetch } = await setup({
      kind: 'choice',
      message: 'Which customer?',
      options: [{ value: 'acme', label: 'Acme' }],
    })
    const { ctx, out } = await testContext({ store, fetch })
    const error = await captureError(runAgentsAnswer(ctx, RUN, undefined, {}))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(out.content()).toContain('Which customer?')
    expect(out.content()).toContain(`agents answer ${RUN} 12345678 --choice <value>`)
  })

  it('already answered is the server’s 409 → exit 1; not an approver is 403 → exit 3', async () => {
    let response = () =>
      jsonResponse(
        {
          error: 'That question has already been answered',
          statusCode: 409,
          code: 'interrupt_not_pending',
        },
        409
      )
    const { store, fetch } = await setup({ kind: 'input', message: 'Q?' }, () => response())
    const { ctx } = await testContext({ store, fetch })
    const conflict = await captureError(runAgentsAnswer(ctx, RUN, undefined, { text: 'x' }))
    expect(exitCodeFor(conflict)).toBe(EXIT_ERROR)
    expect(conflict.message).toBe('That question has already been answered')
    response = () =>
      jsonResponse({ error: 'Only an administrator may answer this agent', statusCode: 403 }, 403)
    const denied = await captureError(runAgentsAnswer(ctx, RUN, undefined, { text: 'x' }))
    expect(exitCodeFor(denied)).toBe(EXIT_FORBIDDEN)
  })

  it('a run waiting on nothing exits 1 before any POST', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      [`/api/agents/runs/${RUN}`]: () => jsonResponse(runWith([])),
    })
    const { ctx } = await testContext({ store, fetch })
    const error = await captureError(runAgentsAnswer(ctx, RUN, undefined, { approve: true }))
    expect(error.message).toMatch(/not waiting on an answer/)
    expect(posted(calls)).toHaveLength(0)
  })
})

describe('agents steer', () => {
  it('posts the note; a settled run is the server’s 409 → exit 1', async () => {
    const store = await loggedInStore()
    let settled = false
    const { fetch, calls } = mockFetch({
      [`/api/agents/runs/${RUN}/steering`]: () =>
        settled
          ? jsonResponse(
              {
                error: 'That run has finished, so it cannot be steered',
                statusCode: 409,
              },
              409
            )
          : jsonResponse(
              {
                id: EVENT,
                runId: RUN,
                seq: 7,
                type: 'steering',
                data: { text: 'Focus on 2026', authorUserId: USER_ID },
                at: '2026-10-01T10:00:00.000Z',
              },
              201
            ),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runAgentsSteer(ctx, RUN, 'Focus on 2026')
    expect(bodyOf(calls[0]?.init ?? {})).toEqual({ text: 'Focus on 2026' })
    expect(out.content()).toContain('Note sent to run')
    settled = true
    expect(exitCodeFor(await captureError(runAgentsSteer(ctx, RUN, 'x')))).toBe(EXIT_ERROR)
    expect(exitCodeFor(await captureError(runAgentsSteer(ctx, RUN, '  ')))).toBe(EXIT_ERROR)
    expect(calls).toHaveLength(2)
  })
})
