/**
 * Fake OpenAI for the Codex suites (§18.22-B). Three halves, as Codex talks to OpenAI three ways:
 *
 * 1. **The Responses API**, as the egress handlers' upstream (`ModelUpstream`): `createFakeOpenAi()`
 *    records every request (`requests[i]`: `{ url, method, path, authorization, accountId, body }` —
 *    so a test can assert the placeholder never left Launch) and answers `POST …/responses` with an
 *    SSE stream whose `response.completed` carries `usage`, `GET …/models` with a model list, and
 *    `POST /oauth/token` with rotated tokens (`refresh`: `ok` or a refusal code).
 * 2. **Codex's own output** (`codex exec --json`): `codexExecJson(turn)` is a `FakeSandbox` process
 *    script shaped like `tests/fixtures/codex/exec-turn1.jsonl`.
 * 3. **ChatGPT-plan credentials**: `fakeJwt(claims)` (unsigned — nothing verifies it) and
 *    `codexAuthJsonText(…)`, the `auth.json` `codex login` writes.
 */
import type { ModelUpstream } from '@/api/services/sessions/ports'
import type { ProcessScript } from './fake-sandbox'

export interface FakeOpenAiUsage {
  input?: number
  cached?: number
  output?: number
}

const b64url = (text: string) =>
  btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** An unsigned JWT with `claims` (the egress and the login only DECODE them). */
export function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.sig`
}

/** A ChatGPT-plan `auth.json`, as Codex 0.160 writes it. */
export function codexAuthJsonText(
  opts: {
    refreshToken?: string
    accessToken?: string
    accountId?: string
    plan?: string
    lastRefresh?: string
    accessExp?: number
  } = {}
): string {
  const accountId = opts.accountId ?? 'acct-fake-0001'
  return JSON.stringify(
    {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: fakeJwt({
          email: 'ada@example.test',
          'https://api.openai.com/auth': {
            chatgpt_plan_type: opts.plan ?? 'plus',
            chatgpt_account_id: accountId,
          },
        }),
        access_token:
          opts.accessToken ??
          fakeJwt({ exp: opts.accessExp ?? Math.floor(Date.now() / 1000) + 3600, sub: 'u' }),
        refresh_token: opts.refreshToken ?? 'rt_fake_refresh_token_0001',
        account_id: accountId,
      },
      last_refresh: opts.lastRefresh ?? '2026-10-03T06:00:00Z',
    },
    null,
    2
  )
}

/** The SSE body of a streamed Responses API answer. */
export function responsesSseText(
  opts: { model?: string; text?: string; usage?: FakeOpenAiUsage } = {}
): string {
  const model = opts.model ?? 'gpt-6.1-sol-2026-09-30'
  const u = opts.usage ?? {}
  const response = {
    id: 'resp_fake',
    object: 'response',
    model,
    status: 'completed',
    usage: {
      input_tokens: u.input ?? 100,
      input_tokens_details: { cached_tokens: u.cached ?? 0 },
      output_tokens: u.output ?? 20,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: (u.input ?? 100) + (u.output ?? 20),
    },
  }
  const events: [string, unknown][] = [
    ['response.created', { type: 'response.created', response: { ...response, usage: null } }],
    [
      'response.output_text.delta',
      { type: 'response.output_text.delta', delta: opts.text ?? 'ok' },
    ],
    ['response.completed', { type: 'response.completed', response }],
  ]
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')
}

/** A streamed Responses answer, delivered in `chunkSize`-byte pieces. */
export function responsesSse(
  opts: Parameters<typeof responsesSseText>[0] = {},
  chunkSize = 50
): Response {
  const bytes = new TextEncoder().encode(responsesSseText(opts))
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize)
        controller.enqueue(bytes.slice(i, i + chunkSize))
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

export interface RecordedOpenAiRequest {
  url: string
  method: string
  path: string
  authorization: string | null
  accountId: string | null
  upgrade: string | null
  body: string
}

export interface FakeOpenAiOptions {
  usage?: FakeOpenAiUsage
  model?: string
  /** How `POST /oauth/token` answers: rotated tokens (`ok`, the default) or a refusal code. */
  refresh?: 'ok' | 'refresh_token_reused' | 'refresh_token_expired' | 'server_error'
  /** The rotated tokens an `ok` refresh returns. */
  rotated?: { access_token?: string; refresh_token?: string; id_token?: string }
  respond?: (req: Request, body: string) => Response | Promise<Response>
}

export function createFakeOpenAi(opts: FakeOpenAiOptions = {}) {
  const requests: RecordedOpenAiRequest[] = []
  const upstream: ModelUpstream = {
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === 'GET' ? '' : await req.text()
      requests.push({
        url: req.url,
        method: req.method,
        path: url.pathname,
        authorization: req.headers.get('authorization'),
        accountId: req.headers.get('chatgpt-account-id'),
        upgrade: req.headers.get('upgrade'),
        body,
      })
      if (opts.respond) return opts.respond(req, body)
      if (url.pathname.endsWith('/models')) {
        return Response.json({ object: 'list', data: [{ id: opts.model ?? 'gpt-6.1-sol' }] })
      }
      if (url.pathname === '/oauth/token') {
        const refresh = opts.refresh ?? 'ok'
        if (refresh === 'ok') {
          return Response.json({
            id_token: opts.rotated?.id_token ?? fakeJwt({ email: 'ada@example.test' }),
            access_token: opts.rotated?.access_token ?? fakeJwt({ exp: 4_102_444_800, n: 2 }),
            refresh_token: opts.rotated?.refresh_token ?? 'rt_fake_refresh_token_0002',
          })
        }
        if (refresh === 'server_error') {
          return Response.json(
            { error: { message: 'busy', code: 'server_error' } },
            { status: 500 }
          )
        }
        return Response.json(
          {
            error: {
              message: 'Your refresh token has already been used.',
              type: 'invalid_request_error',
              param: null,
              code: refresh,
            },
          },
          { status: 401 }
        )
      }
      if (url.pathname.startsWith('/api/accounts/deviceauth/')) {
        return Response.json({ device_auth_id: 'dev_1', user_code: 'K7QX-M2PD', interval: '5' })
      }
      return responsesSse({ usage: opts.usage, model: opts.model })
    },
  }
  return { upstream, requests }
}

export interface CodexTurnScript {
  threadId?: string
  text?: string
  commands?: { command: string; output: string; exitCode?: number }[]
  /** The THREAD's running total at the end of this turn (Codex reports it cumulatively). */
  usage?: { input?: number; cached?: number; output?: number }
  exitCode?: number
}

/** `codex exec --json` output for one turn, as a `FakeSandbox` process script. */
export function codexExecJson(turn: CodexTurnScript = {}): ProcessScript {
  const threadId = turn.threadId ?? '0199a213-81c0-7800-8aa1-bbab2a035a53'
  const lines: string[] = [
    JSON.stringify({ type: 'thread.started', thread_id: threadId }),
    JSON.stringify({ type: 'turn.started' }),
  ]
  for (const [i, c] of (turn.commands ?? []).entries()) {
    const item = { id: `item_c${i}`, type: 'command_execution', command: c.command }
    lines.push(
      JSON.stringify({
        type: 'item.started',
        item: { ...item, aggregated_output: '', exit_code: null, status: 'in_progress' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          ...item,
          aggregated_output: c.output,
          exit_code: c.exitCode ?? 0,
          status: (c.exitCode ?? 0) === 0 ? 'completed' : 'failed',
        },
      })
    )
  }
  lines.push(
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_msg', type: 'agent_message', text: turn.text ?? 'Done.' },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: turn.usage?.input ?? 1000,
        cached_input_tokens: turn.usage?.cached ?? 0,
        cache_write_input_tokens: 0,
        output_tokens: turn.usage?.output ?? 50,
        reasoning_output_tokens: 0,
      },
    })
  )
  return { lines, exitCode: turn.exitCode ?? 0 }
}
