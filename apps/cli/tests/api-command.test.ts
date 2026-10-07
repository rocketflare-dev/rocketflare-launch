/** `launch api ls|show|call` and `launch commands` (issue #6): agent discovery. */
import { Command } from 'commander'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  API_CATALOG,
  type ApiCatalog,
  type JsonSchema,
  matchRoute,
  pathParams,
  registerApiCommands,
  requestIssueLines,
  requestIssues,
  runApiCall,
  runApiLs,
  runApiSchema,
  runApiShow,
} from '../src/commands/api'
import {
  aliasListVerbs,
  type CommandNode,
  commandTree,
  runCommands,
} from '../src/commands/commands'
import { EXIT_ERROR, EXIT_FORBIDDEN, EXIT_NOT_LOGGED_IN } from '../src/errors'
import { API_SCHEMAS } from '../src/generated/api-schemas'
import type { ActionWrapper } from '../src/plugins/types'
import {
  captureError,
  headersOf,
  jsonResponse,
  mockFetch,
  TENANT_ID,
  TEST_KEY,
  tempStore,
  testContext,
} from './helpers'

const SERVER = 'http://server.test'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

async function loggedInStore() {
  const t = await tempStore()
  cleanups.push(t.cleanup)
  await t.store.save({ serverUrl: SERVER, apiKey: TEST_KEY, tenantId: TENANT_ID })
  return t.store
}

const CATALOG: ApiCatalog = {
  routes: [
    {
      method: 'GET',
      path: '/api/sessions/:id',
      summary: 'One session.',
      auth: 'signed-in',
      cli: ['commands/sessions-debug.ts'],
    },
    {
      method: 'POST',
      path: '/api/sessions/:id/end',
      summary: 'End a session; its branch is kept.',
      auth: 'signed-in',
      cli: ['commands/sessions.ts'],
    },
    {
      method: 'POST',
      path: '/api/apps/:id/sessions',
      summary: 'Start a coding session on an app.',
      description: 'Refused with session_limit when the organisation is at its cap.',
      auth: 'signed-in',
      source: 'apps/web/src/api/routes/app-sessions.ts',
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          runtime: { type: 'string', enum: ['claude_code', 'codex'] },
          message: { type: 'string', description: 'the first turn' },
        },
        required: ['message'],
      },
      query: { type: 'object', properties: { dryRun: { type: 'boolean' } } },
    },
    {
      method: 'POST',
      path: '/api/apps/new',
      summary: 'A literal route beside the :id one.',
      auth: 'signed-in',
    },
    { method: 'POST', path: '/api/apps/:id', summary: '', auth: 'signed-in' },
  ],
}

describe('matchRoute', () => {
  it('matches a concrete path to its pattern, the most specific first', () => {
    expect(matchRoute(CATALOG, 'POST', '/api/sessions/abc123/end')?.path).toBe(
      '/api/sessions/:id/end'
    )
    expect(matchRoute(CATALOG, 'post', '/api/apps/new')?.path).toBe('/api/apps/new')
    expect(matchRoute(CATALOG, 'POST', '/api/apps/xyz')?.path).toBe('/api/apps/:id')
    expect(matchRoute(CATALOG, 'GET', '/api/sessions/abc/end')).toBeUndefined()
  })

  it('the committed catalog knows the real routes', () => {
    const route = matchRoute(API_CATALOG, 'POST', '/api/apps/abc/sessions')
    expect(route?.path).toBe('/api/apps/:id/sessions')
    expect((route?.body as JsonSchema | undefined)?.properties).toHaveProperty('runtime')
    expect(route?.zod?.body).toBe('@launch/shared/launch-sessions#createSessionRequestSchema')
    expect(route?.cli).toContain('commands/sessions.ts')
  })
})

describe('api ls', () => {
  it('filters by path or summary, case-insensitively, and by method', async () => {
    const store = await loggedInStore()
    const { ctx, out } = await testContext({ store })
    await runApiLs(ctx, 'BRANCH', {}, CATALOG)
    expect(out.content()).toContain('/api/sessions/:id/end')
    expect(out.content()).not.toContain('/api/apps/:id/sessions')
    expect(out.content()).toContain('✓ commands/sessions.ts')

    const second = await testContext({ store })
    await runApiLs(second.ctx, 'sessions', { method: 'post' }, CATALOG)
    const text = second.out.content()
    expect(text).toContain('/api/apps/:id/sessions')
    expect(text).not.toContain('GET ')
  })

  it('--json prints the matching catalog entries', async () => {
    const store = await loggedInStore()
    const { ctx, out } = await testContext({ store, json: true })
    await runApiLs(ctx, 'new', {}, CATALOG)
    expect(JSON.parse(out.content())).toEqual([CATALOG.routes[3]])
  })

  it('names a route no command covers with `launch api call`', async () => {
    const store = await loggedInStore()
    const { ctx, out } = await testContext({ store })
    await runApiLs(ctx, '/api/apps/new', {}, CATALOG)
    expect(out.content()).toContain('launch api call')
  })
})

describe('api show', () => {
  it('renders the body fields, an example and the call for a concrete path', async () => {
    const store = await loggedInStore()
    const { ctx, out } = await testContext({ store })
    await runApiShow(ctx, 'POST', '/api/apps/a1/sessions', CATALOG)
    const text = out.content()
    expect(text).toContain('POST /api/apps/:id/sessions')
    expect(text).toContain('Start a coding session on an app.')
    expect(text).toContain('session_limit')
    expect(text).toMatch(/message\s+string\s+yes\s+the first turn/)
    expect(text).toMatch(/title\s+string\s+no\s+1–200 chars/)
    expect(text).toContain('"claude_code" | "codex"')
    expect(text).toMatch(/dryRun\s+boolean/)
    expect(text).toMatch(/id\s+string\s+yes/) // the path param, from the pattern
    expect(text).toContain('"runtime": "claude_code"')
    expect(text).toContain('launch api call POST /api/apps/a1/sessions --data')
    expect(text).toContain('apps/web/src/api/routes/app-sessions.ts')
  })

  it('--json prints the catalog entry', async () => {
    const store = await loggedInStore()
    const { ctx, out } = await testContext({ store, json: true })
    await runApiShow(ctx, 'POST', '/api/sessions/x/end', CATALOG)
    expect(JSON.parse(out.content())).toEqual(CATALOG.routes[1])
  })

  it('an unknown route or method exits 1', async () => {
    const store = await loggedInStore()
    const { ctx } = await testContext({ store })
    expect((await captureError(runApiShow(ctx, 'GET', '/api/nope', CATALOG))).exitCode).toBe(
      EXIT_ERROR
    )
    expect((await captureError(runApiShow(ctx, 'FETCH', '/api/nope', CATALOG))).exitCode).toBe(
      EXIT_ERROR
    )
  })
})

describe('api schema', () => {
  it('prints the route’s full JSON Schema and the zod exports it came from', async () => {
    const store = await loggedInStore()
    const { ctx, out } = await testContext({ store, json: true })
    await runApiSchema(ctx, 'POST', '/api/apps/a1/sessions')
    const schema = JSON.parse(out.content())
    expect(schema.path).toBe('/api/apps/:id/sessions')
    expect(schema.body.properties).toHaveProperty('runtime')
    expect(schema.zod.body).toBe('@launch/shared/launch-sessions#createSessionRequestSchema')
  })

  it('show names the shared export it validates with', async () => {
    const store = await loggedInStore()
    const { ctx, out } = await testContext({ store })
    await runApiShow(ctx, 'POST', '/api/apps/a1/sessions')
    expect(out.content()).toContain(
      'validated locally with @launch/shared/launch-sessions#createSessionRequestSchema'
    )
  })

  it('every registry schema is a zod object the catalog names', () => {
    for (const [key, entry] of Object.entries(API_SCHEMAS)) {
      const [method, path] = key.split(' ') as [string, string]
      const route = API_CATALOG.routes.find(r => r.method === method && r.path === path)
      expect(route, key).toBeDefined()
      if ('body' in entry) expect(route?.zod?.body, key).toBeDefined()
    }
  })
})

describe('api call', () => {
  it('sends --data JSON and repeated --query values with the key, and prints the body', async () => {
    const store = await loggedInStore()
    const api = mockFetch({
      '/api/apps/a1/sessions': () => jsonResponse({ session: { id: 's1' } }, 202),
    })
    const { ctx, out, log } = await testContext({ store, fetch: api.fetch })
    await runApiCall(ctx, 'post', '/api/apps/a1/sessions', {
      data: '{"message":"hi","title":"x"}',
      query: ['dryRun=true', 'tag=a', 'tag=b'],
      catalog: CATALOG,
      schemas: {},
    })
    const call = api.calls[0]
    expect(call?.init.method).toBe('POST')
    expect(JSON.parse(String(call?.init.body))).toEqual({ message: 'hi', title: 'x' })
    expect(call?.url.searchParams.get('dryRun')).toBe('true')
    expect(call?.url.searchParams.getAll('tag')).toEqual(['a', 'b'])
    expect(headersOf(api.calls).Authorization).toBe(`Bearer ${TEST_KEY}`)
    expect(JSON.parse(out.content())).toEqual({ session: { id: 's1' } })
    expect(log.lines.join('\n')).not.toContain(TEST_KEY)
  })

  it('reads --data @file and --data - (stdin)', async () => {
    const store = await loggedInStore()
    const api = mockFetch({ '/api/sessions/s1/end': () => jsonResponse({ ok: true }) })
    const { ctx } = await testContext({ store, fetch: api.fetch })
    await runApiCall(ctx, 'POST', '/api/sessions/s1/end', {
      data: '@body.json',
      readFile: async p => (p === 'body.json' ? '{"from":"file"}' : ''),
      catalog: CATALOG,
      validate: false,
    })
    await runApiCall(ctx, 'POST', '/api/sessions/s1/end', {
      data: '-',
      readStdin: async () => '{"from":"stdin"}',
      catalog: CATALOG,
      validate: false,
    })
    expect(api.calls.map(c => JSON.parse(String(c.init.body)))).toEqual([
      { from: 'file' },
      { from: 'stdin' },
    ])
  })

  it('validates --data with the route’s own zod schema before sending; --no-validate sends', async () => {
    const store = await loggedInStore()
    const api = mockFetch({ '/api/apps/a1/sessions': () => jsonResponse({ ok: true }) })
    const { ctx } = await testContext({ store, fetch: api.fetch })
    const error = await captureError(
      runApiCall(ctx, 'POST', '/api/apps/a1/sessions', { data: '{"title":7}' })
    )
    expect(error.exitCode).toBe(EXIT_ERROR)
    expect(error.message).toContain('POST /api/apps/:id/sessions')
    expect(error.message).toMatch(/--data title: Expected string, received number/)
    expect(api.calls).toHaveLength(0)

    await runApiCall(ctx, 'POST', '/api/apps/a1/sessions', {
      data: '{"title":7}',
      validate: false,
    })
    // What was given is what is sent — the server parses it again.
    expect(JSON.parse(String(api.calls[0]?.init.body))).toEqual({ title: 7 })
  })

  it('a valid body passes and is sent unchanged', async () => {
    const store = await loggedInStore()
    const api = mockFetch({ '/api/tenant': () => jsonResponse({ ok: true }) })
    const { ctx } = await testContext({ store, fetch: api.fetch })
    await runApiCall(ctx, 'PATCH', '/api/tenant', { data: '{"name":"Acme"}' })
    expect(JSON.parse(String(api.calls[0]?.init.body))).toEqual({ name: 'Acme' })
  })

  it('--json prints the issues as the server’s envelope', async () => {
    const store = await loggedInStore()
    const api = mockFetch({})
    const { ctx, out } = await testContext({ store, fetch: api.fetch, json: true })
    await captureError(runApiCall(ctx, 'POST', '/api/apps/a1/sessions', { data: '{"title":7}' }))
    const envelope = JSON.parse(out.content())
    expect(envelope.code).toBe('validation_failed')
    expect(envelope.details).toContainEqual(
      expect.objectContaining({ in: 'body', path: ['title'] })
    )
  })

  it('refuses a body for a route that reads none', async () => {
    const store = await loggedInStore()
    const api = mockFetch({})
    const { ctx } = await testContext({ store, fetch: api.fetch })
    const error = await captureError(
      runApiCall(ctx, 'POST', '/api/sessions/s1/end', { data: '{"x":1}', catalog: CATALOG })
    )
    expect(error.message).toContain('--data: this route reads no body')
    expect(api.calls).toHaveLength(0)
  })

  it('checks path params and --query with their schemas', () => {
    const route = CATALOG.routes[2] as (typeof CATALOG.routes)[number]
    const entry = {
      params: z.object({ id: z.string().uuid() }),
      query: z.object({ dryRun: z.enum(['true', 'false']).optional(), tag: z.array(z.string()) }),
      body: z.object({ message: z.string() }),
    }
    const issues = requestIssues(route, entry, {
      path: '/api/apps/nope/sessions',
      query: { dryRun: ['maybe'], tag: ['a', 'b'] },
      body: undefined,
    })
    expect(requestIssueLines(issues)).toEqual([
      'path id: Invalid uuid',
      expect.stringMatching(/^--query dryRun: Invalid enum value/),
      '--data message: Required',
    ])
    // A pattern path (`<id>` or `:id`) has no concrete params to check.
    expect(pathParams('/api/apps/:id/sessions', '/api/apps/<id>/sessions')).toBeUndefined()
    expect(pathParams('/api/apps/:id/sessions', '/api/apps/a%201/sessions')).toEqual({ id: 'a 1' })
  })

  it('a per-param body picks its schema by the path param; a multipart route is refused', () => {
    const credentials = API_CATALOG.routes.find(
      r => r.method === 'PUT' && r.path === '/api/platform/setup/credentials/:kind'
    )
    expect(credentials).toBeDefined()
    const entry = API_SCHEMAS['PUT /api/platform/setup/credentials/:kind']
    const issues = requestIssues(credentials as NonNullable<typeof credentials>, entry, {
      path: '/api/platform/setup/credentials/cloudflare_api_token',
      query: {},
      body: { apiToken: 'short' },
    })
    expect(requestIssueLines(issues)[0]).toMatch(/^--data apiToken: /)

    const upload = API_CATALOG.routes.find(r => r.method === 'POST' && r.path === '/api/files')
    const refused = requestIssues(
      upload as NonNullable<typeof upload>,
      API_SCHEMAS['POST /api/files'],
      {
        path: '/api/files',
        query: { scope: ['uploads'] },
        body: {},
      }
    )
    expect(requestIssueLines(refused).join('\n')).toContain('multipart/form-data (fields: file)')
  })

  it('an optional body may be left out', () => {
    const grant = API_CATALOG.routes.find(r => r.path === '/api/sessions/:id/preview-grant')
    const entry = API_SCHEMAS['POST /api/sessions/:id/preview-grant']
    const input = { path: '/api/sessions/s1/preview-grant', query: {} }
    expect(
      requestIssues(grant as NonNullable<typeof grant>, entry, { ...input, body: undefined })
    ).toEqual([])
    expect(
      requestIssues(grant as NonNullable<typeof grant>, entry, { ...input, body: { path: 7 } })
    ).toHaveLength(1)
  })

  it('refuses bad JSON before any request', async () => {
    const store = await loggedInStore()
    const api = mockFetch({})
    const { ctx } = await testContext({ store, fetch: api.fetch })
    const error = await captureError(
      runApiCall(ctx, 'POST', '/api/x', { data: '{nope', catalog: CATALOG })
    )
    expect(error.exitCode).toBe(EXIT_ERROR)
    expect(api.calls).toHaveLength(0)
  })

  it('prints the error envelope (with details) and maps 400/401/403 to 1/2/3', async () => {
    const store = await loggedInStore()
    const envelope = {
      error: 'Invalid json',
      statusCode: 400,
      code: 'validation_failed',
      details: [{ path: ['message'], message: 'Required' }],
    }
    const statuses: Record<string, number> = { '/api/a': 400, '/api/b': 401, '/api/c': 403 }
    const api = mockFetch(
      Object.fromEntries(
        Object.entries(statuses).map(([p, s]) => [
          p,
          () => jsonResponse({ ...envelope, statusCode: s }, s),
        ])
      )
    )
    const codes: number[] = []
    for (const p of Object.keys(statuses)) {
      const { ctx, out } = await testContext({ store, fetch: api.fetch })
      const error = await captureError(runApiCall(ctx, 'GET', p, { catalog: CATALOG }))
      codes.push(error.exitCode)
      expect(JSON.parse(out.content()).details).toEqual(envelope.details)
    }
    expect(codes).toEqual([EXIT_ERROR, EXIT_NOT_LOGGED_IN, EXIT_FORBIDDEN])
  })

  it('--raw passes the text through', async () => {
    const store = await loggedInStore()
    const api = mockFetch({
      '/api/x': () => new Response('{"a":1}', { headers: { 'Content-Type': 'application/json' } }),
    })
    const { ctx, out } = await testContext({ store, fetch: api.fetch })
    await runApiCall(ctx, 'GET', '/api/x', { raw: true, catalog: CATALOG })
    expect(out.content()).toBe('{"a":1}\n')
  })

  it('needs a login', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const { ctx } = await testContext({ store: t.store })
    const error = await captureError(runApiCall(ctx, 'GET', '/api/x', { catalog: CATALOG }))
    expect(error.exitCode).toBe(EXIT_NOT_LOGGED_IN)
  })
})

describe('commands', () => {
  const noopAction: ActionWrapper = () => async () => {}
  function program() {
    const p = new Command().name('launch').option('--json', 'print raw JSON')
    const sessions = p.command('sessions').description('coding sessions')
    sessions
      .command('logs <id>')
      .description('print the event log')
      .option('--limit <n>', 'only the last n')
      .option('--type <types>', 'type prefixes', 'all')
    registerApiCommands(p, noopAction)
    return p
  }
  const find = (node: CommandNode, path: string): CommandNode | undefined =>
    node.path === path ? node : node.commands.map(c => find(c, path)).find(Boolean)

  it('the tree holds every command with its arguments and options', () => {
    const tree = commandTree(program())
    const logs = find(tree, 'sessions logs')
    expect(logs?.arguments).toEqual([{ name: 'id', required: true, variadic: false }])
    expect(logs?.options).toContainEqual({ flags: '--limit <n>', description: 'only the last n' })
    expect(logs?.options).toContainEqual({
      flags: '--type <types>',
      description: 'type prefixes',
      default: 'all',
    })
    expect(find(tree, 'api call')?.options.map(o => o.flags)).toContain('--data <json|@file|->')
    expect(find(tree, 'api show')?.arguments.map(a => a.name)).toEqual(['method', 'path'])
    expect(find(tree, 'commands')).toBeDefined()
  })

  it('prints lines, or the tree with --json', async () => {
    const store = await loggedInStore()
    const human = await testContext({ store })
    await runCommands(human.ctx, program())
    expect(human.out.content()).toContain('launch sessions logs <id>')
    expect(human.out.content()).toContain('--limit <n>')

    const json = await testContext({ store, json: true })
    await runCommands(json.ctx, program())
    const tree = JSON.parse(json.out.content()) as CommandNode
    expect(tree.commands.map(c => c.path)).toEqual(['sessions', 'api', 'commands'])
  })

  it('ls and list answer to each other, unless a sibling owns the other name', () => {
    const p = new Command().name('launch')
    const a = p.command('a')
    a.command('ls')
    const b = p.command('b')
    b.command('list')
    const c = p.command('c')
    c.command('ls')
    c.command('list')
    aliasListVerbs(p)
    expect(a.commands[0]?.aliases()).toEqual(['list'])
    expect(b.commands[0]?.aliases()).toEqual(['ls'])
    expect(c.commands.map(x => x.aliases())).toEqual([[], []])
    expect(find(commandTree(p), 'a ls')?.aliases).toEqual(['list'])
  })
})
