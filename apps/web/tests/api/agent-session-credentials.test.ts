// @vitest-isolate
// Creates sessions through the route, which reads GLOBAL settings (`sessions_paused`,
// `session_policy`), so the credentials module is mocked over an in-memory store.
/**
 * Sessions and the runtime/credential seam (§18.22), end to end through the routes and the turn
 * runner:
 *
 * - create: a default deployment creates exactly what it always did (Claude Code, Launch's key,
 *   the stored policy frozen unchanged); the 409s for a runtime or an account not on offer, all
 *   before any row; a session on a connected personal account;
 * - the owner rule: only the account's owner sends turns to (or ships) a personal-account session —
 *   409 `session_credential_owner_only` at the route, and a backstop in the turn;
 * - the sender is recorded (`pending_message_user_id` → `user.message.userId`);
 * - the lease: a platform turn leases nothing; a `user` turn with no credential port fails by
 *   name; a port's env and files reach the process and its release always runs;
 * - money: a personal-account session has no money budget, and its usage is recorded with a null
 *   cost that the summary never prices.
 */
import {
  DEFAULT_SESSION_POLICY,
  type SessionPolicy,
  sessionDetailResponseSchema,
} from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { summarizeUsage } from '@/api/services/ai/usage'
import { checkBudget } from '@/api/services/sessions/budget'
import { PLATFORM_LEASE } from '@/api/services/sessions/credentials/lease'
import { recordSessionUsage } from '@/api/services/sessions/egress/anthropic'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import type { SessionCredentialPort } from '@/api/services/sessions/runtimes/types'
import {
  CREDENTIAL_OWNER_ONLY_MESSAGE,
  type RunTurnOptions,
  runTurn,
} from '@/api/services/sessions/turn'
import { aiUsage, type SessionRow, sessions } from '@/db/schema'
import {
  createTestSession,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { claudeStreamJson } from '../helpers/fake-anthropic'
import { createFakeCloud } from '../helpers/fake-cloud'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import { json, request } from '../helpers/request'
import {
  createFakeSessionPorts,
  insertSession,
  seedAgentCredential,
  seedSessionApp,
} from '../helpers/sessions'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

const store = vi.hoisted(() => ({ credentials: new Map(), settings: new Map() }))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

const db = setupTestDatabase()

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))
const FAST: RunTurnOptions = { sleep: tick, cancelPollMs: 5, flushMs: 5 }

const post = (path: string, headers: Record<string, string>, env: TestEnv, body: unknown = {}) =>
  request(path, { method: 'POST', headers }, { env, json: body })

/** Store a session policy in the in-memory settings (the Setup page's Coding agents card). */
function storePolicy(runtimes: SessionPolicy['runtimes']) {
  store.settings.set('session_policy', { runtimes })
}

/** Claude Code may bill a personal account (the admin chose "Either" on the Setup page). */
const personalEnv = () => {
  storePolicy({
    claude_code: {
      enabled: true,
      model: DEFAULT_SESSION_POLICY.model,
      credentialMode: 'user_or_platform',
    },
  })
  return createTestEnv()
}

beforeEach(() => {
  store.settings.clear()
})

async function sessionRows(appId: string, tenantId: string) {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.appId, appId)))
}

async function reload(row: SessionRow): Promise<SessionRow> {
  const [latest] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
  if (!latest) throw new Error('gone')
  return latest
}

/** An admin in the fixture's tenant: may see and drive every session there. */
async function admin(tenantId: string) {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, 'admin')
  return { user, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)) }
}

describe('creating a session', () => {
  it('a default deployment creates exactly what it always did', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const res = await post(`/api/apps/${f.app.id}/sessions`, f.cookie, createTestEnv())
    expect(res.status).toBe(202)
    const { session } = sessionDetailResponseSchema.parse(await json(res))
    expect(session).toMatchObject({
      runtime: 'claude_code',
      credentialSource: 'platform',
      credentialOwnerUserId: null,
    })
    const [row] = await sessionRows(f.app.id, f.tenant.id)
    expect(row).toMatchObject({
      runtime: 'claude_code',
      credentialSource: 'platform',
      agentCredentialId: null,
    })
    // The frozen policy is the stored one, key for key — no runtime fields smuggled in.
    expect(Object.keys(row?.policy ?? {}).sort()).toEqual(
      Object.keys(DEFAULT_SESSION_POLICY).sort()
    )
  })

  it('409 session_runtime_disabled for a runtime the deployment does not run, before any row', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const res = await post(`/api/apps/${f.app.id}/sessions`, f.cookie, createTestEnv(), {
      runtime: 'codex',
    })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ statusCode: 409, code: 'session_runtime_disabled' })
    expect(await sessionRows(f.app.id, f.tenant.id)).toEqual([])
  })

  it('honours the Coding agents setting: Claude off and Codex on — a bare start runs Codex on its model', async () => {
    storePolicy({
      claude_code: { enabled: false, model: 'claude-sonnet-4-5', credentialMode: 'platform' },
      codex: { enabled: true, model: 'gpt-6.1-sol', credentialMode: 'platform' },
    })
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const claude = await post(`/api/apps/${f.app.id}/sessions`, f.cookie, createTestEnv(), {
      runtime: 'claude_code',
    })
    expect(claude.status).toBe(409)
    expect(await json(claude)).toMatchObject({ code: 'session_runtime_disabled' })

    const res = await post(`/api/apps/${f.app.id}/sessions`, f.cookie, createTestEnv())
    expect(res.status).toBe(202)
    const [row] = await sessionRows(f.app.id, f.tenant.id)
    expect(row).toMatchObject({ runtime: 'codex', credentialSource: 'platform' })
    // The frozen policy names the chosen runtime's model — the only one its egress lets through.
    expect(row?.policy.model).toBe('gpt-6.1-sol')
  })

  it('409 agent_credential_not_allowed for a personal account where none may be used', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    await seedAgentCredential(db, f)
    const res = await post(`/api/apps/${f.app.id}/sessions`, f.cookie, createTestEnv(), {
      credential: 'user',
    })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'agent_credential_not_allowed' })
    expect(await sessionRows(f.app.id, f.tenant.id)).toEqual([])
  })

  it('409 agent_credential_required with no connected account, or one that needs a reconnect', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const none = await post(`/api/apps/${f.app.id}/sessions`, f.cookie, personalEnv(), {
      credential: 'user',
    })
    expect(none.status).toBe(409)
    expect(await json(none)).toMatchObject({ code: 'agent_credential_required' })
    await seedAgentCredential(db, f, { status: 'needs_login' })
    const stale = await post(`/api/apps/${f.app.id}/sessions`, f.cookie, personalEnv(), {
      credential: 'user',
    })
    expect(stale.status).toBe(409)
    expect(((await json(stale)) as { error: string }).error).toMatch(/Reconnect/)
    expect(await sessionRows(f.app.id, f.tenant.id)).toEqual([])
  })

  it('on a connected account: the session bills it, for its whole life', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const { row: credential } = await seedAgentCredential(db, f)
    const res = await post(`/api/apps/${f.app.id}/sessions`, f.cookie, personalEnv(), {
      credential: 'user',
    })
    expect(res.status).toBe(202)
    const { session } = sessionDetailResponseSchema.parse(await json(res))
    expect(session).toMatchObject({
      runtime: 'claude_code',
      credentialSource: 'user',
      credentialOwnerUserId: f.user.id,
    })
    const [row] = await sessionRows(f.app.id, f.tenant.id)
    expect(row?.agentCredentialId).toBe(credential.id)
  })
})

describe('only the account owner drives a personal-account session', () => {
  it('a colleague’s turn and ship are 409 session_credential_owner_only; the owner’s turn is recorded as theirs', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const { row: credential } = await seedAgentCredential(db, f)
    const row = await insertSession(db, f, {
      status: 'ready',
      credentialSource: 'user',
      agentCredentialId: credential.id,
    })
    const other = await admin(f.tenant.id)
    const env = personalEnv()

    const theirs = await post(`/api/sessions/${row.id}/turns`, other.cookie, env, {
      message: 'hello',
    })
    expect(theirs.status).toBe(409)
    expect(await json(theirs)).toMatchObject({ code: 'session_credential_owner_only' })
    const ship = await post(`/api/sessions/${row.id}/ship`, other.cookie, env)
    expect(ship.status).toBe(409)
    expect(await json(ship)).toMatchObject({ code: 'session_credential_owner_only' })
    // They can still read it.
    const read = await request(`/api/sessions/${row.id}`, { headers: other.cookie }, { env })
    expect(read.status).toBe(200)

    const mine = await post(`/api/sessions/${row.id}/turns`, f.cookie, env, { message: 'hello' })
    expect(mine.status).toBe(202)
    expect((await reload(row)).pendingMessageUserId).toBe(f.user.id)
  })

  it('a platform session takes anyone’s turn who can drive it, and records who sent it', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const row = await insertSession(db, f, { status: 'ready' })
    const other = await admin(f.tenant.id)
    const res = await post(`/api/sessions/${row.id}/turns`, other.cookie, createTestEnv(), {
      message: 'from the admin',
    })
    expect(res.status).toBe(202)
    expect((await reload(row)).pendingMessageUserId).toBe(other.user.id)
  })
})

describe('the turn', () => {
  it('names the real sender in user.message (the creator for a row without one)', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const other = await admin(f.tenant.id)
    const row = await insertSession(db, f, {
      status: 'ready',
      pendingMessage: 'Change the heading',
      pendingMessageUserId: other.user.id,
    })
    const ports = createFakeSessionPorts().script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ text: 'Done.' }))
    )
    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome.status).toBe('completed')
    const events = await listSessionEvents(db, row.tenantId, row.id)
    const message = events.find(e => e.type === 'user.message')
    expect((message?.data as { userId?: string } | undefined)?.userId).toBe(other.user.id)
    expect((await reload(row)).pendingMessageUserId).toBeNull()
  })

  it('backstop: a personal-account session drops a message its owner did not send', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const other = await admin(f.tenant.id)
    const row = await insertSession(db, f, {
      status: 'ready',
      credentialSource: 'user',
      pendingMessage: 'sneaky',
      pendingMessageUserId: other.user.id,
    })
    const ports = createFakeSessionPorts()
    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome).toEqual({
      status: 'rejected',
      sessionId: row.id,
      reason: 'credential_owner_only',
    })
    const events = await listSessionEvents(db, row.tenantId, row.id)
    expect(events.map(e => e.type)).toEqual(['error'])
    expect((events[0]?.data as { message?: string } | undefined)?.message).toBe(
      CREDENTIAL_OWNER_ONLY_MESSAGE
    )
    expect((ports.sandbox(row.id) as FakeSandbox).commands).toEqual([])
  })

  it('a personal-account turn with no credential port fails by name, and never starts the CLI', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, {
      status: 'ready',
      credentialSource: 'user',
      pendingMessage: 'go',
    })
    const ports = createFakeSessionPorts()
    const outcome = await runTurn(db, ports, row, FAST)
    expect(outcome.status).toBe('failed')
    const events = await listSessionEvents(db, row.tenantId, row.id)
    const failed = events.find(e => e.type === 'turn.failed')
    expect((failed?.data as { message?: string } | undefined)?.message).toMatch(/personal account/)
    expect((ports.sandbox(row.id) as FakeSandbox).processes).toEqual([])
  })

  it('a lease’s env and files reach the process, after the placeholders; release always runs', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, {
      status: 'ready',
      credentialSource: 'user',
      pendingMessage: 'go',
    })
    let released = 0
    const credentials: SessionCredentialPort = {
      lease: async () => ({
        source: 'user',
        env: { LAUNCH_LEASE_MARKER: '1' },
        files: [{ path: '/root/.lease/marker', content: 'leased' }],
        release: async () => {
          released++
        },
      }),
    }
    const ports = createFakeSessionPorts({ credentials }).script(sb =>
      sb.onProcess(/claude -p/, claudeStreamJson({ text: 'ok' }))
    )
    expect((await runTurn(db, ports, row, FAST)).status).toBe('completed')
    const sandbox = ports.sandbox(row.id) as FakeSandbox
    expect(sandbox.files.get('/root/.lease/marker')).toBe('leased')
    expect(sandbox.processes[0]?.opts?.env).toMatchObject({
      LAUNCH_LEASE_MARKER: '1',
      IS_SANDBOX: '1',
    })
    expect(released).toBe(1)

    // A turn whose process cannot start still releases.
    await db
      .update(sessions)
      .set({ pendingMessage: 'again' })
      .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
    sandbox.failNext('startProcess', new Error('boom'))
    expect((await runTurn(db, ports, row, FAST)).status).toBe('failed')
    expect(released).toBe(2)
  })

  it('a platform turn leases nothing: the PLATFORM_LEASE is empty', () => {
    expect(PLATFORM_LEASE).toMatchObject({ source: 'platform', env: {}, files: [] })
  })
})

describe('money', () => {
  it('a personal-account session has no money budget; a platform one over its cap is blocked', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const over = { costMicrocents: 10_000_000_000 }
    const user = await insertSession(db, f, { credentialSource: 'user', ...over })
    const platform = await insertSession(db, f, over)
    expect(await checkBudget(db, user)).toEqual({ ok: true })
    expect((await checkBudget(db, platform)).ok).toBe(false)
  })

  it('subscription usage: tokens recorded, cost null, the session total unmoved, never priced in the summary', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { credentialSource: 'user' })
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }
    await recordSessionUsage(db, row, 'claude-sonnet-4-5', usage, { billing: 'subscription' })
    const [ledger] = await db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.tenantId, f.tenant.id), eq(aiUsage.sessionId, row.id)))
    expect(ledger).toMatchObject({
      billing: 'subscription',
      costMicrocents: null,
      inputTokens: 1000,
    })
    const after = await reload(row)
    expect(Number(after.costMicrocents)).toBe(0)
    expect(Number(after.tokensIn)).toBe(1000)
    const summary = await summarizeUsage(db, f.tenant.id)
    const line = summary.rows.find(r => r.model === 'claude-sonnet-4-5')
    // Nothing Launch paid: zero, not an estimate from the price table, and not "unpriced" either.
    expect(line?.costMicrocents).toBe(0)
    expect(line?.unpricedCalls).toBe(0)
  })
})
