/**
 * Issue #6: `deploys ls|latest <app>` and `releases show|chain|promotion`, in-process against a
 * fake server — the slug resolves, the route's body parses with its shared contract, `--json`
 * prints it, an unknown release exits 1 and a 403 exits 3.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { runDeploysLatest, runDeploysList } from '../src/commands/deploys'
import {
  promotionSentence,
  runReleasesChain,
  runReleasesPromotion,
  runReleasesShow,
} from '../src/commands/releases'
import { EXIT_ERROR, EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
import type { Route } from './helpers'
import { jsonResponse, mockFetch, TENANT_ID, testContext } from './helpers'
import {
  APP_ID,
  APPROVAL_ID,
  appDetail,
  at,
  loggedInStore,
  RELEASE_ID,
  release,
} from './p4-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

const TICKET_ID = 'd0000000-0000-4000-8000-000000000001'
const ENV_ID = '5a000000-0000-4000-8000-000000000001'
const forbidden = () =>
  jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403)

async function run(
  fn: (ctx: Awaited<ReturnType<typeof testContext>>['ctx']) => Promise<void>,
  routes: Record<string, Route>,
  json = false
) {
  const { fetch, calls } = mockFetch({
    '/api/apps/expenses': () => jsonResponse(appDetail),
    ...routes,
  })
  const t = await testContext({ store: await loggedInStore(cleanups), fetch, json })
  const error: any = await fn(t.ctx).then(
    () => null,
    (e: unknown) => e
  )
  return { ...t, calls, error }
}

const ticket = (over: Record<string, unknown> = {}) => ({
  id: TICKET_ID,
  appId: APP_ID,
  environmentId: ENV_ID,
  environment: 'production',
  purpose: 'deploy',
  status: 'finished',
  repository: 'acme/expenses',
  runId: '42',
  runAttempt: 1,
  sha: 'abcdef1234567890',
  ref: 'refs/tags/1.4.0',
  actor: 'alice',
  version: '1.4.0',
  cfVersionId: null,
  activatedAt: at,
  refused: null,
  decisionSource: 'approval',
  decidedByUserId: null,
  decidedAt: at,
  expiresAt: null,
  error: null,
  createdAt: at,
  updatedAt: at,
  finishedAt: at,
  ...over,
})

const progress = (over: Record<string, unknown> = {}) => ({
  ticketId: TICKET_ID,
  environment: 'staging',
  phase: 'failed',
  reached: 'uploaded',
  inProgress: false,
  version: '1.5.0',
  sha: 'abc',
  ref: null,
  actor: 'bob',
  runUrl: 'https://github.com/acme/expenses/actions/runs/43',
  error: 'Migration 0007 failed',
  approvalId: null,
  startedAt: '2026-09-28T10:00:00.000Z',
  updatedAt: at,
  activatedAt: null,
  finishedAt: '2026-09-28T10:03:00.000Z',
  ...over,
})

describe('deploys', () => {
  it('ls prints each ticket with its run; --json is the body; a 403 exits 3', async () => {
    const routes = {
      [`/api/apps/${APP_ID}/deploys`]: () =>
        jsonResponse({ items: [ticket(), ticket({ status: 'failed', error: 'refused' })] }),
    }
    const human = await run(ctx => runDeploysList(ctx, 'expenses'), routes)
    expect(human.out.content()).toContain('Live')
    expect(human.out.content()).toContain('v1.4.0')
    expect(human.out.content()).toContain('https://github.com/acme/expenses/actions/runs/42')

    const json = await run(ctx => runDeploysList(ctx, 'expenses'), routes, true)
    expect(JSON.parse(json.out.content()).items).toHaveLength(2)

    const denied = await run(ctx => runDeploysList(ctx, 'expenses'), {
      [`/api/apps/${APP_ID}/deploys`]: forbidden,
    })
    expect(exitCodeFor(denied.error)).toBe(EXIT_FORBIDDEN)
  })

  it('latest says where each deploy is and why one failed; an unknown app exits 1', async () => {
    const routes = {
      [`/api/apps/${APP_ID}/deploys/latest`]: () => jsonResponse({ items: [progress()] }),
    }
    const human = await run(ctx => runDeploysLatest(ctx, 'expenses'), routes)
    const text = human.out.content()
    expect(text).toContain('Staging v1.5.0 · failed (stopped after uploaded)')
    expect(text).toContain('took 3 min')
    expect(text).toContain('Migration 0007 failed')
    expect(text).toContain('actions/runs/43')

    const json = await run(ctx => runDeploysLatest(ctx, 'expenses'), routes, true)
    expect(JSON.parse(json.out.content()).items[0].phase).toBe('failed')

    const missing = await run(ctx => runDeploysLatest(ctx, 'nope'), {})
    expect(exitCodeFor(missing.error)).toBe(EXIT_ERROR)
  })
})

describe('releases show|chain|promotion', () => {
  const releasePath = `/api/apps/${APP_ID}/releases/${RELEASE_ID}`
  const list = { items: [release()] }

  it('show resolves a version and prints the release; --json is the body', async () => {
    const routes = {
      [`/api/apps/${APP_ID}/releases`]: () => jsonResponse(list),
      [releasePath]: () =>
        jsonResponse(
          release({ status: 'failed', failedStage: 'staging_deploy', error: 'ci / Gate failed' })
        ),
    }
    const human = await run(ctx => runReleasesShow(ctx, 'expenses', '1.4.0'), routes)
    expect(human.out.content()).toContain('v1.4.0 · failed')
    expect(human.out.content()).toContain('ci / Gate failed')
    expect(human.out.content()).toContain('#12 Blue button')
    expect(human.out.content()).toContain('launch releases retry expenses 1.4.0')

    const json = await run(ctx => runReleasesShow(ctx, 'expenses', RELEASE_ID), routes, true)
    expect(JSON.parse(json.out.content()).failedStage).toBe('staging_deploy')

    const unknown = await run(ctx => runReleasesShow(ctx, 'expenses', '9.9.9'), routes)
    expect(exitCodeFor(unknown.error)).toBe(EXIT_ERROR)
  })

  it('chain lists the audit events; a 403 exits 3', async () => {
    const event = {
      id: '0e000000-0000-4000-8000-000000000001',
      tenantId: TENANT_ID,
      at,
      actorType: 'user',
      actorUserId: null,
      actorEmail: 'alice@example.com',
      action: 'release.promoted',
      targetType: 'release',
      targetId: RELEASE_ID,
      appId: APP_ID,
      summary: {},
      requestId: null,
      approvalId: APPROVAL_ID,
      ip: null,
      userAgent: null,
    }
    const routes = {
      [`${releasePath}/chain`]: () => jsonResponse({ release: release(), events: [event] }),
    }
    const human = await run(ctx => runReleasesChain(ctx, 'expenses', RELEASE_ID), {
      ...routes,
      [releasePath]: () => jsonResponse(release()),
    })
    expect(human.out.content()).toContain('release.promoted')
    expect(human.out.content()).toContain('alice@example.com')

    const json = await run(
      ctx => runReleasesChain(ctx, 'expenses', RELEASE_ID),
      {
        ...routes,
        [releasePath]: () => jsonResponse(release()),
      },
      true
    )
    expect(JSON.parse(json.out.content()).events).toHaveLength(1)

    const denied = await run(ctx => runReleasesChain(ctx, 'expenses', RELEASE_ID), {
      [releasePath]: () => jsonResponse(release()),
      [`${releasePath}/chain`]: forbidden,
    })
    expect(exitCodeFor(denied.error)).toBe(EXIT_FORBIDDEN)
  })

  const view = (over: Record<string, unknown> = {}) => ({
    candidate: release(),
    staging: {
      version: '1.4.0',
      deployedAt: at,
      healthStatus: 'up',
      url: null,
      releaseId: RELEASE_ID,
    },
    production: {
      version: '1.3.0',
      deployedAt: at,
      healthStatus: 'up',
      url: null,
      releaseId: null,
    },
    changes: [],
    changesTruncated: false,
    approval: null,
    ...over,
  })

  it('promotion says it is ready and how to promote; --json is the body', async () => {
    const routes = { [`/api/apps/${APP_ID}/promotion`]: () => jsonResponse(view()) }
    const human = await run(ctx => runReleasesPromotion(ctx, 'expenses'), routes)
    expect(human.out.content()).toContain('Ready to promote v1.4.0 to Live')
    expect(human.out.content()).toContain('launch releases promote expenses 1.4.0')
    const json = await run(ctx => runReleasesPromotion(ctx, 'expenses'), routes, true)
    expect(JSON.parse(json.out.content()).candidate.version).toBe('1.4.0')
  })

  it('promotionSentence words each state as the app page does', () => {
    const parse = (o: Record<string, unknown>) =>
      // Dates as the contract gives them.
      ({
        ...view(o),
        candidate:
          o.candidate === null ? null : { ...(o.candidate ?? release()), createdAt: new Date(at) },
      }) as never
    const now = new Date(at)
    expect(promotionSentence(parse({ candidate: null }), now)).toBe('Nothing on staging yet')
    expect(
      promotionSentence(
        parse({
          production: {
            version: '1.4.0',
            deployedAt: at,
            healthStatus: 'up',
            url: null,
            releaseId: null,
          },
        }),
        now
      )
    ).toBe('Live already runs v1.4.0')
    expect(promotionSentence(parse({ candidate: release({ status: 'staging' }) }), now)).toBe(
      'Deploying v1.4.0 to staging…'
    )
    expect(
      promotionSentence(
        parse({
          candidate: release({ status: 'failed' }),
          candidateRun: {
            status: 'completed',
            conclusion: 'failure',
            url: null,
            currentJob: null,
            failedJob: 'ci / Gate',
          },
        }),
        now
      )
    ).toBe('v1.4.0 did not deploy: ci / Gate failed')
    expect(promotionSentence(parse({ candidate: release({ status: 'promoting' }) }), now)).toBe(
      'Deploying v1.4.0 to Live…'
    )
  })
})
