/**
 * Re-scaffold's DATABASE evidence (`pipeline/rescaffold-check.ts` + `rescaffold-database.ts`): a
 * deploy ticket handed the migrator credential but never activated no longer blocks a re-scaffold
 * on its own — the environment's database is asked, as `neondb_owner` over Neon's HTTP SQL, whether
 * drizzle recorded any migration or `public` holds any table. Neon is a FakeCloud here, reached
 * through an explicit `fetch`, and the app is `seedDeployableApp`'s (a real project: `main` +
 * `staging`, `migrator` owning `app`) with a failed create run.
 *
 * What it pins: empty → allowed; migrations → blocked with the count; Neon failing or not
 * connected → blocked, conservatively, saying why; activated → blocked with NO Neon call; no
 * evidence → allowed with NO Neon call; and the view never calls Neon either.
 */
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { NeonClient } from '@/api/services/launch/neon'
import { rescaffoldBlock } from '@/api/services/launch/pipeline/rescaffold-check'
import { pipelineView } from '@/api/services/launch/pipeline/runs'
import { appOperations, deployTickets } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { type DeployableApp, seedDeployableApp } from '../helpers/deploy-gateway'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import { forgetApps } from '../helpers/launch-apps'

const db = setupTestDatabase()
const tenantIds: string[] = []
afterAll(() => forgetApps(db, tenantIds))

/** An app whose launch failed at the staging deploy, on a FakeCloud of its own. */
async function failedLaunch() {
  const cloud: FakeCloud = createFakeCloud()
  const { tenant } = await createTestTenantWithUser(db, 'admin')
  tenantIds.push(tenant.id)
  const runId = crypto.randomUUID()
  const seeded = await seedDeployableApp(db, cloud, tenant.id, {
    status: 'failed',
    launchRunId: runId,
  })
  await db.insert(appOperations).values({
    tenantId: tenant.id,
    appId: seeded.app.id,
    runId,
    kind: 'create',
    step: 'deploy_staging.wait',
    status: 'failed',
    attempt: 1,
    error: 'The staging deploy job failed: db:migrate:ci',
    startedAt: new Date(),
    finishedAt: new Date(),
  })
  const neon = vi.fn(
    async () => new NeonClient('neon-key', { fetch: cloud.fetch, sleep: async () => {} })
  )
  const check = () => rescaffoldBlock(db, tenant.id, seeded.app, { runId, status: 'failed' }, neon)
  const view = () => pipelineView(db, tenant.id, seeded.app, 'create')
  const ticket = (env: AppEnvironmentName, over: Partial<typeof deployTickets.$inferInsert> = {}) =>
    db.insert(deployTickets).values({
      tenantId: tenant.id,
      appId: seeded.app.id,
      environmentId: env === 'staging' ? seeded.staging.id : seeded.production.id,
      purpose: 'deploy',
      status: 'finished',
      runId: String(Math.floor(Math.random() * 1e9)),
      runAttempt: 1,
      ...over,
    })
  /** A deploy job that got the credential, then died before `activate`. */
  const credentialed = (env: AppEnvironmentName = 'staging') =>
    ticket(env, {
      cfVersionId: 'ver-1',
      credentialsIssuedAt: new Date(),
      credentialsRevokedAt: new Date(),
      error: 'finished before activate',
    })
  // Seeding the project made its own Neon calls: count only what the check makes.
  const seededCalls = cloud.callsTo('neon').length + cloud.callsTo('neon-sql').length
  const neonCalls = () =>
    cloud.callsTo('neon').length + cloud.callsTo('neon-sql').length - seededCalls
  return { cloud, seeded, neon, check, view, ticket, credentialed, neonCalls }
}

const branchOf = (seeded: DeployableApp, env: AppEnvironmentName) =>
  env === 'staging' ? seeded.stagingBranchId : seeded.mainBranchId

describe('re-scaffold — the database as evidence', () => {
  it('allows it when the credential went out and the database is empty (the role phase failed)', async () => {
    const t = await failedLaunch()
    await t.credentialed('staging')

    // The view offers it with the note, and asks Neon nothing.
    expect(await t.view()).toMatchObject({ canRescaffold: true, rescaffoldChecksDatabase: true })
    expect(t.neon).not.toHaveBeenCalled()
    expect(t.neonCalls()).toBe(0)

    expect(await t.check()).toBeNull()
    // Asked on staging's branch, as `neondb_owner`, in database `app`, one statement per call.
    const asked = t.cloud.neon.sql
    expect(asked.length).toBeGreaterThan(0)
    for (const q of asked) {
      expect(q).toMatchObject({
        branchId: t.seeded.stagingBranchId,
        role: 'neondb_owner',
        database: 'app',
      })
    }
    // A migrations table that exists but holds no row is still nothing applied.
    t.cloud.neon.addMigrations(t.seeded.projectId, t.seeded.stagingBranchId, 'app', 0)
    expect(await t.check()).toBeNull()
  })

  it('blocks it with the count when the database has applied migrations', async () => {
    const t = await failedLaunch()
    await t.credentialed('staging')
    t.cloud.neon.addMigrations(t.seeded.projectId, t.seeded.stagingBranchId, 'app', 12)
    t.cloud.neon.addTable(t.seeded.projectId, t.seeded.stagingBranchId, 'app', 'users')

    const block = await t.check()
    expect(block?.code).toBe('app_already_deployed')
    expect(block?.message).toMatch(/staging has 12 applied migrations and 1 table in public/)
    expect(block?.message).toMatch(/kit upgrade/)
    // No password or connection string reaches the message.
    for (const role of ['neondb_owner', 'migrator']) {
      const pw =
        t.cloud.neon.projects
          .get(t.seeded.projectId)
          ?.branches.get(t.seeded.stagingBranchId)
          ?.roles.get(role)?.password ?? ''
      expect(pw.length).toBeGreaterThan(0)
      expect(block?.message).not.toContain(pw)
    }
  })

  it("asks production's database too when a production ticket got the credential — a table alone blocks", async () => {
    const t = await failedLaunch()
    await t.credentialed('staging')
    await t.credentialed('production')
    t.cloud.neon.addTable(t.seeded.projectId, branchOf(t.seeded, 'production'), 'app', 'orders')

    const block = await t.check()
    expect(block?.message).toMatch(/production has 1 table in public/)
    const branches = new Set(t.cloud.neon.sql.map(q => q.branchId))
    expect(branches).toEqual(new Set([t.seeded.stagingBranchId, t.seeded.mainBranchId]))
  })

  it('blocks it, conservatively and saying why, when Neon cannot answer', async () => {
    const t = await failedLaunch()
    await t.credentialed('staging')
    t.cloud.failNext('/reset_password', 500, { message: 'internal error' })
    const failed = await t.check()
    expect(failed?.code).toBe('app_already_deployed')
    expect(failed?.message).toMatch(/could not check its database \(staging: internal error\)/)
    expect(failed?.message).toMatch(/migrations may have run/)

    t.cloud.failNext('/sql', 500, { message: 'endpoint is waking up' })
    expect((await t.check())?.message).toMatch(/staging: endpoint is waking up/)

    // Not connected in Setup at all.
    const block = await rescaffoldBlock(
      db,
      t.seeded.app.tenantId,
      t.seeded.app,
      { runId: t.seeded.app.launchRunId, status: 'failed' },
      async () => null
    )
    expect(block?.message).toMatch(/Neon is not connected in Setup/)
  })

  it('blocks an activated deploy without calling Neon', async () => {
    const t = await failedLaunch()
    await t.credentialed('staging')
    await t.ticket('staging', { status: 'active', cfVersionId: 'ver-2', activatedAt: new Date() })
    const block = await t.check()
    expect(block?.message).toMatch(/already deployed/)
    expect(await t.view()).toMatchObject({ canRescaffold: false, rescaffoldChecksDatabase: false })
    expect(t.neon).not.toHaveBeenCalled()
    expect(t.neonCalls()).toBe(0)
  })

  it('allows it with no evidence at all, without calling Neon', async () => {
    const t = await failedLaunch()
    // A job that died at its gate: the ticket closed with no credential and no version.
    await t.ticket('staging')
    expect(await t.check()).toBeNull()
    expect(await t.view()).toMatchObject({ canRescaffold: true, rescaffoldChecksDatabase: false })
    expect(t.neon).not.toHaveBeenCalled()
    expect(t.neonCalls()).toBe(0)
  })
})
