/**
 * The app's database (Launch P2, plan §1 "Neon" and step 4): one Neon project per app, `main`
 * serving production and a `staging` branch serving staging, with two roles on each.
 *
 * 1. Project `<slug>` (Postgres 17) in the PINNED region and org — recorded the moment it exists.
 * 2. `neondb_owner`'s password is reset and its direct URI read back: Launch never stores it, so
 *    it mints one for this step's statements (HTTP SQL, one statement per call).
 * 3. On `main`, as `neondb_owner`, IN SQL: role `migrator` (LOGIN CREATEROLE — the kit's migrations
 *    create its RLS role) and role `app` (LOGIN), each with a throwaway password the API resets
 *    later. NOT through Neon's role API: an API role is created by `cloud_admin` as a
 *    `neon_superuser` member, which is far too much for the Worker's role, and `neondb_owner`
 *    holds no ADMIN on it, so on PG16+ it cannot `GRANT` it (verified on a real project, 17.11).
 * 4. Database `app` owned by `migrator` (through the API, which accepts a SQL-created owner), then
 *    `CREATE EXTENSION IF NOT EXISTS vector` in it as `neondb_owner` — `migrator` is no
 *    `neon_superuser`, and the kit's own `CREATE EXTENSION IF NOT EXISTS vector` then succeeds
 *    as a no-op.
 * 5. `GRANT migrator TO app`: kit 0.15's Worker needs the owner's rights (RLS is inert for the
 *    owner, plan §0.3), and a grant made on `main` before branching is inherited by `staging`.
 * 6. Branch `staging`, then reset BOTH roles' passwords on it — a branch inherits its parent's
 *    passwords, and staging must not be able to reach production with them.
 *
 * **Repair.** A project an earlier Launch provisioned has API-created `migrator`/`app`
 * (`neon_superuser` members) and a database `app` their GRANT never reached. When either role is
 * such a member, the step checks that `app` has no table in `public`, deletes database `app` and
 * the API roles through the API, and continues as above; with tables, or with a `staging` branch
 * already cut from those roles, it refuses rather than destroy anything.
 *
 * Every write is idempotent on a retry: each role, the membership and the database is checked
 * before it is created (an API 409 is taken as done), and the project and branch ids come back
 * from `ctx.prior`. Every password is used at once and dropped — none is recorded or returned.
 */
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  isNeonNotFound,
  NeonApiError,
  type NeonBranch,
  type NeonClient,
  type NeonSqlResult,
} from '../neon'
import type { StepContext } from './operations'

export const MIGRATOR_ROLE = 'migrator'
export const APP_ROLE = 'app'
export const APP_DATABASE = 'app'
export const STAGING_BRANCH = 'staging'
const OWNER_ROLE = 'neondb_owner'
const OWNER_DATABASE = 'neondb'
/** The group Neon's role API puts every role it creates in. */
const NEON_SUPERUSER = 'neon_superuser'
/** The only extension the kit's migrations create. */
const EXTENSIONS = ['vector'] as const
/** `CREATE ROLE <name> <attributes>` for each role the step creates, in order. */
const ROLES: readonly { name: string; attributes: string }[] = [
  { name: MIGRATOR_ROLE, attributes: 'LOGIN CREATEROLE' },
  { name: APP_ROLE, attributes: 'LOGIN' },
]

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

/** A delete whose target is already gone (404) — done on an earlier attempt. */
async function unlessGone<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    if (isNeonNotFound(err)) return null
    throw err
  }
}

/** A double-quoted identifier — the names are constants, and still checked. */
export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Refusing to quote an unexpected identifier: ${name}`)
  }
  return `"${name}"`
}

/** A single-quoted string literal (standard_conforming_strings: only `'` needs doubling). */
export function quoteLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('Refusing a literal with a NUL byte')
  return `'${value.replaceAll("'", "''")}'`
}

/** A random password for a role the API resets before anyone uses it (192 bits, hex). */
function throwawayPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/** Neon's HTTP SQL answers a boolean as `t`/`f` text; a driver would parse it. Accept both. */
function isTrue(value: unknown): boolean {
  return value === true || value === 't' || value === 'true'
}

/** `neondb_owner` on `main`, with one freshly minted password, able to reach any database. */
interface OwnerSession {
  sql(database: string, query: string, params?: readonly unknown[]): Promise<NeonSqlResult>
}

async function ownerSession(
  client: NeonClient,
  ctx: StepContext,
  projectId: string,
  branchId: string
): Promise<OwnerSession> {
  const reset = await client.resetRolePassword(projectId, branchId, OWNER_ROLE)
  ctx.redact(reset.role.password)
  await client.waitForOperations(projectId, reset.operations)
  const uris = new Map<string, string>()
  return {
    async sql(database, query, params = []) {
      let uri = uris.get(database)
      if (!uri) {
        uri = await client.connectionUri(projectId, {
          branchId,
          databaseName: database,
          roleName: OWNER_ROLE,
          pooled: false,
        })
        ctx.redact(uri)
        uris.set(database, uri)
      }
      return client.sql(uri, query, params)
    },
  }
}

/** Which of the step's roles exist, and whether each is a `neon_superuser` member (API-made). */
async function readRoles(owner: OwnerSession): Promise<Map<string, { superuser: boolean }>> {
  const result = await owner.sql(
    OWNER_DATABASE,
    `SELECT r.rolname AS name, EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid AND g.rolname = '${NEON_SUPERUSER}') AS superuser FROM pg_roles r WHERE r.rolname IN ($1, $2)`,
    ROLES.map(r => r.name)
  )
  return new Map(
    result.rows.map(row => [String(row.name), { superuser: isTrue(row.superuser) }] as const)
  )
}

async function databaseExists(owner: OwnerSession, name: string): Promise<boolean> {
  const result = await owner.sql(OWNER_DATABASE, 'SELECT 1 FROM pg_database WHERE datname = $1', [
    name,
  ])
  return result.rows.length > 0
}

async function hasMembership(owner: OwnerSession, role: string, member: string): Promise<boolean> {
  const result = await owner.sql(
    OWNER_DATABASE,
    'SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE g.rolname = $1 AND u.rolname = $2',
    [role, member]
  )
  return result.rows.length > 0
}

/**
 * The repair: drop database `app` and every API-created role among the step's two, so both can
 * be recreated in SQL. Refuses — before deleting anything — when `app` holds a table in `public`
 * or a `staging` branch was already cut from the old roles.
 */
async function repairApiRoles(
  client: NeonClient,
  owner: OwnerSession,
  projectId: string,
  branchId: string,
  apiRoles: readonly string[]
): Promise<void> {
  const hasDatabase = await databaseExists(owner, APP_DATABASE)
  if (hasDatabase) {
    const tables = await owner.sql(
      APP_DATABASE,
      "SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'"
    )
    const n = Number(tables.rows[0]?.n ?? 0)
    if (n > 0) {
      throw new Error(
        `Neon project ${projectId} has roles ${apiRoles.join(', ')} created through Neon's API (members of ${NEON_SUPERUSER}), and database ${APP_DATABASE} already holds ${n} table(s) in public, so Launch will not recreate them. Move the data out and drop database ${APP_DATABASE} and those roles, then retry.`
      )
    }
  }
  const branches = await client.get<{ branches?: NeonBranch[] }>(
    `/projects/${encodeURIComponent(projectId)}/branches`
  )
  if (branches.branches?.some(b => b.name === STAGING_BRANCH)) {
    throw new Error(
      `Neon project ${projectId} has roles ${apiRoles.join(', ')} created through Neon's API (members of ${NEON_SUPERUSER}) and a ${STAGING_BRANCH} branch cut from them. Delete the ${STAGING_BRANCH} branch, then retry.`
    )
  }
  if (hasDatabase) {
    const gone = await unlessGone(() => client.deleteDatabase(projectId, branchId, APP_DATABASE))
    if (gone) await client.waitForOperations(projectId, gone.operations)
  }
  for (const role of apiRoles) {
    const gone = await unlessGone(() => client.deleteRole(projectId, branchId, role))
    if (gone) await client.waitForOperations(projectId, gone.operations)
  }
}

export async function provisionNeon(
  neon: { client: NeonClient; orgId: string | null; regionId: string },
  ctx: StepContext,
  input: { slug: string }
): Promise<NeonIds> {
  const { client } = neon
  const { projectId, mainBranchId } = await ensureProject(neon, ctx, input.slug)
  const owner = await ownerSession(client, ctx, projectId, mainBranchId)

  // Roles, in SQL — after repairing any the API created.
  let roles = await readRoles(owner)
  const apiRoles = [...roles].filter(([, r]) => r.superuser).map(([name]) => name)
  if (apiRoles.length > 0) {
    await repairApiRoles(client, owner, projectId, mainBranchId, apiRoles)
    roles = await readRoles(owner)
  }
  for (const role of ROLES) {
    if (roles.has(role.name)) continue
    const password = throwawayPassword()
    ctx.redact(password)
    await owner.sql(
      OWNER_DATABASE,
      `CREATE ROLE ${quoteIdent(role.name)} ${role.attributes} PASSWORD ${quoteLiteral(password)}`
    )
  }

  const database = await unlessExists(() =>
    client.createDatabase(projectId, mainBranchId, { name: APP_DATABASE, ownerName: MIGRATOR_ROLE })
  )
  if (database) await client.waitForOperations(projectId, database.operations)
  for (const extension of EXTENSIONS) {
    await owner.sql(APP_DATABASE, `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(extension)}`)
  }
  if (!(await hasMembership(owner, MIGRATOR_ROLE, APP_ROLE))) {
    await owner.sql(OWNER_DATABASE, `GRANT ${quoteIdent(MIGRATOR_ROLE)} TO ${quoteIdent(APP_ROLE)}`)
  }

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
