// @vitest-isolate
// Replaces the global fetch with a FakeCloud and mocks the platform credential store.
/**
 * `/ci/scaffold/token` and `/ci/scaffold/done` (Launch P2, slice 2b) through the real app, with a
 * FakeCloud as GitHub (the Actions JWKS, the app's installation tokens) and GitHub Actions OIDC
 * tokens minted for the scaffold job. `launch_settings` and the `github_app` credential are
 * platform-global rows other suites write and delete concurrently, so they live in memory here;
 * the app, its environments and the tickets are real rows.
 */
import { generateKeyPairSync } from 'node:crypto'
import { SCAFFOLD_FINISHED_EVENT } from '@launch/shared/launch-pipeline'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { commitFiles, createOrgRepo } from '@/api/services/launch/github-app'
import { scaffoldFiles } from '@/api/services/launch/rocketflare/scaffold-job'
import { GitHubActionsScaffoldRunner } from '@/api/services/launch/scaffold/github-actions-runner'
import { ScaffoldNotReadyError } from '@/api/services/launch/scaffold/runner'
import { apps, auditEvents, deployTickets } from '@/db/schema'
import { createTestTenant } from '../helpers/auth'
import { storeCredential } from '../helpers/credential-store'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { actionsClaims, mintActionsToken } from '../helpers/github-oidc'
import { seedApp, uniqueSlug } from '../helpers/launch-apps'
import { json, request } from '../helpers/request'
import { createTestEnv, stubs } from '../mocks/bindings'

const cloud = createFakeCloud()
const APPS_DOMAIN = 'clewro.com'
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

/** The platform credentials, in memory (`credential-store.ts`): no global table is written. */
const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

const db = setupTestDatabase()
let restoreFetch: () => void

beforeAll(() => {
  // GitHub (and its JWKS) through the FakeCloud; the local database proxy (neon driver) as is.
  restoreFetch = cloud.install()
  store.settings.set('apps_domain', APPS_DOMAIN)
  store.settings.set('github_org', cloud.opts.org)
  storeCredential(
    store,
    'github_app',
    { appId: String(cloud.opts.appId), privateKey },
    { installationId: cloud.opts.installationId }
  )
})
afterAll(() => restoreFetch())

let env: ReturnType<typeof createTestEnv>
beforeEach(() => {
  env = createTestEnv()
})

/** The recording `APP_LAUNCH_WORKFLOW` of this test's env. */
function launchWorkflow() {
  const workflow = stubs(env).launchWorkflow
  if (!workflow) throw new Error('createTestEnv() has no APP_LAUNCH_WORKFLOW')
  return workflow
}

/** A created app: a real repo in the FakeGitHub org, registered by its GitHub id. */
async function createdApp() {
  const tenant = await createTestTenant(db)
  const slug = uniqueSlug('shop')
  const { app, environments } = await seedApp(db, tenant.id, { slug, status: 'provisioning' })
  const repo = await createOrgRepo(
    cloud.github.issueToken().token,
    cloud.opts.org,
    { name: slug },
    { fetch: cloud.fetch }
  )
  await db
    .update(apps)
    .set({
      repoOwner: cloud.opts.org,
      repoName: slug,
      githubRepoId: String(repo.id),
      defaultBranch: 'main',
      source: 'created',
    })
    .where(eq(apps.id, app.id))
  const launchRunId = crypto.randomUUID()
  launchWorkflow().setStatus(launchRunId, { status: 'waiting' })
  // As the pipeline's `scaffold.start` opens it (slice 2c): approved, unclaimed, on production.
  const production = environments.find(e => e.name === 'production')
  if (!production) throw new Error('seedApp gave no production environment')
  const [ticket] = await db
    .insert(deployTickets)
    .values({
      tenantId: tenant.id,
      appId: app.id,
      environmentId: production.id,
      purpose: 'scaffold',
      status: 'approved',
      repositoryId: String(repo.id),
      repository: `${cloud.opts.org}/${slug}`,
      decisionSource: 'auto',
      decidedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      launchRunId,
    })
    .returning()
  if (!ticket) throw new Error('deploy_tickets insert returned no row')
  return {
    tenant,
    app,
    environments,
    slug,
    repository: `${cloud.opts.org}/${slug}`,
    repositoryId: String(repo.id),
    launchRunId,
    ticket,
  }
}

type Created = Awaited<ReturnType<typeof createdApp>>

/** The scaffold job's OIDC token (no environment, `launch-scaffold.yml` on `main`). */
function jobToken(
  created: Pick<Created, 'repository' | 'repositoryId'>,
  over: Partial<Parameters<typeof actionsClaims>[0]> = {}
) {
  return mintActionsToken(
    actionsClaims({
      repository: created.repository,
      repositoryId: created.repositoryId,
      workflowFile: 'launch-scaffold.yml',
      runId: '5550001',
      ...over,
    })
  )
}

function call(path: 'token' | 'done', token: string | null, body: unknown = {}) {
  return request(
    `/ci/scaffold/${path}`,
    { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} },
    { env, json: body }
  )
}

async function ticketRow(id: string) {
  const [row] = await db.select().from(deployTickets).where(eq(deployTickets.id, id))
  return row
}

describe('POST /ci/scaffold/token', () => {
  it('returns a one-hour token scoped to the ONE repo, and the plan, once', async () => {
    const created = await createdApp()
    const res = await call('token', await jobToken(created))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await json<{
      ticketId: string
      token: string
      expiresAt: string
      plan: Record<string, string>
    }>(res)
    expect(body.ticketId).toBe(created.ticket.id)
    expect(body.plan).toEqual({
      slug: created.slug,
      displayName: created.app.displayName,
      domain: APPS_DOMAIN,
      repo: created.repository,
      kitRepo: 'rocketflare-dev/rocketflare',
      tag: '0.15.0',
      commit: 'c7fd5dfbf9cfbc197c60f1993f18d524ec28bd66',
    })

    // The token GitHub minted is narrowed to this repository and contents + workflows write.
    const minted = cloud.github.tokens.get(body.token)
    expect(minted).toMatchObject({
      repositories: [created.slug],
      permissions: { contents: 'write', workflows: 'write' },
      revoked: false,
    })

    // The ticket is bound to the run that asked.
    expect(await ticketRow(created.ticket.id)).toMatchObject({
      status: 'approved',
      runId: '5550001',
      runAttempt: 1,
      repository: created.repository,
      repositoryId: created.repositoryId,
    })
    expect((await ticketRow(created.ticket.id))?.credentialsIssuedAt).toBeInstanceOf(Date)

    // Audited in the app's tenant, and never with the token.
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.appId, created.app.id),
          eq(auditEvents.action, 'app.scaffold.token_issued')
        )
      )
    expect(audit).toMatchObject({ tenantId: created.tenant.id, actorType: 'app' })
    expect(JSON.stringify(audit?.summary)).not.toContain(body.token)

    // A second call — from this run or any other — gets nothing.
    for (const runId of ['5550001', '5550002']) {
      const again = await call('token', await jobToken(created, { runId }))
      expect(again.status).toBe(409)
      expect(await json(again)).toMatchObject({
        statusCode: 409,
        code: 'scaffold_token_unavailable',
      })
    }
  })

  it('refuses another workflow file, another repository, a branch and a missing token', async () => {
    const created = await createdApp()
    const refused = [
      await jobToken(created, { workflowFile: 'ci.yml' }),
      await jobToken(created, { ref: 'refs/heads/feature' }),
      await jobToken({ repository: created.repository, repositoryId: '99999999' }),
      await jobToken({ repository: 'acme/other', repositoryId: created.repositoryId }),
    ]
    for (const token of refused) {
      const res = await call('token', token)
      expect(res.status).toBe(403)
      expect(await json(res)).toMatchObject({ code: 'ci_caller_refused' })
    }
    expect((await call('token', null)).status).toBe(401)
    const forged = await mintActionsToken(
      actionsClaims({
        repository: created.repository,
        repositoryId: created.repositoryId,
        workflowFile: 'launch-scaffold.yml',
      }),
      { forged: true }
    )
    expect((await call('token', forged)).status).toBe(401)
    // None of that claimed the ticket.
    expect((await ticketRow(created.ticket.id))?.runId).toBeNull()
  })

  it('answers 409 when no scaffold is waiting', async () => {
    const created = await createdApp()
    await db
      .update(deployTickets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deployTickets.id, created.ticket.id))
    expect((await call('token', await jobToken(created))).status).toBe(409)
  })

  it('fails the ticket when GitHub will not mint the token', async () => {
    const created = await createdApp()
    cloud.failNext('/access_tokens', 500)
    const res = await call('token', await jobToken(created))
    expect(res.status).toBe(502)
    expect(await ticketRow(created.ticket.id)).toMatchObject({ status: 'failed' })
  })
})

describe('POST /ci/scaffold/done', () => {
  const COMMIT = 'a'.repeat(40)

  it('finishes the ticket and wakes the launch run with scaffold_finished', async () => {
    const created = await createdApp()
    expect((await call('token', await jobToken(created))).status).toBe(200)

    const res = await call('done', await jobToken(created), { commit: COMMIT })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      ticketId: created.ticket.id,
      status: 'finished',
      notified: true,
    })
    expect(await ticketRow(created.ticket.id)).toMatchObject({
      status: 'finished',
      sha: COMMIT,
    })
    expect(launchWorkflow().events).toEqual([
      {
        instanceId: created.launchRunId,
        type: SCAFFOLD_FINISHED_EVENT,
        payload: { ticketId: created.ticket.id },
      },
    ])

    // A retried `done` for the same commit is the same answer (and one audit row).
    expect((await call('done', await jobToken(created), { commit: COMMIT })).status).toBe(200)
    const finished = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.appId, created.app.id), eq(auditEvents.action, 'app.scaffold.finished'))
      )
    expect(finished).toHaveLength(1)
    expect(finished[0]?.summary).toMatchObject({ after: { commit: COMMIT } })

    // A different commit is not.
    const other = await call('done', await jobToken(created), { commit: 'b'.repeat(40) })
    expect(other.status).toBe(409)
  })

  it('after a retry, wakes the instance that is waiting (<runId>-rN), not the failed one', async () => {
    const created = await createdApp()
    const retried = `${created.launchRunId}-r1`
    launchWorkflow().setStatus(retried, { status: 'waiting' })
    await db
      .update(apps)
      .set({ launchRunId: created.launchRunId, launchInstanceId: retried })
      .where(eq(apps.id, created.app.id))
    expect((await call('token', await jobToken(created))).status).toBe(200)
    expect((await call('done', await jobToken(created), { commit: COMMIT })).status).toBe(200)
    expect(launchWorkflow().events.map(e => e.instanceId)).toEqual([retried])
  })

  it('refuses a run that holds no ticket, and a malformed commit', async () => {
    const created = await createdApp()
    const res = await call('done', await jobToken(created), { commit: COMMIT })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'scaffold_ticket_not_open' })

    const bad = await call('done', await jobToken(created), { commit: 'main' })
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ statusCode: 400, code: 'validation_failed' })
    expect(launchWorkflow().events).toEqual([])
  })

  it('keeps the ticket finished when the launch run cannot be told (the row is the truth)', async () => {
    const created = await createdApp()
    expect((await call('token', await jobToken(created))).status).toBe(200)
    launchWorkflow().notFoundOnSendEvent = true
    const res = await call('done', await jobToken(created), { commit: COMMIT })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ status: 'finished', notified: false })
    expect(await ticketRow(created.ticket.id)).toMatchObject({ status: 'finished' })
  })

  it('cannot finish another app’s ticket', async () => {
    const mine = await createdApp()
    const theirs = await createdApp()
    expect((await call('token', await jobToken(theirs))).status).toBe(200)
    // Same run id, but my repository's token: my app has no ticket bound to that run.
    const res = await call('done', await jobToken(mine), { commit: COMMIT })
    expect(res.status).toBe(409)
    expect(await ticketRow(theirs.ticket.id)).toMatchObject({ status: 'approved' })
  })
})

describe('GitHubActionsScaffoldRunner', () => {
  it('dispatches launch-scaffold.yml with Launch’s URL, then polls the run to its conclusion', async () => {
    const created = await createdApp()
    const token = cloud.github.issueToken().token
    const ctx = {
      token,
      owner: cloud.opts.org,
      repo: created.slug,
      ticketId: created.ticket.id,
      fetch: cloud.fetch,
    }
    // As the pipeline's ports wire it: Launch's URL on the runner, the context as 2c builds it.
    const runner = new GitHubActionsScaffoldRunner({ launchUrl: 'https://launch.clewro.com/' })
    await expect(new GitHubActionsScaffoldRunner().start(ctx, plan(created))).rejects.toThrow(
      /APP_URL/
    )

    // Before the repo step committed the workflow, GitHub does not know it: retry later.
    await expect(runner.start(ctx, plan(created))).rejects.toBeInstanceOf(ScaffoldNotReadyError)

    await commitFiles(
      token,
      cloud.opts.org,
      created.slug,
      'main',
      scaffoldFiles(),
      'Scaffold job',
      {
        fetch: cloud.fetch,
      }
    )
    const ids = await runner.start(ctx, plan(created))
    const run = cloud.github.runs.at(-1)
    expect(run).toMatchObject({
      workflow: 'launch-scaffold.yml',
      ref: 'main',
      inputs: { launch_url: 'https://launch.clewro.com' },
    })
    expect(ids).toMatchObject({
      workflow: 'launch-scaffold.yml',
      runId: String(run?.id),
    })
    // Every answer carries the run and its page, for the wait's row.
    const seen = {
      runId: String(run?.id),
      url: `https://github.com/${cloud.opts.org}/${created.slug}/actions/runs/${run?.id}`,
    }
    expect(await runner.poll(ctx, ids)).toEqual({ status: 'running', ...seen })
    if (run) Object.assign(run, { status: 'completed', conclusion: 'success' })
    expect(await runner.poll(ctx, ids)).toEqual({ status: 'succeeded', ...seen })
    if (run) run.conclusion = 'failure'
    expect(await runner.poll(ctx, ids)).toMatchObject({
      status: 'failed',
      detail: 'the GitHub Actions run ended “failure”',
      ...seen,
    })
  })

  it('a dispatch GitHub never lists a run for is running, then failed once the window passes', async () => {
    const created = await createdApp()
    const runner = new GitHubActionsScaffoldRunner({ launchUrl: 'https://launch.clewro.com' })
    const dispatchedAt = new Date('2026-09-28T10:00:00Z')
    const ctx = {
      token: cloud.github.issueToken().token,
      owner: cloud.opts.org,
      repo: created.slug,
      fetch: cloud.fetch,
    }
    const ids = { workflow: 'launch-scaffold.yml', dispatchedAt: dispatchedAt.toISOString() }
    const at = (minutes: number) => () => new Date(dispatchedAt.getTime() + minutes * 60_000)
    expect(await runner.poll({ ...ctx, now: at(9) }, ids)).toEqual({ status: 'running' })
    expect(await runner.poll({ ...ctx, now: at(11) }, ids)).toEqual({
      status: 'failed',
      detail:
        'GitHub has not started a run of launch-scaffold.yml 11 minutes after it was dispatched',
    })
  })

  function plan(created: Created) {
    return {
      slug: created.slug,
      displayName: 'Shop',
      domain: APPS_DOMAIN,
      repo: created.repository,
      kitRepo: 'rocketflare-dev/rocketflare',
      tag: '0.15.0',
      commit: 'c7fd5dfbf9cfbc197c60f1993f18d524ec28bd66',
    }
  }
})
