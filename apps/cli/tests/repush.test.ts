/**
 * Issue #6: `grants repush <app> <grant>` and `shared retry <slug> <push>`, in-process against a
 * fake server — the grant / push is found by id, prefix or slug, the POST goes to the right path,
 * `--json` is the body, a 409 is the server's sentence (exit 1) and a 403 exits 3.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { runGrantsRepush } from '../src/commands/grants'
import { runSharedRetry } from '../src/commands/shared'
import { EXIT_ERROR, EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
import type { Route } from './helpers'
import { jsonResponse, mockFetch, testContext } from './helpers'
import { APP_ID, appDetail, loggedInStore } from './p4-fixtures'
import {
  appConfig,
  GRANT_ID,
  grant,
  PUSH_ID,
  push,
  pushSummary,
  RESOURCE_ID,
  resource,
  resourceDetail,
  target,
} from './p5-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

const forbidden = () =>
  jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403)

async function run(
  fn: (ctx: Awaited<ReturnType<typeof testContext>>['ctx']) => Promise<void>,
  routes: Record<string, Route>,
  json = false
) {
  const { fetch, calls } = mockFetch({
    '/api/apps/expenses': () => jsonResponse(appDetail),
    [`/api/apps/${APP_ID}/config`]: () => jsonResponse(appConfig()),
    '/api/shared-resources': () => jsonResponse({ items: [resource()] }),
    [`/api/shared-resources/${RESOURCE_ID}`]: () => jsonResponse(resourceDetail()),
    ...routes,
  })
  const t = await testContext({ store: await loggedInStore(cleanups), fetch, json })
  const error: any = await fn(t.ctx).then(
    () => null,
    (e: unknown) => e
  )
  return { ...t, calls, error }
}

describe('grants repush', () => {
  const path = `/api/apps/${APP_ID}/grants/${GRANT_ID}/repush`

  it('finds the grant by resource slug and posts the repush; --json is the body', async () => {
    const routes = {
      [path]: () => jsonResponse({ grant: grant(), pushId: PUSH_ID }, 202),
    }
    const human = await run(ctx => runGrantsRepush(ctx, 'expenses', 'm365'), routes)
    expect(human.error).toBeNull()
    expect(human.calls.at(-1)?.init.method).toBe('POST')
    expect(human.out.content()).toContain('Pushing m365 to expenses (staging) again')
    expect(human.out.content()).toContain('launch shared pushes m365 --env staging --wait')

    const json = await run(
      ctx => runGrantsRepush(ctx, 'expenses', GRANT_ID.slice(0, 8)),
      routes,
      true
    )
    expect(JSON.parse(json.out.content()).pushId).toBe(PUSH_ID)
  })

  it('a 409 is the server’s sentence (exit 1); a 403 exits 3', async () => {
    const refused = await run(ctx => runGrantsRepush(ctx, 'expenses', 'm365'), {
      [path]: () =>
        jsonResponse(
          { error: 'Only an active grant is pushed', statusCode: 409, code: 'grant_not_active' },
          409
        ),
    })
    expect(exitCodeFor(refused.error)).toBe(EXIT_ERROR)
    expect(String(refused.error.message)).toContain('Only an active grant')

    const denied = await run(ctx => runGrantsRepush(ctx, 'expenses', 'm365'), { [path]: forbidden })
    expect(exitCodeFor(denied.error)).toBe(EXIT_FORBIDDEN)
  })
})

describe('shared retry', () => {
  const path = `/api/shared-resources/${RESOURCE_ID}/pushes/${PUSH_ID}/retry`
  const listPath = `/api/shared-resources/${RESOURCE_ID}/pushes`

  it('resolves an 8-character push prefix and posts the retry; --json is the body', async () => {
    const routes = {
      [listPath]: () => jsonResponse({ items: [pushSummary()] }),
      [path]: () => jsonResponse(push(), 202),
    }
    const human = await run(ctx => runSharedRetry(ctx, 'm365', PUSH_ID.slice(0, 8)), routes)
    expect(human.error).toBeNull()
    expect(human.calls.at(-1)?.url.pathname).toBe(path)
    expect(human.out.content()).toContain('Retrying the production push of m365')

    const json = await run(ctx => runSharedRetry(ctx, 'm365', PUSH_ID), routes, true)
    expect(JSON.parse(json.out.content()).id).toBe(PUSH_ID)
  })

  it('--wait follows the push and exits 1 when an app still failed', async () => {
    const failed = push({
      status: 'partial',
      succeeded: 1,
      failed: 1,
      targets: [target('expenses'), target('crm', { status: 'failed', error: 'HTTP 500' })],
    })
    const { error, out } = await run(
      ctx => runSharedRetry(ctx, 'm365', PUSH_ID, { wait: true, sleep: async () => {}, pollMs: 1 }),
      {
        [path]: () => jsonResponse(push(), 202),
        [`/api/shared-resources/${RESOURCE_ID}/pushes/${PUSH_ID}`]: () => jsonResponse(failed),
      }
    )
    expect(exitCodeFor(error)).toBe(EXIT_ERROR)
    expect(out.content()).toContain('crm — HTTP 500')
  })

  it('an unknown push exits 1 before any POST; a 403 exits 3', async () => {
    const unknown = await run(ctx => runSharedRetry(ctx, 'm365', 'ffffffff'), {
      [listPath]: () => jsonResponse({ items: [pushSummary()] }),
    })
    expect(exitCodeFor(unknown.error)).toBe(EXIT_ERROR)
    expect(unknown.calls.some(c => c.init.method === 'POST')).toBe(false)

    const denied = await run(ctx => runSharedRetry(ctx, 'm365', PUSH_ID), { [path]: forbidden })
    expect(exitCodeFor(denied.error)).toBe(EXIT_FORBIDDEN)
  })
})
