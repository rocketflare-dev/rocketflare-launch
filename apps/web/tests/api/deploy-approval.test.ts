// @vitest-isolate
// Installs a FakeCloud as the global fetch and mocks the platform credential store.
/**
 * The production gate (Launch P4, slice 4d): Promote opens a `deploy.production` approval for a
 * release live on staging; approving it writes a pre-approval bound to the release's tag and
 * publishes the GitHub Release; the production run on that tag claims the pre-approval at `start`
 * and ships. Driven over HTTP (`/api/apps/:id/releases…`, `/ci/deploy…`) against the real engine.
 *
 * What it pins:
 * - promote → approve → claim → activate, the release moving `tagged → staging → staging_active →
 *   awaiting_approval → promoting → production_active`, and its chain from the audit log;
 * - a pre-approval for tag A is never claimable by a run on another ref, and is claimed once;
 * - the author cannot approve: the promoter, whoever cut the release, and the creators of the
 *   sessions whose PRs it carries are all excluded (403 `self_approval`);
 * - a job-originated ticket (a Release published by hand in GitHub) waits on its own approval,
 *   is approved within its window, and 409 `deploy_run_gone` after it;
 * - reject → the release is `rejected` and no GitHub Release exists;
 * - Promote's preconditions (staging runs the release, and is up).
 */
import { promoteReleaseResponseSchema, releaseChainSchema } from '@launch/shared/launch-releases'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decide } from '@/api/services/approvals/engine'
import { appReleases, approvalRequests, deployTickets } from '@/db/schema'
import { actorOf, approvalDeps, viewerOf } from '../helpers/approvals'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { appToml, fillDeployCredentials, uploadBody } from '../helpers/deploy-gateway'
import { createFakeCloud } from '../helpers/fake-cloud'
import { forgetApps } from '../helpers/launch-apps'
import { addTestAppOwner } from '../helpers/oidc'
import {
  deployJob,
  type ReleasableApp,
  seedReleasableApp,
  serveAppHosts,
  shipSessionPr,
} from '../helpers/releases'
import { request } from '../helpers/request'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

const db = setupTestDatabase()
const cloud = createFakeCloud()
let restore: () => void
let env: TestEnv
const tenantIds: string[] = []

beforeAll(() => {
  restore = cloud.install()
})
afterAll(async () => {
  restore()
  await forgetApps(db, tenantIds)
})
beforeEach(() => {
  env = createTestEnv()
  fillDeployCredentials(store, cloud)
})

interface Person {
  id: string
  email: string
  cookie: Record<string, string>
}

async function person(tenantId: string, role: 'owner' | 'admin' | 'member'): Promise<Person> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenantId))
  return { id: user.id, email: user.email, cookie }
}

/**
 * An organisation: its owner `admin`; `alice` and `bob`, members who own the app; alice's session
 * shipped PR #1, merged. `served` — the app's hosts answer health from the live version.
 */
async function fixture(opts: { served?: boolean } = {}) {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const admin: Person = {
    id: user.id,
    email: user.email,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
  const alice = await person(tenant.id, 'member')
  const bob = await person(tenant.id, 'member')
  const app = await seedReleasableApp(db, cloud, tenant.id)
  await addTestAppOwner(db, tenant.id, app.app.id, alice.id)
  await addTestAppOwner(db, tenant.id, app.app.id, bob.id)
  if (opts.served ?? true) serveAppHosts(cloud, app)
  const shipped = await shipSessionPr(db, cloud, app, {
    tenantId: tenant.id,
    userId: alice.id,
    title: 'Add the orders page',
  })
  cloud.github.merge(app.owner, app.repo, shipped.number)
  return { tenantId: tenant.id, admin, alice, bob, app, shipped }
}

async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function cutRelease(app: ReleasableApp, who: Person) {
  const res = await request(
    `/api/apps/${app.app.id}/releases`,
    { method: 'POST', headers: who.cookie },
    { env, json: { bump: 'patch' } }
  )
  expect(res.status, await res.clone().text()).toBe(201)
  return body<{ id: string; tag: string; version: string }>(res)
}

/** A whole run of `deploy.yml` on `ref`: start → upload → activate → finish. */
async function ship(app: ReleasableApp, environment: 'staging' | 'production', ref: string) {
  const job = deployJob(env, app, environment, { ref })
  const start = await body<{ id: string; status: string }>(
    await job.call('POST', '/start', { protocol: 1 })
  )
  expect(start.status).toBe('approved')
  const version = ref.replace('refs/tags/', '')
  for (const [path, payload] of [
    ['upload', uploadBody(appToml(app, environment), version)],
    ['activate', undefined],
    ['finish', undefined],
  ] as const) {
    const res = await job.call('POST', `/${start.id}/${path}`, payload)
    expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200)
  }
  return { ticketId: start.id, job }
}

async function promote(app: ReleasableApp, releaseId: string, who: Person) {
  return request(
    `/api/apps/${app.app.id}/releases/${releaseId}/promote`,
    { method: 'POST', headers: who.cookie },
    { env, json: {} }
  )
}

async function decideAs(
  tenantId: string,
  who: { id: string; email: string },
  requestId: string,
  decision: 'approve' | 'reject' = 'approve',
  comment?: string
) {
  return decide(approvalDeps(db, env), {
    requestId,
    viewer: await viewerOf(db, tenantId, who),
    decision,
    comment,
    actor: actorOf(who),
  })
}

async function releaseRow(id: string) {
  const [row] = await db.select().from(appReleases).where(eq(appReleases.id, id))
  if (!row) throw new Error(`no release ${id}`)
  return row
}

/** `needles` appear in `hay` in this order (other rows may sit between them). */
function inOrder(hay: string[], needles: string[]): boolean {
  let at = 0
  for (const item of hay) if (item === needles[at]) at++
  return at === needles.length
}

describe('promote → approve → claim → activate', () => {
  it('ships the release to production through the approval, and the chain shows every step', async () => {
    const { tenantId, alice, bob, app, shipped } = await fixture()
    const cut = await cutRelease(app, alice)
    await ship(app, 'staging', 'refs/tags/0.1.1')
    expect(await releaseRow(cut.id)).toMatchObject({ status: 'staging_active' })

    const promoted = await promote(app, cut.id, alice)
    expect(promoted.status, await promoted.clone().text()).toBe(202)
    const { release, approvalId } = promoteReleaseResponseSchema.parse(await promoted.json())
    expect(release).toMatchObject({ status: 'awaiting_approval', approvalId })
    const [request0] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId))
    expect(request0).toMatchObject({
      kind: 'deploy.production',
      subjectType: 'release',
      subjectId: cut.id,
      status: 'pending',
    })
    expect(request0?.context).toMatchObject({
      version: '0.1.1',
      tag: '0.1.1',
      ref: 'refs/tags/0.1.1',
      stagingHealth: 'up',
      stagingVersion: '0.1.1',
      prs: [expect.objectContaining({ number: shipped.number, sessionId: shipped.session.id })],
    })
    // Promoting again answers the same open request.
    const again = promoteReleaseResponseSchema.parse(
      await (await promote(app, cut.id, alice)).json()
    )
    expect(again.approvalId).toBe(approvalId)
    // Nothing is published before the approval.
    expect(cloud.github.releaseFor(app.owner, app.repo, '0.1.1')).toBeUndefined()

    // Alice cut it, promoted it and wrote its PR: she may not approve it.
    await expect(decideAs(tenantId, alice, approvalId)).rejects.toMatchObject({
      statusCode: 403,
      code: 'self_approval',
    })
    await decideAs(tenantId, bob, approvalId)
    expect(cloud.github.releaseFor(app.owner, app.repo, '0.1.1')).toMatchObject({ via: 'api' })
    expect(await releaseRow(cut.id)).toMatchObject({ status: 'promoting', approvalId })
    const [intent] = await db
      .select()
      .from(deployTickets)
      .where(eq(deployTickets.approvalId, approvalId))
    expect(intent).toMatchObject({
      status: 'approved',
      decisionSource: 'approval',
      decidedByUserId: bob.id,
      ref: 'refs/tags/0.1.1',
      releaseId: cut.id,
      runId: null,
    })

    // The production run on the tag claims it at start — approved at once — and ships.
    const prod = await ship(app, 'production', 'refs/tags/0.1.1')
    expect(prod.ticketId).toBe(intent?.id)
    const final = await releaseRow(cut.id)
    expect(final).toMatchObject({
      status: 'production_active',
      productionTicketId: intent?.id,
    })
    expect(final.stagingTicketId).toEqual(expect.any(String))

    const chainRes = await request(
      `/api/apps/${app.app.id}/releases/${cut.id}/chain`,
      { headers: bob.cookie },
      { env }
    )
    const chain = releaseChainSchema.parse(await chainRes.json())
    const actions = chain.events.map(e => e.action)
    expect(
      inOrder(actions, [
        'session.shipped',
        'pr.merged',
        'release.created',
        'deploy.started',
        'deploy.activated',
        'release.staging_active',
        'approval.requested',
        'approval.decided',
        'approval.approved',
        'release.published',
        'deploy.started',
        'deploy.activated',
        'release.production',
      ]),
      actions.join(' → ')
    ).toBe(true)
    // The approval's rows carry its id.
    for (const e of chain.events.filter(e => e.action.startsWith('approval.'))) {
      expect(e.approvalId).toBe(approvalId)
    }
    expect(JSON.stringify(chain)).not.toMatch(/postgres(ql)?:\/\//)

    // Claimed once: another production run on the same tag waits for a person — and, being a run
    // of this release, joins its chain with its own approval.
    const late = deployJob(env, app, 'production', { ref: 'refs/tags/0.1.1' })
    const lateStart = await body<{ id: string; status: string }>(
      await late.call('POST', '/start', { protocol: 1 })
    )
    expect(lateStart.status).toBe('pending')
    const after = releaseChainSchema.parse(
      await (
        await request(
          `/api/apps/${app.app.id}/releases/${cut.id}/chain`,
          { headers: bob.cookie },
          { env }
        )
      ).json()
    )
    expect(after.events.some(e => e.targetId === lateStart.id)).toBe(true)
  })

  it('an approval for tag A is not claimable by a run on another ref', async () => {
    const { tenantId, alice, bob, app } = await fixture()
    const cut = await cutRelease(app, alice)
    await ship(app, 'staging', 'refs/tags/0.1.1')
    const { approvalId } = promoteReleaseResponseSchema.parse(
      await (await promote(app, cut.id, alice)).json()
    )
    await decideAs(tenantId, bob, approvalId)

    for (const ref of ['refs/tags/0.1.0', 'refs/heads/main']) {
      const other = deployJob(env, app, 'production', { ref })
      const start = await body<{ id: string; status: string }>(
        await other.call('POST', '/start', { protocol: 1 })
      )
      expect(start.status, ref).toBe('pending')
    }
    const [intent] = await db
      .select()
      .from(deployTickets)
      .where(eq(deployTickets.approvalId, approvalId))
    expect(intent?.runId).toBeNull()
    // The right tag still claims it.
    const prod = await ship(app, 'production', 'refs/tags/0.1.1')
    expect(prod.ticketId).toBe(intent?.id)
  })
})

describe('the author cannot approve', () => {
  it('excludes the promoter, whoever cut the release and its sessions’ creators', async () => {
    const { tenantId, admin, alice, bob, app } = await fixture()
    // Bob cuts and promotes; alice's session wrote the PR.
    const cut = await cutRelease(app, bob)
    await ship(app, 'staging', 'refs/tags/0.1.1')
    const { approvalId } = promoteReleaseResponseSchema.parse(
      await (await promote(app, cut.id, bob)).json()
    )
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId))
    expect([...(row?.excludedUserIds ?? [])].sort()).toEqual([alice.id, bob.id].sort())
    for (const author of [alice, bob]) {
      await expect(decideAs(tenantId, author, approvalId)).rejects.toMatchObject({
        statusCode: 403,
        code: 'self_approval',
      })
    }
    // An admin with no part in it approves.
    await decideAs(tenantId, admin, approvalId)
    expect(await releaseRow(cut.id)).toMatchObject({ status: 'promoting' })
  })
})

describe('a job-originated production run', () => {
  it('a Release published by hand waits on its own approval: approved in its window, 409 after', async () => {
    const { tenantId, alice, bob, app } = await fixture()
    const cut = await cutRelease(app, alice)
    await ship(app, 'staging', 'refs/tags/0.1.1')
    cloud.github.publish(app.owner, app.repo, '0.1.1')

    const job = deployJob(env, app, 'production', { ref: 'refs/tags/0.1.1', actor: 'dora' })
    const start = await body<{ id: string; status: string }>(
      await job.call('POST', '/start', { protocol: 1 })
    )
    expect(start.status).toBe('pending')
    const [ticket] = await db.select().from(deployTickets).where(eq(deployTickets.id, start.id))
    expect(ticket).toMatchObject({ releaseId: cut.id, approvalId: expect.any(String) })
    const [waiting] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, ticket?.approvalId as string))
    expect(waiting).toMatchObject({
      kind: 'deploy.production',
      subjectType: 'deploy_ticket',
      subjectId: start.id,
      requestedByLabel: 'github:dora',
      requestedByUserId: null,
    })
    // Expiring with the ticket, and excluding the release's authors.
    expect(waiting?.expiresAt?.getTime()).toBeLessThanOrEqual(
      ticket?.expiresAt?.getTime() as number
    )
    expect(waiting?.excludedUserIds).toEqual([alice.id])

    // Decided on the app page (the ticket route redirects to the engine).
    const decided = await request(
      `/api/apps/${app.app.id}/deploys/${start.id}/decide`,
      { method: 'POST', headers: bob.cookie },
      { env, json: { decision: 'approve' } }
    )
    expect(decided.status, await decided.clone().text()).toBe(200)
    expect(await body(decided)).toMatchObject({
      status: 'approved',
      decisionSource: 'approval',
      decidedByUserId: bob.id,
    })
    expect((await body(await job.call('GET', `/${start.id}`))).status).toBe('approved')

    // A second hand-published run whose window closed: the approval cannot reach it.
    const later = deployJob(env, app, 'production', { ref: 'refs/tags/0.1.1', actor: 'dora' })
    const gone = await body<{ id: string }>(await later.call('POST', '/start', { protocol: 1 }))
    await db
      .update(deployTickets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deployTickets.id, gone.id))
    const tooLate = await request(
      `/api/apps/${app.app.id}/deploys/${gone.id}/decide`,
      { method: 'POST', headers: bob.cookie },
      { env, json: { decision: 'approve' } }
    )
    expect(tooLate.status).toBe(409)
    expect(await body(tooLate)).toMatchObject({ statusCode: 409, code: 'deploy_run_gone' })
    // Nothing was recorded: the request is still pending for its own expiry.
    const [still] = await db.select().from(deployTickets).where(eq(deployTickets.id, gone.id))
    const [req] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, still?.approvalId as string))
    expect(req?.status).toBe('pending')
    void tenantId
  })
})

describe('reject', () => {
  it('the release is rejected, no GitHub Release exists, and it may be promoted again', async () => {
    const { tenantId, alice, bob, app } = await fixture()
    const cut = await cutRelease(app, alice)
    await ship(app, 'staging', 'refs/tags/0.1.1')
    const { approvalId } = promoteReleaseResponseSchema.parse(
      await (await promote(app, cut.id, alice)).json()
    )
    await decideAs(tenantId, bob, approvalId, 'reject', 'Not before the freeze ends')
    expect(await releaseRow(cut.id)).toMatchObject({
      status: 'rejected',
      error: 'The production deploy was rejected',
    })
    expect(cloud.github.releaseFor(app.owner, app.repo, '0.1.1')).toBeUndefined()
    const intents = await db
      .select()
      .from(deployTickets)
      .where(eq(deployTickets.approvalId, approvalId))
    expect(intents).toEqual([])

    const retried = await promote(app, cut.id, alice)
    expect(retried.status).toBe(202)
    const next = promoteReleaseResponseSchema.parse(await retried.json())
    expect(next.approvalId).not.toBe(approvalId)
    expect(next.release.status).toBe('awaiting_approval')
  })
})

describe('Promote’s preconditions', () => {
  it('409 until staging runs the release, and while staging is not up; members may not', async () => {
    const { tenantId, alice, app } = await fixture({ served: false })
    const carol = await person(tenantId, 'member')
    const cut = await cutRelease(app, alice)
    const early = await promote(app, cut.id, alice)
    expect(early.status).toBe(409)
    expect(await body(early)).toMatchObject({ code: 'release_not_promotable' })

    await ship(app, 'staging', 'refs/tags/0.1.1')
    // No host answers: staging is probed and is not up.
    const down = await promote(app, cut.id, alice)
    expect(down.status).toBe(409)
    expect(await body(down)).toMatchObject({ code: 'release_staging_unhealthy' })

    serveAppHosts(cloud, app)
    expect((await promote(app, cut.id, carol)).status).toBe(403)
    expect((await promote(app, cut.id, alice)).status).toBe(202)
    const rows = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.subjectId, cut.id)))
    expect(rows).toHaveLength(1)
  })
})
