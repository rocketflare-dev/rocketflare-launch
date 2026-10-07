/**
 * `launch ai providers|set|rm|test` and `ai prompts …` / `ai models …` (issue #6), in-process
 * against a fake fetch: the body each POST/PUT sends, the API key only from the hidden prompt or
 * stdin (and refused in --data), confirmation before a delete, 403 → 3, 404/409 → 1.
 */
import { stripVTControlCharacters } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { runAiProviders, runAiRemove, runAiSet, runAiTest } from '../src/commands/ai'
import {
  lineDiff,
  runAgentModelReset,
  runAgentModelSet,
  runAgentModelsList,
  runPromptReset,
  runPromptSet,
  runPromptShow,
  runPromptsList,
} from '../src/commands/ai-prompts'
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
const CONFIG = 'cccccccc-1111-4222-8333-444444444444'
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

const config = (over: Record<string, unknown> = {}) => ({
  id: CONFIG,
  tenantId: TENANT_ID,
  scope: 'chat',
  provider: 'anthropic',
  label: 'Claude',
  baseUrl: null,
  model: 'claude-sonnet-4-5',
  isDefault: true,
  hasCredential: true,
  thinking: { enabled: false },
  serviceTier: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
})

const bodyOf = (init: RequestInit) => JSON.parse(String(init.body))

describe('ai providers / set', () => {
  it('providers --json prints the catalog', async () => {
    const store = await loggedInStore()
    const catalog = {
      items: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          scopes: ['chat'],
          needsApiKey: true,
          needsBaseUrl: false,
          supportsThinking: true,
          supportsServiceTier: true,
          defaultModel: 'claude-sonnet-4-5',
          suggestedModels: { chat: ['claude-sonnet-4-5'], embeddings: [] },
        },
      ],
      defaultMaxOutputTokens: 4096,
    }
    const { fetch } = mockFetch({ '/api/ai/config/providers': () => jsonResponse(catalog) })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runAiProviders(ctx)
    expect(JSON.parse(out.content())).toEqual(catalog)
  })

  it('set sends the upsert with the key from the hidden prompt, and never prints it', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/ai/config': () => jsonResponse(config(), 201),
    })
    const { ctx, out, log } = await testContext({ store, fetch })
    await runAiSet(ctx, {
      label: 'Claude',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      default: true,
      thinking: '2048',
      key: true,
      isTTY: true,
      promptHidden: async () => 'sk-secret-123\n',
    })
    expect(bodyOf(calls[0]?.init ?? {})).toEqual({
      scope: 'chat',
      label: 'Claude',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      isDefault: true,
      thinking: { enabled: true, budgetTokens: 2048 },
      apiKey: 'sk-secret-123',
    })
    expect(out.content()).toContain('Added "Claude" (chat): anthropic claude-sonnet-4-5 · key set')
    expect(out.content() + JSON.stringify(log)).not.toContain('sk-secret-123')
  })

  it('set reads the key from stdin when it is not a terminal', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({ '/api/ai/config': () => jsonResponse(config()) })
    const { ctx } = await testContext({ store, fetch })
    await runAiSet(ctx, {
      label: 'Claude',
      provider: 'anthropic',
      model: 'm',
      key: true,
      isTTY: false,
      readStdin: async () => 'sk-piped\n',
    })
    expect(bodyOf(calls[0]?.init ?? {}).apiKey).toBe('sk-piped')
  })

  it('set refuses an apiKey in --data and an invalid body, before any request', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store, fetch })
    const leaked = await captureError(
      runAiSet(ctx, { data: '{"label":"x","provider":"anthropic","model":"m","apiKey":"sk"}' })
    )
    expect(leaked.message).toMatch(/never accepted in --data/)
    const bad = await captureError(runAiSet(ctx, { label: 'x', provider: 'nope', model: 'm' }))
    expect(exitCodeFor(bad)).toBe(EXIT_ERROR)
    expect(bad.message).toMatch(/provider/)
    expect(calls).toHaveLength(0)
  })

  it('a member key is 403 → exit 3', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({ '/api/ai/config': forbidden })
    const { ctx } = await testContext({ store, fetch })
    const error = await captureError(
      runAiSet(ctx, { label: 'x', provider: 'anthropic', model: 'm' })
    )
    expect(exitCodeFor(error)).toBe(EXIT_FORBIDDEN)
  })
})

describe('ai rm / test', () => {
  it('rm finds the provider by label, asks with the page’s words, then deletes', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/ai/config': () => jsonResponse({ items: [config()] }),
      [`/api/ai/config/${CONFIG}`]: () => new Response(null, { status: 204 }),
    })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    const asked: string[] = []
    await runAiRemove(ctx, 'Claude', {
      confirm: async q => {
        asked.push(q)
        return true
      },
    })
    expect(asked[0]).toMatch(/Remove "Claude"\? It is the default/)
    expect(calls[1]?.init.method).toBe('DELETE')
    expect(JSON.parse(out.content())).toEqual({ deleted: CONFIG })
  })

  it('rm refuses without --yes off a terminal; a "no" deletes nothing', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/ai/config': () => jsonResponse({ items: [config()] }),
    })
    const { ctx } = await testContext({ store, fetch })
    const error = await captureError(runAiRemove(ctx, CONFIG))
    expect(error.message).toMatch(/Refusing without confirmation/)
    await runAiRemove(ctx, CONFIG, { confirm: async () => false })
    expect(calls.every(c => (c.init.method ?? 'GET') === 'GET')).toBe(true)
  })

  it('rm of an unknown provider exits 1', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({ '/api/ai/config': () => jsonResponse({ items: [] }) })
    const { ctx } = await testContext({ store, fetch })
    expect(exitCodeFor(await captureError(runAiRemove(ctx, 'nope', { yes: true })))).toBe(
      EXIT_ERROR
    )
  })

  it('test of a saved provider prints the verdict; a failure exits 1', async () => {
    const store = await loggedInStore()
    let ok = true
    const { fetch, calls } = mockFetch({
      '/api/ai/config': () => jsonResponse({ items: [config()] }),
      '/api/ai/config/test': () =>
        jsonResponse(
          ok
            ? { ok: true, latencyMs: 812, model: 'claude-sonnet-4-5', provider: 'anthropic' }
            : {
                ok: false,
                latencyMs: 90,
                model: 'claude-sonnet-4-5',
                provider: 'anthropic',
                error: 'The provider rejected the API key',
                code: 'auth',
              }
        ),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runAiTest(ctx, 'Claude')
    expect(bodyOf(calls[1]?.init ?? {})).toEqual({ configId: CONFIG })
    expect(out.content()).toContain('Connected in 812 ms · claude-sonnet-4-5')
    ok = false
    const error = await captureError(runAiTest(ctx, 'Claude'))
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(out.content()).toContain('Connection failed · The provider rejected the API key')
  })

  it('test of a candidate sends the inline body, key from the prompt', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/ai/config/test': () =>
        jsonResponse({ ok: true, latencyMs: 1, model: 'gpt-4.1-mini', provider: 'openai' }),
    })
    const { ctx } = await testContext({ store, fetch })
    await runAiTest(ctx, undefined, {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      key: true,
      isTTY: true,
      promptHidden: async () => 'sk-x',
    })
    expect(bodyOf(calls[0]?.init ?? {})).toEqual({
      scope: 'chat',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      apiKey: 'sk-x',
    })
  })
})

const prompt = (over: Record<string, unknown> = {}) => ({
  definition: {
    key: 'chat',
    title: 'Chat assistant',
    description: 'The system prompt of chat',
    variables: ['appName', 'userName'],
    defaultText: 'You are {{appName}}.\nBe brief.',
  },
  override: null,
  isOverridden: false,
  effectiveText: 'You are {{appName}}.\nBe brief.',
  ...over,
})

describe('ai prompts', () => {
  it('ls / show --json print the bodies', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      '/api/ai/prompts': () => jsonResponse({ items: [prompt()] }),
      '/api/ai/prompts/chat': () => jsonResponse(prompt()),
    })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runPromptsList(ctx)
    expect(JSON.parse(out.content()).items[0].definition.key).toBe('chat')
    const human = await testContext({ store, fetch })
    await runPromptShow(human.ctx, 'chat')
    expect(human.out.content()).toContain('You are {{appName}}.')
  })

  it('set PUTs the file text and prints what changed; --dry-run sends nothing', async () => {
    const store = await loggedInStore()
    const after = 'You are {{appName}}.\nBe thorough.'
    const { fetch, calls } = mockFetch({
      '/api/ai/prompts/chat': (_url, init) =>
        jsonResponse(
          init.method === 'PUT' ? prompt({ isOverridden: true, effectiveText: after }) : prompt()
        ),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runPromptSet(ctx, 'chat', { file: '-', dryRun: true, readStdin: async () => after })
    expect(calls).toHaveLength(1)
    expect(out.content()).toContain('not saved (--dry-run)')
    await runPromptSet(ctx, 'chat', { file: 'p.txt', readFile: async () => after })
    expect(calls[2]?.init.method).toBe('PUT')
    expect(bodyOf(calls[2]?.init ?? {})).toEqual({ text: after })
    expect(out.content()).toMatch(/- Be brief\./)
    expect(out.content()).toMatch(/\+ Be thorough\./)
  })

  it('set of an empty text exits 1 before any request; an unknown key is 404 → 1', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store, fetch })
    const empty = await captureError(
      runPromptSet(ctx, 'chat', { file: '-', readStdin: async () => '  ' })
    )
    expect(exitCodeFor(empty)).toBe(EXIT_ERROR)
    expect(calls).toHaveLength(0)
    const missing = await captureError(
      runPromptSet(ctx, 'nope', { file: '-', readStdin: async () => 'x' })
    )
    expect(exitCodeFor(missing)).toBe(EXIT_ERROR)
  })

  it('reset asks with the page’s words, then DELETEs', async () => {
    const store = await loggedInStore()
    const overridden = prompt({
      isOverridden: true,
      override: {
        tenantId: TENANT_ID,
        key: 'chat',
        text: 'x',
        updatedByUserId: USER_ID,
        updatedAt: '2026-10-01T10:00:00.000Z',
      },
    })
    const { fetch, calls } = mockFetch({
      '/api/ai/prompts/chat': (_url, init) =>
        jsonResponse(init.method === 'DELETE' ? prompt() : overridden),
    })
    const { ctx } = await testContext({ store, fetch })
    expect((await captureError(runPromptReset(ctx, 'chat'))).message).toMatch(/Refusing/)
    let question = ''
    await runPromptReset(ctx, 'chat', {
      confirm: async q => {
        question = q
        return true
      },
    })
    expect(question).toBe(
      'Discard this organisation\'s override of "Chat assistant" and use the built-in prompt again?'
    )
    expect(calls.at(-1)?.init.method).toBe('DELETE')
  })

  it('a member PUT is 403 → exit 3', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      '/api/ai/prompts/chat': (_url, init) =>
        init.method === 'PUT' ? forbidden() : jsonResponse(prompt()),
    })
    const { ctx } = await testContext({ store, fetch })
    const error = await captureError(
      runPromptSet(ctx, 'chat', { file: '-', readStdin: async () => 'x' })
    )
    expect(exitCodeFor(error)).toBe(EXIT_FORBIDDEN)
  })

  it('lineDiff keeps context and marks changes', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc').map(l => stripVTControlCharacters(l))).toEqual([
      '  a',
      '- b',
      '+ B',
      '  c',
    ])
  })
})

describe('ai models', () => {
  const entry = {
    promptKey: 'chat',
    title: 'Chat assistant',
    assignment: null,
    effective: {
      source: 'tenant',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      configId: CONFIG,
    },
  }

  it('ls --json, set resolves the config label, reset DELETEs', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/ai/agent-models': () => jsonResponse({ items: [entry] }),
      '/api/ai/config': () => jsonResponse({ items: [config()] }),
      '/api/ai/agent-models/chat': (_url, init) =>
        init.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : jsonResponse({
              promptKey: 'chat',
              aiConfigId: CONFIG,
              model: 'claude-opus-4-1',
              updatedAt: '2026-10-01T10:00:00.000Z',
            }),
    })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runAgentModelsList(ctx)
    expect(JSON.parse(out.content()).items[0].promptKey).toBe('chat')
    await runAgentModelSet(ctx, 'chat', { config: 'Claude', model: 'claude-opus-4-1' })
    const put = calls.find(c => c.init.method === 'PUT')
    expect(bodyOf(put?.init ?? {})).toEqual({ aiConfigId: CONFIG, model: 'claude-opus-4-1' })
    const before = calls.length
    expect(exitCodeFor(await captureError(runAgentModelReset(ctx, 'chat')))).toBe(EXIT_ERROR) // no terminal and no --yes: refused, nothing sent
    await runAgentModelReset(ctx, 'chat', { confirm: async () => false })
    expect(calls).toHaveLength(before)
    await runAgentModelReset(ctx, 'chat', { yes: true })
    expect(calls.at(-1)?.init.method).toBe('DELETE')
  })

  it('set with neither flag exits 1 before any request', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({})
    const { ctx } = await testContext({ store, fetch })
    expect(exitCodeFor(await captureError(runAgentModelSet(ctx, 'chat', {})))).toBe(EXIT_ERROR)
    expect(calls).toHaveLength(0)
  })
})
