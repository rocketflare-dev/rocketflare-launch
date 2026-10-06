/**
 * Issue #19's queue half: a `github.event` job, through the real consumer, mapped to the subjects
 * waiting on it and each woken — a landing's Workflow gets `SESSION_WAKE_EVENT`, a followed
 * release's tag-run throttle is cleared. Every delivery goes in through the real route
 * (`postWebhook` → `drainJobs`), so these also prove route → queue → handler end to end.
 *
 * What it proves: each kind of event finds the landing it is about (the gate SHA, the PR, the
 * merge commit, the default branch while `releasing`, the release tag) and nothing else; an event
 * with no subject is a no-op; an app with no repository id recorded is still found by
 * `owner/name`; and TENANT ISOLATION — a delivery for app A's repo never wakes a session in tenant
 * B, even when it carries B's SHA, PR number or tag.
 */
import {
  type SessionLanding,
  type ShipLandingStage,
  sessionLandingSchema,
} from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { resolveGitHubSubjects } from '@/api/services/sessions/github-events'
import { appReleases, apps, type SessionRow, sessions } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import {
  checkRunCompleted,
  drainJobs,
  postWebhook,
  pullRequestEvent,
  pushEvent,
  releaseEvent,
  uniqueRepoId,
  WEBHOOK_SECRET,
  type WebhookRepo,
  workflowRunCompleted,
} from '../helpers/github-webhooks'
import { seedApp, uniqueSlug } from '../helpers/launch-apps'
import { insertSession } from '../helpers/sessions'
import { createTestEnv, type RecordingWorkflow, stubs, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const sha = (c: string) => c.repeat(40)

interface Tenancy {
  env: TestEnv
  workflow: RecordingWorkflow
  repo: WebhookRepo
  tenantId: string
  appId: string
  user: { id: string; email: string }
  app: Awaited<ReturnType<typeof seedApp>>['app']
  tenant: { id: string; name: string; slug: string }
}

/** A tenant with one app on its own repository (`github_repo_id` recorded unless `noRepoId`). */
async function tenancy(env: TestEnv, opts: { noRepoId?: boolean } = {}): Promise<Tenancy> {
  const { tenant, user } = await createTestTenantWithUser(db)
  const slug = uniqueSlug('hook')
  const repo: WebhookRepo = { id: uniqueRepoId(), owner: 'acme-hooks', name: slug }
  const { app } = await seedApp(db, tenant.id, { slug })
  const [updated] = await db
    .update(apps)
    .set({
      repoOwner: repo.owner,
      repoName: repo.name,
      defaultBranch: 'main',
      githubRepoId: opts.noRepoId ? null : String(repo.id),
    })
    .where(and(eq(apps.tenantId, tenant.id), eq(apps.id, app.id)))
    .returning()
  return {
    env,
    workflow: stubs(env).sessionWorkflow as RecordingWorkflow,
    repo,
    tenantId: tenant.id,
    appId: app.id,
    user,
    app: updated ?? app,
    tenant: tenant as Tenancy['tenant'],
  }
}

/** A session of `t`'s app mid-landing, its instance "waiting" (so a wake can reach it). */
async function landingSession(
  t: Tenancy,
  stage: ShipLandingStage,
  landing: Partial<SessionLanding> = {}
): Promise<SessionRow> {
  const prNumber = landing.prNumber ?? 7
  const now = new Date().toISOString()
  const row = await insertSession(db, t, {
    status: stage === 'ci' || stage === 'approval' || stage === 'merging' ? 'shipping' : 'shipped',
    prNumber,
    landing: sessionLandingSchema.parse({
      mode: 'staging',
      stage,
      prNumber,
      gateSha: sha('1'),
      startedAt: now,
      stageAt: now,
      reviewMode: 'none',
      ...landing,
    }),
  })
  t.workflow.setStatus(row.id, { status: 'waiting' })
  return row
}

const wokenIds = (t: Tenancy) =>
  t.workflow.events.filter(e => e.type === 'session_wake').map(e => e.instanceId)

async function deliver(t: Tenancy, event: string, body: unknown) {
  const res = await postWebhook(t.env, event, body)
  expect(res.status, await res.clone().text()).toBe(202)
  const drained = await drainJobs(t.env, db)
  expect(drained).toEqual({ acked: 1, retried: 0 })
}

function newEnv() {
  return createTestEnv({ GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET })
}

describe('github.event: a delivery wakes the landing it is about', () => {
  it('check_run completed on the gate SHA wakes the session landing in ci', async () => {
    const t = await tenancy(newEnv())
    const ci = await landingSession(t, 'ci', { gateSha: sha('a') })
    const other = await landingSession(t, 'ci', { gateSha: sha('b'), prNumber: 8 })
    await deliver(t, 'check_run', checkRunCompleted(t.repo, { sha: sha('a') }))
    expect(wokenIds(t)).toEqual([ci.id])
    expect(wokenIds(t)).not.toContain(other.id)
  })

  it('a PR event finds the landing by its PR number (a person merged or closed it)', async () => {
    const t = await tenancy(newEnv())
    const row = await landingSession(t, 'approval', { prNumber: 41 })
    await deliver(
      t,
      'pull_request',
      pullRequestEvent(t.repo, { number: 41, action: 'closed', sha: sha('f'), merged: true })
    )
    expect(wokenIds(t)).toEqual([row.id])
  })

  it('wakes the instance the row names after a restart (`<id>-rN`)', async () => {
    const t = await tenancy(newEnv())
    const row = await landingSession(t, 'ci', { gateSha: sha('c') })
    await db
      .update(sessions)
      .set({ instanceId: `${row.id}-r1` })
      .where(eq(sessions.id, row.id))
    t.workflow.setStatus(`${row.id}-r1`, { status: 'waiting' })
    await deliver(
      t,
      'workflow_run',
      workflowRunCompleted(t.repo, { sha: sha('c'), branch: 'session/x' })
    )
    expect(wokenIds(t)).toEqual([`${row.id}-r1`])
  })

  it('Phase B: the merge commit’s Gate, and while releasing any news on the default branch', async () => {
    const t = await tenancy(newEnv())
    const releasing = await landingSession(t, 'releasing', { mergeSha: sha('d') })
    await deliver(t, 'check_run', checkRunCompleted(t.repo, { sha: sha('d'), branch: 'main' }))
    expect(wokenIds(t)).toEqual([releasing.id])
    // Issue #21: a newer head on main (another merge) — its Gate is what the release waits for.
    await deliver(t, 'push', pushEvent(t.repo, { ref: 'refs/heads/main', after: sha('e') }))
    expect(wokenIds(t)).toEqual([releasing.id, releasing.id])
    // A branch that is not the default one is nobody's business.
    await deliver(t, 'push', pushEvent(t.repo, { ref: 'refs/heads/feature', after: sha('9') }))
    expect(wokenIds(t)).toHaveLength(2)
  })

  it('Phase B deploying: the release tag’s deploy run wakes the landing and clears the tag-run throttle', async () => {
    const t = await tenancy(newEnv())
    const [release] = await db
      .insert(appReleases)
      .values({
        tenantId: t.tenantId,
        appId: t.appId,
        version: '1.4.1',
        tag: '1.4.1',
        sha: sha('7'),
        status: 'tagged',
        tagRunPolledAt: new Date(),
      })
      .returning()
    if (!release) throw new Error('no release')
    const deploying = await landingSession(t, 'deploying', {
      mergeSha: sha('d'),
      releaseId: release.id,
      tag: '1.4.1',
      version: '1.4.1',
    })
    await deliver(
      t,
      'workflow_run',
      workflowRunCompleted(t.repo, { sha: sha('7'), branch: '1.4.1', conclusion: 'failure' })
    )
    expect(wokenIds(t)).toEqual([deploying.id])
    const [after] = await db.select().from(appReleases).where(eq(appReleases.id, release.id))
    expect(after?.tagRunPolledAt).toBeNull()
    // The release itself (published by the deploy) names the tag too.
    await deliver(t, 'release', releaseEvent(t.repo, { tag: '1.4.1' }))
    expect(wokenIds(t)).toEqual([deploying.id, deploying.id])
  })

  it('an event nothing waits on is a no-op; a landing that is not moving is never woken', async () => {
    const t = await tenancy(newEnv())
    const live = await landingSession(t, 'live', { gateSha: sha('a') })
    await deliver(t, 'check_run', checkRunCompleted(t.repo, { sha: sha('a') }))
    await deliver(t, 'check_run', checkRunCompleted(t.repo, { sha: sha('0') }))
    expect(wokenIds(t)).toEqual([])
    expect(wokenIds(t)).not.toContain(live.id)
  })

  it('an unknown repository is a no-op, acked', async () => {
    const t = await tenancy(newEnv())
    await landingSession(t, 'ci', { gateSha: sha('a') })
    await deliver(
      t,
      'check_run',
      checkRunCompleted({ id: uniqueRepoId(), owner: 'elsewhere', name: 'nope' }, { sha: sha('a') })
    )
    expect(wokenIds(t)).toEqual([])
  })

  it('an app with no repository id recorded (an old import) is found by owner/name', async () => {
    const t = await tenancy(newEnv(), { noRepoId: true })
    const row = await landingSession(t, 'ci', { gateSha: sha('a') })
    await deliver(
      t,
      'check_run',
      checkRunCompleted({ ...t.repo, owner: t.repo.owner.toUpperCase() }, { sha: sha('a') })
    )
    expect(wokenIds(t)).toEqual([row.id])
  })
})

describe('github.event: tenant isolation', () => {
  it('a webhook for app A never wakes a session in tenant B — even with B’s SHA, PR and tag', async () => {
    const env = newEnv()
    const a = await tenancy(env)
    const b = await tenancy(env)
    const [releaseB] = await db
      .insert(appReleases)
      .values({
        tenantId: b.tenantId,
        appId: b.appId,
        version: '2.0.0',
        tag: '2.0.0',
        sha: sha('8'),
        status: 'tagged',
      })
      .returning()
    const sessionA = await landingSession(a, 'ci', { gateSha: sha('5'), prNumber: 3 })
    const sessionB = await landingSession(b, 'ci', { gateSha: sha('5'), prNumber: 3 })
    const deployingB = await landingSession(b, 'deploying', {
      prNumber: 4,
      releaseId: releaseB?.id ?? null,
      tag: '2.0.0',
      mergeSha: sha('6'),
    })

    // A's repo, carrying exactly B's gate SHA and PR number: only A's session wakes.
    await deliver(a, 'check_run', checkRunCompleted(a.repo, { sha: sha('5'), prs: [3] }))
    expect(wokenIds(a)).toEqual([sessionA.id])

    // A's repo naming B's release tag, merge SHA and release commit: nothing in B moves.
    await deliver(
      a,
      'workflow_run',
      workflowRunCompleted(a.repo, { sha: sha('8'), branch: '2.0.0' })
    )
    await deliver(a, 'push', pushEvent(a.repo, { ref: 'refs/tags/2.0.0', after: sha('6') }))
    await deliver(a, 'release', releaseEvent(a.repo, { tag: '2.0.0' }))
    expect(wokenIds(a)).toEqual([sessionA.id])
    expect(wokenIds(a)).not.toContain(sessionB.id)
    expect(wokenIds(a)).not.toContain(deployingB.id)

    // The same delivery on B's repo wakes B's — and only B's.
    await deliver(b, 'check_run', checkRunCompleted(b.repo, { sha: sha('5'), prs: [3] }))
    expect(wokenIds(b).slice(1)).toEqual([sessionB.id])
  })

  it('every subject carries the tenant of the app its repository resolved to', async () => {
    const env = newEnv()
    const a = await tenancy(env)
    const b = await tenancy(env)
    await landingSession(a, 'ci', { gateSha: sha('4') })
    await landingSession(b, 'ci', { gateSha: sha('4') })
    const subjects = await resolveGitHubSubjects(db, {
      deliveryId: 'd',
      event: 'check_run',
      action: 'completed',
      installationId: null,
      repository: { id: String(a.repo.id), owner: a.repo.owner, name: a.repo.name },
      headSha: sha('4'),
      ref: null,
      refKind: null,
      prNumbers: [],
    })
    expect(subjects).toHaveLength(1)
    expect(subjects.every(s => s.tenantId === a.tenantId && s.appId === a.appId)).toBe(true)
  })
})
