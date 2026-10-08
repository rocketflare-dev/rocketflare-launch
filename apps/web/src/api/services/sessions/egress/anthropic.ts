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
 * (a session on the remote sandbox host: the turn meters itself, `turn-meter.ts`).
 *
 * **A session on the creator's own Claude subscription** (§18.22-A, `credential_source = 'user'`)
 * holds `CLAUDE_CODE_OAUTH_TOKEN=<placeholder>` instead. For it: `GET /api/claude_code/*` (its
 * organisation's managed settings and limits) is a 404, so they cannot override Launch's setup;
 * step 3 is skipped (the person's plan pays — turn and time limits still hold); step 4 decrypts the
 * session's own `agent_credentials` row (same tenant, the creator's, active, unexpired — else a 401
 * telling them to reconnect) and sends it as `Authorization: Bearer` with `oauth-2025-04-20` merged
 * into `anthropic-beta`; step 5 records `billing: 'subscription'` with a null cost. An upstream 401
 * marks the credential `needs_login` and answers a sentence; a 429 passes through as it came.
 *
 * **A Claude sign-in's sandbox** (`loginForSandbox`, no session) may make exactly the requests in
 * `CLAUDE_LOGIN_PASSTHROUGH` — here `GET /api/oauth/profile`, and the token exchange on
 * `platform.claude.com` through `handleClaudeLoginHost` — passed through untouched.
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
import { getById, markNeedsLogin, openSecret } from '../credentials/store'
import { MODEL_KEY_PLACEHOLDER, resolveModelKey } from '../model-key'
import type { ModelUpstream } from '../ports'
import { usableClaudeCredential } from '../runtimes/claude-code/credentials'
import type { EgressContext } from './forward-git'
import {
  anthropicError,
  CLAUDE_LOGIN_PASSTHROUGH,
  forwardClaudeSignIn,
  keyedModelRequest,
  type ModelAuth,
  type ModelCall,
  oauthNotFound,
  readModelCall,
} from './forward-model'
import { loginForSandbox, sessionForSandbox } from './sandbox-lookup'

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

/** A subscription session whose credential is gone, refused, or past its expiry. */
export const SUBSCRIPTION_NEEDS_LOGIN_MESSAGE =
  'Your Claude subscription is not connected. Reconnect your Claude account in Launch (Profile), then send your message again.'

/** Anthropic answered 401 to a subscription session's token. */
export const SUBSCRIPTION_REFUSED_MESSAGE =
  'Anthropic refused your Claude subscription token. Reconnect your Claude account in Launch (Profile), then send your message again.'

/** A model call that passed every check, ready to key and send. */
interface PreparedCall {
  session: SessionRow
  call: ModelCall
  auth: ModelAuth
  /** §18.22-A: the session's own subscription credential, when it bills one. */
  credentialId: string | null
}

/**
 * Who is asking, what for, and with which credential — every database read the handler makes
 * before the upstream call. A refusal is the `Response` to send; `'sign-in'` is a Claude login's
 * sandbox (`loginForSandbox`), which only reaches its account profile here.
 */
async function prepareModelCall(
  req: Request,
  db: Database,
  cfg: AppConfig,
  ctx: EgressContext,
  now: Date
): Promise<PreparedCall | Response | 'sign-in'> {
  const session = await sessionForSandbox(db, ctx.containerId)
  if (!session) {
    if ((await loginForSandbox(db, ctx.containerId))?.runtime === 'claude_code') return 'sign-in'
    return anthropicError(403, 'permission_error', 'This sandbox is not a live Launch session')
  }
  const subscription = session.credentialSource === 'user'

  // Claude Code on an OAuth token asks for its organisation's managed settings and limits:
  // "none" (404, tolerated), so they can never override Launch's permission and deny setup.
  const hidden = oauthNotFound(req, subscription ? 'oauth' : 'api_key')
  if (hidden) return hidden

  // The path and model allow-list (`forward-model.ts`, shared with the sandbox host).
  const call = await readModelCall(req, resolveSessionPolicy(session.policy).model)
  if (call instanceof Response) return call

  if (subscription) {
    // The person's own plan pays: no money budget (turn and time limits still hold), and the
    // token is the session's credential — same tenant, the creator's, active, unexpired.
    const row = session.agentCredentialId
      ? await getById(db, session.tenantId, session.agentCredentialId)
      : null
    if (!usableClaudeCredential(row, session, now)) {
      return anthropicError(401, 'authentication_error', SUBSCRIPTION_NEEDS_LOGIN_MESSAGE)
    }
    return {
      session,
      call,
      auth: { kind: 'oauth', token: await openSecret(cfg, row) },
      credentialId: row.id,
    }
  }

  const verdict = await checkBudget(db, session, now)
  if (!verdict.ok) {
    return anthropicError(
      403,
      'permission_error',
      verdict.scope === 'session'
        ? 'This Launch session has reached its budget. Ask an app owner to extend it.'
        : "This app's coding sessions have reached their monthly budget."
    )
  }
  const key = await resolveModelKey(db, cfg)
  if (!key) return anthropicError(503, 'api_error', 'Launch has no Anthropic key configured')
  return { session, call, auth: { kind: 'api_key', key: key.apiKey }, credentialId: null }
}

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
  let prepared: Awaited<ReturnType<typeof prepareModelCall>>
  try {
    prepared = await prepareModelCall(req, handle.db, cfg, ctx, deps.now())
  } finally {
    await handle.close()
  }
  if (prepared instanceof Response) return prepared
  if (prepared === 'sign-in') return passThroughLogin(req, 'api.anthropic.com', deps, logger)
  const { session, call, auth, credentialId } = prepared

  let res: Response
  try {
    res = await deps.upstream.fetch(keyedModelRequest(req, call, auth))
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, 'model proxy: upstream unreachable')
    return anthropicError(502, 'api_error', 'Launch could not reach the Anthropic API')
  }

  if (credentialId && res.status === 401) {
    // Revoked or otherwise dead: the person must reconnect. Later calls stop here, before Anthropic.
    await res.body?.cancel().catch(() => {})
    const markHandle = deps.openDb(env, cfg)
    try {
      await markNeedsLogin(markHandle.db, session.tenantId, credentialId, deps.now())
    } catch (err) {
      logger.error({ err, sessionId: session.id }, 'model proxy: could not mark needs_login')
    } finally {
      await markHandle.close()
    }
    logger.warn(
      { sessionId: session.id, credentialId },
      'model proxy: Anthropic refused a subscription token'
    )
    return anthropicError(401, 'authentication_error', SUBSCRIPTION_REFUSED_MESSAGE)
  }

  // A 429 (the subscription's own rate limit) and every other answer pass through as they came.
  if (call.path !== '/v1/messages' || !res.ok || !res.body) return res

  const model = call.model
  const billing: AiUsageBilling = credentialId ? 'subscription' : 'metered'
  const meter = createUsageMeter(res.headers.get('content-type') ?? '')
  const record = async (): Promise<void> => {
    const usage = meter.result()
    if (!usage) return
    const recordHandle = deps.openDb(env, cfg)
    try {
      await recordSessionUsage(recordHandle.db, session, usage.model ?? model, usage.usage, {
        billing,
      })
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

// ---- a Claude sign-in's own traffic (§18.22-A) ---------------------------------------------------

/** `CLAUDE_LOGIN_PASSTHROUGH` and its forwarding live in `forward-model.ts`, shared with the host. */
export { CLAUDE_LOGIN_PASSTHROUGH }

function passThroughLogin(
  req: Request,
  host: string,
  deps: Pick<AnthropicEgressDeps, 'upstream'>,
  logger: Pick<ReturnType<typeof loggerFor>, 'warn'>
): Promise<Response> {
  return forwardClaudeSignIn(req, host, {
    upstream: deps.upstream,
    onUnreachable: err => logger.warn({ err, host }, 'sign-in passthrough: upstream unreachable'),
  })
}

/**
 * `SessionSandbox.outboundByHost['platform.claude.com']` — a Claude sign-in's token exchange,
 * passed through for a login sandbox (`loginForSandbox`, PRE-TENANT like the session lookup) and
 * refused for everything else, sessions included: a session has no business on this host.
 */
export async function handleClaudeLoginHost(
  req: Request,
  env: AppBindings,
  ctx: EgressContext,
  overrides: Partial<AnthropicEgressDeps> = {}
): Promise<Response> {
  const deps = { ...defaultDeps(), ...overrides }
  const cfg = loadConfig(env)
  const logger = loggerFor(cfg, { handler: 'egress', host: 'platform.claude.com' })
  const handle = deps.openDb(env, cfg)
  let signIn = false
  try {
    signIn = (await loginForSandbox(handle.db, ctx.containerId))?.runtime === 'claude_code'
  } finally {
    await handle.close()
  }
  if (!signIn) {
    return anthropicError(403, 'permission_error', 'This sandbox is not a Launch sign-in')
  }
  return passThroughLogin(req, 'platform.claude.com', deps, logger)
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
  opts: {
    provider?: AiProvider
    feature?: string
    billing?: AiUsageBilling
    /**
     * Run first, in the same transaction: false → record nothing. A caller that may record the
     * same usage twice (a retried Workflow step re-reading Pi's transcript) claims it here.
     */
    claim?: (tx: Database) => Promise<boolean>
  } = {}
): Promise<boolean> {
  const provider = opts.provider ?? 'anthropic'
  // §18.22: a person's own plan paid — the tokens count, the cost is null and the total unmoved.
  const billing = opts.billing ?? 'metered'
  const cost = billing === 'subscription' ? null : estimateCostMicrocents(provider, model, usage)
  return db.transaction(async tx => {
    if (opts.claim && !(await opts.claim(tx))) return false
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
    return true
  })
}
