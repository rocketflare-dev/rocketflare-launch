/**
 * The personal-credential store (§18.22, `services/sessions/credentials/store.ts`) against real
 * Postgres: sealed at rest, never in a public shape, a reconnect replaces, rotation is a
 * compare-and-set on `version`, use is a claim (one session's TURN at a time — a claim whose holder
 * is not mid-turn, or that has expired, is taken over — and stale claims are swept), tenant B never reads tenant A's, and losing the membership loses the credential.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  claim,
  getById,
  getForUser,
  listPublic,
  markNeedsLogin,
  openSecret,
  putSealed,
  release,
  removeForUser,
  resealIfVersion,
  sweepStaleClaims,
  toPublicCredential,
} from '@/api/services/sessions/credentials/store'
import { loadConfig } from '@/config'
import { agentCredentials, tenantUsers } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import {
  AGENT_SECRET_SENTINEL,
  insertSession,
  seedAgentCredential,
  seedSessionApp,
} from '../helpers/sessions'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const cfg = loadConfig(createTestEnv())

describe('agent credentials: sealed, value-free in public', () => {
  it('seals at rest, opens for the server, and lists without the value', async () => {
    const f = await createTestTenantWithUser(db, 'member')
    const { row } = await seedAgentCredential(db, f, { metadata: { plan: 'max' } })
    expect(row.secretSealed).not.toContain(AGENT_SECRET_SENTINEL)
    expect(await openSecret(cfg, row)).toBe(AGENT_SECRET_SENTINEL)

    const listed = await listPublic(db, f.tenant.id, f.user.id)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      runtime: 'claude_code',
      kind: 'claude_oauth_token',
      status: 'active',
      metadata: { plan: 'max' },
      inUse: false,
    })
    expect(JSON.stringify(listed)).not.toContain(AGENT_SECRET_SENTINEL)
    expect(JSON.stringify(listed)).not.toContain(row.secretSealed)
  })

  it('a reconnect replaces the secret, bumps the version and clears needs_login and any claim', async () => {
    const f = await createTestTenantWithUser(db, 'member')
    const { row } = await seedAgentCredential(db, f)
    await markNeedsLogin(db, f.tenant.id, row.id)
    await claim(db, { tenantId: f.tenant.id, id: row.id, sessionId: crypto.randomUUID() })
    await putSealed(db, cfg, {
      tenantId: f.tenant.id,
      userId: f.user.id,
      runtime: 'claude_code',
      kind: 'claude_oauth_token',
      secret: 'sk-ant-oat01-second',
      expiresAt: null,
      metadata: {},
    })
    const again = await getForUser(db, f.tenant.id, f.user.id, 'claude_code')
    expect(again?.id).toBe(row.id)
    expect(again?.version).toBe(row.version + 1)
    expect(again?.status).toBe('active')
    expect(again?.claimedBySessionId).toBeNull()
    expect(await openSecret(cfg, again as NonNullable<typeof again>)).toBe('sk-ant-oat01-second')
  })
})

describe('rotation is a compare-and-set', () => {
  it('only the writer holding the current version wins', async () => {
    const f = await createTestTenantWithUser(db, 'member')
    const { row } = await seedAgentCredential(db, f, { runtime: 'codex' })
    const first = await resealIfVersion(db, cfg, {
      tenantId: f.tenant.id,
      id: row.id,
      expectedVersion: row.version,
      secret: '{"tokens":"rotated-once"}',
    })
    const stale = await resealIfVersion(db, cfg, {
      tenantId: f.tenant.id,
      id: row.id,
      expectedVersion: row.version,
      secret: '{"tokens":"lost-race"}',
    })
    expect([first, stale]).toEqual([true, false])
    const now = await getById(db, f.tenant.id, row.id)
    expect(await openSecret(cfg, now as NonNullable<typeof now>)).toBe('{"tokens":"rotated-once"}')
  })
})

describe('use is a claim', () => {
  /** A tenant with an app, a Codex credential, and sessions to hold it. */
  async function claimFixture() {
    const f = await seedSessionApp(db, createFakeCloud())
    const { row } = await seedAgentCredential(db, f, { runtime: 'codex' })
    const session = (status: 'working' | 'ready' | 'shipping') =>
      insertSession(db, f, { status, runtime: 'codex', credentialSource: 'user' }).then(s => s.id)
    return { f, row, session }
  }

  it('one session’s turn holds it; a second is refused; the holder may re-claim; release frees it', async () => {
    const { f, row, session } = await claimFixture()
    const a = await session('working')
    const b = await session('working')
    expect(await claim(db, { tenantId: f.tenant.id, id: row.id, sessionId: a })).not.toBeNull()
    expect(await claim(db, { tenantId: f.tenant.id, id: row.id, sessionId: b })).toBeNull()
    expect(await claim(db, { tenantId: f.tenant.id, id: row.id, sessionId: a })).not.toBeNull()
    const held = await getById(db, f.tenant.id, row.id)
    expect(toPublicCredential(held as NonNullable<typeof held>).inUse).toBe(true)
    // Another session's release does nothing; the holder's frees it.
    await release(db, { tenantId: f.tenant.id, id: row.id, sessionId: b })
    expect(await claim(db, { tenantId: f.tenant.id, id: row.id, sessionId: b })).toBeNull()
    await release(db, { tenantId: f.tenant.id, id: row.id, sessionId: a })
    expect(await claim(db, { tenantId: f.tenant.id, id: row.id, sessionId: b })).not.toBeNull()
  })

  it('a ship’s fix turn holds it too', async () => {
    const { f, row, session } = await claimFixture()
    const shipping = await session('shipping')
    expect(
      await claim(db, { tenantId: f.tenant.id, id: row.id, sessionId: shipping })
    ).not.toBeNull()
    expect(
      await claim(db, { tenantId: f.tenant.id, id: row.id, sessionId: await session('working') })
    ).toBeNull()
  })

  // Seen live: a `wrangler dev` reload killed a turn before its `finally`, and the claim it left
  // made the next session's turn wait two hours for the expiry.
  it('a claim whose holder is no longer mid-turn (or gone) is taken over at once', async () => {
    const { f, row, session } = await claimFixture()
    const idle = await session('ready')
    await claim(db, { tenantId: f.tenant.id, id: row.id, sessionId: idle })
    const next = await session('working')
    expect(await claim(db, { tenantId: f.tenant.id, id: row.id, sessionId: next })).not.toBeNull()
    expect((await getById(db, f.tenant.id, row.id))?.claimedBySessionId).toBe(next)
    await db
      .update(agentCredentials)
      .set({ claimedBySessionId: null })
      .where(eq(agentCredentials.id, row.id))
    // A holder id with no session row at all (deleted) blocks nothing either.
    await claim(db, { tenantId: f.tenant.id, id: row.id, sessionId: crypto.randomUUID() })
    expect(await claim(db, { tenantId: f.tenant.id, id: row.id, sessionId: next })).not.toBeNull()
  })

  it('a stale claim is reclaimable, and the sweep clears it', async () => {
    const f = await createTestTenantWithUser(db, 'member')
    const { row } = await seedAgentCredential(db, f, { runtime: 'codex' })
    const past = new Date(Date.now() - 10 * 60 * 60_000)
    await claim(db, {
      tenantId: f.tenant.id,
      id: row.id,
      sessionId: crypto.randomUUID(),
      now: past,
      ttlMs: 60_000,
    })
    expect(await sweepStaleClaims(db, { tenantIds: [f.tenant.id] })).toBe(1)
    expect((await getById(db, f.tenant.id, row.id))?.claimedBySessionId).toBeNull()
    expect(await sweepStaleClaims(db, { tenantIds: [f.tenant.id] })).toBe(0)
  })
})

describe('isolation', () => {
  it('tenant B reads nothing of tenant A’s, and a removed member’s credential is gone', async () => {
    const a = await createTestTenantWithUser(db, 'member')
    const b = await createTestTenantWithUser(db, 'member')
    const { row } = await seedAgentCredential(db, a)
    expect(await getById(db, b.tenant.id, row.id)).toBeNull()
    expect(await getForUser(db, b.tenant.id, a.user.id, 'claude_code')).toBeNull()
    expect(await listPublic(db, b.tenant.id, a.user.id)).toEqual([])
    expect(await removeForUser(db, b.tenant.id, a.user.id, 'claude_code')).toBe(false)

    // The membership FK cascades: leaving the organisation takes the credential with it.
    await db
      .delete(tenantUsers)
      .where(and(eq(tenantUsers.tenantId, a.tenant.id), eq(tenantUsers.userId, a.user.id)))
    const left = await db
      .select({ id: agentCredentials.id })
      .from(agentCredentials)
      .where(eq(agentCredentials.id, row.id))
    expect(left).toEqual([])
  })
})
