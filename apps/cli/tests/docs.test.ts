/**
 * `launch docs …` and `launch chat new|rm|compact` (issue #6), in-process against a fake fetch:
 * --json bodies, request bodies validated before sending, confirmation before a delete, 403 → 3,
 * 404/409 → 1.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { runChatCompact, runChatNew, runChatRemove } from '../src/commands/chat'
import {
  runDocsAdd,
  runDocsContent,
  runDocsList,
  runDocsPassages,
  runDocsRemove,
  runDocsSearch,
  runDocsShow,
  runDocsUpload,
  runDocsVisibility,
} from '../src/commands/docs'
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
const DOC = 'dddddddd-1111-4222-8333-444444444444'
const CHUNK = 'eeeeeeee-1111-4222-8333-444444444444'
const GROUP = 'ffffffff-1111-4222-8333-444444444444'
const CONV = 'aaaaaaaa-1111-4222-8333-444444444444'
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

const forbidden = () =>
  jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403)
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body))
const page = (items: unknown[]) => ({
  items,
  pagination: { page: 1, pageSize: 25, total: items.length, totalPages: 1 },
})

const doc = (over: Record<string, unknown> = {}) => ({
  id: DOC,
  tenantId: TENANT_ID,
  ownerUserId: USER_ID,
  title: 'Handbook',
  source: 'upload',
  contentType: 'text/markdown',
  sizeBytes: 2048,
  fileId: null,
  chunkCount: 3,
  status: 'indexed',
  error: null,
  visibility: 'tenant',
  groups: [],
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
})

describe('docs reads', () => {
  it('ls --json forwards the filter; show reads the row and its card', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/ai/documents': () => jsonResponse(page([doc()])),
      [`/api/ai/documents/${DOC}`]: () => jsonResponse(doc()),
      [`/api/ai/documents/${DOC}/card`]: () =>
        jsonResponse({
          id: DOC,
          title: 'Handbook',
          typeLabel: 'Markdown',
          contentType: 'text/markdown',
          status: 'indexed',
          excerpt: 'Welcome to the handbook',
          passages: 3,
          sizeBytes: 2048,
          fileId: null,
          href: `/documents/${DOC}`,
        }),
    })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runDocsList(ctx, { status: 'indexed' })
    expect(calls[0]?.url.searchParams.get('status')).toBe('indexed')
    expect(JSON.parse(out.content()).items[0].id).toBe(DOC)
    const human = await testContext({ store, fetch })
    await runDocsShow(human.ctx, DOC)
    expect(human.out.content()).toContain('Welcome to the handbook')
    expect(human.out.content()).toContain('Visible to: everyone')
  })

  it('content prints the window; not converted yet is the server’s 409 → exit 1', async () => {
    const store = await loggedInStore()
    let converted = true
    const { fetch, calls } = mockFetch({
      [`/api/ai/documents/${DOC}/content`]: () =>
        converted
          ? jsonResponse({
              documentId: DOC,
              title: 'Handbook',
              source: null,
              contentType: 'text/markdown',
              status: 'indexed',
              totalChars: 100,
              passages: 3,
              offset: 0,
              returnedChars: 5,
              text: 'Hello',
              hasMore: true,
              nextOffset: 5,
            })
          : jsonResponse(
              {
                error: 'This document is still being converted and has no text yet',
                statusCode: 409,
                code: 'document_not_converted',
              },
              409
            ),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runDocsContent(ctx, DOC, { maxChars: 5 })
    expect(calls[0]?.url.searchParams.get('maxChars')).toBe('5')
    expect(out.content()).toBe('Hello\n')
    converted = false
    const error = await captureError(runDocsContent(ctx, DOC))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toMatch(/still being converted/)
  })

  it('passages --json prints the page', async () => {
    const store = await loggedInStore()
    const items = [
      { id: CHUNK, documentId: DOC, seq: 0, tokenCount: 12, charOffset: 0, text: 'First' },
    ]
    const { fetch } = mockFetch({
      [`/api/ai/documents/${DOC}/passages`]: () => jsonResponse(page(items)),
    })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runDocsPassages(ctx, DOC)
    expect(JSON.parse(out.content()).items).toEqual(items)
  })

  it('an invisible document is 404 → exit 1', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({})
    const { ctx } = await testContext({ store, fetch })
    expect(exitCodeFor(await captureError(runDocsShow(ctx, DOC)))).toBe(EXIT_ERROR)
  })
})

describe('docs search', () => {
  it('posts the validated query and prints rank, score and signals', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/ai/documents/search': () =>
        jsonResponse({
          query: 'leave policy',
          hits: [
            {
              chunkId: CHUNK,
              documentId: DOC,
              title: 'Handbook',
              text: 'Annual leave is 25 days.',
              seq: 1,
              documentPassages: 3,
              charOffset: 120,
              score: 0.0325,
              rank: 1,
              denseRank: 2,
              lexicalRank: 1,
            },
          ],
        }),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runDocsSearch(ctx, 'leave policy', { limit: 5, doc: DOC })
    expect(bodyOf(calls[0]?.init ?? {})).toEqual({
      query: 'leave policy',
      limit: 5,
      documentId: DOC,
    })
    expect(out.content()).toContain('score 0.0325 · dense #2 · lexical #1 · passage 2/3')
    expect(out.content()).toContain('Annual leave is 25 days.')
  })

  it('a limit over the cap exits 1 before any request', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store, fetch })
    const error = await captureError(runDocsSearch(ctx, 'x', { limit: 99 }))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(error.message).toMatch(/limit/)
    expect(calls).toHaveLength(0)
  })
})

describe('docs add / visibility / rm', () => {
  it('add ingests the file text, restricted to groups', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/ai/documents/ingest': () => jsonResponse(doc({ visibility: 'groups' }), 201),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runDocsAdd(ctx, {
      title: 'Handbook',
      file: 'h.md',
      readFile: async () => '# Handbook',
      source: 'https://example.com/h',
      groups: GROUP,
    })
    expect(bodyOf(calls[0]?.init ?? {})).toEqual({
      title: 'Handbook',
      text: '# Handbook',
      source: 'https://example.com/h',
      visibility: 'groups',
      groupIds: [GROUP],
    })
    expect(out.content()).toContain('indexed, 3 passage(s)')
  })

  it('add needs exactly one of --file/--text and a title', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store, fetch })
    await expect(runDocsAdd(ctx, { title: 'x' })).rejects.toThrow(/exactly one/)
    const noTitle = await captureError(runDocsAdd(ctx, { text: 'x' }))
    expect(noTitle.message).toMatch(/title/)
    expect(calls).toHaveLength(0)
  })

  it('upload sends the file as multipart with its fields', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/ai/documents/upload': () =>
        jsonResponse(doc({ status: 'pending', contentType: 'application/pdf' }), 201),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runDocsUpload(ctx, '/tmp/handbook.pdf', {
      title: 'Handbook',
      groups: GROUP,
      readBytes: async () => new Uint8Array([37, 80, 68, 70]),
    })
    const form = calls[0]?.init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    const file = form.get('file') as File
    expect(file.name).toBe('handbook.pdf')
    expect(file.type).toBe('application/pdf')
    expect(form.get('title')).toBe('Handbook')
    expect(form.get('visibility')).toBe('groups')
    expect(form.get('groupIds')).toBe(JSON.stringify([GROUP]))
    expect(out.content()).toContain('a job is converting and indexing it')
  })

  it('upload refuses an unsupported or empty file before any request', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store, fetch })
    const png = await captureError(
      runDocsUpload(ctx, 'a.png', { readBytes: async () => new Uint8Array([1]) })
    )
    expect(png.message).toMatch(/Choose a PDF/)
    const empty = await captureError(
      runDocsUpload(ctx, 'a.md', { readBytes: async () => new Uint8Array() })
    )
    expect(empty.message).toBe('That file is empty')
    expect(calls).toHaveLength(0)
  })

  it('visibility PUTs the selection; someone else’s document is 403 → exit 3', async () => {
    const store = await loggedInStore()
    let allowed = true
    const { fetch, calls } = mockFetch({
      [`/api/ai/documents/${DOC}/visibility`]: () => (allowed ? jsonResponse(doc()) : forbidden()),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runDocsVisibility(ctx, DOC, { tenant: true })
    expect(bodyOf(calls[0]?.init ?? {})).toEqual({ visibility: 'tenant', groupIds: [] })
    expect(out.content()).toContain('visible to everyone')
    allowed = false
    const error = await captureError(runDocsVisibility(ctx, DOC, { groups: GROUP }))
    expect(exitCodeFor(error)).toBe(EXIT_FORBIDDEN)
  })

  it('rm asks with the page’s words; refuses off a terminal without --yes', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      [`/api/ai/documents/${DOC}`]: (_url, init) =>
        init.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse(doc()),
    })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    expect((await captureError(runDocsRemove(ctx, DOC))).message).toMatch(/Refusing/)
    let question = ''
    await runDocsRemove(ctx, DOC, {
      confirm: async q => {
        question = q
        return true
      },
    })
    expect(question).toBe('Delete "Handbook"? Its chunks leave the search index for good.')
    expect(calls.at(-1)?.init.method).toBe('DELETE')
    expect(JSON.parse(out.content())).toEqual({ deleted: DOC })
  })
})

const conversation = {
  id: CONV,
  tenantId: TENANT_ID,
  userId: USER_ID,
  title: 'Leave question',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  lastMessageAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
}

describe('chat new / rm / compact', () => {
  it('new posts the title and prints the thread', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/chat/conversations': () => jsonResponse(conversation, 201),
    })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runChatNew(ctx, { title: 'Leave question' })
    expect(bodyOf(calls[0]?.init ?? {})).toEqual({ title: 'Leave question' })
    expect(JSON.parse(out.content()).id).toBe(CONV)
  })

  it('rm asks with the page’s words, then deletes', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      [`/api/chat/conversations/${CONV}`]: (_url, init) =>
        init.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : jsonResponse({ ...conversation, messages: [] }),
    })
    const { ctx } = await testContext({ store, fetch })
    let question = ''
    await runChatRemove(ctx, CONV, {
      confirm: async q => {
        question = q
        return true
      },
    })
    expect(question).toBe('Delete "Leave question"? Its messages are removed for good.')
    expect(calls.at(-1)?.init.method).toBe('DELETE')
    await runChatRemove(ctx, CONV, { confirm: async () => false })
    expect(calls.filter(c => c.init.method === 'DELETE')).toHaveLength(1)
  })

  it('compact prints what was queued; nothing to compact is 409 → 1; a member is 403 → 3', async () => {
    const store = await loggedInStore()
    let answer: () => Response = () =>
      jsonResponse({ conversationId: CONV, pendingMessages: 4, pendingChars: 9000 }, 202)
    const { fetch } = mockFetch({
      [`/api/chat/conversations/${CONV}/compact`]: () => answer(),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runChatCompact(ctx, CONV)
    expect(out.content()).toContain('Summarising 4 message(s) (9000 chars)')
    answer = () =>
      jsonResponse(
        {
          error: "There is nothing outside this conversation's context window to summarise yet.",
          statusCode: 409,
          code: 'nothing_to_compact',
        },
        409
      )
    expect(exitCodeFor(await captureError(runChatCompact(ctx, CONV)))).toBe(EXIT_ERROR)
    answer = forbidden
    expect(exitCodeFor(await captureError(runChatCompact(ctx, CONV)))).toBe(EXIT_FORBIDDEN)
  })
})
