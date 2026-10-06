// @vitest-isolate
// Installs a FakeCloud as the global fetch and mocks the platform credential store.
/**
 * Issue #12 (build once): Promote publishes the kit's staging DRAFT release for the tag (the one
 * carrying `launch-bundle-<tag>.tgz`) with a PATCH instead of POSTing a new release, so production
 * deploys the bytes staging ran; and every deploy records Launch's own artifact digest, a
 * production upload being compared with the staging deploy of the same version.
 *
 * What it pins:
 * - draft + asset → one PATCH `{ draft: false, name, body }` (no `tag_name`), no POST, `release:
 *   published` once; the notes carry the tree, the session PR's `launch/gate` link, Staging's
 *   Worker version and digest — and, after production activates, Live's Worker version;
 * - already published → nothing written; no draft → POST as before (production rebuilds);
 * - the digest is recorded at staging (and equals the kit's `bundleSha256` algorithm);
 * - a production upload whose digest differs is warned about and recorded (`digestMismatch`,
 *   the release view's `artifact.matches: false`); one that declares `source: 'bundle'` is
 *   refused 409; a claimed digest that is not Launch's is 400.
 */
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { promoteReleaseResponseSchema, releaseSchema } from '@launch/shared/launch-releases'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decide, retryApply } from '@/api/services/approvals/engine'
import { deployArtifactDigest } from '@/api/services/launch/deploy/artifact-digest'
import { BUNDLE_DRAFT_WAIT_MINUTES, withLiveVersion } from '@/api/services/launch/releases/publish'
import { appReleases, approvalRequests, auditEvents, deployTickets, sessions } from '@/db/schema'
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
  cloud.github.onRelease = null
})

interface Person {
  id: string
  email: string
  cookie: Record<string, string>
}

async function person(tenantId: string, role: 'owner' | 'member'): Promise<Person> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenantId))
  return { id: user.id, email: user.email, cookie }
}

const GATE_SHA = 'a'.repeat(40)
const GATE_TREE = 'b'.repeat(40)

/** alice cut and promotes; bob approves. alice's session shipped PR #n with a gated landing. */
async function fixture() {
  const { tenant } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const alice = await person(tenant.id, 'member')
  const bob = await person(tenant.id, 'member')
  const app = await seedReleasableApp(db, cloud, tenant.id)
  await addTestAppOwner(db, tenant.id, app.app.id, alice.id)
  await addTestAppOwner(db, tenant.id, app.app.id, bob.id)
  serveAppHosts(cloud, app)
  const shipped = await shipSessionPr(db, cloud, app, {
    tenantId: tenant.id,
    userId: alice.id,
    title: 'Add the orders page',
  })
  // Issue #9: the landing's gate — its head (where `launch/gate` is posted) and its tree.
  await db
    .update(sessions)
    .set({
      landing: {
        mode: 'pr',
        stage: 'merged',
        prNumber: shipped.number,
        gateSha: GATE_SHA,
        gateTree: GATE_TREE,
      } as never,
    })
    .where(eq(sessions.id, shipped.session.id))
  cloud.github.merge(app.owner, app.repo, shipped.number)
  return { tenantId: tenant.id, alice, bob, app, shipped }
}

async function cutRelease(app: ReleasableApp, who: Person) {
  const res = await request(
    `/api/apps/${app.app.id}/releases`,
    { method: 'POST', headers: who.cookie },
    { env, json: { bump: 'patch' } }
  )
  expect(res.status, await res.clone().text()).toBe(201)
  return (await res.json()) as { id: string; tag: string; version: string }
}

type Upload = ReturnType<typeof uploadBody> & { digest?: string; source?: 'bundle' | 'build' }

/** One run of `deploy.yml` on `ref` with `upload`; returns the upload's response. */
async function ship(
  app: ReleasableApp,
  environment: 'staging' | 'production',
  ref: string,
  upload?: Upload
) {
  const job = deployJob(env, app, environment, { ref })
  const start = (await (await job.call('POST', '/start', { protocol: 1 })).json()) as {
    id: string
    status: string
  }
  expect(start.status).toBe('approved')
  const version = ref.replace('refs/tags/', '')
  const uploaded = await job.call(
    'POST',
    `/${start.id}/upload`,
    upload ?? uploadBody(appToml(app, environment), version)
  )
  if (uploaded.status !== 200) return { ticketId: start.id, uploaded }
  for (const path of ['activate', 'finish']) {
    const res = await job.call('POST', `/${start.id}/${path}`)
    expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200)
  }
  return { ticketId: start.id, uploaded }
}

async function promoteAndApprove(
  tenantId: string,
  app: ReleasableApp,
  releaseId: string,
  alice: Person,
  bob: Person
) {
  const res = await request(
    `/api/apps/${app.app.id}/releases/${releaseId}/promote`,
    { method: 'POST', headers: alice.cookie },
    { env, json: {} }
  )
  expect(res.status, await res.clone().text()).toBe(202)
  const { approvalId } = promoteReleaseResponseSchema.parse(await res.json())
  await decide(approvalDeps(db, env), {
    requestId: approvalId,
    viewer: await viewerOf(db, tenantId, bob),
    decision: 'approve',
    actor: actorOf(bob),
  })
  return approvalId
}

async function ticket(id: string) {
  const [row] = await db.select().from(deployTickets).where(eq(deployTickets.id, id))
  if (!row) throw new Error(`no ticket ${id}`)
  return row
}

async function uploadedAudit(ticketId: string) {
  const [row] = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.targetId, ticketId), eq(auditEvents.action, 'deploy.uploaded')))
  return (row?.summary as { after?: Record<string, unknown> } | null)?.after ?? {}
}

async function releaseView(app: ReleasableApp, releaseId: string, who: Person) {
  const res = await request(
    `/api/apps/${app.app.id}/releases/${releaseId}`,
    { headers: who.cookie },
    { env }
  )
  expect(res.status).toBe(200)
  return releaseSchema.parse(await res.json())
}

/** A ustar entry: header + data padded to 512 bytes. */
function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const b of header) sum += b
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512)
  return Buffer.concat([header, data, pad])
}

/** The kit's `launch-bundle-<tag>.tgz` with a manifest naming `tag` and `bundleSha256`. */
function bundleTgz(tag: string, bundleSha256: string): Uint8Array {
  const manifest = Buffer.from(
    JSON.stringify({
      protocol: 1,
      tag,
      version: tag,
      commit: 'c'.repeat(40),
      bundleSha256,
      files: {},
    })
  )
  return new Uint8Array(
    gzipSync(
      Buffer.concat([
        tarEntry('manifest.json', manifest),
        tarEntry('worker/worker.js', Buffer.from('export default {}')),
        Buffer.alloc(1024),
      ])
    )
  )
}

/** A staging upload from a build-once kit (kit 0.17.0+ sends `source`). */
const buildOnceUpload = (app: ReleasableApp, version: string): Upload => ({
  ...uploadBody(appToml(app, 'staging'), version),
  source: 'build',
})

async function approvalRow(id: string) {
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id))
  if (!row) throw new Error(`no approval ${id}`)
  return row
}

const releasesOn = (app: ReleasableApp, tag: string) =>
  cloud.github.releases.filter(r => r.owner === app.owner && r.repo === app.repo && r.tag === tag)

describe('Promote publishes the staging draft', () => {
  it('draft + asset → PATCH draft:false, no POST; notes carry tree, gate, both version ids', async () => {
    const { tenantId, alice, bob, app, shipped } = await fixture()
    const cut = await cutRelease(app, alice)
    const staging = await ship(app, 'staging', 'refs/tags/0.1.1')
    const stagingTicket = await ticket(staging.ticketId)
    expect(stagingTicket.artifactDigest).toMatch(/^[0-9a-f]{64}$/)
    // The kit's release-bundle job's draft with the bundle — and a NEWER draft without one (a
    // person's), which GitHub lists first: the bundle's draft still wins.
    const draft = cloud.github.draft(app.owner, app.repo, '0.1.1', {
      bundleBytes: bundleTgz('0.1.1', stagingTicket.artifactDigest as string),
    })
    const stale = cloud.github.draft(app.owner, app.repo, '0.1.1', { bundle: false })
    const updatesOf = () =>
      cloud.github.releaseUpdates.filter(u => u.id === draft.id || u.id === stale.id)
    let published = 0
    cloud.github.onRelease = () => {
      published++
    }

    await promoteAndApprove(tenantId, app, cut.id, alice, bob)

    expect(published).toBe(1)
    expect(updatesOf()).toHaveLength(1)
    const update = updatesOf()[0]
    expect(update?.id).toBe(draft.id)
    expect(update?.body).toMatchObject({ draft: false, name: '0.1.1' })
    expect(update?.body).not.toHaveProperty('tag_name')
    // No POST: the tag still has the two drafts only, one of them now published.
    expect(releasesOn(app, '0.1.1')).toHaveLength(2)
    const live = cloud.github.releaseFor(app.owner, app.repo, '0.1.1')
    expect(live?.id).toBe(draft.id)
    const tree = cloud.github.commits.get(live?.sha ?? '')?.tree
    expect(tree).toBeTruthy()
    expect(live?.body).toContain(`- Tree: \`${tree}\``)
    expect(live?.body).toContain(`#${shipped.number} Add the orders page`)
    expect(live?.body).toContain(
      `- Gate: #${shipped.number} [launch/gate](https://github.com/${app.owner}/${app.repo}/commit/${GATE_SHA}/checks) on tree \`${GATE_TREE}\``
    )
    expect(live?.body).toContain(`- Staging Worker version: \`${stagingTicket.cfVersionId}\``)
    expect(live?.body).toContain('- Live Worker version: pending')
    expect(live?.body).toContain(`- Artifact digest (staging): \`${stagingTicket.artifactDigest}\``)
    expect(live?.body).toContain('launch-bundle-0.1.1.tgz, the build staging ran')

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, cut.id), eq(auditEvents.action, 'release.published')))
    expect((audit?.summary as { after?: unknown } | undefined)?.after).toMatchObject({
      via: 'draft',
      bundle: true,
    })

    // Production deploys the same bytes: the digests match, and Live's id reaches the notes.
    const prod = await ship(app, 'production', 'refs/tags/0.1.1')
    const prodTicket = await ticket(prod.ticketId)
    expect(prodTicket.artifactDigest).toBe(stagingTicket.artifactDigest)
    expect(await uploadedAudit(prod.ticketId)).toMatchObject({
      digest: stagingTicket.artifactDigest,
      stagingDigest: stagingTicket.artifactDigest,
    })
    expect(await uploadedAudit(prod.ticketId)).not.toHaveProperty('digestMismatch')
    await vi.waitFor(() =>
      expect(cloud.github.releaseFor(app.owner, app.repo, '0.1.1')?.body).toContain(
        `- Live Worker version: \`${prodTicket.cfVersionId}\``
      )
    )
    expect(cloud.github.releaseFor(app.owner, app.repo, '0.1.1')?.body).not.toContain('pending')

    const view = await releaseView(app, cut.id, bob)
    expect(view.artifact).toEqual({
      stagingVersionId: stagingTicket.cfVersionId,
      stagingDigest: stagingTicket.artifactDigest,
      productionVersionId: prodTicket.cfVersionId,
      productionDigest: prodTicket.artifactDigest,
      matches: true,
    })
  })

  it('already published → nothing is written', async () => {
    const { tenantId, alice, bob, app } = await fixture()
    const cut = await cutRelease(app, alice)
    await ship(app, 'staging', 'refs/tags/0.1.1')
    // A person published it in GitHub before the approval was decided.
    cloud.github.publish(app.owner, app.repo, '0.1.1')
    const before = cloud.github.releaseUpdates.length

    await promoteAndApprove(tenantId, app, cut.id, alice, bob)

    expect(cloud.github.releaseUpdates).toHaveLength(before)
    expect(releasesOn(app, '0.1.1')).toHaveLength(1)
    expect(cloud.github.releaseFor(app.owner, app.repo, '0.1.1')?.via).toBe('hook')
  })

  it('no draft (an older kit) → POST as before; production rebuilds', async () => {
    const { tenantId, alice, bob, app } = await fixture()
    const cut = await cutRelease(app, alice)
    await ship(app, 'staging', 'refs/tags/0.1.1')
    const before = cloud.github.releaseUpdates.length

    await promoteAndApprove(tenantId, app, cut.id, alice, bob)

    expect(cloud.github.releaseUpdates).toHaveLength(before)
    const created = cloud.github.releaseFor(app.owner, app.repo, '0.1.1')
    expect(created).toMatchObject({ via: 'api', draft: false })
    expect(created?.body).toContain('Production builds from the tag (no release bundle)')
    expect(releasesOn(app, '0.1.1')).toHaveLength(1)
  })
})

describe('Promote waits for the bundle draft, and checks it (issue #21)', () => {
  it('a build-once kit with no draft yet: nothing is published; the retry after the draft appears publishes it', async () => {
    const { tenantId, alice, bob, app } = await fixture()
    const cut = await cutRelease(app, alice)
    const staging = await ship(app, 'staging', 'refs/tags/0.1.1', buildOnceUpload(app, '0.1.1'))
    const digest = (await ticket(staging.ticketId)).artifactDigest as string

    const approvalId = await promoteAndApprove(tenantId, app, cut.id, alice, bob)

    expect(releasesOn(app, '0.1.1')).toEqual([])
    const waiting = await approvalRow(approvalId)
    expect(waiting.appliedAt).toBeNull()
    expect(waiting.applyError).toContain('Waiting for the staging run to attach the release bundle')

    const draft = cloud.github.draft(app.owner, app.repo, '0.1.1', {
      bundleBytes: bundleTgz('0.1.1', digest),
    })
    const later = new Date(Date.now() + 5 * 60_000)
    expect(
      await retryApply(
        approvalDeps(db, env, () => later),
        { tenantId, requestId: approvalId }
      )
    ).toBe('applied')
    expect(cloud.github.releaseFor(app.owner, app.repo, '0.1.1')?.id).toBe(draft.id)
    expect(releasesOn(app, '0.1.1')).toHaveLength(1)
    expect(cloud.github.assetDownloads.some(d => d.name === 'launch-bundle-0.1.1.tgz')).toBe(true)
  })

  it('the draft long gone (staging went live over 20 minutes ago — a kit prunes old drafts): POSTs at once and says why', async () => {
    const { tenantId, alice, bob, app } = await fixture()
    const cut = await cutRelease(app, alice)
    const staging = await ship(app, 'staging', 'refs/tags/0.1.1', buildOnceUpload(app, '0.1.1'))
    await db
      .update(deployTickets)
      .set({ activatedAt: new Date(Date.now() - (BUNDLE_DRAFT_WAIT_MINUTES + 5) * 60_000) })
      .where(eq(deployTickets.id, staging.ticketId))

    const approvalId = await promoteAndApprove(tenantId, app, cut.id, alice, bob)

    expect((await approvalRow(approvalId)).appliedAt).toBeInstanceOf(Date)
    const created = cloud.github.releaseFor(app.owner, app.repo, '0.1.1')
    expect(created).toMatchObject({ via: 'api', draft: false })
    expect(created?.body).toContain('the staging release bundle’s draft is gone')
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, cut.id), eq(auditEvents.action, 'release.published')))
    expect((audit?.summary as { after?: unknown } | undefined)?.after).toMatchObject({
      via: 'created',
      rebuildReason: 'draft_gone',
    })
  })

  it('the last attempt the engine allows publishes without the draft: production rebuilds', async () => {
    const { tenantId, alice, bob, app } = await fixture()
    const cut = await cutRelease(app, alice)
    await ship(app, 'staging', 'refs/tags/0.1.1', buildOnceUpload(app, '0.1.1'))
    const approvalId = await promoteAndApprove(tenantId, app, cut.id, alice, bob)
    expect(releasesOn(app, '0.1.1')).toEqual([])
    // Retries past the sweep's 4-minute backoff, inside the 20-minute window: three more wait,
    // the fifth attempt gives up waiting and POSTs.
    for (let i = 1; i <= 4; i++) {
      const at = new Date(Date.now() + i * 4.5 * 60_000)
      const outcome = await retryApply(
        approvalDeps(db, env, () => at),
        {
          tenantId,
          requestId: approvalId,
        }
      )
      expect(outcome).toBe(i < 4 ? 'failed' : 'applied')
    }
    expect(cloud.github.releaseFor(app.owner, app.repo, '0.1.1')?.body).toContain(
      'did not appear in time'
    )
  })

  it('a bundle that is not the build staging deployed is never published', async () => {
    const { tenantId, alice, bob, app } = await fixture()
    const cut = await cutRelease(app, alice)
    await ship(app, 'staging', 'refs/tags/0.1.1', buildOnceUpload(app, '0.1.1'))
    const draft = cloud.github.draft(app.owner, app.repo, '0.1.1', {
      bundleBytes: bundleTgz('0.1.1', 'f'.repeat(64)),
    })
    const before = cloud.github.releaseUpdates.length

    const approvalId = await promoteAndApprove(tenantId, app, cut.id, alice, bob)

    expect(cloud.github.releaseUpdates).toHaveLength(before)
    expect(cloud.github.releaseFor(app.owner, app.repo, '0.1.1')).toBeUndefined()
    expect(releasesOn(app, '0.1.1').map(r => r.id)).toEqual([draft.id])
    expect((await approvalRow(approvalId)).applyError).toContain('not the build staging deployed')
  })
})

describe('the Live Worker version line (issue #21)', () => {
  it('is filled once: a rollback or re-deploy of the tag leaves it naming the first go-live', () => {
    const pending = '**Build**\n\n- Live Worker version: pending (set when production goes live)\n'
    const first = withLiveVersion(pending, 'v-first')
    expect(first).toContain('- Live Worker version: `v-first`')
    expect(withLiveVersion(first, 'v-rollback')).toBe(first)
    // Notes Launch did not write (no line) are left alone.
    expect(withLiveVersion('Hand-written notes', 'v-first')).toBe('Hand-written notes')
  })
})

describe('the artifact digest', () => {
  it('is recorded at staging, computed as the kit computes bundleSha256', async () => {
    const { alice, app } = await fixture()
    await cutRelease(app, alice)
    const body = uploadBody(appToml(app, 'staging'), '0.1.1')
    const staging = await ship(app, 'staging', 'refs/tags/0.1.1', body)
    // `sha256sum` lines of worker/<module> + ui/<asset>, sorted, hashed.
    const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
    const files: [string, string][] = [
      ...Object.entries(body.modules).map(
        ([rel, b64]) => [`worker/${rel}`, sha(Buffer.from(b64, 'base64'))] as [string, string]
      ),
      ...Object.entries(body.assets).map(
        ([p, b64]) => [`ui/${p.slice(1)}`, sha(Buffer.from(b64, 'base64'))] as [string, string]
      ),
    ]
    files.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    const expected = sha(files.map(([p, h]) => `${h}  ${p}\n`).join(''))
    expect(await deployArtifactDigest(body)).toBe(expected)
    expect((await ticket(staging.ticketId)).artifactDigest).toBe(expected)
    expect(await uploadedAudit(staging.ticketId)).toMatchObject({ digest: expected })
  })

  it('a production upload that differs is warned about and recorded, not refused', async () => {
    const { tenantId, alice, bob, app } = await fixture()
    const cut = await cutRelease(app, alice)
    const staging = await ship(app, 'staging', 'refs/tags/0.1.1')
    await promoteAndApprove(tenantId, app, cut.id, alice, bob)
    const rebuilt = uploadBody(appToml(app, 'production'), '0.1.1')
    rebuilt.assets['/index.html'] = Buffer.from('<!doctype html><title>rebuilt</title>').toString(
      'base64'
    )
    const prod = await ship(app, 'production', 'refs/tags/0.1.1', { ...rebuilt, source: 'build' })
    expect(prod.uploaded.status).toBe(200)
    const stagingDigest = (await ticket(staging.ticketId)).artifactDigest
    const prodTicket = await ticket(prod.ticketId)
    expect(prodTicket.status).not.toBe('failed')
    expect(prodTicket.artifactDigest).not.toBe(stagingDigest)
    expect(await uploadedAudit(prod.ticketId)).toMatchObject({
      digest: prodTicket.artifactDigest,
      stagingDigest,
      source: 'build',
      digestMismatch: true,
    })
    const view = await releaseView(app, cut.id, bob)
    expect(view.artifact).toMatchObject({ matches: false, stagingDigest })
    const [row] = await db.select().from(appReleases).where(eq(appReleases.id, cut.id))
    expect(row?.status).toBe('production_active')
  })

  it('a production upload that says it is the bundle but differs is refused (409)', async () => {
    const { tenantId, alice, bob, app } = await fixture()
    const cut = await cutRelease(app, alice)
    await ship(app, 'staging', 'refs/tags/0.1.1')
    await promoteAndApprove(tenantId, app, cut.id, alice, bob)
    const tampered = uploadBody(appToml(app, 'production'), '0.1.1')
    tampered.modules['worker.js'] = Buffer.from('export default {}').toString('base64')
    const prod = await ship(app, 'production', 'refs/tags/0.1.1', {
      ...tampered,
      source: 'bundle',
    })
    expect(prod.uploaded.status).toBe(409)
    expect(await prod.uploaded.json()).toMatchObject({ code: 'deploy_digest_mismatch' })
    expect((await ticket(prod.ticketId)).status).toBe('failed')
  })

  it('a claimed digest that is not Launch’s is 400; a matching one is accepted', async () => {
    const { alice, app } = await fixture()
    await cutRelease(app, alice)
    const body = uploadBody(appToml(app, 'staging'), '0.1.1')
    const wrong = await ship(app, 'staging', 'refs/tags/0.1.1', { ...body, digest: 'f'.repeat(64) })
    expect(wrong.uploaded.status).toBe(400)
    expect(await wrong.uploaded.json()).toMatchObject({ code: 'deploy_digest_invalid' })
    const right = await ship(app, 'staging', 'refs/tags/0.1.1', {
      ...body,
      digest: await deployArtifactDigest(body),
    })
    expect(right.uploaded.status).toBe(200)
  })
})
