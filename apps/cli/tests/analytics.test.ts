/**
 * The analytics plugin's dashboard commands (issue #6), in-process against a fake fetch: a page
 * by id or slug, the create body validated with the plugin's shared schema, confirmation before a
 * reset / delete / recreate, a template page refused for delete, 403 → 3, 404 → 1.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT_ERROR, EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
import {
  runAnalyticsPageCreate,
  runAnalyticsPageRemove,
  runAnalyticsPageReset,
  runAnalyticsPageShow,
  runAnalyticsPageUpdate,
  runAnalyticsPageVisibility,
  runAnalyticsTemplatesList,
  runAnalyticsTemplatesRecreate,
} from '../src/plugins/analytics'
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
const PAGE = '0a0a0a0a-1111-4222-8333-444444444444'
const GROUP = 'ffffffff-1111-4222-8333-444444444444'
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

const dashboard = (over: Record<string, unknown> = {}) => ({
  id: PAGE,
  tenantId: TENANT_ID,
  slug: 'team-activity',
  name: 'Team activity',
  description: null,
  templateKey: null,
  config: { portlets: [{ id: 'p1', title: 'Sign-ins', chartType: 'line' }] },
  isDefault: false,
  order: 0,
  createdBy: USER_ID,
  visibility: 'tenant',
  groups: [],
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
})

describe('analytics pages', () => {
  it('show resolves a slug through the list; --json prints the page', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      '/api/analytics/pages': () => jsonResponse({ items: [dashboard()] }),
    })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runAnalyticsPageShow(ctx, 'team-activity')
    expect(JSON.parse(out.content()).id).toBe(PAGE)
    const missing = await captureError(runAnalyticsPageShow(ctx, 'nope'))
    expect(exitCodeFor(missing)).toBe(EXIT_ERROR)
  })

  it('show by id reads the page; an unknown id is 404 → exit 1', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({
      [`/api/analytics/pages/${PAGE}`]: () => jsonResponse(dashboard()),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runAnalyticsPageShow(ctx, PAGE)
    expect(out.content()).toContain('Sign-ins')
    const other = '0b0b0b0b-1111-4222-8333-444444444444'
    expect(exitCodeFor(await captureError(runAnalyticsPageShow(ctx, other)))).toBe(EXIT_ERROR)
  })

  it('create posts the validated body; a missing name exits 1 before any request', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      '/api/analytics/pages': () => jsonResponse(dashboard(), 201),
    })
    const { ctx } = await testContext({ store, fetch })
    await runAnalyticsPageCreate(ctx, {
      name: 'Team activity',
      data: '@d.json',
      readFile: async () => '{"config":{"portlets":[]}}',
    })
    expect(bodyOf(calls[0]?.init ?? {})).toEqual({
      name: 'Team activity',
      config: { portlets: [] },
    })
    const bad = await captureError(runAnalyticsPageCreate(ctx, {}))
    expect(bad.message).toMatch(/name/)
    expect(calls).toHaveLength(1)
  })

  it('a member creating is 403 → exit 3', async () => {
    const store = await loggedInStore()
    const { fetch } = mockFetch({ '/api/analytics/pages': forbidden })
    const { ctx } = await testContext({ store, fetch })
    expect(exitCodeFor(await captureError(runAnalyticsPageCreate(ctx, { name: 'x' })))).toBe(
      EXIT_FORBIDDEN
    )
  })

  it('update PATCHes the validated change; an empty change exits 1 before any request', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      [`/api/analytics/pages/${PAGE}`]: () => jsonResponse(dashboard({ name: 'Renamed' })),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runAnalyticsPageUpdate(ctx, PAGE, { name: 'Renamed', description: '', default: true })
    const patch = calls.find(c => c.init.method === 'PATCH')
    expect(JSON.parse(String(patch?.init.body))).toEqual({
      name: 'Renamed',
      description: null,
      isDefault: true,
    })
    expect(out.content()).toContain('Updated "Renamed"')
    const before = calls.length
    expect((await captureError(runAnalyticsPageUpdate(ctx, PAGE, {}))).message).toMatch(
      /At least one field/
    )
    expect(calls).toHaveLength(before)
  })

  it('visibility PUTs the groups', async () => {
    const store = await loggedInStore()
    const { fetch, calls } = mockFetch({
      [`/api/analytics/pages/${PAGE}`]: () => jsonResponse(dashboard()),
      [`/api/analytics/pages/${PAGE}/visibility`]: () =>
        jsonResponse(
          dashboard({
            visibility: 'groups',
            groups: [{ id: GROUP, name: 'Ops', typeName: 'Team' }],
          })
        ),
    })
    const { ctx, out } = await testContext({ store, fetch })
    await runAnalyticsPageVisibility(ctx, PAGE, { groups: GROUP })
    expect(bodyOf(calls[1]?.init ?? {})).toEqual({ visibility: 'groups', groupIds: [GROUP] })
    expect(out.content()).toContain('visible to Ops')
  })

  it('reset asks with the page’s words; a user-created page has nothing to reset', async () => {
    const store = await loggedInStore()
    let templated = true
    const { fetch, calls } = mockFetch({
      [`/api/analytics/pages/${PAGE}`]: () =>
        jsonResponse(dashboard(templated ? { templateKey: 'team-activity' } : {})),
      [`/api/analytics/pages/${PAGE}/reset`]: () =>
        jsonResponse(dashboard({ templateKey: 'team-activity' })),
    })
    const { ctx } = await testContext({ store, fetch })
    expect((await captureError(runAnalyticsPageReset(ctx, PAGE))).message).toMatch(/Refusing/)
    let question = ''
    await runAnalyticsPageReset(ctx, PAGE, {
      confirm: async q => {
        question = q
        return true
      },
    })
    expect(question).toBe(
      '"Team activity" goes back to its template layout. Portlets added or changed on this dashboard are lost.'
    )
    expect(calls.at(-1)?.init.method).toBe('POST')
    templated = false
    expect((await captureError(runAnalyticsPageReset(ctx, PAGE, { yes: true }))).message).toMatch(
      /not made from a template/
    )
  })

  it('rm deletes a user-created page after asking; a template page is refused', async () => {
    const store = await loggedInStore()
    let templated = false
    const { fetch, calls } = mockFetch({
      [`/api/analytics/pages/${PAGE}`]: (_url, init) =>
        init.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : jsonResponse(dashboard(templated ? { templateKey: 'x' } : {})),
    })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runAnalyticsPageRemove(ctx, PAGE, { confirm: async () => true })
    expect(calls.at(-1)?.init.method).toBe('DELETE')
    expect(JSON.parse(out.content())).toEqual({ deleted: PAGE })
    templated = true
    const refused = await captureError(runAnalyticsPageRemove(ctx, PAGE, { yes: true }))
    expect(refused.message).toMatch(/reset them instead/)
  })
})

describe('analytics templates', () => {
  it('list --json; recreate asks, then reports created and reset', async () => {
    const store = await loggedInStore()
    const items = [{ key: 'team-activity', name: 'Team activity', description: 'Who did what' }]
    const { fetch, calls } = mockFetch({
      '/api/analytics/templates': () => jsonResponse({ items }),
      '/api/analytics/templates/recreate': () => jsonResponse({ created: 1, reset: 2 }),
    })
    const { ctx, out } = await testContext({ store, fetch, json: true })
    await runAnalyticsTemplatesList(ctx)
    expect(JSON.parse(out.content()).items).toEqual(items)
    await runAnalyticsTemplatesRecreate(ctx, { confirm: async () => false })
    expect(calls).toHaveLength(1)
    const human = await testContext({ store, fetch })
    await runAnalyticsTemplatesRecreate(human.ctx, { yes: true })
    expect(human.out.content()).toContain('Created 1 and reset 2 template dashboard(s).')
  })
})
