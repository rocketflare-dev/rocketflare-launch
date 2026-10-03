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
 * Steps 2 and 4 are `readModelCall` / `keyedModelRequest` (`forward-model.ts`, no database), which
 * the sandbox host's `HostedSessionSandbox` runs too — without 3 and 5, which need the database
 * (`SESSION_SANDBOX_HOST=remote`: the turn meters itself, `turn-meter.ts`).
 *
 * `count_tokens` is free, so it is keyed but not metered. A response the reader abandons half way
 * (the container died mid-stream) records nothing — the TransformStream's `flush` never runs; the
 * row's running cost is then short by that one call.
 */
import type { TokenUsage } from '@launch/shared/ai/chat'
import type { AiProvider } from '@launch/shared/ai/config'
import { estimateCostMicrocents } from '@launch/shared/ai/pricing'
import type { AiUsageBilling } from '@launch/shared/ai/usage'
import { resolveSessionPolicy } from '@launch/shared/launch-sessions'
import { and, eq, sql } from 'drizzle-orm'
import { type AppConfig, loadConfig } from '../../../../config'
import { type Database, type DatabaseHandle, openDatabase } from '../../../../db/client'
import { type SessionRow, sessions } from '../../../../db/schema'
import type { AppBindings } from '../../../types'
import { loggerFor } from '../../../utils/core/logger'
import { recordUsage } from '../../ai/usage'
import { checkBudget } from '../budget'
import { MODEL_KEY_PLACEHOLDER, resolveModelKey } from '../model-key'
import type { ModelUpstream } from '../ports'
import type { EgressContext } from './forward-git'
import { anthropicError, keyedModelRequest, type ModelCall, readModelCall } from './forward-model'
import { sessionForSandbox } from './sandbox-lookup'

export type { EgressContext } from './forward-git'
export {
  ALLOWED_MODEL_PATHS,
  ANTHROPIC_UPSTREAM_ORIGIN,
  anthropicError,
  isAllowedModel,
} from './forward-model'
export { MODEL_KEY_PLACEHOLDER }

/** Everything the handler reaches, injectable so a test drives it with fakes. */
export interface AnthropicEgressDeps {
  upstream: ModelUpstream
  openDb: (env: AppBindings, cfg: AppConfig) => DatabaseHandle
  now: () => Date
}

/** The `ai_usage.feature` a session's model calls are recorded under. */
export const SESSION_USAGE_FEATURE = 'session'

/** The pre-tenant lookup moved to `sandbox-lookup.ts` (§18.22); re-exported where it always was. */
export { sessionForSandbox }

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
  let call: ModelCall
  try {
    const found = await sessionForSandbox(handle.db, ctx.containerId)
    if (!found) {
      return anthropicError(403, 'permission_error', 'This sandbox is not a live Launch session')
    }
    session = found

    // The path and model allow-list (`forward-model.ts`, shared with the sandbox host).
    const read = await readModelCall(req, resolveSessionPolicy(session.policy).model)
    if (read instanceof Response) return read
    call = read

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
  } finally {
    await handle.close()
  }

  let res: Response
  try {
    res = await deps.upstream.fetch(keyedModelRequest(req, call, apiKey))
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, 'model proxy: upstream unreachable')
    return anthropicError(502, 'api_error', 'Launch could not reach the Anthropic API')
  }

  if (call.path !== '/v1/messages' || !res.ok || !res.body) return res

  const model = call.model
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
  usage: TokenUsage,
  /**
   * A call Launch made itself for the session (the ship's PR summary, `ship.ts`): its provider
   * and `ai_usage.feature`. Default: the session's own Anthropic call, feature `session`.
   * `billing: 'subscription'` (§18.22): a personal account paid — recorded with a null cost.
   */
  opts: { provider?: AiProvider; feature?: string; billing?: AiUsageBilling } = {}
): Promise<void> {
  const provider = opts.provider ?? 'anthropic'
  // §18.22: a person's own plan paid — the tokens count, the cost is null and the total unmoved.
  const billing = opts.billing ?? 'metered'
  const cost = billing === 'subscription' ? null : estimateCostMicrocents(provider, model, usage)
  await db.transaction(async tx => {
    await recordUsage(tx, {
      tenantId: session.tenantId,
      userId: session.createdByUserId,
      sessionId: session.id,
      feature: opts.feature ?? SESSION_USAGE_FEATURE,
      provider,
      model,
      usage,
      costMicrocents: cost,
      billing,
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
