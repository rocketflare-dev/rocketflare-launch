/**
 * Shipping a session (Launch P3 slice 3d, plan §1.10): `ship()` with a scripted turn runner and a
 * `FakeSandbox` (the gate's exit code) over a `GitHubRepoHost` against the FakeCloud's GitHub —
 * red gate → a `ship.gate` event and no PR; green → a PR from `session/<short>`, `shipped`, the
 * audit row, and CI read until it settles (`refreshChecks`, the `sessions.checks` cron) — plus the
 * routes that request it: `POST /:id/ship`, `POST /:id/end`, `GET /:id/pr`.
 */
import { generateKeyPairSync } from 'node:crypto'
import { sessionBranchName } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { sessionsChecksTask } from '@/api/services/sessions/checks-cron'
import { GitHubRepoHost } from '@/api/services/sessions/repo/github-repo-host'
import { LocalRepoHost } from '@/api/services/sessions/repo/local-repo-host'
import {
  parseShipReply,
  refreshChecks,
  runSessionChecks,
  type ShipTurnRunner,
  ship,
} from '@/api/services/sessions/ship'
import { createR2Storage } from '@/api/services/storage'
import { loadConfig } from '@/config'
import { auditEvents, type SessionRow, sessionEvents, sessions } from '@/db/schema'
import {
  createTestSession,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import { json, request } from '../helpers/request'
import { createFakeSessionPorts, insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()
const { privateKey: APP_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})
const env = createTestEnv()
const cfg = loadConfig(env)
const REPLY = `All green.\n{"title": "Add a greeting to the home page", "body": "Adds **Hello**.", "gatePassed": true}`

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

/** A turn runner that records its message and writes the reply as the turn's `text` event. */
function turnRunner(reply: string | null, outcome: 'completed' | 'failed' = 'completed') {
  const messages: string[] = []
  const runTurn: ShipTurnRunner = async ({ message, session }) => {
    messages.push(message)
    const turn = session.turnCount + 1
    if (reply !== null) {
      await db.insert(sessionEvents).values({
        sessionId: session.id,
        tenantId: session.tenantId,
        seq: 1000 + turn,
        turn,
        type: 'text',
        data: { text: reply },
      })
    }
    return { outcome, turn }
  }
  return { runTurn, messages }
}

async function setup(opts: { gateExit?: number } = {}) {
  const cloud = createFakeCloud()
  const f = await seedSessionApp(db, cloud)
  const row = await insertSession(db, f, { status: 'ready', requestedAction: 'ship', turnCount: 2 })
  const branch = sessionBranchName(row.shortId)
  const ports = createFakeSessionPorts({ repoHost: githubHost(cloud) }).script(sandbox =>
    sandbox
      .onExec(/^bash -c 'pnpm lint/, {
        exitCode: opts.gateExit ?? 0,
        stdout: opts.gateExit ? 'src/ui/Home.tsx:3 error: unused variable' : 'All checks passed',
      })
      .onExec('git diff --cached --quiet', { exitCode: 1 })
      // The commit, as the push through the egress handler will land it on GitHub.
      .onExec('git commit', () => {
        cloud.github.pushCommit(
          f.repo.owner,
          f.repo.repo,
          { 'src/home.txt': 'Hello' },
          'Add a greeting',
          branch
        )
        return { exitCode: 0 }
      })
      .onExec('git rev-parse HEAD', () => ({
        stdout:
          cloud.github.repo(f.repo.owner, f.repo.repo)?.refs.get(`heads/${branch}`) ??
          'f'.repeat(40),
      }))
  )
  const deps = (runTurn: ShipTurnRunner) => ({
    cfg,
    ports,
    storage: createR2Storage(env.FILES),
    runTurn,
  })
  return { cloud, f, row, branch, ports, deps, ref: { tenantId: f.tenant.id, sessionId: row.id } }
}

async function eventsOf(row: SessionRow) {
  return db
    .select()
    .from(sessionEvents)
    .where(and(eq(sessionEvents.tenantId, row.tenantId), eq(sessionEvents.sessionId, row.id)))
    .orderBy(sessionEvents.seq)
}

async function reload(row: SessionRow) {
  const [after] = await db.select().from(sessions).where(eq(sessions.id, row.id))
  return after as SessionRow
}

describe('the ship reply', () => {
  it('takes the last JSON object with a title, fenced or on its own line', () => {
    expect(parseShipReply(REPLY)).toEqual({
      title: 'Add a greeting to the home page',
      body: 'Adds **Hello**.',
      gatePassed: true,
    })
    expect(parseShipReply('Done:\n```json\n{"title":"Fix","body":"b"}\n```')).toMatchObject({
      title: 'Fix',
      gatePassed: null,
    })
    expect(
      parseShipReply('{"title": "Old"}\nthen\n{"title": "New", "gatePassed": false}')
    ).toMatchObject({
      title: 'New',
      gatePassed: false,
    })
    expect(parseShipReply('no json here')).toBeNull()
    expect(parseShipReply(null)).toBeNull()
  })
})

describe('ship()', () => {
  it('a red gate → a ship.gate event with the output, back to ready, and no PR', async () => {
    const { cloud, row, ports, deps, ref } = await setup({ gateExit: 1 })
    const turn = turnRunner(REPLY)
    const outcome = await ship(db, deps(turn.runTurn), ref)
    expect(outcome).toMatchObject({ status: 'gate_failed' })
    expect(cloud.github.pulls).toHaveLength(0)
    // The ship prompt was the turn's message.
    expect(turn.messages[0]).toContain('pnpm lint && pnpm typecheck && pnpm test')
    // Launch ran the gate itself, in the checkout.
    const gate = ports.sandboxes.get(row.id)?.execs.find(e => e.command.startsWith('bash -c'))
    expect(gate?.opts?.cwd).toBe('/workspace/app')

    const gates = (await eventsOf(row)).filter(e => e.type === 'ship.gate')
    expect(gates).toHaveLength(1)
    expect(gates[0]?.data).toMatchObject({ passed: false, attempt: 1 })
    expect((gates[0]?.data as { output?: string } | undefined)?.output).toContain('unused variable')
    const after = await reload(row)
    expect(after.status).toBe('ready')
    expect(after.requestedAction).toBeNull()
    expect(after.prNumber).toBeNull()
  })

  it('the model saying the gate still fails is enough to stop — Launch does not run it', async () => {
    const { cloud, row, ports, deps, ref } = await setup()
    const turn = turnRunner('{"title": "WIP", "body": "", "gatePassed": false}')
    expect(await ship(db, deps(turn.runTurn), ref)).toMatchObject({ status: 'gate_failed' })
    expect(ports.sandboxes.get(row.id)?.execs.some(e => e.command.startsWith('bash -c'))).toBe(
      false
    )
    expect(cloud.github.pulls).toHaveLength(0)
  })

  it('a failed turn → turn_failed, back to ready, no gate', async () => {
    const { row, deps, ref } = await setup()
    const outcome = await ship(db, deps(turnRunner(null, 'failed').runTurn), ref)
    expect(outcome).toEqual({ status: 'turn_failed', reason: 'failed' })
    expect((await reload(row)).status).toBe('ready')
    expect((await eventsOf(row)).some(e => e.type === 'ship.gate')).toBe(false)
  })

  it('a green gate → checkpoint, a PR from session/<short>, shipped, audited; pending checks then success', async () => {
    const { cloud, f, row, branch, deps, ref } = await setup()
    const outcome = await ship(db, deps(turnRunner(REPLY).runTurn), ref)
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

    const types = (await eventsOf(row)).map(e => e.type)
    expect(types).toEqual(expect.arrayContaining(['ship.gate', 'ship.pr']))
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

    // A retried ship step answers the PR it already opened.
    expect(await ship(db, deps(turnRunner(REPLY).runTurn), ref)).toMatchObject({
      status: 'shipped',
      prNumber: 1,
    })
    expect(cloud.github.pulls).toHaveLength(1)
  })

  it('a session that is not ready is skipped', async () => {
    const { deps, f } = await setup()
    const working = await insertSession(db, f, { status: 'working' })
    expect(
      await ship(db, deps(turnRunner(REPLY).runTurn), {
        tenantId: f.tenant.id,
        sessionId: working.id,
      })
    ).toMatchObject({ status: 'skipped' })
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

  it('POST /:id/end → 202 and a running turn is asked to stop; an ended session → 409', async () => {
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
