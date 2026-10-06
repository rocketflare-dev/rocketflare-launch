// @vitest-isolate
// Mocks the platform credential store: `launch_settings` is global and `setup.test.ts` owns it.
/**
 * The Setup page's Coding agents card — `PUT /api/platform/setup/session-agents` and the overview's
 * `sessionAgents` (§18.22) — through the real app, with `launch_settings` / `admin_credentials` in
 * memory (`credential-store.ts`). Covers: the fail-closed defaults (Claude Code on Launch's key,
 * Codex off); a change merged into `session_policy.runtimes` with the policy's budgets kept and
 * Claude's model mirrored onto `model`; `setting.changed` with the effective before and after (and
 * none for a no-op); an unpriced model and an unknown runtime refused (400) before anything is
 * stored; "nothing enabled" refused (409); readiness — Launch's key from the sealed credential or
 * the Worker secret, and connected personal accounts counted in the admin's organisation only; and
 * 401 / 403 for anyone who cannot administer the platform.
 */
import { DEFAULT_SESSION_POLICY } from '@launch/shared/launch-sessions'
import { type SessionAgentStatus, setupOverviewSchema } from '@launch/shared/launch-setup'
import { and, asc, eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { auditEvents } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenant,
  createTestTenantWithUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { storeCredential } from '../helpers/credential-store'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { seedAgentCredential } from '../helpers/sessions'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

const db = setupTestDatabase()
let admin: { cookie: Record<string, string>; tenantId: string; userId: string }

beforeAll(async () => {
  const user = await createTestGlobalAdmin(db)
  const tenant = await createTestTenant(db)
  await linkUserToTenant(db, user.id, tenant.id, 'owner')
  admin = {
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
    tenantId: tenant.id,
    userId: user.id,
  }
})
beforeEach(() => {
  store.settings.clear()
  store.credentials.clear()
})

/** No platform AI secrets unless a test sets one: readiness reads only whether they are set. */
const noSecrets = (overrides: Partial<TestEnv> = {}) =>
  createTestEnv({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', ...overrides })

function call(
  method: string,
  body?: unknown,
  opts: { cookie?: Record<string, string>; env?: TestEnv } = {}
) {
  return request(
    `/api/platform/setup${method === 'GET' ? '' : '/session-agents'}`,
    { method, headers: opts.cookie ?? admin.cookie },
    { env: opts.env ?? noSecrets(), ...(body === undefined ? {} : { json: body }) }
  )
}

async function agents(res: Response): Promise<Record<string, SessionAgentStatus>> {
  const overview = setupOverviewSchema.parse(await json(res))
  return Object.fromEntries(overview.sessionAgents.runtimes.map(r => [r.runtime, r]))
}

async function agentAudits() {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, admin.tenantId),
        eq(auditEvents.action, 'setting.changed'),
        eq(auditEvents.targetId, 'session_policy.runtimes')
      )
    )
    .orderBy(asc(auditEvents.at))
}

const codexOn = { enabled: true, model: 'gpt-6.1-sol', credentialMode: 'platform' } as const

describe('the overview', () => {
  it('fails closed with nothing stored: Claude Code on Launch’s key, Codex off', async () => {
    const res = await call('GET')
    expect(res.status).toBe(200)
    const { claude_code, codex } = await agents(res)
    // No model pinned: each agent runs its own default.
    expect(DEFAULT_SESSION_POLICY.model).toBeNull()
    expect(claude_code).toMatchObject({
      enabled: true,
      model: null,
      credentialMode: 'platform',
      isDefault: true,
      platformKey: { kind: 'anthropic_api_key', source: null },
      minImage: null,
    })
    expect(codex).toMatchObject({
      enabled: false,
      model: null,
      credentialMode: 'platform',
      isDefault: true,
      platformKey: { kind: 'openai_api_key', source: null },
      minImage: 'session-6',
    })
    expect(claude_code?.models).toContain('claude-opus-5-5')
  })

  it('an old stored policy (no runtimes) still reads as Claude Code on its own model', async () => {
    store.settings.set('session_policy', { model: 'claude-opus-4-1', maxTurns: 10 })
    const { claude_code, codex } = await agents(await call('GET'))
    expect(claude_code).toMatchObject({
      enabled: true,
      model: 'claude-opus-4-1',
      credentialMode: 'platform',
    })
    expect(codex?.enabled).toBe(false)
  })

  it('readiness: Launch’s key from the credential or the secret, and accounts in this organisation', async () => {
    storeCredential(store, 'openai_api_key', { apiKey: `sk-proj-${'x'.repeat(30)}` })
    await seedAgentCredential(
      db,
      { tenant: { id: admin.tenantId }, user: { id: admin.userId } },
      {
        runtime: 'codex',
        kind: 'codex_chatgpt_auth',
      }
    )
    // Someone else's organisation: never counted.
    const other = await createTestTenantWithUser(db, 'member')
    await seedAgentCredential(db, other, { runtime: 'codex', kind: 'codex_chatgpt_auth' })
    const env = noSecrets({ ANTHROPIC_API_KEY: 'sk-ant-api03-test-secret-value' })
    const { claude_code, codex } = await agents(await call('GET', undefined, { env }))
    expect(claude_code?.platformKey.source).toBe('secret')
    expect(codex?.platformKey.source).toBe('credential')
    expect(codex?.connectedAccounts).toBe(1)
    expect(claude_code?.connectedAccounts).toBe(0)
  })
})

describe('PUT /session-agents', () => {
  it('merges into the policy, keeping its budgets, and audits the effective before and after', async () => {
    store.settings.set('session_policy', { maxSessionUsd: 25, maxTurns: 40 })
    const audited = (await agentAudits()).length
    const res = await call('PUT', {
      runtimes: {
        claude_code: {
          enabled: true,
          model: 'claude-opus-4-1',
          credentialMode: 'user_or_platform',
        },
        codex: codexOn,
      },
    })
    expect(res.status).toBe(200)
    const { claude_code, codex } = await agents(res)
    expect(claude_code).toMatchObject({
      model: 'claude-opus-4-1',
      credentialMode: 'user_or_platform',
      isDefault: false,
    })
    expect(codex).toMatchObject({ enabled: true, isDefault: false })

    expect(store.settings.get('session_policy')).toEqual({
      maxSessionUsd: 25,
      maxTurns: 40,
      model: 'claude-opus-4-1',
      runtimes: {
        claude_code: {
          enabled: true,
          model: 'claude-opus-4-1',
          credentialMode: 'user_or_platform',
        },
        codex: codexOn,
      },
    })
    const audits = await agentAudits()
    expect(audits).toHaveLength(audited + 1)
    const audit = audits.at(-1)
    expect(audit?.summary).toEqual({
      before: {
        runtimes: {
          claude_code: {
            enabled: true,
            model: DEFAULT_SESSION_POLICY.model,
            credentialMode: 'platform',
          },
          codex: { enabled: false, model: null, credentialMode: 'platform' },
        },
      },
      after: {
        runtimes: {
          claude_code: {
            enabled: true,
            model: 'claude-opus-4-1',
            credentialMode: 'user_or_platform',
          },
          codex: codexOn,
        },
      },
    })

    // The same settings again change nothing and audit nothing.
    const again = await call('PUT', { runtimes: { codex: codexOn } })
    expect(again.status).toBe(200)
    expect(await agentAudits()).toHaveLength(audited + 1)
  })

  it('one runtime at a time leaves the other’s stored entry alone', async () => {
    await call('PUT', { runtimes: { codex: codexOn } })
    await call('PUT', {
      runtimes: {
        claude_code: { enabled: true, model: 'claude-haiku-4-5', credentialMode: 'platform' },
      },
    })
    const stored = store.settings.get('session_policy') as { runtimes: Record<string, unknown> }
    expect(stored.runtimes.codex).toEqual(codexOn)
    expect(stored.runtimes.claude_code).toMatchObject({ model: 'claude-haiku-4-5' })
  })

  it('400 for a model Launch has no price for, or an unknown runtime — nothing stored', async () => {
    const audited = (await agentAudits()).length
    for (const body of [
      { runtimes: { codex: { ...codexOn, model: 'gpt-mystery-1' } } },
      {
        runtimes: {
          claude_code: { enabled: true, model: 'gpt-6.1-sol', credentialMode: 'platform' },
        },
      },
      { runtimes: { cursor: codexOn } },
      { runtimes: {} },
    ]) {
      const res = await call('PUT', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await json(res)).toMatchObject({ code: 'validation_failed' })
    }
    expect(store.settings.has('session_policy')).toBe(false)
    expect(await agentAudits()).toHaveLength(audited)
  })

  it('409 session_agents_none_enabled when nothing would be left on', async () => {
    const res = await call('PUT', {
      runtimes: {
        claude_code: { enabled: false, model: 'claude-sonnet-4-5', credentialMode: 'platform' },
      },
    })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'session_agents_none_enabled' })
    expect(store.settings.has('session_policy')).toBe(false)
    // Codex on first, then Claude off: allowed.
    await call('PUT', { runtimes: { codex: codexOn } })
    const ok = await call('PUT', {
      runtimes: {
        claude_code: { enabled: false, model: 'claude-sonnet-4-5', credentialMode: 'platform' },
      },
    })
    expect(ok.status).toBe(200)
  })

  it('is 401 without a session and 403 for an organisation owner who is not a global admin', async () => {
    const anon = await request('/api/platform/setup/session-agents', {
      method: 'PUT',
    })
    expect(anon.status).toBe(401)
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const res = await call('PUT', { runtimes: { codex: codexOn } }, { cookie })
    expect(res.status).toBe(403)
    expect(store.settings.has('session_policy')).toBe(false)
  })
})
