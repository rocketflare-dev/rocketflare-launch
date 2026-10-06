/**
 * The model proxy on a person's own Claude subscription (§18.22-A, `egress/anthropic.ts`), and the
 * turn's lease (`runtimes/claude-code/credentials.ts`), against Postgres with a recording upstream:
 *
 * - the session's sealed token goes upstream as `Authorization: Bearer`, with no `x-api-key`, the
 *   OAuth beta flag merged into the client's own, and the placeholder never upstream;
 * - `GET /api/claude_code/*` is a 404 that never reaches Anthropic (org-managed settings must not
 *   override Launch); everything else outside the Messages allow-list is still a 403;
 * - no money budget (an exhausted cap does not stop it), usage recorded `billing: 'subscription'`
 *   with a null cost and the session's cost total unmoved;
 * - a credential that is gone, `needs_login`, expired, or another person's → a 401 sentence and no
 *   upstream call; an upstream 401 marks it `needs_login`; a 429 passes through;
 * - the token appears in no response the sandbox sees, and in no `ai_usage` row.
 */
import { usdToMicrocents } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { CredentialNeedsLoginError } from '@/api/services/sessions/credentials/errors'
import { createSessionCredentialPort } from '@/api/services/sessions/credentials/lease'
import { getById } from '@/api/services/sessions/credentials/store'
import {
  handleAnthropic,
  MODEL_KEY_PLACEHOLDER,
  SUBSCRIPTION_NEEDS_LOGIN_MESSAGE,
  SUBSCRIPTION_REFUSED_MESSAGE,
} from '@/api/services/sessions/egress/anthropic'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import { leaseClaudeUserCredential } from '@/api/services/sessions/runtimes/claude-code/credentials'
import { type RunTurnOptions, runTurn } from '@/api/services/sessions/turn'
import { loadConfig } from '@/config'
import { agentCredentials, aiUsage, sessions } from '@/db/schema'
import { createTestUser, linkUserToTenant } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { anthropicJson, anthropicSse, claudeStreamJson } from '../helpers/fake-anthropic'
import { createFakeCloud } from '../helpers/fake-cloud'
import { FakeSandbox } from '../helpers/fake-sandbox'
import {
  createFakeSessionPorts,
  insertSession,
  seedAgentCredential,
  seedSessionApp,
} from '../helpers/sessions'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const MODEL = 'claude-opus-5-5'
const TOKEN = 'sk-ant-oat01-SUBSCRIPTION-proxy-sentinel-token-never-echoed'
const ENV_KEY = 'sk-ant-api03-env-key-for-subscription-tests-000'
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))
const FAST: RunTurnOptions = { sleep: tick, cancelPollMs: 5, flushMs: 5 }

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

/** An upstream that records every header (the shared fake keeps only the two auth ones). */
function recordingUpstream(
  respond: (req: Request, body: Record<string, unknown> | null) => Response
) {
  const requests: Sent[] = []
  return {
    requests,
    upstream: {
      fetch: async (req: Request) => {
        const body = await req.text()
        requests.push({
          url: req.url,
          method: req.method,
          headers: Object.fromEntries(req.headers.entries()),
          body,
        })
        let parsed: Record<string, unknown> | null = null
        try {
          parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null
        } catch {
          parsed = null
        }
        return respond(req, parsed)
      },
    },
  }
}

const usage = { input: 7, output: 42, cacheRead: 300, cacheWrite: 20 }
const okUpstream = () =>
  recordingUpstream((_req, body) =>
    body?.stream ? anthropicSse({ usage, text: 'ok' }) : anthropicJson({ usage, text: 'ok' })
  )

/** What a subscription session's Claude Code sends (spike S-A2's headers). */
function oauthRequest(
  body: Record<string, unknown> | null,
  opts: { path?: string; method?: string } = {}
): Request {
  const method = opts.method ?? 'POST'
  return new Request(`https://api.anthropic.com${opts.path ?? '/v1/messages?beta=true'}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
      authorization: `Bearer ${MODEL_KEY_PLACEHOLDER}`,
      'x-app': 'cli',
    },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  })
}

async function subscriptionSession(
  opts: {
    credential?: Parameters<typeof seedAgentCredential>[2]
    session?: Parameters<typeof insertSession>[2]
  } = {}
) {
  const f = await seedSessionApp(db, createFakeCloud())
  const { row: credential } = await seedAgentCredential(db, f, {
    secret: TOKEN,
    ...opts.credential,
  })
  const sandboxId = `fake-sandbox-${crypto.randomUUID()}`
  const row = await insertSession(db, f, {
    status: 'working',
    sandboxId,
    credentialSource: 'user',
    agentCredentialId: credential.id,
    ...opts.session,
  })
  return { f, row, credential, sandboxId, env: createTestEnv({ ANTHROPIC_API_KEY: ENV_KEY }) }
}

async function usageRows(sessionId: string) {
  return db.select().from(aiUsage).where(eq(aiUsage.sessionId, sessionId))
}

async function credentialStatus(tenantId: string, id: string) {
  return (await getById(db, tenantId, id))?.status
}

describe('a subscription session’s model call', () => {
  it('Bearer the real token, no x-api-key, the beta flag merged, metered as subscription with no cost', async () => {
    const s = await subscriptionSession()
    const up = okUpstream()
    const res = await handleAnthropic(
      oauthRequest({ model: MODEL, stream: true, messages: [] }),
      s.env,
      { containerId: s.sandboxId },
      up
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain(TOKEN)

    expect(up.requests).toHaveLength(1)
    const sent = up.requests[0] as Sent
    expect(sent.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
    expect(sent.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(sent.headers['x-api-key']).toBeUndefined()
    expect(sent.headers['anthropic-beta']).toBe(
      'claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20'
    )
    expect(sent.headers['x-app']).toBe('cli')
    expect(JSON.stringify(sent)).not.toContain(MODEL_KEY_PLACEHOLDER)
    expect(JSON.stringify(sent)).not.toContain(ENV_KEY)

    const rows = await usageRows(s.row.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tenantId: s.f.tenant.id,
      userId: s.f.user.id,
      provider: 'anthropic',
      feature: 'session',
      inputTokens: 7,
      outputTokens: 42,
      cacheReadTokens: 300,
      cacheWriteTokens: 20,
      costMicrocents: null,
      billing: 'subscription',
    })
    expect(JSON.stringify(rows)).not.toContain(TOKEN)
    const [after] = await db.select().from(sessions).where(eq(sessions.id, s.row.id))
    expect(after).toMatchObject({ tokensIn: 7, tokensOut: 42, costMicrocents: 0 })
  })

  it('count_tokens is keyed the same way and not metered', async () => {
    const s = await subscriptionSession()
    const up = recordingUpstream(() => Response.json({ input_tokens: 12 }))
    const res = await handleAnthropic(
      oauthRequest({ model: MODEL, messages: [] }, { path: '/v1/messages/count_tokens?beta=true' }),
      s.env,
      { containerId: s.sandboxId },
      up
    )
    expect(res.status).toBe(200)
    expect(up.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(await usageRows(s.row.id)).toHaveLength(0)
  })

  it('no money budget: an exhausted session cap does not stop it', async () => {
    const s = await subscriptionSession({ session: { costMicrocents: usdToMicrocents(10_000) } })
    const up = okUpstream()
    const res = await handleAnthropic(
      oauthRequest({ model: MODEL }),
      s.env,
      { containerId: s.sandboxId },
      up
    )
    expect(res.status).toBe(200)
    expect(up.requests).toHaveLength(1)
  })

  it('GET /api/claude_code/* is a 404 that never reaches Anthropic; other paths are still refused', async () => {
    const s = await subscriptionSession()
    const up = okUpstream()
    for (const path of ['/api/claude_code/policy_limits', '/api/claude_code/settings']) {
      const res = await handleAnthropic(
        oauthRequest(null, { path, method: 'GET' }),
        s.env,
        { containerId: s.sandboxId },
        up
      )
      expect(res.status, path).toBe(404)
      expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'not_found_error' } })
    }
    for (const [path, method] of [
      ['/api/claude_cli/bootstrap', 'GET'],
      ['/api/oauth/profile', 'GET'],
      ['/api/event_logging/v2/batch', 'POST'],
      ['/v1/models', 'GET'],
    ] as const) {
      const res = await handleAnthropic(
        oauthRequest({ model: MODEL }, { path, method }),
        s.env,
        { containerId: s.sandboxId },
        up
      )
      expect(res.status, `${method} ${path}`).toBe(403)
    }
    // The model allow-list still holds.
    const wrongModel = await handleAnthropic(
      oauthRequest({ model: 'claude-mystery-9' }),
      s.env,
      { containerId: s.sandboxId },
      up
    )
    expect(wrongModel.status).toBe(403)
    expect(up.requests).toHaveLength(0)
  })

  it('a platform session is untouched: its /api/claude_code/* is still a 403, its key still x-api-key', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const sandboxId = `fake-sandbox-${crypto.randomUUID()}`
    await insertSession(db, f, { status: 'working', sandboxId })
    const env = createTestEnv({ ANTHROPIC_API_KEY: ENV_KEY })
    const up = okUpstream()
    const settings = await handleAnthropic(
      oauthRequest(null, { path: '/api/claude_code/settings', method: 'GET' }),
      env,
      { containerId: sandboxId },
      up
    )
    expect(settings.status).toBe(403)
    const res = await handleAnthropic(
      oauthRequest({ model: MODEL }),
      env,
      { containerId: sandboxId },
      up
    )
    expect(res.status).toBe(200)
    expect(up.requests[0]?.headers['x-api-key']).toBe(ENV_KEY)
    expect(up.requests[0]?.headers.authorization).toBeUndefined()
    expect(up.requests[0]?.headers['anthropic-beta']).toBe(
      'claude-code-20250219,interleaved-thinking-2025-05-14'
    )
  })
})

describe('a credential the session may not spend', () => {
  it('needs_login, expired, missing, or another person’s: a 401 sentence and no upstream call', async () => {
    const cases = [
      await subscriptionSession({ credential: { status: 'needs_login' } }),
      await subscriptionSession({ credential: { expiresAt: new Date(Date.now() - 60_000) } }),
      await subscriptionSession({ session: { agentCredentialId: null } }),
    ]
    // Someone else's credential in the same tenant, pinned onto this session.
    const other = await subscriptionSession()
    const stranger = await createTestUser(db)
    await linkUserToTenant(db, stranger.id, other.f.tenant.id, 'member')
    const { row: theirs } = await seedAgentCredential(
      db,
      { tenant: other.f.tenant, user: stranger },
      { secret: 'sk-ant-oat01-someone-elses-token-0000000000' }
    )
    await db
      .update(sessions)
      .set({ agentCredentialId: theirs.id })
      .where(and(eq(sessions.tenantId, other.f.tenant.id), eq(sessions.id, other.row.id)))
    cases.push(other)

    for (const s of cases) {
      const up = okUpstream()
      const res = await handleAnthropic(
        oauthRequest({ model: MODEL }),
        s.env,
        { containerId: s.sandboxId },
        up
      )
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({
        type: 'error',
        error: { type: 'authentication_error', message: SUBSCRIPTION_NEEDS_LOGIN_MESSAGE },
      })
      expect(up.requests).toHaveLength(0)
    }
  })

  it('a credential from another tenant is never found, whatever id the session row holds', async () => {
    const a = await subscriptionSession()
    const b = await subscriptionSession()
    await db
      .update(sessions)
      .set({ agentCredentialId: b.credential.id })
      .where(and(eq(sessions.tenantId, a.f.tenant.id), eq(sessions.id, a.row.id)))
    const up = okUpstream()
    const res = await handleAnthropic(
      oauthRequest({ model: MODEL }),
      a.env,
      { containerId: a.sandboxId },
      up
    )
    expect(res.status).toBe(401)
    expect(up.requests).toHaveLength(0)
  })
})

describe('what Anthropic answers', () => {
  it('a 401 marks the credential needs_login and answers a sentence — the next call stops at Launch', async () => {
    const s = await subscriptionSession()
    const up = recordingUpstream(() =>
      Response.json(
        { type: 'error', error: { type: 'authentication_error', message: `bad token ${TOKEN}` } },
        { status: 401 }
      )
    )
    const res = await handleAnthropic(
      oauthRequest({ model: MODEL }),
      s.env,
      { containerId: s.sandboxId },
      up
    )
    expect(res.status).toBe(401)
    const text = await res.text()
    expect(text).not.toContain(TOKEN)
    expect(JSON.parse(text)).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: SUBSCRIPTION_REFUSED_MESSAGE },
    })
    expect(await credentialStatus(s.f.tenant.id, s.credential.id)).toBe('needs_login')

    const again = await handleAnthropic(
      oauthRequest({ model: MODEL }),
      s.env,
      { containerId: s.sandboxId },
      up
    )
    expect(again.status).toBe(401)
    expect(up.requests).toHaveLength(1)
    expect(await usageRows(s.row.id)).toHaveLength(0)
  })

  it('a 429 (the plan’s own limit) passes through unchanged, and the credential stays active', async () => {
    const s = await subscriptionSession()
    const up = recordingUpstream(() =>
      Response.json(
        { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } },
        { status: 429, headers: { 'retry-after': '30' } }
      )
    )
    const res = await handleAnthropic(
      oauthRequest({ model: MODEL }),
      s.env,
      { containerId: s.sandboxId },
      up
    )
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('30')
    expect(await res.json()).toMatchObject({ error: { type: 'rate_limit_error' } })
    expect(await credentialStatus(s.f.tenant.id, s.credential.id)).toBe('active')
  })
})

describe('the turn’s lease', () => {
  const leaseFor = (s: Awaited<ReturnType<typeof subscriptionSession>>, session = s.row) =>
    leaseClaudeUserCredential({
      db,
      cfg: loadConfig(s.env),
      session,
      sandbox: new FakeSandbox(),
      now: () => new Date(),
    })

  it('an active credential: a user lease with NOTHING in it, and last_used_at stamped', async () => {
    const s = await subscriptionSession()
    const lease = await leaseFor(s)
    expect(lease.source).toBe('user')
    expect(lease.env).toEqual({})
    expect(lease.files).toEqual([])
    await lease.release()
    const [row] = await db
      .select()
      .from(agentCredentials)
      .where(
        and(eq(agentCredentials.tenantId, s.f.tenant.id), eq(agentCredentials.id, s.credential.id))
      )
    expect(row?.lastUsedAt).toBeInstanceOf(Date)
    expect(row?.claimedBySessionId).toBeNull()
  })

  it('needs_login, expired or missing: CredentialNeedsLoginError, telling them to reconnect', async () => {
    for (const s of [
      await subscriptionSession({ credential: { status: 'needs_login' } }),
      await subscriptionSession({ credential: { expiresAt: new Date(Date.now() - 1000) } }),
      await subscriptionSession({ session: { agentCredentialId: null } }),
    ]) {
      const err = await leaseFor(s).catch(e => e as Error)
      expect(err).toBeInstanceOf(CredentialNeedsLoginError)
      expect((err as Error).message).toBe(
        'Reconnect your Claude account on the Home page, then send your message again.'
      )
    }
  })

  it('a whole turn: the CLI runs with the placeholder OAuth token and no API key at all', async () => {
    const s = await subscriptionSession({ session: { status: 'ready', pendingMessage: 'go' } })
    const ports = createFakeSessionPorts({
      credentials: createSessionCredentialPort(db, loadConfig(s.env)),
    }).script(sb => sb.onProcess(/claude -p/, claudeStreamJson({ text: 'ok' })))
    expect((await runTurn(db, ports, s.row, FAST)).status).toBe('completed')
    const env = (ports.sandbox(s.row.id) as FakeSandbox).processes[0]?.opts?.env ?? {}
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(MODEL_KEY_PLACEHOLDER)
    expect('ANTHROPIC_API_KEY' in env).toBe(false)
    expect(JSON.stringify(env)).not.toContain(TOKEN)
    const events = await listSessionEvents(db, s.row.tenantId, s.row.id)
    expect(JSON.stringify(events)).not.toContain(TOKEN)
  })

  it('a turn on a credential that needs reconnecting fails with the sentence and never starts the CLI', async () => {
    const s = await subscriptionSession({
      credential: { status: 'needs_login' },
      session: { status: 'ready', pendingMessage: 'go' },
    })
    const ports = createFakeSessionPorts({
      credentials: createSessionCredentialPort(db, loadConfig(s.env)),
    })
    expect((await runTurn(db, ports, s.row, FAST)).status).toBe('failed')
    const failed = (await listSessionEvents(db, s.row.tenantId, s.row.id)).find(
      e => e.type === 'turn.failed'
    )
    expect((failed?.data as { message?: string } | undefined)?.message).toBe(
      'Reconnect your Claude account on the Home page, then send your message again.'
    )
    expect((ports.sandbox(s.row.id) as FakeSandbox).processes).toEqual([])
  })

  it('another tenant’s credential id is not found', async () => {
    const a = await subscriptionSession()
    const b = await subscriptionSession()
    const err = await leaseFor(a, { ...a.row, agentCredentialId: b.credential.id }).catch(
      e => e as Error
    )
    expect(err).toBeInstanceOf(CredentialNeedsLoginError)
  })
})
