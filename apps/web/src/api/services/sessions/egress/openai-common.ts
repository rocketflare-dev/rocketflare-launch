/**
 * What the three OpenAI egress handlers share (§18.22-B): `openai.ts` (`api.openai.com`, Launch's
 * key), `chatgpt.ts` (`chatgpt.com`, a person's plan) and `openai-auth.ts` (`auth.openai.com`, the
 * device sign-in and token refresh).
 *
 * - **WebSocket first, then SSE.** Codex 0.160 opens `wss://…/responses` before it falls back to a
 *   streamed HTTP request (spike S-B1). A handler cannot meter or model-check a WebSocket, so every
 *   upgrade is answered `426 Upgrade Required` — Codex then uses SSE, which it can.
 * - **The Responses API's usage** comes once, on the `response.completed` SSE event (or a JSON
 *   body's `usage`); OpenAI counts cached input INSIDE `input_tokens`, so it is split out here into
 *   Launch's disjoint counters (`TokenUsage.inputTokens` is uncached).
 * - **The model allow-list** is the session policy's model, read out of the request body — the
 *   same rule as Anthropic's (`isAllowedModel`). A body Launch cannot read (compressed: Codex's
 *   `enable_request_compression`, switched off in its `config.toml`) is refused, never forwarded
 *   unchecked.
 */
import type { TokenUsage } from '@launch/shared/ai/chat'
import type { AppConfig } from '../../../../config'
import type { DatabaseHandle } from '../../../../db/client'
import type { AppBindings } from '../../../types'
import type { ModelUpstream } from '../ports'
import { isAllowedModel } from './forward-model'
import { openAiError } from './refuse'

export { openAiError }

/** Everything an OpenAI handler reaches, injectable so a test drives it with fakes. */
export interface OpenAiEgressDeps {
  upstream: ModelUpstream
  openDb: (env: AppBindings, cfg: AppConfig) => DatabaseHandle
  now: () => Date
}

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
  policyModel: string
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
  if (!parsed || !isAllowedModel(parsed.model, policyModel)) {
    return openAiError(
      403,
      'permission_error',
      `This Launch session may only use the model ${policyModel}`
    )
  }
  return { path: url.pathname, search: url.search, body, model: String(parsed.model) }
}

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
