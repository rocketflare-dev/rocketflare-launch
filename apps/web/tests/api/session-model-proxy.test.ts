/**
 * The model proxy (`services/sessions/egress/anthropic.ts`, Launch P3 slice 3c), driven directly
 * with a fake Anthropic upstream (`tests/helpers/fake-anthropic.ts`): the session is found only
 * from the platform's container id, only the two Messages paths and the policy's model pass, the
 * budget is checked BEFORE any upstream call, the sandbox's placeholder is replaced by the real key
 * and never reaches Anthropic, and every metered call lands in `ai_usage` AND the session's totals.
 *
 * This file owns the `anthropic_api_key` credential (one row per deployment): it sets it in one
 * test and removes it in that test's `finally`.
 */
import { estimateCostMicrocents } from '@launch/shared/ai/pricing'
import { DEFAULT_SESSION_POLICY, usdToMicrocents } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { putCredential, removeCredential } from '@/api/services/launch/credentials'
import {
  createUsageMeter,
  handleAnthropic,
  isAllowedModel,
  MODEL_KEY_PLACEHOLDER,
} from '@/api/services/sessions/egress/anthropic'
import { redactModelKeyText } from '@/api/services/sessions/model-key'
import { loadConfig } from '@/config'
import { aiUsage, apps, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { anthropicSseText, createFakeAnthropic } from '../helpers/fake-anthropic'
import { createFakeCloud } from '../helpers/fake-cloud'
import { insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const ENV_KEY = 'sk-ant-api03-env-key-for-tests-0000000000'
const MODEL = 'claude-opus-5-5'

function modelRequest(
  body: Record<string, unknown> | string | null,
  opts: { path?: string; method?: string } = {}
): Request {
  return new Request(`https://api.anthropic.com${opts.path ?? '/v1/messages?beta=true'}`, {
    method: opts.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': MODEL_KEY_PLACEHOLDER,
      authorization: `Bearer ${MODEL_KEY_PLACEHOLDER}`,
    },
    body:
      opts.method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function liveSession(overrides: Parameters<typeof insertSession>[2] = {}) {
  const f = await seedSessionApp(db, createFakeCloud())
  const sandboxId = `fake-sandbox-${crypto.randomUUID()}`
  const row = await insertSession(db, f, { status: 'working', sandboxId, ...overrides })
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

describe('the model proxy: who and what may pass', () => {
  it('an unknown container, or an ended session’s, is a 403 with no upstream call', async () => {
    const anthropic = createFakeAnthropic()
    const env = createTestEnv({ ANTHROPIC_API_KEY: ENV_KEY })
    const req = () => modelRequest({ model: MODEL, messages: [] })
    const unknown = await handleAnthropic(req(), env, { containerId: 'nobody' }, anthropic)
    expect(unknown.status).toBe(403)
    expect(await unknown.json()).toEqual({
      type: 'error',
      error: { type: 'permission_error', message: expect.any(String) },
    })
    const { sandboxId } = await liveSession({ status: 'ended' })
    const ended = await handleAnthropic(req(), env, { containerId: sandboxId }, anthropic)
    expect(ended.status).toBe(403)
    expect(anthropic.requests).toHaveLength(0)
  })

  it('a path or a method outside the allow-list is a 403', async () => {
    const anthropic = createFakeAnthropic()
    const env = createTestEnv({ ANTHROPIC_API_KEY: ENV_KEY })
    const { sandboxId } = await liveSession()
    for (const [path, method] of [
      ['/v1/models', 'GET'],
      ['/v1/messages/batches', 'POST'],
      ['/v1/complete', 'POST'],
      ['/v1/messages', 'GET'],
    ] as const) {
      const res = await handleAnthropic(
        modelRequest({ model: MODEL }, { path, method }),
        env,
        { containerId: sandboxId },
        anthropic
      )
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
        'permission_error'
      )
    }
    expect(anthropic.requests).toHaveLength(0)
  })

  it('a model other than the policy’s — or no parseable body — is a 403', async () => {
    const anthropic = createFakeAnthropic()
    const env = createTestEnv({ ANTHROPIC_API_KEY: ENV_KEY })
    const { sandboxId } = await liveSession({ policy: { ...DEFAULT_SESSION_POLICY, model: MODEL } })
    for (const body of [{ model: 'claude-opus-4-1' }, { model: 'claude-opus-5-5-evil' }, {}, 'x']) {
      const res = await handleAnthropic(
        modelRequest(body),
        env,
        { containerId: sandboxId },
        anthropic
      )
      expect(res.status).toBe(403)
    }
    expect(anthropic.requests).toHaveLength(0)
    expect(isAllowedModel('claude-opus-5-5-20260801', MODEL)).toBe(true)
    expect(isAllowedModel('CLAUDE-OPUS-5-5', MODEL)).toBe(true)
    expect(isAllowedModel('claude-opus-5-5x', MODEL)).toBe(false)
  })

  it('no model pinned (the default): any Anthropic model Launch can price passes, an unpriced one is a 403', async () => {
    expect(DEFAULT_SESSION_POLICY.model).toBeNull()
    const anthropic = createFakeAnthropic()
    const env = createTestEnv({ ANTHROPIC_API_KEY: ENV_KEY })
    const { sandboxId } = await liveSession()
    // Claude Code's main model and its own background model, both its choice.
    for (const model of ['claude-opus-5-5', 'claude-haiku-4-5-20251001']) {
      const res = await handleAnthropic(
        modelRequest({ model, stream: true }),
        env,
        { containerId: sandboxId },
        anthropic
      )
      expect(res.status, model).toBe(200)
      await res.text()
    }
    for (const body of [{ model: 'claude-mystery-9' }, { model: 'gpt-6.1-sol' }, {}]) {
      const res = await handleAnthropic(
        modelRequest(body),
        env,
        { containerId: sandboxId },
        anthropic
      )
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
        'a model Launch has a price for'
      )
    }
    expect(anthropic.requests).toHaveLength(2)
    expect(isAllowedModel('claude-sonnet-5', null)).toBe(true)
    expect(isAllowedModel('claude-mystery-9', null)).toBe(false)
    expect(isAllowedModel('gpt-6.1-sol', null, 'openai')).toBe(true)
    expect(isAllowedModel('claude-sonnet-5', null, 'openai')).toBe(false)
  })

  it('over the session budget: 403 permission_error and NO upstream call', async () => {
    const anthropic = createFakeAnthropic()
    const env = createTestEnv({ ANTHROPIC_API_KEY: ENV_KEY })
    const { sandboxId } = await liveSession({ costMicrocents: usdToMicrocents(10) })
    const res = await handleAnthropic(
      modelRequest({ model: MODEL, stream: true }),
      env,
      { containerId: sandboxId },
      anthropic
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      type: 'error',
      error: { type: 'permission_error', message: expect.stringContaining('budget') },
    })
    expect(anthropic.requests).toHaveLength(0)
  })

  it('over the APP’s monthly budget: the same 403, with no upstream call', async () => {
    const anthropic = createFakeAnthropic()
    const env = createTestEnv({ ANTHROPIC_API_KEY: ENV_KEY })
    const { f, row, sandboxId } = await liveSession()
    // A cap of one microcent, already spent by an earlier session of the same app.
    await db
      .update(apps)
      .set({ sessionMonthlyBudgetMicrocents: 1 })
      .where(and(eq(apps.tenantId, f.tenant.id), eq(apps.id, f.app.id)))
    await db.insert(aiUsage).values({
      tenantId: f.tenant.id,
      sessionId: row.id,
      feature: 'session',
      provider: 'anthropic',
      model: MODEL,
      inputTokens: 1,
      outputTokens: 1,
      costMicrocents: 5,
    })
    const res = await handleAnthropic(
      modelRequest({ model: MODEL }),
      env,
      { containerId: sandboxId },
      anthropic
    )
    expect(res.status).toBe(403)
    expect(anthropic.requests).toHaveLength(0)
  })

  it('no key anywhere is an Anthropic-shaped 503', async () => {
    const anthropic = createFakeAnthropic()
    const env = createTestEnv({ ANTHROPIC_API_KEY: undefined })
    const { sandboxId } = await liveSession()
    const res = await handleAnthropic(
      modelRequest({ model: MODEL }),
      env,
      { containerId: sandboxId },
      anthropic
    )
    expect(res.status).toBe(503)
    expect(((await res.json()) as { type: string }).type).toBe('error')
    expect(anthropic.requests).toHaveLength(0)
  })
})

describe('the model proxy: keyed and metered', () => {
  it('swaps the key (the placeholder never reaches upstream) and meters a STREAMED answer', async () => {
    const usage = { input: 6, output: 115, cacheRead: 40131, cacheWrite: 4865 }
    const anthropic = createFakeAnthropic({ usage, text: 'Changed the heading.' })
    const env = createTestEnv({ ANTHROPIC_API_KEY: ENV_KEY })
    const { f, row, sandboxId } = await liveSession()

    const res = await handleAnthropic(
      modelRequest({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      env,
      { containerId: sandboxId },
      anthropic
    )
    expect(res.status).toBe(200)
    // The body is passed through untouched while it is metered.
    const body = await res.text()
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(body.startsWith('event: message_start\n')).toBe(true)
    expect(body).toContain('"text":"heading."')
    expect(body.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true)

    expect(anthropic.requests).toHaveLength(1)
    const sent = anthropic.requests[0]
    expect(sent?.apiKey).toBe(ENV_KEY)
    expect(sent?.authorization).toBeNull()
    expect(sent?.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
    expect(JSON.stringify(sent)).not.toContain(MODEL_KEY_PLACEHOLDER)

    const rows = await usageRows(row.id)
    expect(rows).toHaveLength(1)
    const cost = estimateCostMicrocents('anthropic', 'claude-sonnet-4-5-20250929', {
      inputTokens: 6,
      outputTokens: 115,
      cacheReadTokens: 40131,
      cacheWriteTokens: 4865,
    })
    expect(rows[0]).toMatchObject({
      tenantId: f.tenant.id,
      userId: f.user.id,
      sessionId: row.id,
      feature: 'session',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      inputTokens: 6,
      outputTokens: 115,
      cacheReadTokens: 40131,
      cacheWriteTokens: 4865,
      costMicrocents: cost,
    })
    const totals = await sessionRow(row.id)
    expect(totals).toMatchObject({
      tokensIn: 6,
      tokensOut: 115,
      cacheRead: 40131,
      cacheWrite: 4865,
      costMicrocents: cost,
    })
  })

  it('meters JSON answers too, and the ledger always adds up to the totals', async () => {
    const anthropic = createFakeAnthropic({ usage: { input: 100, output: 50 } })
    const env = createTestEnv({ ANTHROPIC_API_KEY: ENV_KEY })
    const { row, sandboxId } = await liveSession()
    for (let i = 0; i < 3; i++) {
      const res = await handleAnthropic(
        modelRequest({ model: MODEL, stream: i === 1 }),
        env,
        { containerId: sandboxId },
        anthropic
      )
      await res.text()
    }
    const rows = await usageRows(row.id)
    expect(rows).toHaveLength(3)
    const totals = await sessionRow(row.id)
    expect(totals.tokensIn).toBe(300)
    expect(totals.tokensOut).toBe(150)
    expect(totals.costMicrocents).toBe(rows.reduce((sum, r) => sum + Number(r.costMicrocents), 0))
  })

  it('count_tokens is keyed but not metered; an upstream error is passed through unmetered', async () => {
    const anthropic = createFakeAnthropic()
    const env = createTestEnv({ ANTHROPIC_API_KEY: ENV_KEY })
    const { row, sandboxId } = await liveSession()
    anthropic.respond = () => Response.json({ input_tokens: 42 })
    const counted = await handleAnthropic(
      modelRequest({ model: MODEL }, { path: '/v1/messages/count_tokens' }),
      env,
      { containerId: sandboxId },
      anthropic
    )
    expect(await counted.json()).toEqual({ input_tokens: 42 })
    anthropic.respond = () =>
      Response.json(
        { type: 'error', error: { type: 'overloaded_error', message: 'x' } },
        { status: 529 }
      )
    const overloaded = await handleAnthropic(
      modelRequest({ model: MODEL }),
      env,
      { containerId: sandboxId },
      anthropic
    )
    expect(overloaded.status).toBe(529)
    await overloaded.text()
    expect(anthropic.requests.map(r => r.apiKey)).toEqual([ENV_KEY, ENV_KEY])
    expect(await usageRows(row.id)).toHaveLength(0)
  })

  it('prefers the anthropic_api_key credential over the Worker secret', async () => {
    const env = createTestEnv({ ANTHROPIC_API_KEY: ENV_KEY })
    const credentialKey = 'sk-ant-api03-credential-key-000000000000'
    await putCredential(
      db,
      loadConfig(env),
      'anthropic_api_key',
      { apiKey: credentialKey },
      {},
      null
    )
    try {
      const anthropic = createFakeAnthropic()
      const { sandboxId } = await liveSession()
      const res = await handleAnthropic(
        modelRequest({ model: MODEL }),
        env,
        { containerId: sandboxId },
        anthropic
      )
      await res.text()
      expect(anthropic.requests[0]?.apiKey).toBe(credentialKey)
    } finally {
      await removeCredential(db, 'anthropic_api_key')
    }
  })
})

describe('the meter and the redaction, alone', () => {
  it('SSE counts are cumulative: the last message_delta wins, no double counting', () => {
    const meter = createUsageMeter('text/event-stream')
    const text = anthropicSseText({ usage: { input: 3, output: 40, cacheRead: 7 } })
    for (let i = 0; i < text.length; i += 5) meter.push(text.slice(i, i + 5))
    expect(meter.result()?.usage).toEqual({
      inputTokens: 3,
      outputTokens: 40,
      cacheReadTokens: 7,
      cacheWriteTokens: 0,
    })
    expect(createUsageMeter('text/event-stream').result()).toBeNull()
  })

  it('redacts keys and the placeholder', () => {
    expect(redactModelKeyText(`a ${MODEL_KEY_PLACEHOLDER} b sk-ant-api03-XYZ_abc-123 c`)).toBe(
      'a [redacted] b [redacted] c'
    )
  })
})
