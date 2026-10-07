/**
 * Issue #6, in-process against a fake server: what an app, its pipeline, its health and its
 * upgrades are doing — `apps ls|show|health|health-check|operations|pipeline [retry|cancel]|
 * rescaffold|upgrades|config-scan`. Each reads its route with the shared contract; `--json` is the
 * parsed body; a refusal is the server's sentence (exit 1) and a 403 exits 3.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  healthChanges,
  pipelineStepLines,
  runAppsConfigScan,
  runAppsHealth,
  runAppsHealthCheck,
  runAppsList,
  runAppsOperations,
  runAppsPipeline,
  runAppsPipelineCancel,
  runAppsPipelineRetry,
  runAppsRescaffold,
  runAppsShow,
  runAppsUpgrades,
  stepLabel,
} from '../src/commands/apps'
import { EXIT_ERROR, EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
import type { Route } from './helpers'
import { jsonResponse, mockFetch, testContext } from './helpers'
import { APP_ID, APPROVAL_ID, appDetail, at, loggedInStore, release } from './p4-fixtures'
import { appConfig } from './p5-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})
const store = () => loggedInStore(cleanups)

const STAGING_ID = '5a000000-0000-4000-8000-000000000001'
const PROD_ID = '5b000000-0000-4000-8000-000000000002'
const RUN_ID = 'f0000000-0000-4000-8000-000000000001'
const TICKET_ID = 'd0000000-0000-4000-8000-000000000001'

const envSummary = (name: string, over: Record<string, unknown> = {}) => ({
  id: name === 'staging' ? STAGING_ID : PROD_ID,
  name,
  url: `https://expenses${name === 'staging' ? '-staging' : ''}.apps.test`,
  healthStatus: 'up',
  healthCheckedAt: at,
  healthChangedAt: at,
  healthVersion: '1.4.0',
  healthLatencyMs: 120,
  healthError: null,
  ...over,
})
const envDetail = (name: string, over: Record<string, unknown> = {}) => ({
  ...envSummary(name, over),
  workerName: `expenses-${name}`,
  resources: {},
  lastDeployVersion: '1.4.0',
  lastDeployAt: at,
  lastDeployBy: 'alice',
  ...over,
})
const detail = {
  ...appDetail,
  environments: [
    envDetail('staging'),
    envDetail('production', { healthStatus: 'down', healthError: 'HTTP 502' }),
  ],
}

const forbidden = () =>
  jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403)
const conflict = (error: string, code: string) =>
  jsonResponse({ error, statusCode: 409, code }, 409)

function server(extra: Record<string, Route> = {}) {
  return mockFetch({ '/api/apps/expenses': () => jsonResponse(detail), ...extra })
}

async function run(
  fn: (ctx: Awaited<ReturnType<typeof testContext>>['ctx']) => Promise<void>,
  routes: Record<string, Route>,
  json = false
) {
  const { fetch, calls } = server(routes)
  const t = await testContext({ store: await store(), fetch, json })
  const error: any = await fn(t.ctx).then(
    () => null,
    (e: unknown) => e
  )
  return { ...t, calls, error }
}

describe('apps ls', () => {
  const list = {
    appsDomain: 'apps.test',
    items: [
      {
        ...appDetail,
        environments: [envSummary('staging'), envSummary('production')],
        latestDeploy: {
          ticketId: TICKET_ID,
          environment: 'production',
          phase: 'migrating',
          reached: 'uploaded',
          inProgress: true,
          version: '1.4.0',
          sha: 'abc',
          ref: null,
          actor: 'alice',
          runUrl: null,
          error: null,
          approvalId: null,
          startedAt: at,
          updatedAt: at,
          activatedAt: null,
          finishedAt: null,
        },
      },
    ],
  }

  it('prints each app with its health and the deploy in flight; --json is the body', async () => {
    const human = await run(ctx => runAppsList(ctx), { '/api/apps': () => jsonResponse(list) })
    expect(human.error).toBeNull()
    expect(human.out.content()).toContain('expenses')
    expect(human.out.content()).toContain('Up · v1.4.0')
    expect(human.out.content()).toContain('Live v1.4.0 · migrating')

    const json = await run(ctx => runAppsList(ctx), { '/api/apps': () => jsonResponse(list) }, true)
    expect(JSON.parse(json.out.content()).items[0].latestDeploy.phase).toBe('migrating')
  })

  it('a 403 exits 3', async () => {
    const { error } = await run(ctx => runAppsList(ctx), { '/api/apps': forbidden })
    expect(exitCodeFor(error)).toBe(EXIT_FORBIDDEN)
  })
})

describe('apps show', () => {
  const promotion = {
    candidate: release({ version: '1.5.0', tag: '1.5.0', status: 'awaiting_approval' }),
    staging: { version: '1.5.0', deployedAt: at, healthStatus: 'up', url: null, releaseId: null },
    production: {
      version: '1.4.0',
      deployedAt: at,
      healthStatus: 'down',
      url: null,
      releaseId: null,
    },
    changes: [
      {
        version: '1.5.0',
        number: 14,
        title: 'Red button',
        url: null,
        sessionId: null,
        sessionTitle: null,
      },
    ],
    changesTruncated: false,
    approval: {
      id: APPROVAL_ID,
      status: 'pending',
      approvers: [{ id: APP_ID, name: 'Ana', email: 'ana@x.test' }],
    },
  }

  it('adds health and the newest release with its promotion state; --json carries promotion', async () => {
    const routes = { [`/api/apps/${APP_ID}/promotion`]: () => jsonResponse(promotion) }
    const human = await run(ctx => runAppsShow(ctx, 'expenses'), routes)
    const text = human.out.content()
    expect(text).toContain('kit 0.15.0')
    expect(text).toContain('Staging')
    expect(text).toContain('Live: HTTP 502')
    expect(text).toContain('Latest release v1.5.0 · waiting for approval')
    expect(text).toContain('v1.5.0 is waiting for approval from Ana')
    expect(text).toContain('#14 Red button')

    const json = await run(ctx => runAppsShow(ctx, 'expenses'), routes, true)
    const body = JSON.parse(json.out.content())
    expect(body.slug).toBe('expenses')
    expect(body.promotion.candidate.version).toBe('1.5.0')
  })

  it('a failed promotion read never fails show (promotion: null); an unknown app exits 1', async () => {
    const ok = await run(ctx => runAppsShow(ctx, 'expenses'), {}, true)
    expect(ok.error).toBeNull()
    expect(JSON.parse(ok.out.content()).promotion).toBeNull()

    const missing = await run(ctx => runAppsShow(ctx, 'nope'), {})
    expect(exitCodeFor(missing.error)).toBe(EXIT_ERROR)
  })
})

describe('apps health and health-check', () => {
  const check = (env: string, checkedAt: string, status: string) => ({
    id: crypto.randomUUID(),
    environmentId: env === 'staging' ? STAGING_ID : PROD_ID,
    environmentName: env,
    checkedAt,
    status,
    httpStatus: status === 'up' ? 200 : 502,
    readyStatus: status === 'up' ? 200 : null,
    latencyMs: 80,
    version: '1.4.0',
    error: status === 'up' ? null : 'HTTP 502',
  })
  const history = {
    since: at,
    items: [
      check('production', '2026-09-28T10:00:00.000Z', 'up'),
      check('production', '2026-09-28T10:05:00.000Z', 'up'),
      check('production', '2026-09-28T10:10:00.000Z', 'down'),
      check('production', '2026-09-28T10:15:00.000Z', 'up'),
    ],
  }

  it('passes --hours, sums each environment and lists the changes', async () => {
    const human = await run(ctx => runAppsHealth(ctx, 'expenses', { hours: 6 }), {
      [`/api/apps/${APP_ID}/health`]: () => jsonResponse(history),
    })
    expect(human.calls[1]?.url.searchParams.get('hours')).toBe('6')
    expect(human.out.content()).toContain('75% up over 4 checks · now Up')
    expect(human.out.content()).toContain('Staging  no checks')
    expect(healthChanges(history.items as never)).toHaveLength(3)

    const json = await run(
      ctx => runAppsHealth(ctx, 'expenses'),
      { [`/api/apps/${APP_ID}/health`]: () => jsonResponse(history) },
      true
    )
    expect(JSON.parse(json.out.content()).items).toHaveLength(4)
  })

  it('health-check posts and prints each environment; a 403 exits 3', async () => {
    const body = {
      environments: [
        envSummary('staging'),
        envSummary('production', { healthStatus: 'degraded', healthError: 'ready 503' }),
      ],
    }
    const human = await run(ctx => runAppsHealthCheck(ctx, 'expenses'), {
      [`/api/apps/${APP_ID}/health-check`]: () => jsonResponse(body),
    })
    expect(human.calls[1]?.init.method).toBe('POST')
    expect(human.out.content()).toContain('Degraded')
    expect(human.out.content()).toContain('Live: ready 503')

    const json = await run(
      ctx => runAppsHealthCheck(ctx, 'expenses'),
      { [`/api/apps/${APP_ID}/health-check`]: () => jsonResponse(body) },
      true
    )
    expect(JSON.parse(json.out.content()).environments).toHaveLength(2)

    const denied = await run(ctx => runAppsHealthCheck(ctx, 'expenses'), {
      [`/api/apps/${APP_ID}/health-check`]: forbidden,
    })
    expect(exitCodeFor(denied.error)).toBe(EXIT_FORBIDDEN)
  })
})

describe('apps operations', () => {
  it('names each step in words; --json is the body', async () => {
    const body = {
      items: [
        {
          id: crypto.randomUUID(),
          runId: RUN_ID,
          kind: 'create',
          step: 'scaffold.wait',
          status: 'failed',
          attempt: 2,
          error: 'The scaffold job failed',
          externalIds: {},
          startedAt: '2026-09-28T10:00:00.000Z',
          finishedAt: '2026-09-28T10:04:00.000Z',
          createdAt: at,
        },
      ],
    }
    const routes = { [`/api/apps/${APP_ID}/operations`]: () => jsonResponse(body) }
    const human = await run(ctx => runAppsOperations(ctx, 'expenses'), routes)
    expect(human.out.content()).toContain('Scaffold from the template')
    expect(human.out.content()).toContain('4 min')
    const json = await run(ctx => runAppsOperations(ctx, 'expenses'), routes, true)
    expect(JSON.parse(json.out.content()).items[0].step).toBe('scaffold.wait')
    expect(stepLabel('health#3')).toBe('Wait for staging to answer')
  })
})

describe('apps pipeline', () => {
  const step = (over: Record<string, unknown>) => ({
    step: 'reserve',
    label: 'Reserve the name',
    status: 'succeeded',
    attempt: 1,
    error: null,
    url: null,
    startedAt: '2026-09-28T10:00:00.000Z',
    finishedAt: '2026-09-28T10:00:03.000Z',
    ...over,
  })
  const view = {
    appId: APP_ID,
    runId: RUN_ID,
    kind: 'create',
    status: 'failed',
    steps: [
      step({}),
      step({
        step: 'scaffold',
        label: 'Scaffold from the template',
        status: 'failed',
        attempt: 2,
        error: 'ci / scaffold failed',
        url: 'https://github.com/acme/expenses/actions/runs/1',
      }),
      step({
        step: 'neon',
        label: 'Create the database',
        status: 'pending',
        startedAt: null,
        finishedAt: null,
      }),
    ],
    canRescaffold: true,
    rescaffoldChecksDatabase: false,
    templateTag: '0.16.1',
  }

  it('prints each step with its timing, error and run, and the way out; --kind is passed', async () => {
    const routes = { [`/api/apps/${APP_ID}/pipeline`]: () => jsonResponse(view) }
    const human = await run(ctx => runAppsPipeline(ctx, 'expenses', { kind: 'create' }), routes)
    const text = human.out.content()
    expect(human.calls[1]?.url.searchParams.get('kind')).toBe('create')
    expect(text).toContain('launch run f0000000 · failed')
    expect(text).toContain('✓ Reserve the name · 3 s')
    expect(text).toContain('ci / scaffold failed')
    expect(text).toContain('actions/runs/1')
    expect(text).toContain('launch apps pipeline retry expenses')
    expect(text).toContain('launch apps rescaffold expenses')

    const json = await run(ctx => runAppsPipeline(ctx, 'expenses'), routes, true)
    expect(JSON.parse(json.out.content()).steps).toHaveLength(3)
  })

  it('a running step reads "so far"', () => {
    const [line] = pipelineStepLines(
      {
        ...step({ status: 'running', finishedAt: null }),
        startedAt: new Date('2026-09-28T10:00:00Z'),
        finishedAt: null,
      } as never,
      new Date('2026-09-28T10:02:00Z')
    )
    expect(line).toContain('2 min so far')
  })

  it('retry posts the kind; a 409 is the server’s sentence and exits 1', async () => {
    const ok = await run(ctx => runAppsPipelineRetry(ctx, 'expenses', { kind: 'teardown' }), {
      [`/api/apps/${APP_ID}/pipeline/retry`]: () =>
        jsonResponse({ runId: RUN_ID, instanceId: `${RUN_ID}-r1` }, 202),
    })
    expect(JSON.parse(String(ok.calls[1]?.init.body))).toEqual({ kind: 'teardown' })
    expect(ok.out.content()).toContain("Retrying expenses's teardown")

    const refused = await run(ctx => runAppsPipelineRetry(ctx, 'expenses'), {
      [`/api/apps/${APP_ID}/pipeline/retry`]: () =>
        conflict('The latest run has not failed', 'run_not_failed'),
    })
    expect(exitCodeFor(refused.error)).toBe(EXIT_ERROR)
    expect(String(refused.error.message)).toContain('has not failed')
  })

  it('cancel names the step it stopped at; a 403 exits 3', async () => {
    const ok = await run(ctx => runAppsPipelineCancel(ctx, 'expenses'), {
      [`/api/apps/${APP_ID}/pipeline/cancel`]: () =>
        jsonResponse({ runId: RUN_ID, step: 'scaffold.wait', terminated: true }),
    })
    expect(ok.out.content()).toContain("Stopped expenses's launch at “Scaffold from the template”")

    const json = await run(
      ctx => runAppsPipelineCancel(ctx, 'expenses'),
      {
        [`/api/apps/${APP_ID}/pipeline/cancel`]: () =>
          jsonResponse({ runId: RUN_ID, step: 'scaffold.wait', terminated: true }),
      },
      true
    )
    expect(JSON.parse(json.out.content()).terminated).toBe(true)

    const denied = await run(ctx => runAppsPipelineCancel(ctx, 'expenses'), {
      [`/api/apps/${APP_ID}/pipeline/cancel`]: forbidden,
    })
    expect(exitCodeFor(denied.error)).toBe(EXIT_FORBIDDEN)
  })

  it('rescaffold prints the kit; a 409 exits 1', async () => {
    const ok = await run(ctx => runAppsRescaffold(ctx, 'expenses', { yes: true }), {
      [`/api/apps/${APP_ID}/pipeline/rescaffold`]: () =>
        jsonResponse(
          {
            runId: RUN_ID,
            instanceId: `${RUN_ID}-r2`,
            templateTag: '0.16.1',
            previousTemplateTag: '0.16.0',
          },
          202
        ),
    })
    expect(ok.out.content()).toContain('again from kit 0.16.1 (was 0.16.0)')

    const refused = await run(ctx => runAppsRescaffold(ctx, 'expenses', { yes: true }), {
      [`/api/apps/${APP_ID}/pipeline/rescaffold`]: () =>
        conflict('This app has deployed; upgrade its kit instead', 'app_already_deployed'),
    })
    expect(exitCodeFor(refused.error)).toBe(EXIT_ERROR)
    expect(String(refused.error.message)).toContain('upgrade its kit instead')
  })
})

describe('apps upgrades and config-scan', () => {
  it('upgrades lists the history in the page’s words', async () => {
    const body = {
      items: [
        {
          id: crypto.randomUUID(),
          appId: APP_ID,
          targetKind: 'kit',
          pluginId: null,
          fromVersion: '0.15.0',
          toVersion: '0.16.1',
          status: 'needs_attention',
          sessionId: null,
          prNumber: null,
          prUrl: null,
          error: 'The upgrade stopped',
          requestedByUserId: null,
          createdAt: at,
          updatedAt: at,
        },
      ],
    }
    const routes = { [`/api/apps/${APP_ID}/upgrades`]: () => jsonResponse(body) }
    const human = await run(ctx => runAppsUpgrades(ctx, 'expenses'), routes)
    expect(human.out.content()).toContain('0.15.0 → 0.16.1')
    expect(human.out.content()).toContain('Needs attention')
    const json = await run(ctx => runAppsUpgrades(ctx, 'expenses'), routes, true)
    expect(JSON.parse(json.out.content()).items[0].status).toBe('needs_attention')
  })

  it('config-scan posts and prints what grants needs prints; a 403 exits 3', async () => {
    const routes = { [`/api/apps/${APP_ID}/config/scan`]: () => jsonResponse(appConfig()) }
    const human = await run(ctx => runAppsConfigScan(ctx, 'expenses'), routes)
    expect(human.calls[1]?.init.method).toBe('POST')
    expect(human.out.content()).toContain('Keys no secret matches: STRIPE_KEY')
    const json = await run(ctx => runAppsConfigScan(ctx, 'expenses'), routes, true)
    expect(JSON.parse(json.out.content()).unmatched).toEqual(['STRIPE_KEY'])

    const denied = await run(ctx => runAppsConfigScan(ctx, 'expenses'), {
      [`/api/apps/${APP_ID}/config/scan`]: forbidden,
    })
    expect(exitCodeFor(denied.error)).toBe(EXIT_FORBIDDEN)
  })
})
