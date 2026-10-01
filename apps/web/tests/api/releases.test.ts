// @vitest-isolate
// Installs a FakeCloud as the global fetch and mocks the platform credential store.
/**
 * Release (Launch P4, slice 4d): `POST /api/apps/:id/releases {bump}` bumps the root
 * `package.json` on the default branch, tags the bump commit `X.Y.Z` and records the PRs since the
 * previous tag — all through the GitHub App under a token narrowed to the one repo and revoked
 * afterwards — and the `sessions.checks` cron follows shipped PRs to their merge.
 *
 * What it pins: the bump (only the version moves), the tag on the bump commit, the PR list (a
 * session's PR matched to its session, a person's PR found by the compare, an open PR left out),
 * `pr.merged` recorded once whichever path saw it first, idempotency by the tag (a Release that
 * died before tagging resumes rather than bumping twice), 409 for a tag that already exists, and
 * the route's 401 / 403 / 404 / tenant isolation; and (issue #5) the chain reading the
 * `session.merge` reviews of the release's sessions.
 */
import {
  releaseChainSchema,
  releaseListResponseSchema,
  releaseSchema,
} from '@launch/shared/launch-releases'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordAudit, SYSTEM_ACTOR } from '@/api/services/launch/audit'
import { followMergedPullRequests, githubPullReader } from '@/api/services/sessions/checks-cron'
import { loadConfig } from '@/config'
import { approvalRequests, auditEvents } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { fillDeployCredentials } from '../helpers/deploy-gateway'
import { createFakeCloud } from '../helpers/fake-cloud'
import { forgetApps } from '../helpers/launch-apps'
import { addTestAppOwner } from '../helpers/oidc'
import {
  openPullOnBranch,
  type ReleasableApp,
  seedReleasableApp,
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

/** An organisation, its owner, alice (a member who owns the app) and a releasable app. */
async function fixture() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const admin: Person = {
    id: user.id,
    email: user.email,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
  const alice = await person(tenant.id, 'member')
  const app = await seedReleasableApp(db, cloud, tenant.id)
  await addTestAppOwner(db, tenant.id, app.app.id, alice.id)
  return { tenantId: tenant.id, admin, alice, app }
}

function release(app: ReleasableApp, who: Person, bump: 'patch' | 'minor' | 'major' = 'patch') {
  return request(
    `/api/apps/${app.app.id}/releases`,
    { method: 'POST', headers: who.cookie },
    { env, json: { bump } }
  )
}

async function actions(tenantId: string, appId: string) {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.appId, appId)))
  return rows.sort((a, b) => a.at.getTime() - b.at.getTime())
}

describe('POST /api/apps/:id/releases', () => {
  it('bumps package.json, tags the bump commit and records the merged session PR', async () => {
    const { tenantId, alice, app } = await fixture()
    const shipped = await shipSessionPr(db, cloud, app, {
      tenantId,
      userId: alice.id,
      title: 'Add the orders page',
    })
    cloud.github.merge(app.owner, app.repo, shipped.number)
    const tokensBefore = cloud.github.tokens.size

    const res = await release(app, alice)
    expect(res.status, await res.clone().text()).toBe(201)
    const created = releaseSchema.parse(await res.json())
    expect(created).toMatchObject({
      version: '0.1.1',
      tag: '0.1.1',
      previousTag: null,
      status: 'tagged',
      createdByUserId: alice.id,
    })
    // The tag is on the bump commit, whose package.json says the version and nothing else moved.
    const repo = cloud.github.repo(app.owner, app.repo)
    expect(repo?.refs.get('tags/0.1.1')).toBe(created.sha)
    expect(repo?.refs.get('heads/main')).toBe(created.sha)
    const pkg = cloud.github.readFile(app.owner, app.repo, 'package.json', '0.1.1')
    expect(pkg).toBe(`{\n  "name": "${app.repo}",\n  "private": true,\n  "version": "0.1.1"\n}\n`)
    expect(cloud.github.commits.get(created.sha)?.message).toBe('release: 0.1.1')
    // The first release has no tag to compare against: its merged session PRs.
    expect(created.prs).toEqual([
      expect.objectContaining({
        number: shipped.number,
        title: 'Add the orders page',
        author: 'launch-app[bot]',
        sessionId: shipped.session.id,
        mergeSha: expect.any(String),
      }),
    ])
    // Every token Launch minted for it was narrowed to the repo and revoked.
    const minted = [...cloud.github.tokens.values()].slice(tokensBefore)
    expect(minted.length).toBeGreaterThan(0)
    for (const t of minted) {
      expect(t.repositories).toEqual([app.repo])
      expect(t.revoked).toBe(true)
    }
    const trail = (await actions(tenantId, app.app.id)).map(a => a.action)
    expect(trail).toEqual(['session.shipped', 'pr.merged', 'release.created'])
  })

  it('a later release lists the compare’s merged PRs — a person’s too — and not an open one', async () => {
    const { tenantId, alice, app } = await fixture()
    const first = releaseSchema.parse(await (await release(app, alice)).json())

    const byHand = openPullOnBranch(cloud, app, {
      branch: 'fix-typo',
      title: 'Fix a typo',
      author: 'dora',
    })
    cloud.github.merge(app.owner, app.repo, byHand.number)
    openPullOnBranch(cloud, app, { branch: 'wip', title: 'Still open', author: 'erin' })
    const shipped = await shipSessionPr(db, cloud, app, {
      tenantId,
      userId: alice.id,
      title: 'Session work',
    })
    cloud.github.merge(app.owner, app.repo, shipped.number)

    const res = await release(app, alice, 'minor')
    expect(res.status, await res.clone().text()).toBe(201)
    const second = releaseSchema.parse(await res.json())
    expect(second).toMatchObject({ version: '0.2.0', tag: '0.2.0', previousTag: first.tag })
    expect(second.prs.map(p => [p.number, p.author, p.sessionId ?? null])).toEqual([
      [byHand.number, 'dora', null],
      [shipped.number, 'launch-app[bot]', shipped.session.id],
    ])
    // One pr.merged per PR, whichever path recorded it.
    const merged = (await actions(tenantId, app.app.id)).filter(a => a.action === 'pr.merged')
    expect(merged.map(m => m.targetId).sort()).toEqual(
      [String(byHand.number), String(shipped.number)].sort()
    )

    // Newest first, for any member.
    const list = await request(
      `/api/apps/${app.app.id}/releases`,
      { headers: alice.cookie },
      { env }
    )
    expect(releaseListResponseSchema.parse(await list.json()).items.map(r => r.tag)).toEqual([
      '0.2.0',
      '0.1.1',
    ])
  })

  it('is idempotent by the tag: a Release that died before tagging resumes, not bumps again', async () => {
    const { alice, app } = await fixture()
    const bumpsOf = (message: string) =>
      [...cloud.github.commits.values()].filter(c => c.message === message).length
    const before = { patch: bumpsOf('release: 0.1.1'), next: bumpsOf('release: 0.1.2') }
    cloud.failNext(({ method, url }) => method === 'POST' && url.endsWith('/git/refs'), 500)
    const failed = await release(app, alice)
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({ statusCode: 502, code: 'release_github_failed' })
    // The bump was committed; the tag was not.
    expect(cloud.github.readFile(app.owner, app.repo, 'package.json')).toContain('"0.1.1"')
    expect(cloud.github.repo(app.owner, app.repo)?.refs.has('tags/0.1.1')).toBe(false)

    const retried = await release(app, alice)
    expect(retried.status, await retried.clone().text()).toBe(201)
    expect(releaseSchema.parse(await retried.json())).toMatchObject({ version: '0.1.1' })
    // One bump commit for this app's 0.1.1 (the FakeCloud's commits are shared by the file).
    expect(bumpsOf('release: 0.1.1')).toBe(before.patch + 1)
    expect(bumpsOf('release: 0.1.2')).toBe(before.next)
  })

  it('409 when the next version is already tagged, or package.json has no version', async () => {
    const { alice, app } = await fixture()
    const main = cloud.github.repo(app.owner, app.repo)?.refs.get('heads/main') as string
    cloud.github.repo(app.owner, app.repo)?.refs.set('tags/0.1.1', main)
    const tagged = await release(app, alice)
    expect(tagged.status).toBe(409)
    expect(await tagged.json()).toMatchObject({ code: 'release_tag_exists' })

    cloud.github.pushCommit(app.owner, app.repo, { 'package.json': '{ "name": "x" }\n' })
    const unversioned = await release(app, alice)
    expect(unversioned.status).toBe(409)
    expect(await unversioned.json()).toMatchObject({ code: 'release_version_unreadable' })
  })

  it('401 without a session, 403 for a member who does not own the app, 404 across tenants', async () => {
    const { tenantId, alice, app } = await fixture()
    const carol = await person(tenantId, 'member')
    expect((await request(`/api/apps/${app.app.id}/releases`, {}, { env })).status).toBe(401)
    const refused = await release(app, carol)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ statusCode: 403, code: 'forbidden' })
    // A member may read.
    const created = releaseSchema.parse(await (await release(app, alice)).json())
    const one = await request(
      `/api/apps/${app.app.id}/releases/${created.id}`,
      { headers: carol.cookie },
      { env }
    )
    expect(releaseSchema.parse(await one.json()).id).toBe(created.id)

    const other = await fixture()
    for (const path of [
      `/api/apps/${app.app.id}/releases`,
      `/api/apps/${app.app.id}/releases/${created.id}`,
      `/api/apps/${app.app.id}/releases/${created.id}/chain`,
    ]) {
      const res = await request(path, { headers: other.admin.cookie }, { env })
      expect(res.status, path).toBe(404)
    }
    // Another app's release id under this app is a 404 too.
    const foreign = await request(
      `/api/apps/${other.app.app.id}/releases/${created.id}`,
      { headers: other.admin.cookie },
      { env }
    )
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toMatchObject({ code: 'release_not_found' })
  })
})

describe('sessions.checks follows shipped PRs to their merge', () => {
  it('records pr.merged once with the merge SHA, pr.closed for a closed one, and stops', async () => {
    const { tenantId, alice, app } = await fixture()
    const merged = await shipSessionPr(db, cloud, app, {
      tenantId,
      userId: alice.id,
      title: 'Merged later',
    })
    const closed = await shipSessionPr(db, cloud, app, {
      tenantId,
      userId: alice.id,
      title: 'Closed unmerged',
    })
    const reader = githubPullReader(loadConfig(env))
    const opts = { tenantIds: [tenantId] }

    expect(await followMergedPullRequests(db, reader, opts)).toMatchObject({
      merged: 0,
      closed: 0,
      open: 2,
    })
    const mergeSha = cloud.github.merge(app.owner, app.repo, merged.number)
    cloud.github.closePull(app.owner, app.repo, closed.number)
    expect(await followMergedPullRequests(db, reader, opts)).toMatchObject({
      merged: 1,
      closed: 1,
      open: 0,
    })
    // Recorded: nothing left to read.
    const readsBefore = cloud.callsTo('github').length
    expect(await followMergedPullRequests(db, reader, opts)).toMatchObject({
      merged: 0,
      closed: 0,
      open: 0,
    })
    expect(cloud.callsTo('github').length).toBe(readsBefore)

    const rows = (await actions(tenantId, app.app.id)).filter(a => a.action.startsWith('pr.'))
    expect(rows.map(r => [r.action, r.targetId])).toEqual(
      expect.arrayContaining([
        ['pr.merged', String(merged.number)],
        ['pr.closed', String(closed.number)],
      ])
    )
    const record = rows.find(r => r.action === 'pr.merged')
    expect(record?.summary.after).toMatchObject({
      mergeSha,
      sessionId: merged.session.id,
      via: 'sessions.checks',
    })
    expect(record?.targetType).toBe('pull_request')

    // A release after the cron does not record the merge a second time.
    await release(app, alice)
    const again = (await actions(tenantId, app.app.id)).filter(a => a.action === 'pr.merged')
    expect(again).toHaveLength(1)
  })
})

describe('GET /api/apps/:id/releases/:rid/chain', () => {
  /** A `session.merge` request on `sessionId` with its `approval.requested` row (as S2 opens it). */
  async function mergeReview(tenantId: string, appId: string, sessionId: string) {
    const [row] = await db
      .insert(approvalRequests)
      .values({
        tenantId,
        kind: 'session.merge',
        appId,
        subjectType: 'session',
        subjectId: sessionId,
        status: 'approved',
        context: { kind: 'session.merge' } as never,
        policy: {} as never,
      })
      .returning()
    if (!row) throw new Error('no approval row')
    await recordAudit(db, {
      ...SYSTEM_ACTOR,
      tenantId,
      action: 'approval.requested',
      targetType: 'approval_request',
      targetId: row.id,
      appId,
      approvalId: row.id,
      summary: { after: { kind: 'session.merge', subjectId: sessionId } },
    })
    return row.id
  }

  it('includes the session.merge reviews of the release’s sessions, and no other session’s', async () => {
    const { tenantId, alice, app } = await fixture()
    const shipped = await shipSessionPr(db, cloud, app, {
      tenantId,
      userId: alice.id,
      title: 'Reviewed in Launch',
    })
    cloud.github.merge(app.owner, app.repo, shipped.number)
    const reviewed = await mergeReview(tenantId, app.app.id, shipped.session.id)
    // Another session of the app, not in this release (its PR is still open).
    const pending = await shipSessionPr(db, cloud, app, {
      tenantId,
      userId: alice.id,
      title: 'Not released yet',
    })
    const elsewhere = await mergeReview(tenantId, app.app.id, pending.session.id)

    const created = releaseSchema.parse(await (await release(app, alice)).json())
    const res = await request(
      `/api/apps/${app.app.id}/releases/${created.id}/chain`,
      { headers: alice.cookie },
      { env }
    )
    expect(res.status, await res.clone().text()).toBe(200)
    const chain = releaseChainSchema.parse(await res.json())
    const approvals = chain.events.filter(e => e.action === 'approval.requested')
    expect(approvals.map(e => e.approvalId)).toEqual([reviewed])
    expect(chain.events.map(e => e.approvalId)).not.toContain(elsewhere)
    expect(chain.events.map(e => e.action)).toEqual(
      expect.arrayContaining([
        'session.shipped',
        'approval.requested',
        'pr.merged',
        'release.created',
      ])
    )
  })
})
