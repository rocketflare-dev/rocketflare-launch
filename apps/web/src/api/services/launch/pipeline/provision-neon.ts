/**
 * The app's database (Launch P2, plan §1 "Neon" and step 4): one Neon project per app, `main`
 * serving production and a `staging` branch serving staging, with two roles on each.
 *
 * 1. Project `<slug>` (Postgres 17) in the PINNED region and org — recorded the moment it exists.
 * 2. On `main`: role `migrator`, role `app`, database `app` owned by `migrator`.
 * 3. `GRANT migrator TO app`, as `neondb_owner` over Neon's HTTP SQL endpoint, after resetting
 *    that owner's password: Launch never stores it, so it mints one for the one statement. Kit
 *    0.15's Worker needs the owner's rights (RLS is inert for the owner, plan §0.3), and a grant
 *    made on `main` before branching is inherited by `staging`.
 * 4. Branch `staging`, then reset BOTH roles' passwords on it — a branch inherits its parent's
 *    passwords, and staging must not be able to reach production with them.
 *
 * Every write is idempotent on a retry: an existing role, database or branch (Neon's 409) is taken
 * as done, and the project and branch ids come back from `ctx.prior`. Every password Neon hands
 * back is used at once and dropped — none is recorded or returned.
 */
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import { NeonApiError, type NeonBranch, type NeonClient, runSql } from '../neon'
import type { StepContext } from './operations'

export const MIGRATOR_ROLE = 'migrator'
export const APP_ROLE = 'app'
export const APP_DATABASE = 'app'
export const STAGING_BRANCH = 'staging'
const OWNER_ROLE = 'neondb_owner'
const OWNER_DATABASE = 'neondb'

export interface NeonIds {
  projectId: string
  mainBranchId: string
  stagingBranchId: string
}

/** A create that answers 409 already exists — done on an earlier attempt. */
async function unlessExists<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof NeonApiError && err.status === 409) return null
    throw err
  }
}

export async function provisionNeon(
  neon: { client: NeonClient; orgId: string | null; regionId: string },
  ctx: StepContext,
  input: { slug: string }
): Promise<NeonIds> {
  const { client } = neon
  const { projectId, mainBranchId } = await ensureProject(neon, ctx, input.slug)

  for (const role of [MIGRATOR_ROLE, APP_ROLE]) {
    const made = await unlessExists(() => client.createRole(projectId, mainBranchId, role))
    if (made) await client.waitForOperations(projectId, made.operations)
  }
  const database = await unlessExists(() =>
    client.createDatabase(projectId, mainBranchId, { name: APP_DATABASE, ownerName: MIGRATOR_ROLE })
  )
  if (database) await client.waitForOperations(projectId, database.operations)

  // `GRANT` as the project owner, with a password minted for this one statement.
  const reset = await client.resetRolePassword(projectId, mainBranchId, OWNER_ROLE)
  ctx.redact(reset.role.password)
  await client.waitForOperations(projectId, reset.operations)
  const ownerUri = await client.connectionUri(projectId, {
    branchId: mainBranchId,
    databaseName: OWNER_DATABASE,
    roleName: OWNER_ROLE,
    pooled: false,
  })
  ctx.redact(ownerUri)
  await runSql(ownerUri, `GRANT ${MIGRATOR_ROLE} TO ${APP_ROLE}`)

  let stagingBranchId = ctx.prior.neonStagingBranchId
  if (!stagingBranchId) {
    const branch = await unlessExists(() =>
      client.createBranch(projectId, { name: STAGING_BRANCH, parentId: mainBranchId })
    )
    if (branch) {
      stagingBranchId = branch.branch.id
      await ctx.record({ neonStagingBranchId: stagingBranchId })
      await client.waitForOperations(projectId, branch.operations)
    } else {
      stagingBranchId = await findBranch(client, projectId, STAGING_BRANCH)
      await ctx.record({ neonStagingBranchId: stagingBranchId })
    }
  }

  // The branch inherited main's passwords: give staging its own.
  for (const role of [MIGRATOR_ROLE, APP_ROLE]) {
    const fresh = await client.resetRolePassword(projectId, stagingBranchId, role)
    ctx.redact(fresh.role.password)
    await client.waitForOperations(projectId, fresh.operations)
  }
  return { projectId, mainBranchId, stagingBranchId }
}

async function ensureProject(
  neon: { client: NeonClient; orgId: string | null; regionId: string },
  ctx: StepContext,
  slug: string
): Promise<{ projectId: string; mainBranchId: string }> {
  const { neonProjectId, neonMainBranchId } = ctx.prior
  if (neonProjectId && neonMainBranchId) {
    return { projectId: neonProjectId, mainBranchId: neonMainBranchId }
  }
  const created = await neon.client.createProject({
    name: slug,
    regionId: neon.regionId,
    orgId: neon.orgId,
    pgVersion: 17,
  })
  const ids = { projectId: created.project.id, mainBranchId: created.branch.id }
  // The answer also carries `neondb_owner`'s password and a connection string — both dropped.
  await ctx.record({ neonProjectId: ids.projectId, neonMainBranchId: ids.mainBranchId })
  await neon.client.waitForOperations(ids.projectId, created.operations)
  return ids
}

async function findBranch(client: NeonClient, projectId: string, name: string): Promise<string> {
  const body = await client.get<{ branches?: NeonBranch[] }>(
    `/projects/${encodeURIComponent(projectId)}/branches`
  )
  const found = body.branches?.find(b => b.name === name)
  if (!found) throw new Error(`Neon says branch ${name} exists, but it is not listed`)
  return found.id
}

/** The Neon ids an environment runs on, as `app_environments.neon` records them. */
export function environmentNeon(ids: NeonIds, env: AppEnvironmentName) {
  return {
    projectId: ids.projectId,
    branchId: env === 'production' ? ids.mainBranchId : ids.stagingBranchId,
    databaseName: APP_DATABASE,
    roleName: APP_ROLE,
    migratorRole: MIGRATOR_ROLE,
    appRole: APP_ROLE,
  }
}

/**
 * A fresh pooled `DATABASE_URL` for the Worker: `app`'s password is reset on the branch and the
 * pooled URI read back. A SECRET — the caller puts it on the Worker and forgets it.
 */
export async function freshAppDatabaseUrl(
  client: NeonClient,
  ctx: Pick<StepContext, 'redact'>,
  projectId: string,
  branchId: string
): Promise<string> {
  const reset = await client.resetRolePassword(projectId, branchId, APP_ROLE)
  ctx.redact(reset.role.password)
  await client.waitForOperations(projectId, reset.operations)
  const uri = await client.connectionUri(projectId, {
    branchId,
    databaseName: APP_DATABASE,
    roleName: APP_ROLE,
    pooled: true,
  })
  ctx.redact(uri)
  return uri
}
