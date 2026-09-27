/**
 * The model proxy (Launch P3, plan §1.4) — `SessionSandbox.outboundByHost['api.anthropic.com']`,
 * running IN LAUNCH'S WORKER for every request a session's Claude Code makes. The sandbox holds
 * only `ANTHROPIC_API_KEY=launch-session-placeholder`; this handler:
 *
 * 1. finds the session from `ctx.containerId` → `sessions.sandbox_id` (unique) — a server-side
 *    lookup, so the sandbox cannot forge who it is. Unknown, or not a live session → 403;
 * 2. allows only `POST /v1/messages` and `/v1/messages/count_tokens`, and only `policy.model` (or a
 *    dated id of it: `claude-sonnet-4-5` admits `claude-sonnet-4-5-20250929`) → 403 otherwise;
 * 3. checks the budget (`budget.ts`: the session's cap, then the app's month) — over is an
 *    Anthropic-shaped 403 `permission_error` and NO upstream call;
 * 4. swaps in the real key (`model-key.ts`: the `anthropic_api_key` credential, else
 *    `cfg.ANTHROPIC_API_KEY`) and sends it through `deps.upstream` (`ModelUpstream`);
 * 5. meters usage from the SSE or JSON response AS IT STREAMS BACK (ported from
 *    `spikes/s7-sandbox/worker/src/index.js`, but line by line instead of buffering the whole
 *    stream), and when the body ends writes one `ai_usage` row (`recordUsage` with `sessionId`,
 *    feature `session`) and adds the same numbers to the session's running totals — in ONE
 *    transaction, so the ledger always adds up to the totals.
 *
 * Every refusal is Anthropic's own error shape (`{ type: 'error', error: { type, message } }`), so
 * Claude Code reports it to the person the way it would report the API's. **No response, log line
 * or error message carries the key or the placeholder**: the sandbox's own `x-api-key` /
 * `Authorization` are dropped before anything else happens to the request.
 *
 * **Pre-tenant by design**, like `/ci/*`: the only thing this request carries is the container id,
 * so the session lookup names no tenant and the tenant is then taken from the row — the entry for
 * this file in `tests/config/unscoped-allowlist.test.ts`.
 *
 * `count_tokens` is free, so it is keyed but not metered. A response the reader abandons half way
 * (the container died mid-stream) records nothing — the TransformStream's `flush` never runs; the
 * row's running cost is then short by that one call.
 */
import type { TokenUsage } from '@launch/shared/ai/chat'
import { estimateCostMicrocents } from '@launch/shared/ai/pricing'
import { ACTIVE_SESSION_STATUSES, resolveSessionPolicy } from '@launch/shared/launch-sessions'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { type AppConfig, loadConfig } from '../../../../config'
import { type Database, type DatabaseHandle, openDatabase } from '../../../../db/client'
import { type SessionRow, sessions } from '../../../../db/schema'
import type { AppBindings } from '../../../types'
import { loggerFor } from '../../../utils/core/logger'
import { recordUsage } from '../../ai/usage'
import { checkBudget } from '../budget'
import { MODEL_KEY_PLACEHOLDER, resolveModelKey } from '../model-key'
import type { ModelUpstream } from '../ports'

export { MODEL_KEY_PLACEHOLDER }

/** What the platform hands an outbound handler (`OutboundHandlerContext` in `@cloudflare/containers`). */
export interface EgressContext {
  /** The Durable Object id of the sandbox — `sessions.sandbox_id`. */
  containerId: string
  className?: string
}

/** Everything the handler reaches, injectable so a test drives it with fakes. */
export interface AnthropicEgressDeps {
  upstream: ModelUpstream
  openDb: (env: AppBindings, cfg: AppConfig) => DatabaseHandle
  now: () => Date
}

/** Where a keyed request goes. The path and query come from the sandbox's request; the host never does. */
export const ANTHROPIC_UPSTREAM_ORIGIN = 'https://api.anthropic.com'

/** The only paths a session may call; everything else is a 403. */
export const ALLOWED_MODEL_PATHS = ['/v1/messages', '/v1/messages/count_tokens'] as const

/** The `ai_usage.feature` a session's model calls are recorded under. */
export const SESSION_USAGE_FEATURE = 'session'

/** An error in Anthropic's own shape, so Claude Code reports it as the API would. */
export function anthropicError(status: number, type: string, message: string): Response {
  return Response.json({ type: 'error', error: { type, message } }, { status })
}

/**
 * The live session a container belongs to, or null. PRE-TENANT: `sandbox_id` is unique and the
 * platform — not the sandbox — supplies it; the tenant is taken from the row that comes back.
 */
export async function sessionForSandbox(
  db: Database,
  sandboxId: string
): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.sandboxId, sandboxId), inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]))
    )
    .limit(1)
  return row ?? null
}

/** Is `requested` the policy's model — exactly, or a dated id of it (`<model>-YYYYMMDD`)? */
export function isAllowedModel(requested: unknown, policyModel: string): boolean {
  if (typeof requested !== 'string' || !requested) return false
  const want = policyModel.trim().toLowerCase()
  const got = requested.trim().toLowerCase()
  return (
    got === want || new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}$`).test(got)
  )
}

/** Request headers never forwarded: the sandbox's credentials, and what the new request sets itself. */
const DROPPED_HEADERS = ['authorization', 'x-api-key', 'host', 'content-length', 'cookie']

const defaultDeps = (): AnthropicEgressDeps => ({
  upstream: { fetch: req => fetch(req) },
  openDb: (env, cfg) => openDatabase({ ...cfg, HYPERDRIVE: env.HYPERDRIVE }),
  now: () => new Date(),
})

export async function handleAnthropic(
  req: Request,
  env: AppBindings,
  ctx: EgressContext,
  overrides: Partial<AnthropicEgressDeps> = {}
): Promise<Response> {
  const deps = { ...defaultDeps(), ...overrides }
  const cfg = loadConfig(env)
  const logger = loggerFor(cfg, { handler: 'egress', host: 'api.anthropic.com' })
  const handle = deps.openDb(env, cfg)
  let session: SessionRow
  let apiKey: string
  let body: string
  let model: string
  let path: string
  let upstreamUrl: string
  try {
    const found = await sessionForSandbox(handle.db, ctx.containerId)
    if (!found) {
      return anthropicError(403, 'permission_error', 'This sandbox is not a live Launch session')
    }
    session = found

    const url = new URL(req.url)
    path = url.pathname
    if (req.method !== 'POST' || !(ALLOWED_MODEL_PATHS as readonly string[]).includes(path)) {
      return anthropicError(
        403,
        'permission_error',
        `Launch sessions may only call POST ${ALLOWED_MODEL_PATHS.join(' and ')}`
      )
    }

    body = await req.text()
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null
    } catch {
      parsed = null
    }
    const policy = resolveSessionPolicy(session.policy)
    if (!parsed || !isAllowedModel(parsed.model, policy.model)) {
      return anthropicError(
        403,
        'permission_error',
        `This Launch session may only use the model ${policy.model}`
      )
    }
    model = String(parsed.model)

    const verdict = await checkBudget(handle.db, session, deps.now())
    if (!verdict.ok) {
      return anthropicError(
        403,
        'permission_error',
        verdict.scope === 'session'
          ? 'This Launch session has reached its budget. Ask an app owner to extend it.'
          : "This app's coding sessions have reached their monthly budget."
      )
    }

    const key = await resolveModelKey(handle.db, cfg)
    if (!key) {
      return anthropicError(503, 'api_error', 'Launch has no Anthropic key configured')
    }
    apiKey = key.apiKey
    upstreamUrl = `${ANTHROPIC_UPSTREAM_ORIGIN}${path}${url.search}`
  } finally {
    await handle.close()
  }

  const headers = new Headers(req.headers)
  for (const name of DROPPED_HEADERS) headers.delete(name)
  headers.set('x-api-key', apiKey)
  const upstreamReq = new Request(upstreamUrl, { method: 'POST', headers, body })

  let res: Response
  try {
    res = await deps.upstream.fetch(upstreamReq)
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, 'model proxy: upstream unreachable')
    return anthropicError(502, 'api_error', 'Launch could not reach the Anthropic API')
  }

  if (path !== '/v1/messages' || !res.ok || !res.body) return res

  const meter = createUsageMeter(res.headers.get('content-type') ?? '')
  const record = async (): Promise<void> => {
    const usage = meter.result()
    if (!usage) return
    const recordHandle = deps.openDb(env, cfg)
    try {
      await recordSessionUsage(recordHandle.db, session, usage.model ?? model, usage.usage)
    } catch (err) {
      logger.error({ err, sessionId: session.id }, 'model proxy: could not record usage')
    } finally {
      await recordHandle.close()
    }
  }
  const decoder = new TextDecoder()
  const metered = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        meter.push(decoder.decode(chunk, { stream: true }))
        controller.enqueue(chunk)
      },
      async flush() {
        meter.push(decoder.decode())
        await record()
      },
    })
  )
  return new Response(metered, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

// ---- metering ------------------------------------------------------------------------------------

export interface MeteredUsage {
  usage: TokenUsage
  /** The model the response names (a dated id), when it names one. */
  model: string | null
}

export interface UsageMeter {
  push(text: string): void
  /** The usage the response reported, or null when it reported none. */
  result(): MeteredUsage | null
}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined

/**
 * Reads usage out of a Messages API response as it passes through. SSE: `message_start` carries
 * the input and cache counts (and a placeholder output count), each `message_delta` the CUMULATIVE
 * counts so far — so a later value replaces an earlier one rather than adding to it. JSON: one
 * `usage` object on the whole body.
 */
export function createUsageMeter(contentType: string): UsageMeter {
  const sse = contentType.includes('text/event-stream')
  let buffer = ''
  let model: string | null = null
  let seen = false
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

  const take = (u: unknown) => {
    if (!u || typeof u !== 'object') return
    const r = u as Record<string, unknown>
    const input = count(r.input_tokens)
    const output = count(r.output_tokens)
    const cacheRead = count(r.cache_read_input_tokens)
    const cacheWrite = count(r.cache_creation_input_tokens)
    if (input !== undefined) usage.inputTokens = input
    if (output !== undefined) usage.outputTokens = output
    if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead
    if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite
    seen = true
  }

  const readObject = (text: string) => {
    let j: Record<string, unknown>
    try {
      j = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    const message = j.message as Record<string, unknown> | undefined
    if (j.type === 'message_start' && message) {
      if (typeof message.model === 'string') model = message.model
      take(message.usage)
    } else if (j.type === 'message_delta') {
      take(j.usage)
    } else if (j.type === 'message') {
      if (typeof j.model === 'string') model = j.model
      take(j.usage)
    }
  }

  const readLine = (line: string) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('data:')) readObject(trimmed.slice(5).trim())
  }

  return {
    push(text) {
      buffer += text
      if (!sse) return
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) readLine(line)
    },
    result() {
      if (sse) {
        if (buffer) readLine(buffer)
      } else {
        readObject(buffer)
      }
      buffer = ''
      return seen ? { usage: { ...usage }, model } : null
    },
  }
}

/**
 * One `ai_usage` row for the session's call, and the same numbers added to its running totals, in
 * one transaction. The cost is priced once here (`@launch/shared/ai/pricing`) and passed to both,
 * so `sum(ai_usage.cost_microcents)` for the session IS `sessions.cost_microcents`. A model with no
 * price records a null cost and adds nothing to the total — the budget cannot see it.
 */
export async function recordSessionUsage(
  db: Database,
  session: Pick<SessionRow, 'id' | 'tenantId' | 'createdByUserId'>,
  model: string,
  usage: TokenUsage
): Promise<void> {
  const cost = estimateCostMicrocents('anthropic', model, usage)
  await db.transaction(async tx => {
    await recordUsage(tx, {
      tenantId: session.tenantId,
      userId: session.createdByUserId,
      sessionId: session.id,
      feature: SESSION_USAGE_FEATURE,
      provider: 'anthropic',
      model,
      usage,
      costMicrocents: cost,
    })
    await tx
      .update(sessions)
      .set({
        tokensIn: sql`${sessions.tokensIn} + ${usage.inputTokens}`,
        tokensOut: sql`${sessions.tokensOut} + ${usage.outputTokens}`,
        cacheRead: sql`${sessions.cacheRead} + ${usage.cacheReadTokens ?? 0}`,
        cacheWrite: sql`${sessions.cacheWrite} + ${usage.cacheWriteTokens ?? 0}`,
        costMicrocents: sql`${sessions.costMicrocents} + ${cost ?? 0}`,
        lastActivityAt: new Date(),
      })
      .where(and(eq(sessions.tenantId, session.tenantId), eq(sessions.id, session.id)))
  })
}
