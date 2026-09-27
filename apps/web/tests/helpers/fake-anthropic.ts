/**
 * Fake Anthropic for the coding-session suites (Launch P3). Two halves, because a session talks to
 * the model twice over:
 *
 * 1. **The Messages API, as the model proxy's upstream** (`ModelUpstream`,
 *    `services/sessions/egress/anthropic.ts`). `createFakeAnthropic()` records every request
 *    (`requests[i]`: `{ url, method, path, apiKey, authorization, body }` — so a test can assert the
 *    placeholder never reached upstream) and answers a streamed request with SSE and anything else
 *    with JSON, both carrying `usage`:
 *
 *    ```ts
 *    const anthropic = createFakeAnthropic({ usage: { input: 12, output: 40, cacheRead: 900 } })
 *    await handleAnthropic(req, env, { containerId }, { upstream: anthropic.upstream })
 *    anthropic.requests[0].apiKey            // the real key, never 'launch-session-placeholder'
 *    ```
 *
 *    `anthropicSse(message)` / `anthropicJson(message)` build one response directly; the SSE puts
 *    input and cache usage in `message_start` and output in `message_delta`, as Anthropic does —
 *    which is exactly what the S7 meter reads. `respond = (req, body) => Response` overrides.
 * 2. **Claude Code's own output** (`claude -p … --output-format stream-json --verbose`), which is
 *    what a session's turn process prints inside the sandbox. `claudeStreamJson(turn)` returns a
 *    `FakeSandbox` process script shaped like `spikes/s7-sandbox/output-locked-session.txt`'s turn:
 *    `system:init` → (`assistant` tool_use → `user` tool_result)… → `assistant` text → `result`.
 *
 *    ```ts
 *    sandbox.onProcess(/claude -p/, claudeStreamJson({
 *      sessionId: 'c1d2…', text: 'Changed the heading.',
 *      tools: [{ name: 'Edit', input: { file_path: 'src/ui/pages/Home.tsx' }, result: 'ok' }],
 *      usage: { input: 6, output: 115, cacheRead: 40131, cacheWrite: 4865 },
 *    }))
 *    ```
 */
import type { ModelUpstream } from '@/api/services/sessions/ports'
import type { ProcessScript } from './fake-sandbox'

export interface FakeUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

export interface FakeMessage {
  text?: string
  model?: string
  usage?: FakeUsage
  stopReason?: string
}

const usageOf = (u: FakeUsage = {}) => ({
  input_tokens: u.input ?? 10,
  output_tokens: u.output ?? 20,
  cache_read_input_tokens: u.cacheRead ?? 0,
  cache_creation_input_tokens: u.cacheWrite ?? 0,
})

const messageId = () => `msg_fake_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`

/** A non-streamed Messages API answer. */
export function anthropicJson(message: FakeMessage = {}): Response {
  return Response.json({
    id: messageId(),
    type: 'message',
    role: 'assistant',
    model: message.model ?? 'claude-sonnet-4-5-20250929',
    content: [{ type: 'text', text: message.text ?? 'ok' }],
    stop_reason: message.stopReason ?? 'end_turn',
    stop_sequence: null,
    usage: usageOf(message.usage),
  })
}

/** The SSE body of a streamed Messages API answer, as text (one event per `\n\n`). */
export function anthropicSseText(message: FakeMessage = {}): string {
  const usage = usageOf(message.usage)
  const text = message.text ?? 'ok'
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: messageId(),
          type: 'message',
          role: 'assistant',
          model: message.model ?? 'claude-sonnet-4-5-20250929',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          // Anthropic reports input and cache here and a placeholder output count.
          usage: { ...usage, output_tokens: 1 },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    ...text
      .split(/(?<= )/)
      .map(
        piece =>
          [
            'content_block_delta',
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } },
          ] as [string, unknown]
      ),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: message.stopReason ?? 'end_turn', stop_sequence: null },
        usage: { output_tokens: usage.output_tokens },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')
}

/** A streamed Messages API answer (`text/event-stream`), delivered in `chunkSize`-byte pieces. */
export function anthropicSse(message: FakeMessage = {}, chunkSize = 64): Response {
  const bytes = new TextEncoder().encode(anthropicSseText(message))
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize)
        controller.enqueue(bytes.slice(i, i + chunkSize))
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

export interface RecordedAnthropicRequest {
  url: string
  method: string
  path: string
  /** `x-api-key` as upstream saw it. */
  apiKey: string | null
  authorization: string | null
  body: Record<string, unknown> | null
}

export interface FakeAnthropic {
  upstream: ModelUpstream
  requests: RecordedAnthropicRequest[]
  /** Override the answer; default SSE when `body.stream`, else JSON, with the configured message. */
  respond: (req: Request, body: Record<string, unknown> | null) => Response | Promise<Response>
}

/** A recording Anthropic behind a `ModelUpstream` (see the header). */
export function createFakeAnthropic(message: FakeMessage = {}): FakeAnthropic {
  const fake: FakeAnthropic = {
    requests: [],
    respond: (_req, body) => (body?.stream ? anthropicSse(message) : anthropicJson(message)),
    upstream: {
      fetch: async (req: Request) => {
        const text = await req.text()
        let body: Record<string, unknown> | null = null
        try {
          body = text ? (JSON.parse(text) as Record<string, unknown>) : null
        } catch {
          body = null
        }
        fake.requests.push({
          url: req.url,
          method: req.method,
          path: new URL(req.url).pathname,
          apiKey: req.headers.get('x-api-key'),
          authorization: req.headers.get('authorization'),
          body,
        })
        return fake.respond(req, body)
      },
    },
  }
  return fake
}

// ---- Claude Code stream-json --------------------------------------------------------------------

export interface FakeClaudeTool {
  name: string
  input?: Record<string, unknown>
  result?: string
  isError?: boolean
}

export interface FakeClaudeTurn {
  /** Claude Code's session id (`system.init`), what `--resume` takes next turn. */
  sessionId?: string
  model?: string
  cwd?: string
  /** Tool calls, in order, each followed by its result. */
  tools?: readonly FakeClaudeTool[]
  /** The final assistant text (and the `result` line's `result`). */
  text?: string
  usage?: FakeUsage
  /** `success` (default), or `error_max_turns` / `error_during_execution`. */
  subtype?: string
  durationMs?: number
  costUsd?: number
  exitCode?: number
  /** Keep the process running after the output until killed (a cancel test). */
  hang?: boolean
}

/** The stream-json LINES of one Claude Code turn (each a JSON object, no trailing newline). */
export function claudeStreamJsonLines(turn: FakeClaudeTurn = {}): string[] {
  const sessionId = turn.sessionId ?? crypto.randomUUID()
  const model = turn.model ?? 'claude-sonnet-4-5-20250929'
  const usage = usageOf(turn.usage)
  const line = (o: unknown) => JSON.stringify(o)
  const lines: string[] = [
    line({
      type: 'system',
      subtype: 'init',
      cwd: turn.cwd ?? '/workspace/app',
      session_id: sessionId,
      tools: ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep'],
      mcp_servers: [],
      model,
      permissionMode: 'acceptEdits',
      apiKeySource: 'ANTHROPIC_API_KEY',
    }),
  ]
  let n = 0
  for (const tool of turn.tools ?? []) {
    const id = `toolu_fake_${++n}`
    lines.push(
      line({
        type: 'assistant',
        message: {
          id: messageId(),
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'tool_use', id, name: tool.name, input: tool.input ?? {} }],
          stop_reason: null,
          usage,
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              tool_use_id: id,
              type: 'tool_result',
              content: tool.result ?? 'ok',
              is_error: tool.isError ?? false,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      })
    )
  }
  const text = turn.text ?? 'done'
  lines.push(
    line({
      type: 'assistant',
      message: {
        id: messageId(),
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text }],
        stop_reason: null,
        usage,
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    }),
    line({
      type: 'result',
      subtype: turn.subtype ?? 'success',
      is_error: (turn.subtype ?? 'success') !== 'success',
      duration_ms: turn.durationMs ?? 6500,
      duration_api_ms: Math.round((turn.durationMs ?? 6500) * 0.8),
      num_turns: (turn.tools?.length ?? 0) + 1,
      result: text,
      session_id: sessionId,
      total_cost_usd: turn.costUsd ?? 0.0123,
      usage,
    })
  )
  return lines
}

/** A `FakeSandbox.onProcess` script for one Claude Code turn. */
export function claudeStreamJson(turn: FakeClaudeTurn = {}): ProcessScript {
  return { lines: claudeStreamJsonLines(turn), exitCode: turn.exitCode ?? 0, hang: turn.hang }
}
