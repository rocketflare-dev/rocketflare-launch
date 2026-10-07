/**
 * Issue #6's read commands, in-process against a fake fetch: `ai status|usage`, `chat ls|show|
 * stats`, `activity ls`, `notifications ls|read` and `status --ready`. Each: --json prints the
 * parsed body, 403 exits 3, 404 exits 1.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { runActivityList } from '../src/commands/activity'
import { runAiStatus, runAiUsage } from '../src/commands/ai'
import { runChatList, runChatShow, runChatStats } from '../src/commands/chat'
import { runNotificationsList, runNotificationsRead } from '../src/commands/notifications'
import { runStatus } from '../src/commands/status'
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
const CONV = 'cccccccc-dddd-4eee-8fff-000000000000'
const MSG = 'dddddddd-eeee-4fff-8000-111111111111'
const NOTE = 'eeeeeeee-ffff-4000-8111-222222222222'
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

const page = (items: unknown[]) => ({
  items,
  pagination: { page: 1, pageSize: 25, total: items.length, totalPages: 1 },
})
const forbidden = () =>
  jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403)
const AT = '2026-10-01T10:00:00.000Z'

describe('ai status / usage', () => {
  const readiness = {
    chat: { ready: true, source: 'tenant', provider: 'anthropic', model: 'claude-sonnet-4-5' },
    embeddings: { ready: false, source: 'none' },
  }
  const configs = {
    items: [
      {
        id: MSG,
        scope: 'chat',
        provider: 'anthropic',
        label: 'Main',
        baseUrl: null,
        model: 'claude-sonnet-4-5',
        isDefault: true,
        hasCredential: true,
        thinking: { enabled: false },
        serviceTier: null,
        createdAt: AT,
        updatedAt: AT,
      },
    ],
  }

  it('status prints readiness and providers (key as set/none only); --json both bodies', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      '/api/ai/config/readiness': () => jsonResponse(readiness),
      '/api/ai/config': () => jsonResponse(configs),
    })
    const a = await testContext({ store, fetch })
    await runAiStatus(a.ctx)
    expect(a.out.content()).toContain('ready · anthropic claude-sonnet-4-5')
    expect(a.out.content()).toContain('not ready')
    expect(a.out.content()).toContain('set')

    const b = await testContext({ store, fetch, json: true })
    await runAiStatus(b.ctx)
    expect(JSON.parse(b.out.content())).toEqual({ readiness, configs })
  })

  it('status 403 → exit 3', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      '/api/ai/config/readiness': forbidden,
      '/api/ai/config': forbidden,
    })
    const { ctx } = await testContext({ store, fetch })
    expect(exitCodeFor(await captureError(runAiStatus(ctx)))).toBe(EXIT_FORBIDDEN)
  })

  it('usage asks for the last N days and prints the totals', async () => {
    const store = await loggedInStore()
    const totals = {
      calls: 3,
      inputTokens: 300,
      outputTokens: 90,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicrocents: 250_000_000,
      unpricedCalls: 0,
    }
    const summary = {
      from: '2026-09-24T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
      rows: [{ provider: 'anthropic', model: 'claude-sonnet-4-5', feature: 'chat', ...totals }],
      totals,
    }
    const { fetch, calls } = mockFetch({ '/api/ai/usage/summary': () => jsonResponse(summary) })
    const now = new Date('2026-10-01T00:00:00.000Z')
    const a = await testContext({ store, fetch })
    await runAiUsage(a.ctx, { days: 7, now })
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      from: '2026-09-24T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
    })
    expect(a.out.content()).toContain('Last 7 day(s): 3 call(s) · 300→90 tokens · $2.5000')

    const b = await testContext({ store, fetch, json: true })
    await runAiUsage(b.ctx, { now })
    expect(JSON.parse(b.out.content())).toEqual(summary)
  })
})

describe('chat ls / show / stats', () => {
  const conversation = {
    id: CONV,
    tenantId: TENANT_ID,
    userId: USER_ID,
    title: 'Pricing question',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    createdAt: AT,
    updatedAt: AT,
    lastMessageAt: AT,
  }
  const thread = {
    ...conversation,
    messages: [
      { id: MSG, conversationId: CONV, role: 'user', content: 'How much?', createdAt: AT },
      {
        id: NOTE,
        conversationId: CONV,
        role: 'assistant',
        content: 'It depends.',
        toolCalls: [{ id: 't1', name: 'search_knowledge', input: { q: 'price' } }],
        usage: { inputTokens: 50, outputTokens: 10 },
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        createdAt: AT,
      },
    ],
  }

  it('ls --json prints the page; show prints messages, tools and the traces hint', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      '/api/chat/conversations': () => jsonResponse(page([conversation])),
      [`/api/chat/conversations/${CONV}`]: () => jsonResponse(thread),
    })
    const a = await testContext({ store, fetch, json: true })
    await runChatList(a.ctx)
    expect(JSON.parse(a.out.content())).toEqual(page([conversation]))

    const b = await testContext({ store, fetch })
    await runChatShow(b.ctx, CONV)
    const text = b.out.content()
    expect(text).toContain('Pricing question')
    expect(text).toContain('→ search_knowledge')
    expect(text).toContain('50→10 tok')
    expect(text).toContain(`launch traces list --conversation ${CONV}`)

    const c = await testContext({ store, fetch, json: true })
    await runChatShow(c.ctx, CONV)
    expect(JSON.parse(c.out.content())).toEqual(thread)
  })

  it('show 404 → exit 1; stats 403 → exit 3', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({ [`/api/chat/conversations/${CONV}/stats`]: forbidden })
    const { ctx } = await testContext({ store, fetch })
    expect(exitCodeFor(await captureError(runChatShow(ctx, CONV)))).toBe(EXIT_ERROR)
    expect(exitCodeFor(await captureError(runChatStats(ctx, CONV)))).toBe(EXIT_FORBIDDEN)
  })

  it('stats prints the next model, the context and the usage', async () => {
    const store = await loggedInStore()
    const stats = {
      conversationId: CONV,
      next: {
        ready: true,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        source: 'tenant',
        maxOutputTokens: 4096,
        knowledgeTools: ['search_knowledge'],
        maxToolTurns: 6,
      },
      context: {
        budgetChars: 100_000,
        windowChars: 2000,
        windowMessages: 2,
        droppedMessages: 0,
        droppedChars: 0,
        headroomChars: 98_000,
        composition: {
          systemPrompt: 1000,
          summary: 0,
          toolSchemas: 500,
          userMessages: 300,
          assistantMessages: 200,
        },
        totalChars: 2000,
        charsPerToken: 4,
      },
      compaction: {
        summary: null,
        summarisedThroughId: null,
        pendingMessages: 0,
        pendingChars: 0,
        minChars: 8000,
        maxSummaryChars: 4000,
        summarisedMessages: 0,
      },
      turns: { user: 1, assistant: 1, toolCalls: 1 },
      usage: { inputTokens: 50, outputTokens: 10 },
      costMicrocents: null,
      unpricedTurns: 1,
      byModel: [],
    }
    const { fetch } = mockFetch({
      [`/api/chat/conversations/${CONV}/stats`]: () => jsonResponse(stats),
    })
    const a = await testContext({ store, fetch })
    await runChatStats(a.ctx, CONV)
    expect(a.out.content()).toContain('anthropic claude-sonnet-4-5')
    expect(a.out.content()).toContain('2000 chars sent per turn (≈500 tokens)')
    expect(a.out.content()).toContain('system prompt 50%')
    expect(a.out.content()).toContain('cost unknown')

    const b = await testContext({ store, fetch, json: true })
    await runChatStats(b.ctx, CONV)
    expect(JSON.parse(b.out.content())).toEqual(stats)
  })
})

describe('activity ls', () => {
  it('forwards filters; --json prints the page; 403 → exit 3', async () => {
    const store = await loggedInStore()
    const body = page([
      {
        id: MSG,
        tenantId: TENANT_ID,
        userId: USER_ID,
        type: 'agent_run.requested',
        subjectType: 'AgentRun',
        subjectId: NOTE,
        metadata: { agentKey: 'research-topic' },
        createdAt: AT,
        actor: { name: 'Ada', email: 'ada@example.com' },
      },
    ])
    const { fetch, calls } = mockFetch({ '/api/activity': () => jsonResponse(body) })
    const a = await testContext({ store, fetch, json: true })
    await runActivityList(a.ctx, { type: 'agent_run.requested', subjectType: 'AgentRun' })
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      type: 'agent_run.requested',
      subjectType: 'AgentRun',
    })
    expect(JSON.parse(a.out.content())).toEqual(body)

    const b = await testContext({ store, fetch })
    await runActivityList(b.ctx)
    expect(b.out.content()).toContain('ada@example.com')

    const denied = await testContext({
      store,
      fetch: mockFetch({ '/api/activity': forbidden }).fetch,
    })
    expect(exitCodeFor(await captureError(runActivityList(denied.ctx)))).toBe(EXIT_FORBIDDEN)
  })
})

describe('notifications ls / read', () => {
  const note = {
    id: NOTE,
    tenantId: TENANT_ID,
    userId: USER_ID,
    type: 'approval.requested',
    title: 'Approve the release',
    body: null,
    data: {},
    readAt: null,
    createdAt: AT,
  }

  it('ls --unread sends unreadOnly=true; --json prints the page', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({ '/api/notifications': () => jsonResponse(page([note])) })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runNotificationsList(ctx, { unread: true })
    expect(calls[0]?.url.searchParams.get('unreadOnly')).toBe('true')
    expect(JSON.parse(out.content())).toEqual(page([note]))
  })

  it('read posts ids or { all: true }, and refuses neither/both and a bad id up front', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/notifications/read': () => jsonResponse({ updated: 1 }),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runNotificationsRead(ctx, [NOTE])
    await runNotificationsRead(ctx, [], { all: true })
    expect(calls.map(c => JSON.parse(String(c.init.body)))).toEqual([
      { ids: [NOTE] },
      { all: true },
    ])
    expect(out.content()).toContain('Marked 1 notification(s) read.')

    for (const attempt of [
      () => runNotificationsRead(ctx, []),
      () => runNotificationsRead(ctx, [NOTE], { all: true }),
      () => runNotificationsRead(ctx, ['nope']),
    ]) {
      expect(exitCodeFor(await captureError(attempt()))).toBe(EXIT_ERROR)
    }
    expect(calls).toHaveLength(2)
  })
})

describe('status readiness', () => {
  const health = () => jsonResponse({ status: 'ok', version: '1.2.3', env: 'development' })

  it('reports ready; --json carries it', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      '/api/health': health,
      '/api/ready': () => jsonResponse({ status: 'ready' }),
    })
    const a = await testContext({ store, fetch })
    await runStatus(a.ctx, { ready: true })
    expect(a.out.content()).toContain('Ready:   ready')

    const b = await testContext({ store, fetch, json: true })
    await runStatus(b.ctx)
    expect(JSON.parse(b.out.content()).ready).toEqual({ ready: true, status: 'ready' })
  })

  it('a 503 is reported without --ready and exits 1 with it', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      '/api/health': health,
      '/api/ready': () =>
        jsonResponse(
          { error: 'Database unavailable', statusCode: 503, code: 'database_unavailable' },
          503
        ),
    })
    const a = await testContext({ store, fetch })
    await runStatus(a.ctx)
    expect(a.out.content()).toContain('not ready — Database unavailable (database_unavailable)')

    const b = await testContext({ store, fetch })
    const error = await captureError(runStatus(b.ctx, { ready: true }))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toContain('not ready')
  })
})
