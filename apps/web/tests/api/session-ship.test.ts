// @vitest-isolate
// Stubs the global fetch in one test (the summary with no model must never reach the network), so
// this file needs its own module registry.
/**
 * Shipping a session, the parts that are not the gate (Launch P3 slice 3d, plan §1.10; issue #1):
 * the PR's title and body from ONE summary call (`summarizeShip`: the resolve order, the small
 * model, the usage billed to the session, the fallback), the PR itself (`openShipPullRequest` over
 * a `GitHubRepoHost` against the FakeCloud's GitHub — `shipped`, the audit row, CI read until it
 * settles: `refreshChecks`, the `sessions.checks` cron) — plus the routes that request it:
 * `POST /:id/ship`, `POST /:id/end` (a ship in flight included), `GET /:id/pr`. The gate and the
 * Workflow steps are `session-ship-gate.test.ts`.
 */
import { generateKeyPairSync } from 'node:crypto'
import { sessionBranchName } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { sessionsChecksTask } from '@/api/services/sessions/checks-cron'
import { appendSessionEvents } from '@/api/services/sessions/event-log'
import { GitHubRepoHost } from '@/api/services/sessions/repo/github-repo-host'
import { LocalRepoHost } from '@/api/services/sessions/repo/local-repo-host'
import {
  fallbackShipSummary,
  openShipPullRequest,
  parseShipSummary,
  refreshChecks,
  runSessionChecks,
  SHIP_SUMMARY_ANTHROPIC_MODEL,
  SHIP_SUMMARY_FEATURE,
  type ShipSummaryInput,
  shipPrBody,
  shipRequests,
  summarizeShip,
} from '@/api/services/sessions/ship'
import { loadConfig } from '@/config'
import { aiUsage, auditEvents, type SessionRow, sessionEvents, sessions } from '@/db/schema'
import { FakeChatClient } from '../helpers/ai'
import {
  createTestSession,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import { json, request } from '../helpers/request'
import { insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()
const { privateKey: APP_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})
const env = createTestEnv()
const cfg = loadConfig(env)

function githubHost(cloud: FakeCloud) {
  return new GitHubRepoHost(db, cfg, {
    fetch: cloud.fetch,
    github: {
      auth: { appId: String(cloud.opts.appId), privateKey: APP_PEM },
      installationId: cloud.opts.installationId,
      org: cloud.opts.org,
    },
  })
}

async function reload(row: SessionRow) {
  const [after] = await db.select().from(sessions).where(eq(sessions.id, row.id))
  return after as SessionRow
}

async function eventsOf(row: SessionRow) {
  return db
    .select()
    .from(sessionEvents)
    .where(and(eq(sessionEvents.tenantId, row.tenantId), eq(sessionEvents.sessionId, row.id)))
    .orderBy(sessionEvents.seq)
}

const INPUT: ShipSummaryInput = {
  appName: 'Orders',
  userName: 'Ada',
  requests: ['Add a greeting to the home page', 'Make it bold'],
  diffStat: ' src/ui/pages/Home.tsx | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)',
  sessionTitle: null,
  shortId: 'abcdefgh2345',
}

describe('the summary', () => {
  it('parseShipSummary takes the last JSON object with a title, fenced or on its own line', () => {
    expect(parseShipSummary('{"title": "Add a greeting", "body": "Adds **Hello**."}')).toEqual({
      title: 'Add a greeting',
      body: 'Adds **Hello**.',
    })
    expect(parseShipSummary('Here:\n```json\n{"title":"Fix","body":"b"}\n```')).toEqual({
      title: 'Fix',
      body: 'b',
    })
    expect(parseShipSummary('{"title": "Old"}\nthen\n{"title": "New"}')).toMatchObject({
      title: 'New',
      body: '',
    })
    expect(parseShipSummary('no json here')).toBeNull()
    expect(parseShipSummary('{"title": "   "}')).toBeNull()
    expect(parseShipSummary(null)).toBeNull()
  })

  it('the fallback is the session title, else the first request — never invented', () => {
    expect(fallbackShipSummary(INPUT).title).toBe('Add a greeting to the home page')
    expect(fallbackShipSummary({ ...INPUT, sessionTitle: 'Say hello' }).title).toBe('Say hello')
    expect(fallbackShipSummary({ ...INPUT, requests: [] }).title).toBe(
      'Changes from Launch session abcdefgh2345'
    )
    const body = fallbackShipSummary(INPUT).body
    expect(body).toContain('- Make it bold')
    expect(body).toContain('1 file changed')
  })

  it('shipRequests: the person’s messages, oldest first, keys redacted', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'shipping', turnCount: 2 })
    await appendSessionEvents(db, row, [
      { type: 'user.message', turn: 1, data: { text: 'Add orders', userId: null } },
      { type: 'text', turn: 1, data: { text: 'Done.' } },
      {
        type: 'user.message',
        turn: 2,
        data: { text: 'Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz for it', userId: null },
      },
    ])
    expect(await shipRequests(db, row)).toEqual(['Add orders', 'Use [redacted] for it'])
  })

  it('ONE call, no tools, on the small model; the usage is billed to the session', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'shipping' })
    const client = new FakeChatClient([
      {
        text: '{"title": "Greet people on the home page", "body": "Adds a bold greeting."}',
        usage: { inputTokens: 900, outputTokens: 60 },
      },
    ])
    const result = await summarizeShip(db, cfg, env, row, INPUT, {
      client: { client, provider: 'anthropic', model: SHIP_SUMMARY_ANTHROPIC_MODEL },
    })
    expect(result).toEqual({
      title: 'Greet people on the home page',
      body: 'Adds a bold greeting.',
      source: 'model',
    })
    expect(client.calls).toHaveLength(1)
    const [call] = client.calls
    expect(call?.model).toBe('claude-haiku-4-5')
    expect(call?.tools).toBeUndefined()
    expect(JSON.stringify(call?.messages)).toContain('Make it bold')
    expect(JSON.stringify(call?.messages)).toContain('1 file changed')
    expect(String(call?.system)).toContain('ONE JSON object')

    const usage = await db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.tenantId, row.tenantId), eq(aiUsage.sessionId, row.id)))
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({
      feature: SHIP_SUMMARY_FEATURE,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      inputTokens: 900,
      outputTokens: 60,
    })
    const after = await reload(row)
    expect(Number(after.costMicrocents)).toBe(Number(usage[0]?.costMicrocents))
    expect(Number(after.costMicrocents)).toBeGreaterThan(0)
  })

  it('a reply that does not parse, or a failed call, falls back — the PR never waits', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'shipping', title: 'Say hello' })
    const prose = new FakeChatClient([{ text: 'Sure! Here is a PR.' }])
    expect(
      await summarizeShip(
        db,
        cfg,
        env,
        row,
        { ...INPUT, sessionTitle: 'Say hello' },
        {
          client: { client: prose, provider: 'anthropic', model: 'm' },
        }
      )
    ).toMatchObject({ title: 'Say hello', source: 'fallback' })
    const broken = new FakeChatClient([{ error: new Error('overloaded') }])
    expect(
      await summarizeShip(db, cfg, env, row, INPUT, {
        client: { client: broken, provider: 'anthropic', model: 'm' },
      })
    ).toMatchObject({ title: 'Add a greeting to the home page', source: 'fallback' })
  })

  it('with no chat configured and no Anthropic key: the fallback, and no model call', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'shipping' })
    const bare = createTestEnv({ ANTHROPIC_API_KEY: undefined, AI: undefined })
    // Never the network, whatever the shared database's credentials say.
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input))
      throw new Error('no network in this test')
    })
    try {
      const result = await summarizeShip(db, loadConfig(bare), bare, row, INPUT)
      expect(result.source).toBe('fallback')
      expect(result.title).toBe('Add a greeting to the home page')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the pull request', () => {
  async function setup() {
    const cloud = createFakeCloud()
    const f = await seedSessionApp(db, cloud)
    const row = await insertSession(db, f, { status: 'shipping', turnCount: 2 })
    const branch = sessionBranchName(row.shortId)
    // The final checkpoint, as its push lands the branch on GitHub.
    const headSha = cloud.github.pushCommit(
      f.repo.owner,
      f.repo.repo,
      { 'src/home.txt': 'Hello' },
      'Launch session',
      branch
    )
    await db.update(sessions).set({ headSha }).where(eq(sessions.id, row.id))
    const deps = {
      repoHost: githubHost(cloud),
      emit: (events: Parameters<typeof appendSessionEvents>[2]) =>
        appendSessionEvents(db, row, events),
    }
    return { cloud, f, row, branch, deps, ref: { tenantId: f.tenant.id, sessionId: row.id } }
  }

  it('the body is the summary, then Launch’s line naming the gate it ran', () => {
    const body = shipPrBody(
      'Adds a greeting.',
      { shortId: 'abcdefgh2345' },
      {
        creatorName: 'Ada',
        fixTurns: 1,
      }
    )
    expect(body).toContain('Adds a greeting.')
    expect(body).toContain('coding session `abcdefgh2345` for Ada')
    expect(body).toContain('`pnpm lint`, `pnpm typecheck`, `pnpm test:ephemeral`')
    expect(body).toContain('after 1 fix turn')
    expect(shipPrBody('', { shortId: 'x' }, { fixTurns: 0 })).not.toContain('fix turn')
  })

  it('opens the PR from session/<short>, shipped, audited; pending checks then success', async () => {
    const { cloud, f, row, branch, deps, ref } = await setup()
    const outcome = await openShipPullRequest(db, deps, ref, {
      title: 'Add a greeting to the home page',
      body: 'Adds **Hello**.',
      fixTurns: 0,
    })
    expect(outcome).toMatchObject({ status: 'shipped', prNumber: 1 })

    expect(cloud.github.pulls).toHaveLength(1)
    const pr = cloud.github.pulls[0]
    expect(pr).toMatchObject({
      head: branch,
      base: 'main',
      title: 'Add a greeting to the home page',
    })
    expect(pr?.body).toContain('Adds **Hello**.')
    expect(pr?.body).toContain(`coding session \`${row.shortId}\``)

    const after = await reload(row)
    expect(after.status).toBe('shipped')
    expect(after.prNumber).toBe(1)
    expect(after.prUrl).toContain(`/pull/1`)
    expect(after.headSha).toBe(pr?.headSha)
    // No CI reported yet: GitHub's empty combined status is `pending` with no contexts → `none`.
    expect(after.prChecks?.state).toBe('none')

    expect((await eventsOf(row)).map(e => e.type)).toContain('ship.pr')
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, f.tenant.id), eq(auditEvents.targetId, row.id)))
    expect(audit).toMatchObject({ action: 'session.shipped', appId: f.app.id })
    expect(JSON.stringify(audit?.summary)).not.toMatch(/ghs_/)

    // CI starts: pending.
    cloud.github.setCheckRuns(f.repo.owner, f.repo.repo, branch, [
      { name: 'ci / gate', status: 'in_progress' },
    ])
    const host = githubHost(cloud)
    const pending = await refreshChecks(db, host, await reload(row))
    expect(pending).toMatchObject({ state: 'pending', total: 1, pending: 1 })
    // Within 30 s a read answers the stored verdict without asking GitHub.
    const calls = cloud.callsTo('github').length
    expect(await refreshChecks(db, host, await reload(row), { maxAgeMs: 30_000 })).toMatchObject({
      state: 'pending',
    })
    expect(cloud.callsTo('github').length).toBe(calls)

    // CI finishes; the cron settles it.
    cloud.github.setCheckRuns(f.repo.owner, f.repo.repo, branch, [
      { name: 'ci / gate', status: 'completed', conclusion: 'success' },
    ])
    cloud.github.setStatuses(f.repo.owner, f.repo.repo, branch, [
      { context: 'deploy/preview', state: 'success' },
    ])
    const result = await runSessionChecks(db, () => host)
    expect(result.refreshed).toBeGreaterThanOrEqual(1)
    expect((await reload(row)).prChecks).toMatchObject({ state: 'success', total: 2, passed: 2 })

    // A retried step answers the PR it already opened.
    expect(
      await openShipPullRequest(db, deps, ref, { title: 'x', body: 'y', fixTurns: 0 })
    ).toMatchObject({ status: 'shipped', prNumber: 1 })
    expect(cloud.github.pulls).toHaveLength(1)
  })

  it('a session that is not shipping opens nothing', async () => {
    const { cloud, f, deps } = await setup()
    const ready = await insertSession(db, f, { status: 'ready' })
    expect(
      await openShipPullRequest(
        db,
        deps,
        { tenantId: f.tenant.id, sessionId: ready.id },
        {
          title: 't',
          body: 'b',
          fixTurns: 0,
        }
      )
    ).toMatchObject({ status: 'skipped' })
    expect(cloud.github.pulls).toHaveLength(0)
  })

  it('the sessions.checks task runs over the injected repo host', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, {
      status: 'shipped',
      prNumber: 7,
      prUrl: 'local://x/y/pull/7',
      headSha: 'e'.repeat(40),
    })
    const task = sessionsChecksTask(() => new LocalRepoHost(cfg))
    const logs: unknown[] = []
    await task.run({
      env,
      config: cfg,
      db,
      logger: { info: (o: unknown) => logs.push(o) } as never,
      waitUntil: () => {},
    })
    expect((await reload(row)).prChecks).toMatchObject({
      state: 'success',
      headSha: 'e'.repeat(40),
    })
    expect(task.name).toBe('sessions.checks')
  })
})

describe('the routes', () => {
  const post = (path: string, headers: Record<string, string>, e = createTestEnv()) =>
    request(
      path,
      { method: 'POST', headers: { ...headers, 'X-Requested-With': 'fetch' } },
      { env: e }
    )

  it('POST /:id/ship → 202 + requested_action + a wake; twice or mid-turn → 409', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ready', instanceId: 'inst-1' })
    const e = createTestEnv()
    const res = await post(`/api/sessions/${row.id}/ship`, f.cookie, e)
    expect(res.status).toBe(202)
    const body = await json<{ session: { requestedAction: string; status: string } }>(res)
    expect(body.session).toMatchObject({ requestedAction: 'ship', status: 'ready' })
    expect(JSON.stringify(body)).not.toContain(row.previewToken)
    // `inst-1` was never created (a lost instance): no wake lands, and a fresh instance is
    // started from the row instead (`wakeOrRestart`), its id recorded on the session.
    expect(stubs(e).sessionWorkflow?.events).toEqual([])
    expect(stubs(e).sessionWorkflow?.created.map(c => c.id)).toEqual([`${row.id}-r1`])
    expect((await reload(row)).instanceId).toBe(`${row.id}-r1`)
    const again = await post(`/api/sessions/${row.id}/ship`, f.cookie, e)
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ statusCode: 409, code: 'session_not_ready' })

    const busy = await insertSession(db, f, { status: 'working' })
    const mid = await post(`/api/sessions/${busy.id}/ship`, f.cookie)
    expect(await json(mid)).toMatchObject({ code: 'turn_in_progress' })
  })

  it('wakes the Workflow instance with the golden event type and an empty payload', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ready' })
    const e = createTestEnv()
    stubs(e).sessionWorkflow?.setStatus(row.id, { status: 'waiting' })
    expect((await post(`/api/sessions/${row.id}/ship`, f.cookie, e)).status).toBe(202)
    expect(stubs(e).sessionWorkflow?.events).toEqual([
      { instanceId: row.id, type: 'session_wake', payload: {} },
    ])
  })

  it('POST /:id/end → 202 and a running turn is asked to stop — mid-ship too; an ended session → 409', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'working' })
    const e = createTestEnv()
    const res = await post(`/api/sessions/${row.id}/end`, f.cookie, e)
    expect(res.status).toBe(202)
    const after = await reload(row)
    expect(after.requestedAction).toBe('end')
    expect(after.cancelRequestedAt).not.toBeNull()
    // The instance is gone (a `wrangler dev` reload): the end still reaches a Workflow.
    expect(stubs(e).sessionWorkflow?.created.map(c => c.id)).toEqual([`${row.id}-r1`])

    const ended = await insertSession(db, f, { status: 'ended' })
    const again = await post(`/api/sessions/${ended.id}/end`, f.cookie)
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ code: 'session_not_endable' })

    // A ship in flight can be ended too (issue #1): its gate stops, and a fix turn is cancelled.
    const shipping = await insertSession(db, f, { status: 'shipping' })
    const mid = await post(`/api/sessions/${shipping.id}/end`, f.cookie)
    expect(mid.status).toBe(202)
    const stopping = await reload(shipping)
    expect(stopping.requestedAction).toBe('end')
    expect(stopping.cancelRequestedAt).not.toBeNull()
    const ending = await insertSession(db, f, { status: 'ending' })
    expect((await post(`/api/sessions/${ending.id}/end`, f.cookie)).status).toBe(409)
  })

  it('503 without SESSION_WORKFLOW, before any row is written', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ready' })
    const res = await post(
      `/api/sessions/${row.id}/ship`,
      f.cookie,
      createTestEnv({ SESSION_WORKFLOW: undefined })
    )
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({ code: 'sessions_not_configured' })
    expect((await reload(row)).requestedAction).toBeNull()
  })

  it('GET /:id/pr answers the PR and fresh checks; 401 signed out; a stranger and another tenant get 404', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const checks = {
      state: 'pending' as const,
      headSha: 'e'.repeat(40),
      checkedAt: new Date(),
      total: 1,
      passed: 0,
      failed: 0,
      pending: 1,
      checks: [{ name: 'ci', source: 'check_run' as const, state: 'pending' as const, url: null }],
    }
    const row = await insertSession(db, f, {
      status: 'shipped',
      prNumber: 3,
      prUrl: 'https://github.com/o/r/pull/3',
      prChecks: checks,
    })
    const res = await request(`/api/sessions/${row.id}/pr`, { headers: f.cookie })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({
      prNumber: 3,
      prUrl: 'https://github.com/o/r/pull/3',
      checks: { state: 'pending', total: 1 },
    })

    expect((await request(`/api/sessions/${row.id}/pr`)).status).toBe(401)

    const stranger = await createTestUser(db)
    await linkUserToTenant(db, stranger.id, f.tenant.id, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, stranger.id, f.tenant.id))
    expect((await request(`/api/sessions/${row.id}/pr`, { headers: cookie })).status).toBe(404)
    expect((await post(`/api/sessions/${row.id}/end`, cookie)).status).toBe(404)

    const elsewhere = await seedSessionApp(db, createFakeCloud())
    expect(
      (await request(`/api/sessions/${row.id}/pr`, { headers: elsewhere.cookie })).status
    ).toBe(404)
  })
})
