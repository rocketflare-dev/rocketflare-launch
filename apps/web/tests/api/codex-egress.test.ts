/**
 * Codex's egress (§18.22-B), driven directly with a fake OpenAI upstream
 * (`tests/helpers/fake-openai.ts`):
 *
 * - `api.openai.com` (`egress/openai.ts`): a WebSocket upgrade is 426 (Codex falls back to SSE);
 *   only a live Codex session on Launch's account passes, only `/v1/responses` (+ `/compact`) for
 *   the policy's model and `GET /v1/models`; the budget is checked before any upstream call; the
 *   placeholder is replaced by Launch's key and never reaches OpenAI; usage is metered as provider
 *   `openai` with a price.
 * - `chatgpt.com` (`egress/chatgpt.ts`): only a Codex session on a ChatGPT plan whose turn holds
 *   the claim, only the responses and models paths (analytics refused), the plan's own token passed
 *   through, usage recorded as `subscription` with no cost.
 * - `auth.openai.com` (`egress/openai-auth.ts`): a Codex login sandbox's device flow passes; a
 *   session's refresh passes and its rotated tokens are stored AT ONCE (compare-and-set); a reused
 *   refresh token marks the plan `needs_login`; anything else is refused.
 *
 * This file owns the `openai_api_key` credential (one row per deployment): it sets it in one test
 * and removes it in that test's `finally`.
 */
import { DEFAULT_SESSION_POLICY, usdToMicrocents } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { putCredential, removeCredential } from '@/api/services/launch/credentials'
import { claim, getById, openSecret } from '@/api/services/sessions/credentials/store'
import { handleChatGpt } from '@/api/services/sessions/egress/chatgpt'
import { handleOpenAi } from '@/api/services/sessions/egress/openai'
import { handleOpenAiAuth, refreshSignedOut } from '@/api/services/sessions/egress/openai-auth'
import { MODEL_KEY_PLACEHOLDER } from '@/api/services/sessions/model-key'
import { parseCodexAuthJson } from '@/api/services/sessions/runtimes/codex/auth-json'
import { loadConfig } from '@/config'
import { agentLogins, aiUsage, sessions } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { codexAuthJsonText, createFakeOpenAi, fakeJwt } from '../helpers/fake-openai'
import { insertSession, seedAgentCredential, seedSessionApp } from '../helpers/sessions'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
// Built, not written out: a literal key-shaped string in a test is what secret scanners look for.
const ENV_KEY = ['sk', 'proj', 'env-key-for-tests-000000000000'].join('-')
const MODEL = 'gpt-6.1-sol'
const POLICY = { ...DEFAULT_SESSION_POLICY, model: MODEL }
const env = () => createTestEnv({ OPENAI_API_KEY: ENV_KEY })
const cfg = loadConfig(createTestEnv())

function responsesRequest(
  host: string,
  path: string,
  body: Record<string, unknown> | string | null,
  opts: { method?: string; headers?: Record<string, string> } = {}
): Request {
  return new Request(`https://${host}${path}`, {
    method: opts.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${MODEL_KEY_PLACEHOLDER}`,
      ...opts.headers,
    },
    body:
      (opts.method ?? 'POST') === 'GET'
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
  })
}

async function liveSession(overrides: Parameters<typeof insertSession>[2] = {}) {
  const f = await seedSessionApp(db, createFakeCloud())
  const sandboxId = `fake-sandbox-${crypto.randomUUID()}`
  const row = await insertSession(db, f, {
    status: 'working',
    sandboxId,
    runtime: 'codex',
    policy: POLICY,
    ...overrides,
  })
  return { f, row, sandboxId }
}

async function usageRows(sessionId: string) {
  return db.select().from(aiUsage).where(eq(aiUsage.sessionId, sessionId))
}

async function sessionRow(id: string) {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id))
  if (!row) throw new Error('no session')
  return row
}

// ---- api.openai.com -----------------------------------------------------------------------------

describe('api.openai.com: Codex on Launch’s key', () => {
  it('a WebSocket upgrade is 426 — before anything else, and with no upstream call', async () => {
    const openai = createFakeOpenAi()
    const { sandboxId } = await liveSession()
    const res = await handleOpenAi(
      new Request('https://api.openai.com/v1/responses', {
        headers: { upgrade: 'websocket', connection: 'Upgrade' },
      }),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(res.status).toBe(426)
    expect(openai.requests).toHaveLength(0)
  })

  it('an unknown container, a Claude session or a plan session is a 403 in OpenAI’s shape', async () => {
    const openai = createFakeOpenAi()
    const req = () => responsesRequest('api.openai.com', '/v1/responses', { model: MODEL })
    const unknown = await handleOpenAi(req(), env(), { containerId: 'nobody' }, openai)
    expect(unknown.status).toBe(403)
    expect(await unknown.json()).toEqual({
      error: { message: expect.any(String), type: 'permission_error', param: null, code: null },
    })
    const claude = await liveSession({ runtime: 'claude_code' })
    expect(
      (await handleOpenAi(req(), env(), { containerId: claude.sandboxId }, openai)).status
    ).toBe(403)
    const plan = await liveSession({ credentialSource: 'user' })
    expect((await handleOpenAi(req(), env(), { containerId: plan.sandboxId }, openai)).status).toBe(
      403
    )
    expect(openai.requests).toHaveLength(0)
  })

  it('a path outside the allow-list, or a model other than the policy’s, is a 403', async () => {
    const openai = createFakeOpenAi()
    const { sandboxId } = await liveSession()
    for (const [path, method] of [
      ['/v1/chat/completions', 'POST'],
      ['/v1/files', 'POST'],
      ['/v1/responses', 'GET'],
    ] as const) {
      const res = await handleOpenAi(
        responsesRequest('api.openai.com', path, { model: MODEL }, { method }),
        env(),
        { containerId: sandboxId },
        openai
      )
      expect(res.status, `${method} ${path}`).toBe(403)
    }
    for (const body of [{ model: 'gpt-6-astra' }, {}, 'x']) {
      const res = await handleOpenAi(
        responsesRequest('api.openai.com', '/v1/responses', body),
        env(),
        { containerId: sandboxId },
        openai
      )
      expect(res.status).toBe(403)
    }
    // A compressed body cannot be checked, so it is never forwarded.
    const zstd = await handleOpenAi(
      responsesRequest(
        'api.openai.com',
        '/v1/responses',
        { model: MODEL },
        {
          headers: { 'content-encoding': 'zstd' },
        }
      ),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(zstd.status).toBe(415)
    expect(openai.requests).toHaveLength(0)
  })

  it('swaps the placeholder for Launch’s key, streams the answer back, and meters it as openai with a price', async () => {
    const openai = createFakeOpenAi({ usage: { input: 1200, cached: 1000, output: 300 } })
    const { row, sandboxId } = await liveSession()
    const res = await handleOpenAi(
      responsesRequest('api.openai.com', '/v1/responses', { model: MODEL, stream: true }),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('response.completed')
    expect(openai.requests).toHaveLength(1)
    expect(openai.requests[0]).toMatchObject({
      url: 'https://api.openai.com/v1/responses',
      authorization: `Bearer ${ENV_KEY}`,
    })
    expect(JSON.stringify(openai.requests)).not.toContain(MODEL_KEY_PLACEHOLDER)

    const [usage] = await usageRows(row.id)
    expect(usage).toMatchObject({
      provider: 'openai',
      feature: 'session',
      billing: 'metered',
      inputTokens: 200,
      cacheReadTokens: 1000,
      outputTokens: 300,
    })
    expect(usage?.costMicrocents).toBeGreaterThan(0)
    expect(Number((await sessionRow(row.id)).costMicrocents)).toBe(usage?.costMicrocents)
  })

  it('GET /v1/models is keyed and passed through, not metered', async () => {
    const openai = createFakeOpenAi()
    const { row, sandboxId } = await liveSession()
    const res = await handleOpenAi(
      responsesRequest('api.openai.com', '/v1/models', null, { method: 'GET' }),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(res.status).toBe(200)
    expect(openai.requests[0]?.authorization).toBe(`Bearer ${ENV_KEY}`)
    expect(await usageRows(row.id)).toEqual([])
  })

  it('over budget: an OpenAI-shaped 403 and no upstream call', async () => {
    const openai = createFakeOpenAi()
    const { sandboxId } = await liveSession({
      costMicrocents: usdToMicrocents(POLICY.maxSessionUsd + 1),
    })
    const res = await handleOpenAi(
      responsesRequest('api.openai.com', '/v1/responses', { model: MODEL }),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/budget/)
    expect(openai.requests).toHaveLength(0)
  })

  it('no key at all is a 503; the admin credential wins over the Worker secret', async () => {
    const openai = createFakeOpenAi()
    const { sandboxId } = await liveSession()
    const none = await handleOpenAi(
      responsesRequest('api.openai.com', '/v1/responses', { model: MODEL }),
      createTestEnv(),
      { containerId: sandboxId },
      openai
    )
    expect(none.status).toBe(503)
    const stored = ['sk', 'proj', 'admin-credential-key-0000000000'].join('-')
    await putCredential(db, cfg, 'openai_api_key', { apiKey: stored }, {}, null)
    try {
      const res = await handleOpenAi(
        responsesRequest('api.openai.com', '/v1/responses', { model: MODEL }),
        env(),
        { containerId: sandboxId },
        openai
      )
      await res.text()
      expect(openai.requests.at(-1)?.authorization).toBe(`Bearer ${stored}`)
    } finally {
      await removeCredential(db, 'openai_api_key')
    }
  })
})

// ---- chatgpt.com --------------------------------------------------------------------------------

async function planSession(opts: { claimed?: boolean } = {}) {
  const f = await seedSessionApp(db, createFakeCloud())
  const { row: credential } = await seedAgentCredential(db, f, {
    runtime: 'codex',
    secret: codexAuthJsonText(),
  })
  const sandboxId = `fake-sandbox-${crypto.randomUUID()}`
  const row = await insertSession(db, f, {
    status: 'working',
    sandboxId,
    runtime: 'codex',
    policy: POLICY,
    credentialSource: 'user',
    agentCredentialId: credential.id,
  })
  if (opts.claimed !== false) {
    await claim(db, { tenantId: f.tenant.id, id: credential.id, sessionId: row.id })
  }
  return { f, row, credential, sandboxId }
}

const ACCESS = fakeJwt({ exp: 4_102_444_800, sub: 'u' })
const planHeaders = { authorization: `Bearer ${ACCESS}`, 'chatgpt-account-id': 'acct-fake-0001' }

describe('chatgpt.com: Codex on a person’s plan', () => {
  it('passes the plan’s own token through to the responses path, and records usage as subscription with no cost', async () => {
    const openai = createFakeOpenAi({ usage: { input: 500, cached: 100, output: 40 } })
    const { row, sandboxId } = await planSession()
    const res = await handleChatGpt(
      responsesRequest(
        'chatgpt.com',
        '/backend-api/codex/responses',
        { model: MODEL },
        {
          headers: planHeaders,
        }
      ),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(res.status).toBe(200)
    await res.text()
    expect(openai.requests[0]).toMatchObject({
      url: 'https://chatgpt.com/backend-api/codex/responses',
      authorization: `Bearer ${ACCESS}`,
      accountId: 'acct-fake-0001',
    })
    const [usage] = await usageRows(row.id)
    expect(usage).toMatchObject({
      provider: 'openai',
      billing: 'subscription',
      costMicrocents: null,
      inputTokens: 400,
      cacheReadTokens: 100,
    })
    expect(Number((await sessionRow(row.id)).costMicrocents)).toBe(0)
  })

  it('refuses analytics and every other path, an upgrade (426), and the wrong model', async () => {
    const openai = createFakeOpenAi()
    const { sandboxId } = await planSession()
    for (const [path, method] of [
      ['/backend-api/codex/analytics-events/events', 'POST'],
      ['/backend-api/conversation', 'POST'],
      ['/backend-api/codex/responses', 'GET'],
      ['/', 'GET'],
    ] as const) {
      const res = await handleChatGpt(
        responsesRequest('chatgpt.com', path, { model: MODEL }, { method, headers: planHeaders }),
        env(),
        { containerId: sandboxId },
        openai
      )
      expect(res.status, `${method} ${path}`).toBe(403)
    }
    const ws = await handleChatGpt(
      new Request('https://chatgpt.com/backend-api/codex/responses', {
        headers: { upgrade: 'websocket' },
      }),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(ws.status).toBe(426)
    const wrong = await handleChatGpt(
      responsesRequest('chatgpt.com', '/backend-api/codex/responses', { model: 'gpt-6-astra' }),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(wrong.status).toBe(403)
    expect(openai.requests).toHaveLength(0)
  })

  it('a session whose turn does not hold the claim — or a platform session — is refused', async () => {
    const openai = createFakeOpenAi()
    const req = () =>
      responsesRequest('chatgpt.com', '/backend-api/codex/responses', { model: MODEL })
    const unclaimed = await planSession({ claimed: false })
    expect(
      (await handleChatGpt(req(), env(), { containerId: unclaimed.sandboxId }, openai)).status
    ).toBe(403)
    const other = await planSession({ claimed: false })
    await claim(db, {
      tenantId: other.f.tenant.id,
      id: other.credential.id,
      sessionId: crypto.randomUUID(),
    })
    expect(
      (await handleChatGpt(req(), env(), { containerId: other.sandboxId }, openai)).status
    ).toBe(403)
    const platform = await liveSession()
    expect(
      (await handleChatGpt(req(), env(), { containerId: platform.sandboxId }, openai)).status
    ).toBe(403)
    expect(openai.requests).toHaveLength(0)
  })

  it('GET /backend-api/codex/models passes through unmetered', async () => {
    const openai = createFakeOpenAi()
    const { row, sandboxId } = await planSession()
    const res = await handleChatGpt(
      responsesRequest('chatgpt.com', '/backend-api/codex/models?client_version=0.160.0', null, {
        method: 'GET',
        headers: planHeaders,
      }),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(res.status).toBe(200)
    expect(openai.requests[0]?.url).toBe(
      'https://chatgpt.com/backend-api/codex/models?client_version=0.160.0'
    )
    expect(await usageRows(row.id)).toEqual([])
  })
})

// ---- auth.openai.com ----------------------------------------------------------------------------

const refreshRequest = (body: Record<string, unknown>) =>
  new Request('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const REFRESH_BODY = {
  client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
  grant_type: 'refresh_token',
  refresh_token: 'rt_fake_refresh_token_0001',
}

describe('auth.openai.com: the refresh', () => {
  it('a refresh mid-turn passes through, and the rotated tokens are stored at once (version bumped)', async () => {
    const openai = createFakeOpenAi({
      rotated: { refresh_token: 'rt_rotated_by_openai', access_token: ACCESS },
    })
    const { f, credential, sandboxId } = await planSession()
    const res = await handleOpenAiAuth(
      refreshRequest(REFRESH_BODY),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(res.status).toBe(200)
    // Codex gets the answer unchanged.
    expect(((await res.json()) as { refresh_token: string }).refresh_token).toBe(
      'rt_rotated_by_openai'
    )
    expect(openai.requests[0]?.url).toBe('https://auth.openai.com/oauth/token')
    const after = await getById(db, f.tenant.id, credential.id)
    expect(after?.version).toBe(credential.version + 1)
    const stored = parseCodexAuthJson(await openSecret(cfg, after as NonNullable<typeof after>))
    expect(stored?.tokens).toMatchObject({
      refresh_token: 'rt_rotated_by_openai',
      access_token: ACCESS,
      account_id: 'acct-fake-0001',
    })
    // The same rotation seen twice is stored once.
    await handleOpenAiAuth(refreshRequest(REFRESH_BODY), env(), { containerId: sandboxId }, openai)
    expect((await getById(db, f.tenant.id, credential.id))?.version).toBe(credential.version + 1)
  })

  it('a reused refresh token marks the plan needs_login, and Codex sees OpenAI’s own refusal', async () => {
    const openai = createFakeOpenAi({ refresh: 'refresh_token_reused' })
    const { f, credential, sandboxId } = await planSession()
    const res = await handleOpenAiAuth(
      refreshRequest(REFRESH_BODY),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'refresh_token_reused' } })
    const after = await getById(db, f.tenant.id, credential.id)
    expect(after?.status).toBe('needs_login')
    expect(after?.version).toBe(credential.version)
  })

  it('a transient failure leaves the plan alone', async () => {
    const openai = createFakeOpenAi({ refresh: 'server_error' })
    const { f, credential, sandboxId } = await planSession()
    const res = await handleOpenAiAuth(
      refreshRequest(REFRESH_BODY),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(res.status).toBe(500)
    expect((await getById(db, f.tenant.id, credential.id))?.status).toBe('active')
  })

  it('a session may only refresh: another grant, another path, or no claim is a 403', async () => {
    const openai = createFakeOpenAi()
    const { sandboxId } = await planSession()
    const grant = await handleOpenAiAuth(
      refreshRequest({ ...REFRESH_BODY, grant_type: 'authorization_code' }),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(grant.status).toBe(403)
    const device = await handleOpenAiAuth(
      new Request('https://auth.openai.com/api/accounts/deviceauth/usercode', { method: 'POST' }),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(device.status).toBe(403)
    const unclaimed = await planSession({ claimed: false })
    const res = await handleOpenAiAuth(
      refreshRequest(REFRESH_BODY),
      env(),
      { containerId: unclaimed.sandboxId },
      openai
    )
    expect(res.status).toBe(403)
    expect(openai.requests).toHaveLength(0)
  })

  it('the signed-out rule is Codex’s own', () => {
    expect(refreshSignedOut(401, { error: { code: 'refresh_token_expired' } })).toBe(true)
    expect(refreshSignedOut(400, { error: 'invalid_grant' })).toBe(true)
    expect(refreshSignedOut(400, { error: { code: 'refresh_token_invalidated' } })).toBe(true)
    expect(refreshSignedOut(401, {})).toBe(true)
    expect(refreshSignedOut(500, { error: { code: 'server_error' } })).toBe(false)
    expect(refreshSignedOut(400, { error: 'invalid_request' })).toBe(false)
  })
})

describe('auth.openai.com: a Codex login sandbox', () => {
  async function login(runtime: 'codex' | 'claude_code' = 'codex') {
    const { tenant, user } = await createTestTenantWithUser(db)
    const sandboxId = `fake-sandbox-${crypto.randomUUID()}`
    const [row] = await db
      .insert(agentLogins)
      .values({
        tenantId: tenant.id,
        userId: user.id,
        runtime,
        status: 'awaiting_user',
        sandboxId,
        expiresAt: new Date(Date.now() + 600_000),
      })
      .returning()
    if (!row) throw new Error('no login')
    return { row, sandboxId }
  }

  it('the device-code flow and its exchange pass through untouched; nothing else does', async () => {
    const openai = createFakeOpenAi()
    const { sandboxId } = await login()
    for (const path of [
      '/api/accounts/deviceauth/usercode',
      '/api/accounts/deviceauth/token',
      '/oauth/token',
    ]) {
      const res = await handleOpenAiAuth(
        new Request(`https://auth.openai.com${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann"}',
        }),
        env(),
        { containerId: sandboxId },
        openai
      )
      expect(res.status, path).toBe(200)
    }
    expect(openai.requests.map(r => r.path)).toEqual([
      '/api/accounts/deviceauth/usercode',
      '/api/accounts/deviceauth/token',
      '/oauth/token',
    ])
    const other = await handleOpenAiAuth(
      new Request('https://auth.openai.com/oauth/revoke', { method: 'POST' }),
      env(),
      { containerId: sandboxId },
      openai
    )
    expect(other.status).toBe(403)
  })

  it('a Claude login sandbox, or a finished Codex login, gets nothing', async () => {
    const openai = createFakeOpenAi()
    const claude = await login('claude_code')
    const req = () =>
      new Request('https://auth.openai.com/api/accounts/deviceauth/usercode', { method: 'POST' })
    expect(
      (await handleOpenAiAuth(req(), env(), { containerId: claude.sandboxId }, openai)).status
    ).toBe(403)
    const done = await login()
    await db
      .update(agentLogins)
      .set({ status: 'succeeded' })
      .where(and(eq(agentLogins.tenantId, done.row.tenantId), eq(agentLogins.id, done.row.id)))
    expect(
      (await handleOpenAiAuth(req(), env(), { containerId: done.sandboxId }, openai)).status
    ).toBe(403)
    expect(openai.requests).toHaveLength(0)
  })
})
