/**
 * Codex's `exec --json` output → `session_events` rows (§18.22-B), the PURE half of a Codex turn.
 * The JSONL (Codex 0.160, `exec/src/exec_events.rs`; fixtures in `tests/fixtures/codex/`):
 *
 * | line                                              | → event                                  |
 * |---------------------------------------------------|------------------------------------------|
 * | `thread.started { thread_id }` (again on resume)   | none — `resumeId` (what `resume` takes next turn) |
 * | `turn.started`                                    | nothing                                  |
 * | `item.started` `command_execution { command }`    | `tool.start { name: 'Bash', input: { command } }` |
 * | `item.completed` `command_execution { aggregated_output, exit_code, status }` | `tool.end` (`isError` on a non-zero exit or `failed`) |
 * | `item.*` `file_change { changes: [{ path, kind }] }` | `tool.start` / `tool.end` `Edit`        |
 * | `item.*` `mcp_tool_call` · `web_search` · `collab_tool_call` · `todo_list` | `tool.start` / `tool.end` (`mcp__<server>__<tool>`, `WebSearch`, `Agent`, `TodoWrite`) |
 * | `item.completed` `agent_message { text }`         | `text { text }` (and the turn's final answer) |
 * | `item.completed` `error { message }`              | `error { message }`                      |
 * | `item.*` `reasoning`, any `item.updated`          | nothing (not part of the transcript a person reads) |
 * | `turn.completed { usage }`                        | none — `result` (the turn step writes `turn.end`) |
 * | `turn.failed { error: { message } }`              | `error { message }`; no result, so the turn fails with the exit |
 * | top-level `error { message }`                     | nothing (a retry notice, or the same message `turn.failed` repeats) |
 *
 * An item that completes without having started (Codex sends some only on completion) opens and
 * closes its tool in one line.
 *
 * **`turn.completed.usage` is the THREAD's running total** (spike S-B1), so the turn's own usage is
 * the difference from the last total — kept in `sessions.runtime_state.usage` between turns (the
 * parser reads it in and hands the new total back as `runtimeState`, which the turn writes). A
 * different thread (a fresh conversation) starts from zero. OpenAI counts cached input INSIDE
 * `input_tokens`; the session's counters are disjoint (`tokensIn` is uncached), as Anthropic's are.
 *
 * Every string that lands in an event is clipped and redacted (`clipStrings` + `redactModelKeys`),
 * exactly as Claude's are.
 */
import type { AgentRuntimeState } from '@launch/shared/launch-agents'
import type { SessionEventInput, SessionUsage } from '@launch/shared/launch-sessions'
import { z } from 'zod'
import { CLAUDE_RESULT_TEXT_MAX, clipStrings } from '../../claude-stream'
import { redactModelKeys } from '../../model-key'
import type { RuntimeLineMapping, RuntimeStreamParser } from '../types'

/** A thread's running token totals, as `turn.completed` last reported them. */
export const codexUsageTotalsSchema = z.object({
  threadId: z.string(),
  inputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  cacheWriteInputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  reasoningOutputTokens: z.number().nonnegative(),
})
export type CodexUsageTotals = z.infer<typeof codexUsageTotalsSchema>

/** The last totals in `runtime_state`, or null (none yet, or not a shape this knows). */
export function codexUsageOf(state: AgentRuntimeState | null | undefined): CodexUsageTotals | null {
  const parsed = codexUsageTotalsSchema.safeParse(
    (state as { usage?: unknown } | null | undefined)?.usage
  )
  return parsed.success ? parsed.data : null
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null

const asCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0

const clean = <T>(value: T): T => redactModelKeys(clipStrings(value))

/** The totals a `turn.completed` line reports. */
function totalsOf(threadId: string, usage: unknown): CodexUsageTotals {
  const u = asRecord(usage) ?? {}
  return {
    threadId,
    inputTokens: asCount(u.input_tokens),
    cachedInputTokens: asCount(u.cached_input_tokens),
    cacheWriteInputTokens: asCount(u.cache_write_input_tokens),
    outputTokens: asCount(u.output_tokens),
    reasoningOutputTokens: asCount(u.reasoning_output_tokens),
  }
}

/**
 * This turn's usage: `now` minus `before` when both are the same thread and no counter went
 * backwards (a counter that did means Codex restarted its count — take `now` whole).
 */
export function codexUsageDelta(
  now: CodexUsageTotals,
  before: CodexUsageTotals | null
): SessionUsage {
  const base =
    before &&
    before.threadId === now.threadId &&
    now.inputTokens >= before.inputTokens &&
    now.cachedInputTokens >= before.cachedInputTokens &&
    now.cacheWriteInputTokens >= before.cacheWriteInputTokens &&
    now.outputTokens >= before.outputTokens
      ? before
      : null
  const input = now.inputTokens - (base?.inputTokens ?? 0)
  const cached = now.cachedInputTokens - (base?.cachedInputTokens ?? 0)
  return {
    tokensIn: Math.max(0, input - cached),
    tokensOut: now.outputTokens - (base?.outputTokens ?? 0),
    cacheRead: cached,
    cacheWrite: now.cacheWriteInputTokens - (base?.cacheWriteInputTokens ?? 0),
  }
}

/** A tool's name for an item type, or null for a type that is not a tool. */
function toolNameOf(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case 'command_execution':
      return 'Bash'
    case 'file_change':
      return 'Edit'
    case 'mcp_tool_call': {
      const server = asString(item.server) ?? 'mcp'
      const tool = asString(item.tool) ?? 'tool'
      return `mcp__${server}__${tool}`
    }
    case 'web_search':
      return 'WebSearch'
    case 'collab_tool_call':
      return 'Agent'
    case 'todo_list':
      return 'TodoWrite'
    default:
      return null
  }
}

function toolInputOf(item: Record<string, unknown>): unknown {
  switch (item.type) {
    case 'command_execution':
      return { command: asString(item.command) ?? '' }
    case 'file_change':
      return { changes: Array.isArray(item.changes) ? item.changes : [] }
    case 'mcp_tool_call':
      return asRecord(item.arguments) ?? item.arguments ?? {}
    case 'web_search':
      return { query: asString(item.query) ?? '' }
    case 'todo_list':
      return { items: Array.isArray(item.items) ? item.items : [] }
    default: {
      const { id: _id, type: _type, status: _status, ...rest } = item
      return rest
    }
  }
}

function toolResultOf(item: Record<string, unknown>): { result: string; isError: boolean } {
  const failed = item.status === 'failed' || item.status === 'declined'
  switch (item.type) {
    case 'command_execution': {
      const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : ''
      const code = typeof item.exit_code === 'number' ? item.exit_code : null
      return {
        result: code !== null && code !== 0 ? `${output}\n[exit code ${code}]`.trim() : output,
        isError: failed || (code !== null && code !== 0),
      }
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const lines = changes
        .map(change => {
          const c = asRecord(change)
          return c ? `${asString(c.kind) ?? 'change'} ${asString(c.path) ?? ''}`.trim() : ''
        })
        .filter(Boolean)
      return { result: lines.join('\n') || (failed ? 'not applied' : 'applied'), isError: failed }
    }
    case 'mcp_tool_call': {
      const error = asRecord(item.error)
      if (error) return { result: asString(error.message) ?? 'failed', isError: true }
      const result = item.result
      return {
        result: typeof result === 'string' ? result : result ? JSON.stringify(result) : '',
        isError: failed,
      }
    }
    case 'todo_list': {
      const items = Array.isArray(item.items) ? item.items : []
      const lines = items.map(entry => {
        const e = asRecord(entry)
        return e ? `[${e.completed === true ? 'x' : ' '}] ${asString(e.text) ?? ''}` : ''
      })
      return { result: lines.filter(Boolean).join('\n'), isError: failed }
    }
    default:
      return { result: failed ? 'failed' : 'done', isError: failed }
  }
}

export interface CodexParserOptions {
  /** `sessions.runtime_state` as the turn read it — the last usage totals live there. */
  runtimeState?: AgentRuntimeState | null
}

/**
 * The stateful half: raw process output in (chunks split lines anywhere), mappings out, with the
 * open tools, the thread and the last answer carried between lines.
 */
export function createCodexStreamParser(
  turn: number,
  opts: CodexParserOptions = {}
): RuntimeStreamParser {
  const state = opts.runtimeState ?? null
  const before = codexUsageOf(state)
  const open = new Set<string>()
  let threadId: string | null = null
  let lastText: string | null = null
  let buffer = ''

  const map = (line: string): RuntimeLineMapping => {
    const out: RuntimeLineMapping = { events: [], resumeId: null, result: null }
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return out
    let msg: Record<string, unknown> | null
    try {
      msg = asRecord(JSON.parse(trimmed))
    } catch {
      return out
    }
    if (!msg) return out
    const events: SessionEventInput[] = out.events

    switch (msg.type) {
      case 'thread.started': {
        threadId = asString(msg.thread_id)
        out.resumeId = threadId
        return out
      }
      case 'item.started':
      case 'item.completed': {
        const item = asRecord(msg.item)
        if (!item) return out
        const id = asString(item.id)
        if (item.type === 'agent_message') {
          const text = msg.type === 'item.completed' ? asString(item.text) : null
          if (text) {
            lastText = text
            events.push({ type: 'text', turn, data: { text: clean(text) } })
          }
          return out
        }
        if (item.type === 'error') {
          const message = msg.type === 'item.completed' ? asString(item.message) : null
          if (message) events.push({ type: 'error', turn, data: { message: clean(message) } })
          return out
        }
        const name = toolNameOf(item)
        if (!name) return out
        const key = id ?? `${name}:${open.size}`
        if (!open.has(key)) {
          open.add(key)
          events.push({
            type: 'tool.start',
            turn,
            data: { name, input: clean(toolInputOf(item)), ...(id ? { toolCallId: id } : {}) },
          })
        }
        if (msg.type === 'item.completed') {
          open.delete(key)
          const { result, isError } = toolResultOf(item)
          events.push({
            type: 'tool.end',
            turn,
            data: { name, result: clean(result), isError, ...(id ? { toolCallId: id } : {}) },
          })
        }
        return out
      }
      case 'turn.completed': {
        const totals = totalsOf(threadId ?? before?.threadId ?? '', msg.usage)
        const usage = codexUsageDelta(totals, before)
        out.result = {
          subtype: 'success',
          isError: false,
          durationMs: null,
          usage,
          text: lastText ? redactModelKeys(clipStrings(lastText, CLAUDE_RESULT_TEXT_MAX)) : null,
        }
        // What the `host` egress mode records as the turn's `ai_usage` row (`turn-meter.ts`): the
        // host's handlers forward without metering, so this is the turn's only ledger there.
        out.turnUsage = [
          {
            model: null,
            usage: {
              inputTokens: usage.tokensIn,
              outputTokens: usage.tokensOut,
              cacheReadTokens: usage.cacheRead,
              cacheWriteTokens: usage.cacheWrite,
            },
          },
        ]
        if (threadId) out.runtimeState = { ...(state ?? {}), usage: totals }
        return out
      }
      case 'turn.failed': {
        const message = asString(asRecord(msg.error)?.message) ?? 'Codex could not finish the turn'
        events.push({ type: 'error', turn, data: { message: clean(message) } })
        return out
      }
      default:
        return out
    }
  }

  return {
    push(chunk) {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      return lines.filter(line => line.trim()).map(map)
    },
    end() {
      const rest = buffer
      buffer = ''
      return rest.trim() ? [map(rest)] : []
    },
  }
}
