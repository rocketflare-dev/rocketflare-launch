/**
 * The P4 migration's DATA half (`0023_launch-p4-approvals.sql`, plan §2): P1's pending
 * `app_access_requests` become `app.access` approval requests with the same ids, then the old table
 * and its enum are dropped. The shared test database was migrated from empty, so it can never have
 * held an old row; this suite builds a scratch database at the P3 schema (every migration before
 * 0023, from a trimmed copy of the journal), writes P1-shaped rows into it, applies the rest with
 * the same `runMigrations` the deploy uses, and reads what came out.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  approvalContextSchema,
  approvalPolicySchema,
  DEFAULT_APPROVAL_POLICIES,
} from '@launch/shared/launch-approvals'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../../scripts/migrate'
import { testDatabaseUrl } from '../helpers/db'
import { WEB_ROOT } from '../helpers/source-files'

const MIGRATIONS = path.join(WEB_ROOT, 'migrations')
const P4_TAG = '0023_launch-p4-approvals'
const scratchName = `launch_p4_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
// This suite talks TCP to the compose Postgres whatever the suite's driver is.
const POSTGRES_ENV = { DATABASE_DRIVER: 'postgres' }

const admin = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} })
let scratchUrl = ''
let beforeP4 = ''
let sql: postgres.Sql

/** A copy of `migrations/` whose journal stops just before the P4 migration. */
function migrationsBeforeP4(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'launch-p4-'))
  cpSync(MIGRATIONS, dir, { recursive: true })
  const journalPath = path.join(dir, 'meta/_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[]
  }
  const at = journal.entries.findIndex(e => e.tag === P4_TAG)
  if (at === -1) throw new Error(`${P4_TAG} is not in the journal`)
  journal.entries = journal.entries.slice(0, at)
  writeFileSync(journalPath, JSON.stringify(journal))
  return dir
}

const ids = {
  tenant: crypto.randomUUID(),
  asker: crypto.randomUUID(),
  quiet: crypto.randomUUID(),
  owner: crypto.randomUUID(),
  app: crypto.randomUUID(),
  pending: crypto.randomUUID(),
  pendingNoMessage: crypto.randomUUID(),
  approved: crypto.randomUUID(),
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${scratchName}`)
  const url = new URL(testDatabaseUrl())
  url.pathname = `/${scratchName}`
  scratchUrl = url.toString()
  beforeP4 = migrationsBeforeP4()
  await runMigrations(scratchUrl, {
    migrationsFolder: beforeP4,
    quiet: true,
    maxAttempts: 5,
    env: POSTGRES_ENV,
  })

  sql = postgres(scratchUrl, { max: 1, onnotice: () => {} })
  await sql`INSERT INTO tenants (id, name, slug) VALUES (${ids.tenant}, 'Acme', ${scratchName})`
  for (const [id, email] of [
    [ids.asker, 'asker@example.test'],
    [ids.quiet, 'quiet@example.test'],
    [ids.owner, 'owner@example.test'],
  ] as const) {
    await sql`INSERT INTO users (id, email, name) VALUES (${id}, ${email}, ${email})`
  }
  await sql`INSERT INTO apps (id, tenant_id, slug, display_name, source)
            VALUES (${ids.app}, ${ids.tenant}, ${`app-${scratchName.slice(-8)}`}, 'Shop', 'imported')`
  await sql`INSERT INTO app_access_requests (id, tenant_id, app_id, user_id, message, status, created_at)
            VALUES (${ids.pending}, ${ids.tenant}, ${ids.app}, ${ids.asker}, 'For the close', 'pending',
                    now() - interval '30 days')`
  await sql`INSERT INTO app_access_requests (id, tenant_id, app_id, user_id, status)
            VALUES (${ids.pendingNoMessage}, ${ids.tenant}, ${ids.app}, ${ids.quiet}, 'pending')`
  await sql`INSERT INTO app_access_requests
              (id, tenant_id, app_id, user_id, status, decided_by_user_id, decided_at)
            VALUES (${ids.approved}, ${ids.tenant}, ${ids.app}, ${ids.owner}, 'approved', ${ids.owner}, now())`

  // The rest — P4 — exactly as a deploy applies it.
  await runMigrations(scratchUrl, {
    migrationsFolder: MIGRATIONS,
    quiet: true,
    maxAttempts: 5,
    env: POSTGRES_ENV,
  })
}, 120_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`)
  await admin.end({ timeout: 5 })
  if (beforeP4) rmSync(beforeP4, { recursive: true, force: true })
})

describe('the P4 migration moves P1 access requests onto the approvals engine', () => {
  it('copies every PENDING request, with its id, and nothing that was already decided', async () => {
    const rows = await sql<{ id: string }[]>`SELECT id FROM approval_requests ORDER BY id`
    expect(rows.map(r => r.id).sort()).toEqual([ids.pending, ids.pendingNoMessage].sort())
  })

  it('each is an app.access request for the person, who is excluded from deciding it', async () => {
    const [row] = await sql<
      {
        tenant_id: string
        kind: string
        app_id: string
        subject_type: string
        subject_id: string
        status: string
        requested_by_user_id: string
        requested_by_label: string | null
        reason: string | null
        context: unknown
        policy: unknown
        required_approvals: number
        excluded_user_ids: unknown
        expires_at: Date
        created_at: Date
        applied_at: Date | null
        apply_attempts: number
      }[]
    >`SELECT * FROM approval_requests WHERE id = ${ids.pending}`
    expect(row).toMatchObject({
      tenant_id: ids.tenant,
      kind: 'app.access',
      app_id: ids.app,
      subject_type: 'user',
      subject_id: ids.asker,
      status: 'pending',
      requested_by_user_id: ids.asker,
      requested_by_label: null,
      reason: 'For the close',
      required_approvals: 1,
      excluded_user_ids: [ids.asker],
      applied_at: null,
      apply_attempts: 0,
    })
    // The context and the policy are exactly what the engine will parse.
    expect(approvalContextSchema.parse(row?.context)).toEqual({
      kind: 'app.access',
      userId: ids.asker,
      message: 'For the close',
    })
    expect(approvalPolicySchema.parse(row?.policy)).toEqual(DEFAULT_APPROVAL_POLICIES['app.access'])
    // A 30-day-old request keeps its creation time but gets a fresh 14 days to be decided.
    const days = (d: Date) => (d.getTime() - Date.now()) / 86_400_000
    expect(days(row?.created_at ?? new Date())).toBeLessThan(-29)
    expect(days(row?.expires_at ?? new Date())).toBeGreaterThan(13.9)
    expect(days(row?.expires_at ?? new Date())).toBeLessThan(14.1)
  })

  it('a request with no message has a null reason and a null context message', async () => {
    const [row] = await sql<{ reason: string | null; context: { message: unknown } }[]>`
      SELECT reason, context FROM approval_requests WHERE id = ${ids.pendingNoMessage}`
    expect(row?.reason).toBeNull()
    expect(row?.context.message).toBeNull()
  })

  it('drops the P1 table and its enum', async () => {
    const [table] = await sql<{ t: string | null }[]>`
      SELECT to_regclass('public.app_access_requests')::text AS t`
    expect(table?.t).toBeNull()
    const types = await sql`SELECT 1 FROM pg_type WHERE typname = 'app_access_request_status'`
    expect(types).toHaveLength(0)
  })

  it('the moved rows still hold the pending-subject key: asking again is a no-op', async () => {
    const again = await sql`
      INSERT INTO approval_requests
        (tenant_id, kind, app_id, subject_type, subject_id, context, policy)
      VALUES (${ids.tenant}, 'app.access', ${ids.app}, 'user', ${ids.asker}, '{}'::jsonb, '{}'::jsonb)
      ON CONFLICT DO NOTHING RETURNING id`
    expect(again).toHaveLength(0)
  })
})
