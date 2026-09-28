/**
 * The launch pipeline's `neon` step (`provisionNeon`) against the FakeNeon, which models roles as
 * a real Neon project has them: the API's are `neon_superuser` members made by `cloud_admin`, so
 * `neondb_owner` cannot GRANT them; roles it makes in SQL it can. What it proves: a fresh project
 * gets SQL roles (no API role create) and the GRANT succeeds; a project an earlier Launch left
 * with API roles and an EMPTY `app` is repaired; one whose `app` holds tables, or that already
 * has a `staging` branch, is refused untouched; and a retry — whole or after a mid-step failure —
 * repeats no write.
 */
import type { AppOperationExternalIds } from '@launch/shared/launch-apps'
import { beforeEach, describe, expect, it } from 'vitest'
import { NeonClient, runSql } from '@/api/services/launch/neon'
import type { StepContext } from '@/api/services/launch/pipeline/operations'
import {
  APP_DATABASE,
  provisionNeon,
  quoteIdent,
  quoteLiteral,
} from '@/api/services/launch/pipeline/provision-neon'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'

let cloud: FakeCloud
let client: NeonClient
beforeEach(() => {
  cloud = createFakeCloud()
  client = new NeonClient('neon-test', { fetch: cloud.fetch, sleep: async () => {} })
})

function stepContext(prior: AppOperationExternalIds = {}) {
  const redacted: string[] = []
  const state = { ...prior }
  const ctx: StepContext = {
    get prior() {
      return state
    },
    attempt: 1,
    async record(partial) {
      Object.assign(state, partial)
    },
    redact(...values) {
      for (const v of values) if (v) redacted.push(v)
    },
  }
  return { ctx, redacted, state }
}

const provision = (ctx: StepContext, slug = 'shop') =>
  provisionNeon({ client, orgId: 'org-1', regionId: 'aws-us-east-2' }, ctx, { slug })

const roleCreates = () =>
  cloud.callsTo('neon').filter(c => c.method === 'POST' && /\/roles$/.test(c.path))

function mainBranch(projectId: string) {
  const project = cloud.neon.projects.get(projectId)
  const main = [...(project?.branches.values() ?? [])].find(b => b.parent_id === null)
  if (!main) throw new Error('no main branch')
  return main
}

/** A project as an earlier Launch left it: API roles, `app` owned by the API `migrator`. */
async function legacyProject(slug: string) {
  const created = await client.createProject({ name: slug, regionId: 'aws-us-east-2' })
  const projectId = created.project.id
  const mainBranchId = created.branch.id
  await client.createRole(projectId, mainBranchId, 'migrator')
  await client.createRole(projectId, mainBranchId, 'app')
  await client.createDatabase(projectId, mainBranchId, {
    name: APP_DATABASE,
    ownerName: 'migrator',
  })
  return {
    projectId,
    mainBranchId,
    prior: { neonProjectId: projectId, neonMainBranchId: mainBranchId },
  }
}

describe('provisionNeon — a fresh project', () => {
  it('creates both roles in SQL, never through the API, and the GRANT succeeds', async () => {
    const { ctx, redacted } = stepContext()
    const ids = await provision(ctx)

    expect(roleCreates()).toHaveLength(0)
    const main = mainBranch(ids.projectId)
    expect(main.roles.get('migrator')).toMatchObject({
      superuser: false,
      createdBy: 'neondb_owner',
      canCreateRole: true,
    })
    expect(main.roles.get('app')).toMatchObject({
      superuser: false,
      createdBy: 'neondb_owner',
      canCreateRole: false,
    })
    expect(main.members.has('migrator->app')).toBe(true)
    expect(cloud.neon.grants).toEqual([
      { projectId: ids.projectId, role: 'migrator', member: 'app' },
    ])
    expect(main.databases.get(APP_DATABASE)?.owner_name).toBe('migrator')
    expect(main.extensions.get(APP_DATABASE)?.has('vector')).toBe(true)

    // Every statement ran as neondb_owner, one per call; the extension in `app`, the rest in neondb.
    const statements = cloud.neon.sql.filter(s => s.projectId === ids.projectId)
    expect(new Set(statements.map(s => s.role))).toEqual(new Set(['neondb_owner']))
    expect(statements.every(s => !s.query.includes(';'))).toBe(true)
    expect(statements.find(s => /CREATE EXTENSION/.test(s.query))?.database).toBe(APP_DATABASE)
    // The throwaway passwords were handed to the redactor before they went anywhere.
    for (const s of statements.filter(s => /CREATE ROLE/.test(s.query))) {
      const password = /PASSWORD '([^']+)'/.exec(s.query)?.[1] as string
      expect(password).toMatch(/^[0-9a-f]{48}$/)
      expect(redacted).toContain(password)
    }

    // Staging inherits the SQL roles and the membership, with its own passwords.
    const staging = cloud.neon.projects.get(ids.projectId)?.branches.get(ids.stagingBranchId)
    expect(staging?.roles.get('app')?.superuser).toBe(false)
    expect(staging?.members.has('migrator->app')).toBe(true)
    expect(staging?.roles.get('migrator')?.resets).toBe(1)
    expect(staging?.roles.get('app')?.resets).toBe(1)
  })

  it('leaves migrator able to run the kit migrations: vector no-op, its RLS role, the grant', async () => {
    const ids = await provision(stepContext().ctx)
    // The deploy gateway's per-deploy reset works on a SQL-created role.
    await client.resetRolePassword(ids.projectId, ids.mainBranchId, 'migrator')
    const uri = await client.connectionUri(ids.projectId, {
      branchId: ids.mainBranchId,
      databaseName: APP_DATABASE,
      roleName: 'migrator',
      pooled: false,
    })
    const sql = (q: string) => runSql(uri, q, [], cloud.fetch)
    await sql('CREATE EXTENSION IF NOT EXISTS vector')
    await sql('CREATE TABLE users (id uuid primary key)')
    await sql(`CREATE ROLE launch_rls NOLOGIN`)
    await sql('GRANT launch_rls TO app')
    // Without IF NOT EXISTS the migrator, no neon_superuser, could not create an extension.
    await expect(sql('CREATE EXTENSION pg_trgm')).rejects.toThrow(/permission denied/)
    expect(mainBranch(ids.projectId).members.has('launch_rls->app')).toBe(true)
  })

  it('a retry of the whole step repeats no write', async () => {
    const first = stepContext()
    const ids = await provision(first.ctx)
    const again = await provision(stepContext(first.state).ctx)
    expect(again).toEqual(ids)
    // Roles and the membership were read, not written, the second time.
    expect(cloud.neon.sql.filter(s => /^CREATE ROLE/.test(s.query))).toHaveLength(2)
    expect(cloud.neon.sql.filter(s => /^GRANT/.test(s.query))).toHaveLength(1)
    expect(cloud.neon.grants).toHaveLength(1)
    expect([...cloud.neon.projects.values()]).toHaveLength(1)
    expect(roleCreates()).toHaveLength(0)
  })

  it('a failure after the roles exist resumes on retry without recreating them', async () => {
    const first = stepContext()
    cloud.failNext(c => c.method === 'POST' && /\/databases$/.test(c.url), 500)
    await expect(provision(first.ctx)).rejects.toThrow()
    const projectId = first.state.neonProjectId as string
    expect(mainBranch(projectId).roles.has('migrator')).toBe(true)

    const ids = await provision(stepContext(first.state).ctx)
    expect(ids.projectId).toBe(projectId)
    const creates = cloud.neon.sql.filter(s => /CREATE ROLE/.test(s.query))
    expect(creates).toHaveLength(2)
    expect(mainBranch(projectId).members.has('migrator->app')).toBe(true)
  })
})

describe('provisionNeon — a project with API-created roles (the legacy repair)', () => {
  it('with an empty app database: deletes it and the API roles, recreates both in SQL', async () => {
    const legacy = await legacyProject('hola')
    const ids = await provision(stepContext(legacy.prior).ctx, 'hola')
    expect(ids.projectId).toBe(legacy.projectId)

    const deletes = cloud
      .callsTo('neon')
      .filter(c => c.method === 'DELETE')
      .map(c => c.path.replace(/^.*\/branches\/[^/]+/, ''))
    expect(deletes).toEqual(['/databases/app', '/roles/migrator', '/roles/app'])
    const main = mainBranch(legacy.projectId)
    expect(main.roles.get('migrator')).toMatchObject({
      superuser: false,
      createdBy: 'neondb_owner',
    })
    expect(main.roles.get('app')).toMatchObject({ superuser: false, createdBy: 'neondb_owner' })
    expect(main.databases.get(APP_DATABASE)?.owner_name).toBe('migrator')
    expect(main.extensions.get(APP_DATABASE)?.has('vector')).toBe(true)
    expect(main.members.has('migrator->app')).toBe(true)
    expect(roleCreates()).toHaveLength(2) // the legacy seed's own, none by the step
  })

  it('repairs only the role the API made when the other is already a SQL one', async () => {
    const legacy = await legacyProject('half')
    await client.deleteDatabase(legacy.projectId, legacy.mainBranchId, APP_DATABASE)
    await client.deleteRole(legacy.projectId, legacy.mainBranchId, 'migrator')
    cloud.neon.sqlRole(legacy.projectId, legacy.mainBranchId, 'migrator', { canCreateRole: true })
    const before = cloud.calls.length
    await provision(stepContext(legacy.prior).ctx, 'half')
    const stepDeletes = cloud.calls
      .slice(before)
      .filter(c => c.vendor === 'neon' && c.method === 'DELETE')
      .map(c => c.path.replace(/^.*\/branches\/[^/]+/, ''))
    expect(stepDeletes).toEqual(['/roles/app'])
    expect(mainBranch(legacy.projectId).roles.get('migrator')?.createdBy).toBe('neondb_owner')
    expect(mainBranch(legacy.projectId).roles.get('app')?.superuser).toBe(false)
    expect(mainBranch(legacy.projectId).members.has('migrator->app')).toBe(true)
  })

  it('with tables in app: refuses with a clear message and changes nothing', async () => {
    const legacy = await legacyProject('kept')
    cloud.neon.addTable(legacy.projectId, legacy.mainBranchId, APP_DATABASE, 'users')
    await expect(provision(stepContext(legacy.prior).ctx, 'kept')).rejects.toThrow(
      /created through Neon's API.*holds 1 table\(s\) in public.*will not recreate them/
    )
    const main = mainBranch(legacy.projectId)
    expect(main.roles.get('migrator')?.superuser).toBe(true)
    expect(main.databases.has(APP_DATABASE)).toBe(true)
    expect(cloud.callsTo('neon').filter(c => c.method === 'DELETE')).toHaveLength(0)
    expect(cloud.neon.sql.some(s => /^(CREATE|GRANT|DROP)/.test(s.query))).toBe(false)
  })

  it('with a staging branch already cut from the API roles: refuses and changes nothing', async () => {
    const legacy = await legacyProject('cut')
    await client.createBranch(legacy.projectId, { name: 'staging', parentId: legacy.mainBranchId })
    await expect(provision(stepContext(legacy.prior).ctx, 'cut')).rejects.toThrow(
      /staging branch cut from them/
    )
    expect(cloud.callsTo('neon').filter(c => c.method === 'DELETE')).toHaveLength(0)
  })
})

describe('quoting', () => {
  it('quotes the role names and refuses anything else', () => {
    expect(quoteIdent('migrator')).toBe('"migrator"')
    expect(() => quoteIdent('app"; DROP ROLE x; --')).toThrow(/unexpected identifier/)
    expect(() => quoteIdent('App')).toThrow()
    expect(quoteLiteral("it's")).toBe("'it''s'")
  })
})
