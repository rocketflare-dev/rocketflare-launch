/**
 * The `SessionDbPort` (Launch P3, slice 3b) — `NeonSessionDb`, under either `SESSION_BACKEND`, over
 * the FakeCloud's Neon: `dev` is cut `schema-only` from `main` with `session_owner` (made IN SQL by
 * `neondb_owner`, never a `neon_superuser` member) and `session_app` (with `vector`); an API-made
 * role from an earlier Launch is repaired; a session's branch is a child of `dev` with the role's
 * password RESET on it; every write is retry-safe; deleting twice is fine.
 */
import { describe, expect, it } from 'vitest'
import { NeonClient } from '@/api/services/launch/neon'
import { NeonSessionDb } from '@/api/services/sessions/db/neon-session-db'
import { loadConfig } from '@/config'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { seedSessionApp, sessionAppRef } from '../helpers/sessions'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const NEON_KEY = 'neon-test-key-abcdefghijklmnop'

describe('NeonSessionDb', () => {
  async function setup() {
    const cloud = createFakeCloud()
    const f = await seedSessionApp(db, cloud)
    const port = new NeonSessionDb(db, loadConfig(createTestEnv()), {
      fetch: cloud.fetch,
      sleep: async () => {},
      apiKey: NEON_KEY,
    })
    return { cloud, f, port, app: sessionAppRef(f) }
  }

  it('ensureDev cuts dev schema-only from main with session_owner and session_app — idempotently', async () => {
    const { cloud, f, port, app } = await setup()
    const first = await port.ensureDev(app)
    const dev = cloud.neon.branchNamed(f.neonProjectId, 'dev')
    expect(dev).toMatchObject({ init_source: 'schema-only' })
    expect(dev?.roles.has('session_owner')).toBe(true)
    expect(dev?.databases.get('session_app')).toMatchObject({ owner_name: 'session_owner' })
    expect(first).toEqual({
      devBranchId: dev?.id,
      database: 'session_app',
      preparedCommit: null,
      preparedAt: null,
      status: 'none',
    })
    // Again (a retried step), and again with the result recorded: one dev, status kept.
    const again = await port.ensureDev({ ...app, sessionDb: { ...first, status: 'ready' } })
    expect(again).toMatchObject({ devBranchId: dev?.id, status: 'ready' })
    const devs = [...(cloud.neon.projects.get(f.neonProjectId)?.branches.values() ?? [])].filter(
      b => b.name === 'dev'
    )
    expect(devs).toHaveLength(1)
  })

  it('makes session_owner IN SQL as neondb_owner — no neon_superuser — and vector as the owner', async () => {
    const { cloud, f, port, app } = await setup()
    await port.ensureDev(app)
    const dev = cloud.neon.branchNamed(f.neonProjectId, 'dev')
    const role = dev?.roles.get('session_owner')
    expect(role).toMatchObject({ superuser: false, createdBy: 'neondb_owner', canCreateRole: true })
    expect(dev?.extensions.get('session_app')?.has('vector')).toBe(true)
    // No role went through Neon's role API.
    const created = cloud.neon.sql.filter(s => /^CREATE ROLE "?session_owner/i.test(s.query))
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ branchId: dev?.id, role: 'neondb_owner' })
    // The throwaway password never reaches the URI a container gets: the API resets it first.
    const uri = await port.devUriFor({ ...app, sessionDb: await port.ensureDev(app) })
    expect(created[0]?.query).not.toContain(decodeURIComponent(new URL(uri).password))
    // Again: nothing is made twice.
    await port.ensureDev(app)
    expect(cloud.neon.sql.filter(s => /^CREATE ROLE/i.test(s.query))).toHaveLength(2)
  })

  it('makes the kit’s RLS role on dev, held by session_owner WITH ADMIN — so no sandbox runs db-roles', async () => {
    const { cloud, f, port, app } = await setup()
    await port.ensureDev(app)
    const dev = cloud.neon.branchNamed(f.neonProjectId, 'dev')
    expect(dev?.roles.get('rocketflare_app')).toMatchObject({
      superuser: false,
      createdBy: 'neondb_owner',
      canCreateRole: false,
    })
    // The kit's db-roles (a turn's `pnpm db:migrate`) alters it as session_owner: Postgres 16+
    // allows that only WITH ADMIN OPTION.
    expect(dev?.admins.has('rocketflare_app->session_owner')).toBe(true)
    // A retried step makes and grants nothing twice.
    await port.ensureDev(app)
    const made = (re: RegExp) => cloud.neon.sql.filter(s => re.test(s.query)).length
    expect(made(/^CREATE ROLE "?rocketflare_app/i)).toBe(1)
    expect(made(/^GRANT "?rocketflare_app/i)).toBe(1)
    // A session's branch inherits it.
    await port.createBranch(
      { ...app, sessionDb: await port.ensureDev(app) },
      {
        id: 'sess-1',
        shortId: 'abc123',
      }
    )
    expect(
      cloud.neon.branchNamed(f.neonProjectId, 'session-abc123')?.roles.has('rocketflare_app')
    ).toBe(true)
  })

  it('leaves the RLS role alone when the kit’s db-roles already made it as session_owner', async () => {
    const { cloud, f, port, app } = await setup()
    await port.ensureDev(app)
    const dev = cloud.neon.branchNamed(f.neonProjectId, 'dev')
    // A dev prepared before Launch made the role: the kit's db-roles made it, as session_owner.
    dev?.roles.delete('rocketflare_app')
    dev?.admins.clear()
    cloud.neon.sqlRole(f.neonProjectId, dev?.id ?? '', 'rocketflare_app', {
      createdBy: 'session_owner',
    })
    const before = cloud.neon.sql.length
    await port.ensureDev(app)
    const statements = cloud.neon.sql.slice(before).map(s => s.query)
    expect(statements.some(q => /^(CREATE ROLE|GRANT) "?rocketflare_app/i.test(q))).toBe(false)
  })

  it('repairs a dev whose session_owner an earlier Launch made through the API, and re-prepares it', async () => {
    const { cloud, f, port, app } = await setup()
    // The old way: dev, then the role and the database through Neon's API.
    const api = new NeonClient(NEON_KEY, { fetch: cloud.fetch, sleep: async () => {} })
    const main = cloud.neon.branchNamed(f.neonProjectId, 'main')
    const old = await api.createBranch(f.neonProjectId, {
      name: 'dev',
      parentId: main?.id,
      initSource: 'schema-only',
    })
    await api.createRole(f.neonProjectId, old.branch.id, 'session_owner')
    await api.createDatabase(f.neonProjectId, old.branch.id, {
      name: 'session_app',
      ownerName: 'session_owner',
    })
    expect(
      cloud.neon.branchNamed(f.neonProjectId, 'dev')?.roles.get('session_owner')
    ).toMatchObject({ superuser: true })

    const prepared = {
      devBranchId: old.branch.id,
      database: 'session_app',
      preparedCommit: 'abc1234',
      preparedAt: new Date(),
      status: 'ready' as const,
    }
    const result = await port.ensureDev({ ...app, sessionDb: prepared })
    const dev = cloud.neon.branchNamed(f.neonProjectId, 'dev')
    expect(dev?.id).toBe(old.branch.id)
    expect(dev?.roles.get('session_owner')).toMatchObject({
      superuser: false,
      createdBy: 'neondb_owner',
    })
    expect(dev?.databases.get('session_app')).toMatchObject({ owner_name: 'session_owner' })
    // Its seeded state went with the old database: the next session prepares it again.
    expect(result).toMatchObject({ devBranchId: old.branch.id, status: 'none', preparedAt: null })
  })

  it('createBranch branches dev, resets session_owner on it, and reuses the branch on a retry', async () => {
    const { cloud, f, port, app } = await setup()
    const dev = await port.ensureDev(app)
    const ref = { ...app, sessionDb: dev }
    const session = { id: crypto.randomUUID(), shortId: 'abcdefghijkl' }
    const before = cloud.callsTo('neon').length
    const branch = await port.createBranch(ref, session)
    const fake = cloud.neon.branchNamed(f.neonProjectId, 'session-abcdefghijkl')
    // It waits for create_branch (and the password reset's apply_config) — never start_compute:
    // the compute starts on its own, or on the first connection.
    const ops = cloud.neon.projects.get(f.neonProjectId)?.operations
    const polled = cloud
      .callsTo('neon')
      .slice(before)
      .map(c => c.path.match(/\/operations\/([^/]+)$/)?.[1])
      .filter((id): id is string => Boolean(id))
      .map(id => ops?.get(id)?.action)
    expect(polled).toEqual(['create_branch', 'apply_config'])
    expect(fake?.parent_id).toBe(dev.devBranchId)
    expect(branch.db).toEqual({
      provider: 'neon',
      projectId: f.neonProjectId,
      branchId: fake?.id,
      host: fake?.host,
      database: 'session_app',
      role: 'session_owner',
    })
    // The password on the branch is its own: a reset happened, and the URI carries it.
    expect(fake?.roles.get('session_owner')?.resets).toBe(1)
    const password = decodeURIComponent(new URL(branch.uri).password)
    expect(password).toBe(fake?.roles.get('session_owner')?.password)
    expect(password).not.toBe(
      cloud.neon.branchNamed(f.neonProjectId, 'dev')?.roles.get('session_owner')?.password
    )
    expect(new URL(branch.uri).searchParams.get('sslmode')).toBe('require')
    // No secret in the non-secret half.
    expect(JSON.stringify(branch.db)).not.toContain(password)

    const retried = await port.createBranch(ref, session)
    expect(retried.db.branchId).toBe(branch.db.branchId)

    await port.deleteBranch(ref, branch.db)
    expect(cloud.neon.branchNamed(f.neonProjectId, 'session-abcdefghijkl')).toBeUndefined()
    await expect(port.deleteBranch(ref, branch.db)).resolves.toBeUndefined()
  })

  it('devUriFor is dev’s session_app as session_owner, with a fresh password each time', async () => {
    const { cloud, f, port, app } = await setup()
    const dev = await port.ensureDev(app)
    const uri = await port.devUriFor({ ...app, sessionDb: dev })
    expect(new URL(uri).pathname).toBe('/session_app')
    expect(decodeURIComponent(new URL(uri).username)).toBe('session_owner')
    expect(cloud.neon.branchNamed(f.neonProjectId, 'dev')?.roles.get('session_owner')?.resets).toBe(
      1
    )
  })

  it('refuses by name without a Neon project, or before ensureDev', async () => {
    const { port, app } = await setup()
    await expect(port.ensureDev({ ...app, neonProjectId: null })).rejects.toThrow(/no Neon project/)
    await expect(
      port.createBranch({ ...app, sessionDb: null }, { id: 'x', shortId: 'y' })
    ).rejects.toThrow(/ensureDev/)
  })
})
