// @vitest-isolate
// Installs the FakeCloud as the GLOBAL fetch (the Workflow's vendor clients use the default), so this file needs its own module registry.
/**
 * `AppLaunchWorkflow` (Launch P2, slice 2c) driven end to end under Node: `createApp` writes the
 * rows, then the class runs with `createFakeWorkflowStep` and the FakeCloud as every vendor. The
 * adapter ports are slice 2b's stand-ins (`tests/helpers/launch-pipeline.ts`); `onWait` plays the
 * scaffold job (commits the renamed kit, finishes the ticket) and the staging deploy (an `active`
 * ticket, a live version).
 *
 * What it proves: every step runs once, in order, under a DISTINCT name; every id lands on its row
 * and in `app_environments`; no secret reaches `app_operations`, `audit_events` or a step result;
 * a Neon 423 burst is ridden out; a failure at R2 then a retry creates the Neon project and the KV
 * namespaces exactly once; an email failure does not block the launch; a failed scaffold job ends
 * the wait at once.
 */
import {
  APP_LAUNCH_STEPS,
  DEPLOY_FINISHED_EVENT,
  SCAFFOLD_FINISHED_EVENT,
} from '@launch/shared/launch-pipeline'
import { DEFAULT_TEMPLATE_PIN } from '@launch/shared/launch-setup'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SYSTEM_ACTOR } from '@/api/services/launch/audit'
import { retryPipeline } from '@/api/services/launch/pipeline/retry'
import { pipelineView } from '@/api/services/launch/pipeline/runs'
import {
  type AppRow,
  appEnvironments,
  appOperations,
  apps,
  auditEvents,
  deployTickets,
  notifications,
  oidcClients,
} from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import { forgetApps } from '../helpers/launch-apps'
import {
  finishScaffoldTicket,
  type Launch,
  LaunchHarness,
  pushScaffold,
} from '../helpers/launch-pipeline'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()
const tenantIds: string[] = []
afterAll(() => forgetApps(db, tenantIds))

let cloud: FakeCloud
let restore: () => void
let h: LaunchHarness
beforeEach(() => {
  cloud = createFakeCloud()
  restore = cloud.install()
  h = new LaunchHarness(db, cloud, tenantIds)
})
afterEach(() => restore())

async function rows(launch: Launch) {
  const list = await db
    .select()
    .from(appOperations)
    .where(
      and(eq(appOperations.tenantId, launch.tenantId), eq(appOperations.runId, launch.params.runId))
    )
  return Object.fromEntries(list.map(r => [r.step, r]))
}

async function appRow(launch: Launch) {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.tenantId, launch.tenantId), eq(apps.id, launch.params.appId)))
  return row
}

async function envRows(launch: Launch) {
  const list = await db
    .select()
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, launch.tenantId),
        eq(appEnvironments.appId, launch.params.appId)
      )
    )
  return Object.fromEntries(list.map(e => [e.name, e])) as Record<
    'staging' | 'production',
    (typeof list)[number]
  >
}

/** Every secret value the FakeCloud minted or received — none may appear anywhere Launch keeps. */
function secretsIn(c: FakeCloud): string[] {
  const out: string[] = []
  for (const script of c.cloudflare.scripts.values()) {
    // `BOOTSTRAP_ADMIN_EMAILS` is a Worker secret by transport only: an email is not a credential.
    for (const [name, value] of script.secrets)
      if (name !== 'BOOTSTRAP_ADMIN_EMAILS') out.push(value)
  }
  for (const project of c.neon.projects.values()) {
    for (const branch of project.branches.values()) {
      for (const role of branch.roles.values()) out.push(role.password)
    }
  }
  for (const key of c.resend.apiKeys.values()) out.push(key.token)
  out.push(...c.github.tokens.keys())
  return out.filter(s => s.length >= 8)
}

describe('AppLaunchWorkflow — a whole launch against the FakeCloud', () => {
  it('runs every step once, in order, under distinct names, and goes live', async () => {
    const launch = await h.request()
    const { outcome, fake, results } = await h.run(launch)
    expect(outcome).toEqual({ runId: launch.params.runId, status: 'live' })

    // Distinct names — the platform replays a repeated one's result.
    expect(new Set(fake.names).size).toBe(fake.names.length)
    const doNames = fake.calls.map(c => c.name)
    const firsts = [
      'reserve',
      'repo',
      'scaffold.start',
      'scaffold.poll#0',
      'scaffold.poll#1',
      'scaffold.wait',
      'scaffold.verify',
      'neon',
      'cloudflare',
      'oidc_client',
      'write_config',
      'placeholders',
      'github_env',
      'worker_secrets',
      'email',
      'deploy_staging.start',
      'deploy_staging.poll#0',
      'deploy_staging.poll#1',
      'deploy_staging.wait',
      'deploy_staging.check',
      'health#0',
      'health',
      'production',
      'live',
    ]
    expect(doNames).toEqual(firsts)
    expect(fake.waits.map(w => w.name)).toEqual(['scaffold.wait#0', 'deploy_staging.wait#0'])
    expect(fake.calls.find(c => c.name === 'neon')?.config).toMatchObject({
      retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
      timeout: '5 minutes',
    })

    // One row per APP_LAUNCH_STEPS entry, each settled.
    const byStep = await rows(launch)
    expect(Object.keys(byStep).sort()).toEqual(APP_LAUNCH_STEPS.map(s => s.step).sort())
    for (const def of APP_LAUNCH_STEPS) {
      const expected = def.step === 'production' ? 'skipped' : 'succeeded'
      expect([def.step, byStep[def.step]?.status]).toEqual([def.step, expected])
    }
    expect(byStep.neon?.attempt).toBe(1)

    const view = await pipelineView(db, launch.tenantId, (await appRow(launch)) as AppRow, 'create')
    expect(view.status).toBe('succeeded')

    // The app and its environments carry what was created, by id.
    const app = await appRow(launch)
    expect(app).toMatchObject({
      status: 'live',
      repoOwner: cloud.opts.org,
      repoName: launch.slug,
      defaultBranch: 'main',
      templateRef: DEFAULT_TEMPLATE_PIN.tag,
      templateVersion: DEFAULT_TEMPLATE_PIN.tag,
      templateContractVersion: '1',
    })
    const repo = cloud.github.repo(cloud.opts.org, launch.slug)
    expect(app?.githubRepoId).toBe(String(repo?.id))
    expect(byStep.repo?.externalIds).toMatchObject({ repoId: String(repo?.id) })

    const envs = await envRows(launch)
    const kvStaging = [...cloud.cloudflare.kv.values()].find(
      k => k.title === `${launch.slug}-rate-limit-staging`
    )
    expect(envs.staging.url).toBe(`https://${launch.slug}-staging.${cloud.opts.domain}`)
    expect(envs.staging.resources.kv).toEqual([
      { binding: 'RATE_LIMIT_KV', id: kvStaging?.id, title: kvStaging?.title },
    ])
    const queue = [...cloud.cloudflare.queues.values()].find(
      q => q.queue_name === `${launch.slug}-jobs-staging`
    )
    expect(envs.staging.resources.queues).toEqual([
      { binding: 'JOBS_QUEUE', queue: `${launch.slug}-jobs-staging`, id: queue?.queue_id },
    ])
    expect(envs.staging.resources.r2).toEqual([
      { binding: 'FILES', bucketName: `${launch.slug}-files-staging` },
    ])
    expect(envs.staging.resources.doMigrationTag).toBe('v1')
    expect(envs.staging.resources.queueConsumers).toEqual([
      {
        queue: `${launch.slug}-jobs-staging`,
        queueId: queue?.queue_id,
        consumerId: [...(queue?.consumers.keys() ?? [])][0],
        scriptName: `${launch.slug}-staging`,
      },
    ])
    const route = [...cloud.cloudflare.routes.values()].find(
      r => r.pattern === `${launch.slug}-staging.${cloud.opts.domain}/*`
    )
    expect(route?.script).toBe(`${launch.slug}-staging`)
    expect(envs.staging.routeIds).toEqual([route?.id])
    expect(envs.production.neon).toMatchObject({ roleName: 'app', migratorRole: 'migrator' })
    expect(envs.staging.neon?.branchId).not.toBe(envs.production.neon?.branchId)
    expect(envs.staging.resendKeyId).toBeTruthy()
    expect(envs.staging.encryptionKeySealed).toBeTruthy()

    // Cloudflare: placeholders with the DO migration, workers.dev off, workflows, consumers.
    const staging = cloud.cloudflare.scripts.get(`${launch.slug}-staging`)
    expect(staging?.migrationTag).toBe('v1')
    expect(staging?.workersDev).toBe(false)
    expect(cloud.cloudflare.workflows.get(`${launch.slug}-agent-run-staging`)).toMatchObject({
      class_name: 'AgentRunWorkflow',
      script_name: `${launch.slug}-staging`,
    })
    // Secrets were put BY NAME, once per environment (and RESEND_API_KEY by the email step).
    expect([...(staging?.secretPuts ?? [])].sort()).toEqual(
      [
        'BOOTSTRAP_ADMIN_EMAILS',
        'DATABASE_URL',
        'OAUTH_ENCRYPTION_KEY',
        'OIDC_CLIENT_SECRET',
        'RESEND_API_KEY',
      ].sort()
    )
    expect(staging?.secrets.get('BOOTSTRAP_ADMIN_EMAILS')).toBe(launch.userEmail)
    expect(staging?.secrets.get('DATABASE_URL')).toMatch(/^postgresql:\/\/app:.*-pooler\./)

    // Neon: one project, migrator owns app, the grant, staging's passwords reset.
    const projects = [...cloud.neon.projects.values()].filter(p => p.name === launch.slug)
    expect(projects).toHaveLength(1)
    const project = projects[0] as (typeof projects)[number]
    expect(project).toMatchObject({
      region_id: 'aws-us-east-2',
      org_id: 'org-test-1',
      pg_version: 17,
    })
    expect(cloud.neon.grants).toContainEqual({
      projectId: project.id,
      role: 'migrator',
      member: 'app',
    })
    const stagingBranch = project.branches.get(envs.staging.neon?.branchId ?? '')
    expect(stagingBranch?.roles.get('migrator')?.resets).toBe(1)
    expect(stagingBranch?.databases.get('app')?.owner_name).toBe('migrator')

    // GitHub: the scaffold files, then the config commit with no placeholders left.
    expect(repo?.environments.has('staging')).toBe(true)
    expect(repo?.variables.get('DEPLOYER_URL')).toBe('http://localhost:3001/ci')
    const toml = cloud.github.readFile(
      cloud.opts.org,
      launch.slug,
      'apps/web/wrangler.staging.toml'
    )
    expect(toml).toContain(`id = "${kvStaging?.id}"`)
    expect(toml).not.toMatch(/<KV_/)
    const [client] = await db
      .select()
      .from(oidcClients)
      .where(eq(oidcClients.appId, launch.params.appId))
    expect(toml).toContain(`OIDC_CLIENT_ID = "${client?.clientId}"`)
    expect(client?.redirectUris).toContain(
      `https://${launch.slug}-staging.${cloud.opts.domain}/auth/oidc/callback`
    )
    expect(cloud.github.runs.map(r => [r.workflow, r.inputs])).toEqual([
      ['launch-scaffold.yml', {}],
      ['deploy.yml', { environment: 'staging' }],
    ])

    // The creator is told; the chain is audited.
    const [note] = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.tenantId, launch.tenantId), eq(notifications.type, 'app.launched'))
      )
    expect(note?.userId).toBe(launch.params.userId)
    const actions = (
      await db.select().from(auditEvents).where(eq(auditEvents.tenantId, launch.tenantId))
    ).map(a => a.action)
    expect(actions).toEqual(
      expect.arrayContaining(['app.create.requested', 'oidc_client.created', 'app.launched'])
    )

    // No secret anywhere Launch keeps, or in anything a step handed back.
    const secrets = secretsIn(cloud)
    expect(secrets.length).toBeGreaterThan(5)
    const kept = JSON.stringify({
      ops: Object.values(byStep),
      audit: await db.select().from(auditEvents).where(eq(auditEvents.tenantId, launch.tenantId)),
      results,
      outcome,
      envs: Object.values(envs).map(e => ({ ...e, encryptionKeySealed: null })),
    })
    expect(secrets.filter(secret => kept.includes(secret))).toEqual([])
  })

  it('rides out a Neon 423 burst', async () => {
    const launch = await h.request()
    cloud.lockNeon(6)
    const { outcome } = await h.run(launch)
    expect(outcome.status).toBe('live')
    expect(cloud.callsTo('neon').filter(c => c.status === 423)).toHaveLength(6)
    expect((await rows(launch)).neon?.attempt).toBe(1)
  })

  it('a failure at R2 then a retry creates the Neon project and KV exactly once', async () => {
    const launch = await h.request()
    // Staging's KV and queue exist; its bucket fails.
    cloud.failNext(({ method, url }) => method === 'POST' && url.endsWith('/r2/buckets'), 500)
    const first = await h.run(launch)
    expect(first.outcome.status).toBe('failed')
    const failed = await rows(launch)
    expect(failed.cloudflare?.status).toBe('failed')
    expect(failed.cloudflare?.externalIds).toMatchObject({
      'kv.staging': expect.any(String),
      'queue.staging': expect.any(String),
    })
    expect(failed.cloudflare?.externalIds['r2.staging']).toBeUndefined()
    expect((await appRow(launch))?.status).toBe('failed')
    const [launchFailed] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.tenantId, launch.tenantId), eq(auditEvents.action, 'app.launch_failed'))
      )
    expect(launchFailed?.summary.after?.error).toMatch(/^cloudflare: /)

    // The retry instance `<runId>-r1`: same params, so everything that succeeded is skipped.
    const second = await h.run(launch, {
      onWait: async wait => (wait.type === DEPLOY_FINISHED_EVENT ? h.deployJob(launch) : undefined),
    })
    expect(second.outcome.status).toBe('live')
    const done = await rows(launch)
    expect(done.cloudflare).toMatchObject({ status: 'succeeded', attempt: 2 })
    expect(done.neon?.attempt).toBe(1)
    expect(done.repo?.attempt).toBe(1)
    expect([...cloud.neon.projects.values()].filter(p => p.name === launch.slug)).toHaveLength(1)
    const kvCreates = cloud
      .callsTo('cloudflare')
      .filter(c => c.method === 'POST' && c.path.endsWith('/storage/kv/namespaces'))
    expect(kvCreates).toHaveLength(2)
    expect(
      [...cloud.cloudflare.kv.values()].filter(k => k.title.startsWith(`${launch.slug}-`))
    ).toHaveLength(2)
    expect(cloud.github.repos.size).toBe(1)
  })

  it('an email failure does not block the launch', async () => {
    const launch = await h.request()
    cloud.failNext('POST https://api.resend.com/api-keys', 500)
    const { outcome } = await h.run(launch)
    expect(outcome.status).toBe('live')
    const byStep = await rows(launch)
    expect(byStep.email?.status).toBe('failed')
    expect(byStep.live?.status).toBe('succeeded')
    const view = await pipelineView(db, launch.tenantId, (await appRow(launch)) as AppRow, 'create')
    expect(view.status).toBe('succeeded')
  })

  it('a failed scaffold job ends the wait at once, and a retry starts the job again', async () => {
    const launch = await h.request()
    launch.ports.pollStatus = 'failed'
    const { outcome, fake } = await h.run(launch, { onWait: async () => undefined })
    expect(outcome.status).toBe('failed')
    expect(fake.waits).toHaveLength(0)
    const byStep = await rows(launch)
    expect(byStep['scaffold.wait']).toMatchObject({ status: 'failed' })
    expect(byStep['scaffold.wait']?.error).toMatch(/the job exited 1/)
    expect(byStep.neon).toBeUndefined()

    // "Retry from failed step" starts the job again: a fresh ticket, a second dispatch, live.
    // The dead job had claimed its ticket (`/ci/scaffold/token` binds the run id).
    const first = await h.scaffoldTicket(launch)
    await db
      .update(deployTickets)
      .set({ runId: '4242', runAttempt: 1 })
      .where(
        and(eq(deployTickets.tenantId, launch.tenantId), eq(deployTickets.id, first?.id ?? ''))
      )
    const env = createTestEnv()
    const retried = await retryPipeline(
      db,
      { APP_LAUNCH_WORKFLOW: stubs(env).launchWorkflow },
      launch.tenantId,
      launch.params.appId,
      'create',
      SYSTEM_ACTOR
    )
    expect(retried.instanceId).toBe(`${launch.params.runId}-r1`)
    launch.ports.pollStatus = 'running'
    const again = await h.run(launch)
    expect(again.outcome.status).toBe('live')
    const tickets = await db
      .select()
      .from(deployTickets)
      .where(
        and(
          eq(deployTickets.tenantId, launch.tenantId),
          eq(deployTickets.appId, launch.params.appId),
          eq(deployTickets.purpose, 'scaffold')
        )
      )
    expect(tickets).toHaveLength(2)
    expect(tickets.find(t => t.id === first?.id)).toMatchObject({
      status: 'failed',
      error: 'Superseded by a retry',
    })
    expect(launch.ports.started).toHaveLength(2)
    expect((await rows(launch))['scaffold.start']?.attempt).toBe(2)
  })

  it('refuses a scaffold whose manifest names another app', async () => {
    const launch = await h.request()
    const { outcome } = await h.run(launch, {
      onWait: async wait => {
        if (wait.type !== SCAFFOLD_FINISHED_EVENT) return undefined
        const ticket = await h.scaffoldTicket(launch)
        const sha = pushScaffold(cloud, launch.slug, { manifestSlug: 'someone-else' })
        await finishScaffoldTicket(db, launch.tenantId, ticket?.id, sha)
        return { ticketId: ticket?.id }
      },
    })
    expect(outcome.status).toBe('failed')
    const byStep = await rows(launch)
    expect(byStep['scaffold.verify']?.error).toMatch(/names the app someone-else/)
  })

  it('without deployStaging, records the deploy and health as skipped and still goes live', async () => {
    const launch = await h.request({ deployStaging: false })
    const { outcome, fake } = await h.run(launch)
    expect(outcome.status).toBe('live')
    const byStep = await rows(launch)
    expect(byStep['deploy_staging.start']?.status).toBe('skipped')
    expect(byStep.health?.status).toBe('skipped')
    expect(fake.waits.map(w => w.type)).toEqual([SCAFFOLD_FINISHED_EVENT])
  })
})
