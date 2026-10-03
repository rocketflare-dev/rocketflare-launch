/**
 * The model proxy's FORWARDING CORE — what `egress/anthropic.ts` does to a request that is not
 * about who is asking or what it costs, with nothing of Launch's database or config, so the
 * sandbox host Worker (`src/sandbox-host/`) bundles it too:
 *
 * - {@link readModelCall}: only `POST /v1/messages` and `/v1/messages/count_tokens`, and only the
 *   policy's model (or a dated id of it) — else an Anthropic-shaped 403;
 * - {@link keyedModelRequest}: the sandbox's own `x-api-key` / `Authorization` (the placeholder)
 *   and hop headers dropped, the real credential set ({@link ModelAuth}: Launch's key as
 *   `x-api-key`, or — §18.22-A — a person's subscription token as `Authorization: Bearer` with
 *   the OAuth beta flag merged into `anthropic-beta`), sent to {@link ANTHROPIC_UPSTREAM_ORIGIN} —
 *   the path and query (`?beta=true`) come from the sandbox's request, the host never does;
 * - {@link forwardModel}: both, then the upstream call (unreachable → 502). What the sandbox host's
 *   `HostedSessionSandbox` runs over the key and model in its egress grant.
 *
 * Metering and the budget are NOT here: `handleAnthropic` (Launch's own sandboxes) checks the
 * budget between the two halves and meters the answer as it streams back; a remote sandbox's turn
 * meters itself from Claude Code's output (`turn-meter.ts`), because the host has no database.
 */

/** Where a keyed request goes. The path and query come from the sandbox's request; the host never does. */
export const ANTHROPIC_UPSTREAM_ORIGIN = 'https://api.anthropic.com'

/** The only paths a session may call; everything else is a 403. */
export const ALLOWED_MODEL_PATHS = ['/v1/messages', '/v1/messages/count_tokens'] as const

/**
 * What Claude Code on a subscription (OAuth) token GETs besides the Messages API (spike S-A2): its
 * organisation's policy limits and managed settings. The model proxy answers 404 — which Claude
 * Code tolerates — so a person's org-managed settings never override Launch's permission and deny
 * setup (§18.22-A).
 */
export const OAUTH_NOT_FOUND_PREFIX = '/api/claude_code/'

/** An error in Anthropic's own shape, so Claude Code reports it as the API would. */
export function anthropicError(status: number, type: string, message: string): Response {
  return Response.json({ type: 'error', error: { type, message } }, { status })
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

/** A model request that passed the allow-list: what it asks for, its body already read. */
export interface ModelCall {
  path: (typeof ALLOWED_MODEL_PATHS)[number]
  search: string
  body: string
  /** The model the body names (the policy's, or a dated id of it). */
  model: string
}

/** The request as a {@link ModelCall}, or the 403 that refuses it. */
export async function readModelCall(
  req: Request,
  policyModel: string
): Promise<ModelCall | Response> {
  const url = new URL(req.url)
  const path = url.pathname
  if (req.method !== 'POST' || !(ALLOWED_MODEL_PATHS as readonly string[]).includes(path)) {
    return anthropicError(
      403,
      'permission_error',
      `Launch sessions may only call POST ${ALLOWED_MODEL_PATHS.join(' and ')}`
    )
  }
  const body = await req.text()
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null
  } catch {
    parsed = null
  }
  if (!parsed || !isAllowedModel(parsed.model, policyModel)) {
    return anthropicError(
      403,
      'permission_error',
      `This Launch session may only use the model ${policyModel}`
    )
  }
  return {
    path: path as ModelCall['path'],
    search: url.search,
    body,
    model: String(parsed.model),
  }
}

/** The beta flag Anthropic requires on a request authorised by a subscription's OAuth token. */
export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20'

/**
 * What authorises the upstream request: Launch's API key (`x-api-key`), or — a session on a
 * person's own Claude subscription (§18.22-A) — their OAuth token (`Authorization: Bearer`, with
 * {@link ANTHROPIC_OAUTH_BETA}). The sandbox host only ever forwards `api_key`.
 */
export type ModelAuth = { kind: 'api_key'; key: string } | { kind: 'oauth'; token: string }

/** `anthropic-beta` with the OAuth flag in it, the client's other flags kept in their order. */
export function withOAuthBeta(existing: string | null): string {
  const flags = (existing ?? '')
    .split(',')
    .map(flag => flag.trim())
    .filter(Boolean)
  if (!flags.includes(ANTHROPIC_OAUTH_BETA)) flags.push(ANTHROPIC_OAUTH_BETA)
  return flags.join(',')
}

/** The upstream request for `call`: the sandbox's headers minus its credentials, and `auth`. */
export function keyedModelRequest(req: Request, call: ModelCall, auth: ModelAuth): Request {
  const headers = new Headers(req.headers)
  for (const name of DROPPED_HEADERS) headers.delete(name)
  if (auth.kind === 'oauth') {
    headers.set('authorization', `Bearer ${auth.token}`)
    headers.set('anthropic-beta', withOAuthBeta(headers.get('anthropic-beta')))
  } else {
    headers.set('x-api-key', auth.key)
  }
  return new Request(`${ANTHROPIC_UPSTREAM_ORIGIN}${call.path}${call.search}`, {
    method: 'POST',
    headers,
    body: call.body,
  })
}

export interface ForwardModelOptions {
  /** The real key. It goes on the one upstream request and nowhere else. */
  key: string
  /** The session policy's model. */
  model: string
  /** Where the keyed request goes; the global `fetch` by default. */
  upstream?: { fetch(req: Request): Promise<Response> }
}

/** Check, key and forward one model request — unmetered (see the header). */
export async function forwardModel(req: Request, opts: ForwardModelOptions): Promise<Response> {
  const call = await readModelCall(req, opts.model)
  if (call instanceof Response) return call
  const upstream = opts.upstream ?? { fetch: (r: Request) => fetch(r) }
  try {
    return await upstream.fetch(keyedModelRequest(req, call, { kind: 'api_key', key: opts.key }))
  } catch {
    return anthropicError(502, 'api_error', 'Launch could not reach the Anthropic API')
  }
}
