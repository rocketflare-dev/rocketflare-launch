// @vitest-isolate
// Reads the GLOBAL `session_policy` setting, so the credentials module is mocked over a store.
/**
 * Personal AI accounts under `/api/me` (§18.22, `routes/me-agents.ts`): the offer and the caller's
 * accounts, disconnect, and the relayed sign-in's routes — which START a login (a row and a
 * Workflow instance) and never run one. Covers: 401 without a session; 409 when the session
 * policy keeps a runtime's personal accounts off (the default, or "Launch" chosen on the Setup
 * page), 503 without the binding; 202 + exactly one instance;
 * 409 for a second active login; the code sealed on the row and a wake with an EMPTY payload;
 * cancel; tenant and person isolation (the same 404 as a missing row); and that no credential or
 * code appears in any response.
 *
 * Every role may run sessions, so no role is refused `create Session`; there is no 403 case.
 */
import {
  AGENT_LOGIN_CODE_EVENT,
  agentAccountsResponseSchema,
  agentLoginResponseSchema,
} from '@launch/shared/launch-agents'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentCredentials, agentLogins, auditEvents } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { AGENT_SECRET_SENTINEL, seedAgentCredential } from '../helpers/sessions'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const store = vi.hoisted(() => ({ credentials: new Map(), settings: new Map() }))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

const db = setupTestDatabase()

/** The Setup page lets Claude Code bill a personal account ("Either"). */
const enabledEnv = (overrides: Partial<TestEnv> = {}) => {
  store.settings.set('session_policy', {
    runtimes: {
      claude_code: {
        enabled: true,
        model: 'claude-sonnet-4-5',
        credentialMode: 'user_or_platform',
      },
    },
  })
  return createTestEnv(overrides)
}

beforeEach(() => {
  store.settings.clear()
})

async function person(role: 'owner' | 'member' = 'member') {
  const f = await createTestTenantWithUser(db, role)
  const cookie = sessionCookieHeader(await createTestSession(db, f.user.id, f.tenant.id))
  return { ...f, cookie }
}

const send = (
  method: string,
  path: string,
  headers: Record<string, string>,
  env: TestEnv,
  body?: unknown
) => request(path, { method, headers }, { env, ...(body !== undefined ? { json: body } : {}) })

describe('GET /api/me/agent-credentials', () => {
  it('401 without a session, with the error envelope', async () => {
    const res = await request('/api/me/agent-credentials')
    expect(res.status).toBe(401)
    expect(await json(res)).toMatchObject({ statusCode: 401, error: expect.any(String) })
  })

  it('by default offers Claude Code on Launch’s key only, and lists the caller’s accounts value-free', async () => {
    const p = await person()
    await seedAgentCredential(db, p)
    const res = await send('GET', '/api/me/agent-credentials', p.cookie, createTestEnv())
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(AGENT_SECRET_SENTINEL)
    const body = agentAccountsResponseSchema.parse(JSON.parse(text))
    expect(body.runtimes.find(r => r.runtime === 'claude_code')).toMatchObject({
      enabled: true,
      credentialMode: 'platform',
      userCredentials: false,
    })
    expect(body.runtimes.find(r => r.runtime === 'codex')?.enabled).toBe(false)
    expect(body.credentials.map(c => c.runtime)).toEqual(['claude_code'])
    expect(body.logins).toEqual([])
  })

  it('never lists another person’s, or another organisation’s, accounts', async () => {
    const a = await person()
    const b = await person()
    await seedAgentCredential(db, a)
    const colleague = await createTestUser(db)
    await linkUserToTenant(db, colleague.id, a.tenant.id, 'member')
    const colleagueCookie = sessionCookieHeader(
      await createTestSession(db, colleague.id, a.tenant.id)
    )
    for (const cookie of [b.cookie, colleagueCookie]) {
      const res = await send('GET', '/api/me/agent-credentials', cookie, enabledEnv())
      expect(agentAccountsResponseSchema.parse(await json(res)).credentials).toEqual([])
    }
  })
})

describe('DELETE /api/me/agent-credentials/:runtime', () => {
  it('disconnects (audited, no value in the audit row); a second delete is 404', async () => {
    const p = await person()
    await seedAgentCredential(db, p)
    const res = await send(
      'DELETE',
      '/api/me/agent-credentials/claude_code',
      p.cookie,
      createTestEnv()
    )
    expect(res.status).toBe(204)
    const left = await db
      .select()
      .from(agentCredentials)
      .where(
        and(eq(agentCredentials.tenantId, p.tenant.id), eq(agentCredentials.userId, p.user.id))
      )
    expect(left).toEqual([])
    const audit = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, p.tenant.id),
          eq(auditEvents.action, 'agent_credential.removed')
        )
      )
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit)).not.toContain(AGENT_SECRET_SENTINEL)
    const again = await send(
      'DELETE',
      '/api/me/agent-credentials/claude_code',
      p.cookie,
      createTestEnv()
    )
    expect(again.status).toBe(404)
    expect((await json(again)) as { code?: string }).toMatchObject({
      code: 'agent_credential_not_found',
    })
  })

  it('an unknown runtime is a 400', async () => {
    const p = await person()
    const res = await send('DELETE', '/api/me/agent-credentials/cursor', p.cookie, createTestEnv())
    expect(res.status).toBe(400)
  })
})

describe('POST /api/me/agent-logins', () => {
  it('409 agent_logins_disabled with nothing set on the Setup page, before any row', async () => {
    const p = await person()
    const env = createTestEnv()
    const res = await send('POST', '/api/me/agent-logins', p.cookie, env, {
      runtime: 'claude_code',
    })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'agent_logins_disabled', statusCode: 409 })
    expect(stubs(env).agentLoginWorkflow?.created).toEqual([])
    const rows = await db.select().from(agentLogins).where(eq(agentLogins.userId, p.user.id))
    expect(rows).toEqual([])
  })

  it('503 agent_logins_not_configured without the Workflow binding', async () => {
    const p = await person()
    const env = enabledEnv({ AGENT_LOGIN_WORKFLOW: undefined })
    const res = await send('POST', '/api/me/agent-logins', p.cookie, env, {
      runtime: 'claude_code',
    })
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({ code: 'agent_logins_not_configured' })
  })

  it('202: a starting row and exactly one instance, ids only; a second is 409', async () => {
    const p = await person()
    const env = enabledEnv()
    const res = await send('POST', '/api/me/agent-logins', p.cookie, env, {
      runtime: 'claude_code',
    })
    expect(res.status).toBe(202)
    const { login } = agentLoginResponseSchema.parse(await json(res))
    expect(login).toMatchObject({
      runtime: 'claude_code',
      status: 'starting',
      needsCode: true,
      verificationUrl: null,
    })
    expect(stubs(env).agentLoginWorkflow?.created).toEqual([
      { id: login.id, params: { loginId: login.id, tenantId: p.tenant.id } },
    ])
    const second = await send('POST', '/api/me/agent-logins', p.cookie, env, {
      runtime: 'claude_code',
    })
    expect(second.status).toBe(409)
    expect(await json(second)).toMatchObject({ code: 'agent_login_in_progress' })
    expect(stubs(env).agentLoginWorkflow?.created).toHaveLength(1)
  })

  it('a runtime the setting keeps off (Codex, by default) is refused', async () => {
    const p = await person()
    const res = await send('POST', '/api/me/agent-logins', p.cookie, enabledEnv(), {
      runtime: 'codex',
    })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'agent_logins_disabled' })
  })

  it('a runtime that is on but billed to Launch only refuses a personal sign-in', async () => {
    const p = await person()
    store.settings.set('session_policy', {
      runtimes: {
        claude_code: { enabled: true, model: 'claude-sonnet-4-5', credentialMode: 'platform' },
        codex: { enabled: true, model: 'gpt-6.1-sol', credentialMode: 'user' },
      },
    })
    const env = createTestEnv()
    const claude = await send('POST', '/api/me/agent-logins', p.cookie, env, {
      runtime: 'claude_code',
    })
    expect(claude.status).toBe(409)
    expect(await json(claude)).toMatchObject({
      code: 'agent_logins_disabled',
      details: { runtime: 'claude_code' },
    })
    const codex = await send('POST', '/api/me/agent-logins', p.cookie, env, { runtime: 'codex' })
    expect(codex.status).toBe(202)
  })
})

describe('the login in flight', () => {
  async function started() {
    const p = await person()
    const env = enabledEnv()
    const res = await send('POST', '/api/me/agent-logins', p.cookie, env, {
      runtime: 'claude_code',
    })
    const { login } = agentLoginResponseSchema.parse(await json(res))
    return { p, env, login }
  }

  it('GET is the caller’s own; another person or organisation gets the same 404', async () => {
    const { p, env, login } = await started()
    const own = await send('GET', `/api/me/agent-logins/${login.id}`, p.cookie, env)
    expect(agentLoginResponseSchema.parse(await json(own)).login.id).toBe(login.id)
    const other = await person()
    const theirs = await send('GET', `/api/me/agent-logins/${login.id}`, other.cookie, env)
    expect(theirs.status).toBe(404)
    expect(await json(theirs)).toMatchObject({ code: 'agent_login_not_found' })
  })

  it('a code before the URL is shown is 409; once awaiting, it is sealed and the wake carries nothing', async () => {
    const { p, env, login } = await started()
    const code = 'pasted-code-SENTINEL-1234'
    const early = await send('POST', `/api/me/agent-logins/${login.id}/code`, p.cookie, env, {
      code,
    })
    expect(early.status).toBe(409)
    expect(await json(early)).toMatchObject({ code: 'agent_login_not_waiting' })

    await db
      .update(agentLogins)
      .set({ status: 'awaiting_user', verificationUrl: 'https://claude.ai/oauth/authorize?x=1' })
      .where(and(eq(agentLogins.tenantId, p.tenant.id), eq(agentLogins.id, login.id)))
    const res = await send('POST', `/api/me/agent-logins/${login.id}/code`, p.cookie, env, { code })
    expect(res.status).toBe(202)
    const text = await res.text()
    expect(text).not.toContain(code)
    expect(agentLoginResponseSchema.parse(JSON.parse(text)).login.status).toBe('submitting')
    const [row] = await db.select().from(agentLogins).where(eq(agentLogins.id, login.id))
    expect(row?.codeSealed).toBeTruthy()
    expect(row?.codeSealed).not.toContain(code)
    expect(stubs(env).agentLoginWorkflow?.events).toEqual([
      { instanceId: login.id, type: AGENT_LOGIN_CODE_EVENT, payload: {} },
    ])
    // A second paste is a 409: the row has moved on.
    const again = await send('POST', `/api/me/agent-logins/${login.id}/code`, p.cookie, env, {
      code,
    })
    expect(again.status).toBe(409)
  })

  it('cancel ends it and wakes the instance; a second cancel is 409; a new login may start', async () => {
    const { p, env, login } = await started()
    const res = await send('POST', `/api/me/agent-logins/${login.id}/cancel`, p.cookie, env)
    expect(res.status).toBe(200)
    expect(agentLoginResponseSchema.parse(await json(res)).login.status).toBe('cancelled')
    expect(stubs(env).agentLoginWorkflow?.events.map(e => e.type)).toEqual([AGENT_LOGIN_CODE_EVENT])
    const again = await send('POST', `/api/me/agent-logins/${login.id}/cancel`, p.cookie, env)
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ code: 'agent_login_finished' })
    const fresh = await send('POST', '/api/me/agent-logins', p.cookie, env, {
      runtime: 'claude_code',
    })
    expect(fresh.status).toBe(202)
  })

  it('the accounts list shows the login in flight', async () => {
    const { p, env, login } = await started()
    const res = await send('GET', '/api/me/agent-credentials', p.cookie, env)
    const body = agentAccountsResponseSchema.parse(await json(res))
    expect(body.logins.map(l => l.id)).toEqual([login.id])
    expect(body.runtimes.find(r => r.runtime === 'claude_code')).toMatchObject({
      credentialMode: 'user_or_platform',
      userCredentials: true,
    })
  })
})
