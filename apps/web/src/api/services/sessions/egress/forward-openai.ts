/**
 * The OpenAI egress FORWARDING CORE (§18.22-B) — what Launch's two OpenAI handlers do to a
 * request that is not about who is asking or what it costs, with nothing of Launch's database or
 * config, so the sandbox host Worker (`src/sandbox-host/`) bundles it too and the two sides cannot
 * drift (the same split as `forward-model.ts` for Anthropic and `forward-git.ts` for git):
 *
 * - **WebSocket first, then SSE.** Codex 0.160 opens `wss://…/responses` before it falls back to a
 *   streamed HTTP request (spike S-B1). A handler cannot meter or model-check a WebSocket, so every
 *   upgrade is answered `426 Upgrade Required` ({@link refuseWebSocket}) — Codex then uses SSE.
 * - **The paths**: Launch's key (`api.openai.com`) — `POST /v1/responses` (+ `/compact`) and `GET
 *   /v1/models` ({@link openAiRoute}); the sign-in host (`auth.openai.com`) — the device flow for
 *   a login sandbox ({@link CODEX_LOGIN_AUTH_PATHS}) and `POST /oauth/token` with `grant_type:
 *   refresh_token` for a session on a ChatGPT plan ({@link readCodexRefresh}). A plan's model
 *   calls (`chatgpt.com`) are not proxied at all: ChatGPT blocks requests from the Workers
 *   runtime, so the container reaches it directly (`registry.ts`).
 * - **The model allow-list** is the session policy's model, read out of the request body — the
 *   same rule as Anthropic's (`isAllowedModel`). A body Launch cannot read (compressed: Codex's
 *   `enable_request_compression`, switched off in its `config.toml`) is a 415, never forwarded
 *   unchecked ({@link readResponsesCall}).
 * - **The Responses API's usage** comes once, on the `response.completed` SSE event (or a JSON
 *   body's `usage`); OpenAI counts cached input INSIDE `input_tokens`, so it is split out here into
 *   Launch's disjoint counters (`TokenUsage.inputTokens` is uncached).
 *
 * The `forward*` functions are whole handlers over a grant — what the sandbox host runs, unmetered
 * (its turns are metered from Codex's own output, `turn-meter.ts`). Launch's own handlers
 * (`openai.ts`, `openai-auth.ts`) call the same pieces with their database checks,
 * the budget and the meter in between.
 */
import type { TokenUsage } from '@launch/shared/ai/chat'
import { isAllowedModel, refusedModelMessage, type UpstreamFetch } from './forward-model'
import { openAiError } from './refuse'

export { openAiError }

const globalUpstream: UpstreamFetch = { fetch: (r: Request) => fetch(r) }

// ---- where requests go ---------------------------------------------------------------------------

/** Where a keyed request on Launch's account goes; the path and query come from the sandbox. */
export const OPENAI_UPSTREAM_ORIGIN = 'https://api.openai.com'
/** The model calls a Codex session may make on Launch's key. */
export const OPENAI_MODEL_PATHS = ['/v1/responses', '/v1/responses/compact'] as const
/** Codex's model discovery: keyed, not metered. */
export const OPENAI_MODELS_PATH = '/v1/models'

export const OPENAI_AUTH_UPSTREAM_ORIGIN = 'https://auth.openai.com'
/** What a Codex login sandbox may call: the device-code flow and its exchange. */
export const CODEX_LOGIN_AUTH_PATHS = [
  '/api/accounts/deviceauth/usercode',
  '/api/accounts/deviceauth/token',
  '/oauth/token',
] as const
/** What a Codex session may call on `auth.openai.com`: the token refresh. */
export const CODEX_REFRESH_PATH = '/oauth/token'

// ---- shared pieces -------------------------------------------------------------------------------

/** `426` for a WebSocket upgrade (Codex then streams over HTTP), or null for anything else. */
export function refuseWebSocket(req: Request): Response | null {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return null
  return new Response('Launch sessions stream model responses over HTTP, not WebSockets.', {
    status: 426,
    headers: { 'content-type': 'text/plain; charset=utf-8', connection: 'close' },
  })
}

/** Request headers never forwarded: the sandbox's credential (on Launch's key) and hop headers. */
const HOP_HEADERS = ['host', 'content-length', 'cookie', 'connection', 'upgrade', 'accept-encoding']

/** The sandbox's headers minus hop headers — and minus its `Authorization` when `dropAuth`. */
export function forwardHeaders(req: Request, opts: { dropAuth: boolean }): Headers {
  const headers = new Headers(req.headers)
  for (const name of HOP_HEADERS) headers.delete(name)
  if (opts.dropAuth) {
    headers.delete('authorization')
    headers.delete('openai-organization')
    headers.delete('openai-project')
  }
  return headers
}

/** A model call that passed the allow-list: its body already read. */
export interface ResponsesCall {
  path: string
  search: string
  body: string
  model: string
}

/** The request as a {@link ResponsesCall}, or the 403/415 that refuses it. */
export async function readResponsesCall(
  req: Request,
  policyModel: string | null
): Promise<ResponsesCall | Response> {
  const url = new URL(req.url)
  const encoding = req.headers.get('content-encoding')
  if (encoding && encoding.toLowerCase() !== 'identity') {
    return openAiError(
      415,
      'invalid_request_error',
      'Launch sessions cannot read a compressed request body; turn request compression off'
    )
  }
  const body = await req.text()
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null
  } catch {
    parsed = null
  }
  if (!parsed || !isAllowedModel(parsed.model, policyModel, 'openai')) {
    return openAiError(403, 'permission_error', refusedModelMessage(policyModel))
  }
  return { path: url.pathname, search: url.search, body, model: String(parsed.model) }
}

/** What a request to a model host is, once its path passed: model discovery or a model call. */
export type ModelRoute = 'models' | 'call'

/** The upstream request on `origin`: the checked call's body, or the discovery GET as it came. */
function upstreamRequest(
  origin: string,
  req: Request,
  call: ResponsesCall | null,
  headers: Headers
): Request {
  const url = new URL(req.url)
  return call
    ? new Request(`${origin}${call.path}${call.search}`, {
        method: 'POST',
        headers,
        body: call.body,
      })
    : new Request(`${origin}${url.pathname}${url.search}`, { method: 'GET', headers })
}

// ---- api.openai.com (Launch's key) ---------------------------------------------------------------

/** `api.openai.com`: which allowed request this is, or the 403. */
export function openAiRoute(req: Request): ModelRoute | Response {
  const url = new URL(req.url)
  if (req.method === 'GET' && url.pathname === OPENAI_MODELS_PATH) return 'models'
  if (req.method === 'POST' && (OPENAI_MODEL_PATHS as readonly string[]).includes(url.pathname)) {
    return 'call'
  }
  return openAiError(
    403,
    'permission_error',
    `Launch sessions may only call POST ${OPENAI_MODEL_PATHS.join(' and ')} and GET ${OPENAI_MODELS_PATH}`
  )
}

/** The upstream request on Launch's key: the sandbox's own `Authorization` (the placeholder) dropped. */
export function openAiKeyedRequest(req: Request, call: ResponsesCall | null, key: string): Request {
  const headers = forwardHeaders(req, { dropAuth: true })
  headers.set('authorization', `Bearer ${key}`)
  return upstreamRequest(OPENAI_UPSTREAM_ORIGIN, req, call, headers)
}

export interface ForwardOpenAiOptions {
  /** Launch's OpenAI key. It goes on the one upstream request and nowhere else. */
  key: string
  /** The session policy's model; null: any priced OpenAI model (Codex picks). */
  model: string | null
  upstream?: UpstreamFetch
}

/** The sandbox host's `api.openai.com` for a Codex session on Launch's key — unmetered. */
export async function forwardOpenAi(req: Request, opts: ForwardOpenAiOptions): Promise<Response> {
  const upgrade = refuseWebSocket(req)
  if (upgrade) return upgrade
  const route = openAiRoute(req)
  if (route instanceof Response) return route
  let call: ResponsesCall | null = null
  if (route === 'call') {
    const read = await readResponsesCall(req, opts.model)
    if (read instanceof Response) return read
    call = read
  }
  try {
    return await (opts.upstream ?? globalUpstream).fetch(openAiKeyedRequest(req, call, opts.key))
  } catch {
    return openAiError(502, 'api_error', 'Launch could not reach the OpenAI API')
  }
}

// ---- auth.openai.com (sign-in and refresh) -------------------------------------------------------

/** A request to `auth.openai.com` with its body already read, headers as Codex sent them. */
export function openAiAuthRequest(req: Request, body: string): Request {
  const url = new URL(req.url)
  return new Request(`${OPENAI_AUTH_UPSTREAM_ORIGIN}${url.pathname}${url.search}`, {
    method: 'POST',
    headers: forwardHeaders(req, { dropAuth: false }),
    body,
  })
}

/** Is this one of the device flow's requests a Codex login sandbox may make? */
export function isCodexSignInRequest(req: Request): boolean {
  return (
    req.method === 'POST' &&
    (CODEX_LOGIN_AUTH_PATHS as readonly string[]).includes(new URL(req.url).pathname)
  )
}

/** A Codex login sandbox's device-flow request: passed through untouched, anything else a 403. */
export async function forwardCodexSignIn(
  req: Request,
  opts: { upstream?: UpstreamFetch; onUnreachable?: (err: unknown) => void } = {}
): Promise<Response> {
  if (!isCodexSignInRequest(req)) {
    return openAiError(
      403,
      'permission_error',
      `Launch sign-ins may not call ${new URL(req.url).pathname}`
    )
  }
  const body = await req.text()
  try {
    return await (opts.upstream ?? globalUpstream).fetch(openAiAuthRequest(req, body))
  } catch (err) {
    opts.onUnreachable?.(err)
    return openAiError(502, 'api_error', 'Launch could not reach OpenAI sign-in')
  }
}

/**
 * A session's token refresh — `POST /oauth/token` with `grant_type: refresh_token` and nothing
 * else: its body, or the 403. The caller has already proved the session holds the plan.
 */
export async function readCodexRefresh(req: Request): Promise<string | Response> {
  const url = new URL(req.url)
  if (req.method !== 'POST' || url.pathname !== CODEX_REFRESH_PATH) {
    return openAiError(403, 'permission_error', `Launch sessions may not call ${url.pathname}`)
  }
  const body = await req.text()
  let grant: { grant_type?: unknown } | null = null
  try {
    grant = JSON.parse(body) as { grant_type?: unknown } | null
  } catch {
    grant = null
  }
  if (grant?.grant_type !== 'refresh_token') {
    return openAiError(403, 'permission_error', 'Launch sessions may only refresh their token')
  }
  return body
}

/**
 * The sandbox host's `auth.openai.com` for a session on a ChatGPT plan: the refresh, passed
 * through. Unlike Launch's handler it cannot reseal the rotated tokens at once (no database) — the
 * turn's lease reads `auth.json` back afterwards and reseals it (§18.22-B, known gaps).
 */
export async function forwardCodexRefresh(
  req: Request,
  opts: { upstream?: UpstreamFetch } = {}
): Promise<Response> {
  const body = await readCodexRefresh(req)
  if (body instanceof Response) return body
  try {
    return await (opts.upstream ?? globalUpstream).fetch(openAiAuthRequest(req, body))
  } catch {
    return openAiError(502, 'api_error', 'Launch could not reach OpenAI sign-in')
  }
}

// ---- metering (Launch's handlers) ----------------------------------------------------------------

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0

/** A Responses API `usage` object as Launch's disjoint `TokenUsage`, or null. */
export function tokenUsageFromResponses(value: unknown): TokenUsage | null {
  if (!value || typeof value !== 'object') return null
  const u = value as Record<string, unknown>
  const details = (u.input_tokens_details ?? {}) as Record<string, unknown>
  const input = count(u.input_tokens)
  const cached = Math.min(input, count(details.cached_tokens))
  return {
    inputTokens: input - cached,
    outputTokens: count(u.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  }
}

export interface MeteredResponse {
  usage: TokenUsage
  /** The model the response names, when it names one. */
  model: string | null
}

export interface ResponsesUsageMeter {
  push(text: string): void
  result(): MeteredResponse | null
}

/**
 * Reads usage out of a Responses API answer as it passes through: the `response.completed` (or
 * `response.incomplete` / `response.failed`, which still bill) event of an SSE stream, or a JSON
 * body's `usage`.
 */
export function createResponsesUsageMeter(contentType: string): ResponsesUsageMeter {
  const sse = contentType.includes('text/event-stream')
  let buffer = ''
  let found: MeteredResponse | null = null

  const take = (response: Record<string, unknown> | null) => {
    if (!response) return
    const usage = tokenUsageFromResponses(response.usage)
    if (usage) found = { usage, model: typeof response.model === 'string' ? response.model : null }
  }
  const readObject = (text: string) => {
    let j: Record<string, unknown>
    try {
      j = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    if (
      j.type === 'response.completed' ||
      j.type === 'response.incomplete' ||
      j.type === 'response.failed'
    ) {
      take((j.response as Record<string, unknown> | undefined) ?? null)
    } else if (!sse) {
      take(j)
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
      return found
    },
  }
}

/**
 * `res` with its body metered on the way through: `onUsage` runs once the body has ENDED (a
 * reader that abandons it half way records nothing — the same rule as Anthropic's meter).
 */
export function meteredResponse(
  res: Response,
  onUsage: (usage: MeteredResponse) => Promise<void>
): Response {
  if (!res.ok || !res.body) return res
  const meter = createResponsesUsageMeter(res.headers.get('content-type') ?? '')
  const decoder = new TextDecoder()
  const body = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        meter.push(decoder.decode(chunk, { stream: true }))
        controller.enqueue(chunk)
      },
      async flush() {
        meter.push(decoder.decode())
        const usage = meter.result()
        if (usage) await onUsage(usage)
      },
    })
  )
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}
