/**
 * `chat send` (issue #6): one turn POSTed to `/api/chat/conversations/:id/messages`, its AG-UI SSE
 * reply read through `ApiClient.stream`. The fake fetch answers with a `ReadableStream` cut into
 * awkward chunks, so frame reassembly is exercised too.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApiClient } from '../src/api'
import { runChatSend } from '../src/commands/chat'
import { EXIT_ERROR, exitCodeFor } from '../src/errors'
import { readSseData } from '../src/utils/sse'
import {
  captureError,
  headersOf,
  jsonResponse,
  mockFetch,
  TENANT_ID,
  TEST_KEY,
  tempStore,
  testContext,
  USER_ID,
} from './helpers'

const SERVER = 'http://server.test'
const CONV = 'cccccccc-dddd-4eee-8fff-000000000000'
const USER_MSG = 'dddddddd-eeee-4fff-8000-111111111111'
const ASSISTANT_MSG = 'eeeeeeee-ffff-4000-8111-222222222222'
const AT = '2026-10-01T10:00:00.000Z'
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

const conversation = {
  id: CONV,
  tenantId: TENANT_ID,
  userId: USER_ID,
  title: 'New conversation',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  createdAt: AT,
  updatedAt: AT,
  lastMessageAt: null,
}

const run = { threadId: CONV, runId: 'run-1' }
const turn = [
  { type: 'RUN_STARTED', ...run },
  {
    type: 'CUSTOM',
    name: 'kit.chat.ids',
    value: {
      conversationId: CONV,
      userMessageId: USER_MSG,
      assistantMessageId: ASSISTANT_MSG,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    },
  },
  { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'search_knowledge' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"query":' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '"leave"}' },
  { type: 'TOOL_CALL_END', toolCallId: 't1' },
  { type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 't1', content: '{"hits":[]}' },
  { type: 'TEXT_MESSAGE_START', messageId: ASSISTANT_MSG, role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: ASSISTANT_MSG, delta: 'Twenty ' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: ASSISTANT_MSG, delta: 'days.' },
  { type: 'TEXT_MESSAGE_END', messageId: ASSISTANT_MSG },
  { type: 'CUSTOM', name: 'kit.usage', value: { usage: { inputTokens: 40, outputTokens: 5 } } },
  { type: 'RUN_FINISHED', ...run },
]

/** The events as an SSE body, cut every `size` bytes (mid-frame, mid-line). */
function sseResponse(events: unknown[], size = 23, extra = ''): Response {
  const text = `: keep-alive\n\n${events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')}${extra}`
  const bytes = new TextEncoder().encode(text)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const messagesPath = `/api/chat/conversations/${CONV}/messages`

describe('chat send', () => {
  it('streams the text to stdout, tool calls to stderr, and ends with the traces hint', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({ [messagesPath]: () => sseResponse(turn) })
    const { ctx, out, log } = await testContext({ store, fetch })
    await runChatSend(ctx, CONV, 'How long is leave?')

    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ content: 'How long is leave?' })
    expect(headersOf(calls).Accept).toBe('text/event-stream')
    expect(out.content()).toBe('Twenty days.\n')
    const stderr = log.lines.join('\n')
    expect(stderr).toContain('→ search_knowledge {"query":"leave"}')
    expect(stderr).toContain('40→5 tok')
    expect(stderr).toContain(`launch traces list --conversation ${CONV}`)
  })

  it('--json prints NDJSON: one validated event per line, unknown frames skipped', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      [messagesPath]: () =>
        sseResponse([...turn.slice(0, 2), { type: 'FROM_THE_FUTURE' }, ...turn.slice(2)], 7),
    })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runChatSend(ctx, CONV, 'How long is leave?')
    const lines = out.content().trimEnd().split('\n')
    expect(lines).toHaveLength(turn.length)
    expect(lines.map(l => JSON.parse(l).type)).toEqual(turn.map(e => e.type))
  })

  it('a RUN_ERROR exits 1 with its message', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      [messagesPath]: () =>
        sseResponse([
          { type: 'RUN_STARTED', ...run },
          { type: 'RUN_ERROR', message: 'The model refused', code: 'provider_error' },
        ]),
    })
    const { ctx } = await testContext({ store, fetch })
    const error = await captureError(runChatSend(ctx, CONV, 'hi'))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toContain('The model refused')
    expect(error.hint).toContain('provider_error')
  })

  it('a stream that closes with no terminal event exits 1', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({ [messagesPath]: () => sseResponse(turn.slice(0, 9)) })
    const { ctx } = await testContext({ store, fetch })
    const error = await captureError(runChatSend(ctx, CONV, 'hi'))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toContain('closed before the reply finished')
  })

  it('--new creates the conversation first, then sends to it', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/chat/conversations': () => jsonResponse(conversation, 201),
      [messagesPath]: () => sseResponse(turn),
    })
    const { ctx, out, log } = await testContext({ store, fetch })
    await runChatSend(ctx, 'How long is leave?', undefined, { new: true, title: 'Leave' })
    expect(calls.map(c => `${c.init.method} ${c.url.pathname}`)).toEqual([
      'POST /api/chat/conversations',
      `POST ${messagesPath}`,
    ])
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ title: 'Leave' })
    expect(log.lines.join('\n')).toContain(`(${CONV})`)
    expect(out.content()).toBe('Twenty days.\n')
  })

  it('refuses an empty message, a missing id and --new with two operands before any request', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store, fetch })
    expect((await captureError(runChatSend(ctx, CONV, '   '))).message).toContain('Invalid message')
    expect((await captureError(runChatSend(ctx, undefined, undefined))).message).toContain('--new')
    expect((await captureError(runChatSend(ctx, CONV, 'hi', { new: true }))).message).toContain(
      'only the message'
    )
    expect(calls).toHaveLength(0)
  })

  it('reads the message from stdin with -', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({ [messagesPath]: () => sseResponse(turn) })
    const { ctx } = await testContext({ store, fetch })
    await runChatSend(ctx, CONV, '-', { readStdin: async () => 'from a pipe\n' })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ content: 'from a pipe' })
  })

  it('a pre-stream 503 is the server envelope, exit 1', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      [messagesPath]: () =>
        jsonResponse(
          { error: 'No AI provider is configured', statusCode: 503, code: 'ai_not_configured' },
          503
        ),
    })
    const { ctx } = await testContext({ store, fetch })
    const error = await captureError(runChatSend(ctx, CONV, 'hi'))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.code).toBe('ai_not_configured')
  })
})

describe('ApiClient.stream / readSseData', () => {
  it('reassembles frames split mid-line and across \\r\\n, joining multi-line data', async () => {
    const text = 'data: {"a":\r\ndata: 1}\r\n\r\n: comment\n\nevent: x\ndata: last'
    const bytes = new TextEncoder().encode(text)
    async function* chunks() {
      for (let i = 0; i < bytes.length; i += 3) yield bytes.slice(i, i + 3)
    }
    const out: string[] = []
    for await (const data of readSseData(chunks())) out.push(data)
    expect(out).toEqual(['{"a":\n1}', 'last'])
  })

  it('sends a JSON body with the key and maps a 401 to exit 2', async () => {
    const seen: RequestInit[] = []
    const client = createApiClient({
      serverUrl: SERVER,
      apiKey: TEST_KEY,
      fetch: async (_url, init = {}) => {
        seen.push(init)
        return jsonResponse({ error: 'Unauthorized', statusCode: 401 }, 401)
      },
    })
    const error = await captureError(client.stream('POST', '/api/x', { body: { a: 1 } }))
    expect(error.exitCode).toBe(2)
    const headers = seen[0]?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${TEST_KEY}`)
    expect(headers['Content-Type']).toBe('application/json')
    expect(seen[0]?.body).toBe('{"a":1}')
  })
})
