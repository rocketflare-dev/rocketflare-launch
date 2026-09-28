/**
 * The two `SessionDbPort` adapters (Launch P3, slice 3b):
 *
 * - `NeonSessionDb` over the FakeCloud's Neon: `dev` is cut `schema-only` from `main` with
 *   `session_owner` and `session_app`; a session's branch is a child of `dev` with the role's
 *   password RESET on it; every write is retry-safe; deleting twice is fine.
 * - `LocalSessionDb` against the real test Postgres: `CREATE DATABASE … TEMPLATE`, even while
 *   something is connected to the template (the Neon proxy pools connections), and `DROP … FORCE`.
 */
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import {
  LOCAL_NEON_HOST,
  LocalSessionDb,
  localDevDatabase,
  localSessionDatabase,
  withDatabase,
} from '@/api/services/sessions/db/local-session-db'
import { NeonSessionDb } from '@/api/services/sessions/db/neon-session-db'
import type { SessionAppRef } from '@/api/services/sessions/ports'
import { type AppConfig, loadConfig } from '@/config'
import { createDatabase, rows } from '@/db/client'
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

  it('createBranch branches dev, resets session_owner on it, and reuses the branch on a retry', async () => {
    const { cloud, f, port, app } = await setup()
    const dev = await port.ensureDev(app)
    const ref = { ...app, sessionDb: dev }
    const session = { id: crypto.randomUUID(), shortId: 'abcdefghijkl' }
    const branch = await port.createBranch(ref, session)
    const fake = cloud.neon.branchNamed(f.neonProjectId, 'session-abcdefghijkl')
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

describe('LocalSessionDb (the laptop: TEMPLATE databases)', () => {
  const adminUrl = process.env.DATABASE_URL as string
  const cfg = { ...loadConfig(createTestEnv()), SESSION_LOCAL_DB_URL: adminUrl } as AppConfig
  const slug = `p3b-${crypto.randomUUID().slice(0, 8)}`
  const app = { slug } as SessionAppRef
  const port = new LocalSessionDb(cfg)
  const created: string[] = []

  afterAll(async () => {
    const admin = createDatabase(adminUrl)
    try {
      for (const name of created)
        await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))
    } finally {
      await admin.close()
    }
  })

  it('names are safe identifiers', () => {
    expect(localDevDatabase('my-app')).toBe('launch_sessdev_my_app')
    expect(localSessionDatabase('abcdefghijkl')).toBe('launch_sess_abcdefghijkl')
    expect(() => localDevDatabase('x"; drop')).not.toThrow()
    expect(localDevDatabase('x"; drop')).toMatch(/^launch_sessdev_[a-z0-9_]+$/)
    expect(withDatabase('postgresql://u:p@localhost:5433/postgres?x=1', 'db2')).toBe(
      'postgresql://u:p@localhost:5433/db2?x=1'
    )
  })

  it('ensureDev creates the template; createBranch copies it even while it is in use; deleteBranch drops', async () => {
    const dev = await port.ensureDev(app)
    created.push(dev.database)
    expect(dev).toMatchObject({
      devBranchId: null,
      database: localDevDatabase(slug),
      status: 'none',
    })
    await expect(port.ensureDev(app)).resolves.toMatchObject({ database: dev.database })

    // "Prepare": a table and a row in the template, and a connection left open (the proxy's pool).
    // The container's URI is Neon-shaped (the kit's bootstrap wants `*.neon.tech` for its neon
    // driver; the proxy ignores the host). This test talks to Postgres directly.
    const devUri = await port.devUriFor(app)
    expect(new URL(devUri).hostname).toBe(LOCAL_NEON_HOST)
    expect(new URL(devUri).pathname).toBe(`/${dev.database}`)
    const holder = createDatabase(withDatabase(adminUrl, dev.database))
    await holder.db.execute(sql`create table seeded (v text)`)
    await holder.db.execute(sql`insert into seeded values ('from dev')`)

    const shortId = 'lmnopqrstuvw'
    try {
      const branch = await port.createBranch(app, { id: crypto.randomUUID(), shortId })
      created.push(branch.db.database)
      expect(branch.db).toMatchObject({
        provider: 'local',
        projectId: null,
        database: localSessionDatabase(shortId),
        branchId: localSessionDatabase(shortId),
      })
      expect(new URL(branch.uri).pathname).toBe(`/${localSessionDatabase(shortId)}`)
      expect(new URL(branch.uri).hostname).toBe(LOCAL_NEON_HOST)
      const copy = createDatabase(withDatabase(adminUrl, branch.db.database))
      try {
        const found = rows<{ v: string }>(await copy.db.execute(sql`select v from seeded`))
        expect(found).toEqual([{ v: 'from dev' }])
      } finally {
        await copy.close()
      }
      // A retry finds it made.
      await expect(port.createBranch(app, { id: 'x', shortId })).resolves.toMatchObject({
        db: { database: branch.db.database },
      })
      await port.deleteBranch(app, branch.db)
      await port.deleteBranch(app, branch.db)
      const admin = createDatabase(adminUrl)
      try {
        const left = rows(
          await admin.db.execute(
            sql`select datname from pg_database where datname = ${branch.db.database}`
          )
        )
        expect(left).toEqual([])
      } finally {
        await admin.close()
      }
    } finally {
      await holder.close()
    }
  })

  it('refuses without SESSION_LOCAL_DB_URL', async () => {
    const bare = new LocalSessionDb({ ...cfg, SESSION_LOCAL_DB_URL: undefined })
    await expect(bare.ensureDev(app)).rejects.toThrow(/SESSION_LOCAL_DB_URL/)
  })
})
