/**
 * pi's transcript → `session_events` (rocketflare-launch#14), the PURE half of a Pi turn. Pi turns
 * are mapped from the DURABLE transcript entries pi commits (not its live `AgentEvent`s, which have
 * no cursor and die with the object's memory), one entry at a time, onto the same vocabulary Claude
 * Code's stream-json and Codex's JSONL become — so the session page and the AG-UI projection read a
 * Pi turn unchanged:
 *
 * | entry (`kind`)                                | → event                                         |
 * |-----------------------------------------------|-------------------------------------------------|
 * | `pi.assistant` — a `text` block               | `text { text }`                                 |
 * | `pi.assistant` — a `toolCall` block           | `tool.start { name, input, toolCallId }`        |
 * | `pi.assistant` — `stopReason: 'error'`        | `error { message }` (the provider's, redacted)  |
 * | `pi.assistant` — its `usage`                  | none — `messageUsage` (`turn-meter.ts` prices it under `workers_ai`) |
 * | `pi.tool-result`                              | `tool.end { name, result, isError, toolCallId }` |
 * | `pi.user`, `pi.system`, `pi.reset`, `pi.compaction`, anything else | nothing                    |
 *
 * `thinking` blocks are not part of the transcript a person reads, as for Claude. Tool names go out
 * in Claude Code's spelling (`bash` → `Bash`…), which is what the session page's one-liners
 * (`sessionChatModel.ts`' `toolSummary`) already know; the model itself sees pi's lower-case names.
 * Every string is clipped and redacted (`clipStrings` + `redactModelKeys`), exactly as Claude's are.
 */
import type { SessionEventInput } from '@launch/shared/launch-sessions'
import { clipStrings } from '../../claude-stream'
import { redactModelKeys } from '../../model-key'
import type { RuntimeLineMapping } from '../types'

/** The event name of each `launch-workspace` tool — Claude Code's spelling of the same tool. */
export const PI_TOOL_EVENT_NAMES: Readonly<Record<string, string>> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
}

/** The event name for a pi tool: its Claude Code spelling, else the name as the model used it. */
export const piToolEventName = (name: string) => PI_TOOL_EVENT_NAMES[name] ?? name

/** The slice of a pi `EntryRecord` the mapping reads (structural: no pi import here). */
export interface PiEntryLike {
  id: number
  kind: string
  model?: readonly unknown[]
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

/** A tool result's content blocks as one string (`[image]` for anything not text). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      const p = asRecord(part)
      if (!p) return ''
      if (p.type === 'text' && typeof p.text === 'string') return p.text
      return p.type ? `[${String(p.type)}]` : ''
    })
    .filter(Boolean)
    .join('\n')
}

/** pi-ai's `Usage` as the ledger's `TokenUsage` (pi's input is uncached, as Anthropic's is). */
export function tokenUsageFromPi(value: unknown) {
  const u = asRecord(value)
  if (!u) return null
  return {
    inputTokens: asCount(u.input),
    outputTokens: asCount(u.output),
    cacheReadTokens: asCount(u.cacheRead),
    cacheWriteTokens: asCount(u.cacheWrite),
  }
}

/** ONE committed transcript entry → its events and usage. Pure. */
export function mapPiEntry(entry: PiEntryLike, turn: number): RuntimeLineMapping {
  const out: RuntimeLineMapping = { events: [], resumeId: null, result: null }
  const message = asRecord(entry.model?.[0])
  if (!message) return out
  const events: SessionEventInput[] = out.events

  if (entry.kind === 'pi.assistant' && message.role === 'assistant') {
    const usage = tokenUsageFromPi(message.usage)
    if (usage) {
      out.messageUsage = { id: `pi:${entry.id}`, model: asString(message.model), usage }
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      const b = asRecord(block)
      if (!b) continue
      if (b.type === 'text') {
        const text = asString(b.text)
        if (text?.trim()) events.push({ type: 'text', turn, data: { text: clean(text) } })
      } else if (b.type === 'toolCall') {
        const id = asString(b.id)
        events.push({
          type: 'tool.start',
          turn,
          data: {
            name: piToolEventName(asString(b.name) ?? 'tool'),
            input: clean(asRecord(b.arguments) ?? {}),
            ...(id ? { toolCallId: id } : {}),
          },
        })
      }
    }
    if (message.stopReason === 'error') {
      const reason = asString(message.errorMessage) ?? 'The model call failed'
      events.push({ type: 'error', turn, data: { message: clean(reason) } })
    }
    return out
  }

  if (entry.kind === 'pi.tool-result' && message.role === 'toolResult') {
    const id = asString(message.toolCallId)
    events.push({
      type: 'tool.end',
      turn,
      data: {
        name: piToolEventName(asString(message.toolName) ?? 'tool'),
        result: clean(contentText(message.content)),
        isError: message.isError === true,
        ...(id ? { toolCallId: id } : {}),
      },
    })
  }
  return out
}
