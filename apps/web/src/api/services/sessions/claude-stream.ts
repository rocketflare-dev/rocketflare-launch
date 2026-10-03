/**
 * Claude Code's side of a session turn (Launch P3, plan §1.3, slice 3c): the command a turn runs
 * in the sandbox, and the PURE mapping from its `--output-format stream-json --verbose` output to
 * `session_events` rows.
 *
 * One user message is one process (S7 proved it, `spikes/s7-sandbox/RESULT.md`):
 *
 * ```
 * claude -p '<message>' [--resume <id>] --output-format stream-json --verbose
 *        --permission-mode bypassPermissions --model <policy model> --disallowedTools "Bash(git push:*)"
 *        --append-system-prompt '<the session-system-note prompt>'
 * ```
 *
 * - `--model` is the session POLICY's model — the only one the model proxy lets through — and the
 *   env points Claude Code's background model at it too (`claudeTurnEnv`), or its small-model calls
 *   (titles, command-prefix checks) would be refused by the allow-list.
 * - `bypassPermissions`: the sandbox IS the boundary (egress allow-list, placeholder key, its own
 *   database branch), so the agent runs any tool without asking — in `-p` mode nobody could answer
 *   a prompt, and `acceptEdits` silently denied every Bash command outside an allow-list. Claude
 *   Code refuses that mode as root unless `IS_SANDBOX=1` is set, which `claudeTurnEnv` does, with
 *   `HOME=SESSION_HOME` so its transcripts land where the checkpoint and the restore read them.
 * - Pushing is Launch's job (the checkpoint after each turn), so the agent may not `git push`:
 *   `--disallowedTools` here, and the `deny` rules in `.claude/settings.local.json` (written at
 *   boot) — deny rules still hold in bypass mode; allow rules have no effect there.
 * - The message is shell-quoted here, never interpolated raw: it is user text. So is the system
 *   note (`session-system-note`, an admin may edit it), on every turn, resumed ones included.
 *
 * The stream-json lines, and what each becomes (`mapClaudeLine`):
 *
 * | line                                         | → event                         |
 * |----------------------------------------------|---------------------------------|
 * | `{type:'system', subtype:'init', session_id}` | none — `claudeSessionId` (what `--resume` takes next turn) |
 * | `{type:'assistant'}` with `text` content      | `text { text }`                 |
 * | `{type:'assistant'}` with `tool_use` content  | `tool.start { name, input, toolCallId }` |
 * | `{type:'user'}` with `tool_result` content    | `tool.end { name, result, isError, toolCallId }` |
 * | `{type:'result'}`                             | none — `result` (the turn step writes `turn.end` with the METERED cost) |
 * | anything else, or a line that is not JSON     | nothing                         |
 *
 * Every string that lands in an event goes through `redactModelKeys` (a tool that ran `env` prints
 * the placeholder) and is clipped, because a `Read` of a large file must not become a megabyte row.
 */
import type { TokenUsage } from '@launch/shared/ai/chat'
import type { SessionCredentialSource } from '@launch/shared/launch-agents'
import type { SessionEventInput, SessionUsage } from '@launch/shared/launch-sessions'
import { MODEL_KEY_PLACEHOLDER, redactModelKeys } from './model-key'
import { SESSION_HOME, SESSION_WORKSPACE } from './rocketflare-dev'

// ---- the command ---------------------------------------------------------------------------------

/** Where a session's checkout lives in the sandbox (`SESSION_WORKSPACE`; the repo step clones into it). */
export const SESSION_WORKDIR = SESSION_WORKSPACE

/** Pushing is Launch's job (plan §1.3): Claude Code may run anything else (bypass mode). */
export const CLAUDE_DISALLOWED_TOOLS = 'Bash(git push:*)'

export interface ClaudeCommandInput {
  /** The user's message, verbatim. Quoted here. */
  message: string
  /** `policy.model` — the only model the proxy allows. */
  model: string
  /** `sessions.claude_session_id` from the previous turn; absent on the first. */
  resumeSessionId?: string | null
  /**
   * The `session-system-note` prompt, filled in — appended to Claude Code's system prompt. Passed
   * on EVERY turn: `--append-system-prompt` does not survive `--resume`.
   */
  systemNote?: string | null
}

/** A token that is safe unquoted in a shell word — ids and model names are nothing else. */
const SAFE_TOKEN = /^[A-Za-z0-9._:@/-]{1,200}$/

/** POSIX single-quoting: `'` → `'\''`. NUL cannot be in an argument at all, so it is dropped. */
export function shellQuote(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is exactly what must be removed
  return `'${text.replace(/\u0000/g, '').replace(/'/g, `'\\''`)}'`
}

/** The shell command for one turn. Throws on a model or resume id that is not a plain token. */
export function buildClaudeCommand(input: ClaudeCommandInput): string {
  if (!SAFE_TOKEN.test(input.model)) throw new Error('buildClaudeCommand: invalid model id')
  const parts = ['claude', '-p', shellQuote(input.message)]
  if (input.resumeSessionId) {
    if (!SAFE_TOKEN.test(input.resumeSessionId)) {
      throw new Error('buildClaudeCommand: invalid resume session id')
    }
    parts.push('--resume', input.resumeSessionId)
  }
  parts.push(
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--model',
    input.model,
    '--disallowedTools',
    `"${CLAUDE_DISALLOWED_TOOLS}"`
  )
  if (input.systemNote) parts.push('--append-system-prompt', shellQuote(input.systemNote))
  return parts.join(' ')
}

/**
 * The turn process's environment. NON-secret by construction: the key is a placeholder the model
 * proxy replaces outside the sandbox (plan §1.4), and the background model is pinned to the
 * policy's so the proxy's allow-list does not refuse Claude Code's own small-model calls.
 * `IS_SANDBOX=1` lets `bypassPermissions` run as root (the session image's user); `HOME` is pinned
 * to `SESSION_HOME` because the transcript path (`CLAUDE_PROJECT_DIR`) is derived from it.
 */
export function claudeTurnEnv(
  model: string,
  /**
   * §18.22: whose account the turn bills. `platform` is the only source wired; Stream A swaps the
   * placeholder key for a placeholder OAuth token on `user` (the token itself never enters).
   */
  _source: SessionCredentialSource = 'platform'
): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: MODEL_KEY_PLACEHOLDER,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    NODE_USE_SYSTEM_CA: '1',
    IS_SANDBOX: '1',
    HOME: SESSION_HOME,
  }
}

// ---- the mapping ---------------------------------------------------------------------------------

/** Longest string kept in an event (a tool's input or result); longer ones are cut with a note. */
export const CLAUDE_EVENT_STRING_MAX = 4_000

/** Claude Code's `result` line, as the turn step needs it. */
export interface ClaudeTurnResult {
  /** `success`, `error_max_turns`, `error_during_execution`… */
  subtype: string
  isError: boolean
  durationMs: number | null
  usage: SessionUsage | null
  /**
   * The line's `result` — the turn's final answer, redacted and clipped to
   * {@link CLAUDE_RESULT_TEXT_MAX}. The ship turn parses its `{ title, body }` out of it.
   */
  text: string | null
}

/** Longest final answer kept from a `result` line (a PR body fits comfortably). */
export const CLAUDE_RESULT_TEXT_MAX = 20_000

/** One model response's usage, as an `assistant` line reports it (the `host` egress mode meters it). */
export interface ClaudeMessageUsage {
  /** The response's id: its content blocks arrive as several lines, each repeating the usage. */
  id: string
  model: string | null
  usage: TokenUsage
}

/** A model's share of a whole turn, from the `result` line's `modelUsage` (or its `usage`). */
export interface ClaudeModelUsage {
  /** Null when the line names none (a `usage` with no `modelUsage`): the policy's model. */
  model: string | null
  usage: TokenUsage
}

export interface ClaudeLineMapping {
  events: SessionEventInput[]
  /** An `assistant` line's usage — the running total the `host` mode's budget watches. */
  messageUsage?: ClaudeMessageUsage
  /**
   * The `result` line's usage per model — Claude Code's background calls included when it reports
   * `modelUsage` — which the `host` mode records as the turn's `ai_usage` rows.
   */
  turnUsage?: ClaudeModelUsage[]
  /** `system.init`'s (or `result`'s) `session_id` — store it for the next `--resume`. */
  claudeSessionId: string | null
  /** Set by the `result` line: the turn is over. */
  result: ClaudeTurnResult | null
  /** `tool_use` ids this line opened, with their names — `tool.end` needs the name back. */
  toolUses: { id: string; name: string }[]
}

export interface ClaudeLineContext {
  turn: number
  /** Tool names by `tool_use` id, from earlier lines (a `tool_result` carries only the id). */
  toolNames?: ReadonlyMap<string, string>
}

const EMPTY = (): ClaudeLineMapping => ({
  events: [],
  claudeSessionId: null,
  result: null,
  toolUses: [],
})

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null

const asCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0

/** Cut every string in `value` to `max` characters, noting how much went. */
export function clipStrings<T>(value: T, max = CLAUDE_EVENT_STRING_MAX): T {
  if (typeof value === 'string') {
    return (
      value.length > max ? `${value.slice(0, max)}… [${value.length - max} more characters]` : value
    ) as T
  }
  if (Array.isArray(value)) return value.map(item => clipStrings(item, max)) as T
  const record = asRecord(value)
  if (record) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) out[key] = clipStrings(item, max)
    return out as T
  }
  return value
}

/** What an event may hold: clipped, and with no key or placeholder in it. */
const clean = <T>(value: T): T => redactModelKeys(clipStrings(value))

/** Anthropic's usage object, flattened into the session's names. */
export function usageFromAnthropic(value: unknown): SessionUsage | null {
  const u = asRecord(value)
  if (!u) return null
  return {
    tokensIn: asCount(u.input_tokens),
    tokensOut: asCount(u.output_tokens),
    cacheRead: asCount(u.cache_read_input_tokens),
    cacheWrite: asCount(u.cache_creation_input_tokens),
  }
}

/** Anthropic's snake_case usage object as a `TokenUsage` (the `ai_usage` shape). */
export function tokenUsageFromAnthropic(value: unknown): TokenUsage | null {
  const u = asRecord(value)
  if (!u) return null
  return {
    inputTokens: asCount(u.input_tokens),
    outputTokens: asCount(u.output_tokens),
    cacheReadTokens: asCount(u.cache_read_input_tokens),
    cacheWriteTokens: asCount(u.cache_creation_input_tokens),
  }
}

/**
 * The `result` line's usage per model: Claude Code's `modelUsage` (camelCase, one entry per model
 * the turn called — its background calls included), else the line's own `usage` (the main loop's
 * calls only, no model named).
 */
export function turnUsageOf(msg: Record<string, unknown>): ClaudeModelUsage[] {
  const byModel = asRecord(msg.modelUsage)
  if (byModel) {
    const out: ClaudeModelUsage[] = []
    for (const [model, value] of Object.entries(byModel)) {
      const u = asRecord(value)
      if (!u) continue
      out.push({
        model,
        usage: {
          inputTokens: asCount(u.inputTokens),
          outputTokens: asCount(u.outputTokens),
          cacheReadTokens: asCount(u.cacheReadInputTokens),
          cacheWriteTokens: asCount(u.cacheCreationInputTokens),
        },
      })
    }
    if (out.length > 0) return out
  }
  const usage = tokenUsageFromAnthropic(msg.usage)
  return usage ? [{ model: null, usage }] : []
}

/** A `tool_result`'s content — a string, or `[{ type: 'text', text }…]` — as one string. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
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
  return content === undefined || content === null ? '' : JSON.stringify(content)
}

/**
 * ONE stream-json line → the events it produces, plus the facts the turn step keeps (the Claude
 * session id, the end of the turn). Pure: the caller carries `toolNames` between lines
 * (`createClaudeStreamParser` does). A line that is not JSON, or not a type this maps, is nothing.
 */
export function mapClaudeLine(line: string, ctx: ClaudeLineContext): ClaudeLineMapping {
  const out = EMPTY()
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return out
  }
  const msg = asRecord(parsed)
  if (!msg) return out
  const turn = ctx.turn

  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') out.claudeSessionId = asString(msg.session_id)
      return out
    }
    case 'assistant': {
      const message = asRecord(msg.message)
      const usage = tokenUsageFromAnthropic(message?.usage)
      const messageId = asString(message?.id)
      if (usage && messageId) {
        out.messageUsage = { id: messageId, model: asString(message?.model), usage }
      }
      const content = message?.content
      if (!Array.isArray(content)) return out
      for (const block of content) {
        const b = asRecord(block)
        if (!b) continue
        if (b.type === 'text') {
          const text = asString(b.text)
          if (text) out.events.push({ type: 'text', turn, data: { text: clean(text) } })
        } else if (b.type === 'tool_use') {
          const name = asString(b.name) ?? 'tool'
          const id = asString(b.id)
          if (id) out.toolUses.push({ id, name })
          out.events.push({
            type: 'tool.start',
            turn,
            data: {
              name,
              input: clean(b.input ?? {}),
              ...(id ? { toolCallId: id } : {}),
            },
          })
        }
        // `thinking` and anything newer: not part of the transcript a person reads.
      }
      return out
    }
    case 'user': {
      const content = asRecord(msg.message)?.content
      if (!Array.isArray(content)) return out
      for (const block of content) {
        const b = asRecord(block)
        if (!b || b.type !== 'tool_result') continue
        const id = asString(b.tool_use_id)
        const name = (id && ctx.toolNames?.get(id)) || 'tool'
        out.events.push({
          type: 'tool.end',
          turn,
          data: {
            name,
            result: clean(toolResultText(b.content)),
            isError: b.is_error === true,
            ...(id ? { toolCallId: id } : {}),
          },
        })
      }
      return out
    }
    case 'result': {
      out.claudeSessionId = asString(msg.session_id)
      out.turnUsage = turnUsageOf(msg)
      const subtype = asString(msg.subtype) ?? 'success'
      out.result = {
        subtype,
        isError: msg.is_error === true || subtype !== 'success',
        durationMs:
          typeof msg.duration_ms === 'number' && msg.duration_ms >= 0
            ? Math.round(msg.duration_ms)
            : null,
        usage: usageFromAnthropic(msg.usage),
        text:
          typeof msg.result === 'string'
            ? redactModelKeys(clipStrings(msg.result, CLAUDE_RESULT_TEXT_MAX))
            : null,
      }
      return out
    }
    default:
      return out
  }
}

/**
 * The stateful half: raw process output in (chunks, which may split a line anywhere), mappings
 * out, with the tool names carried from `tool.start` to `tool.end`. `end()` maps a final line that
 * had no newline.
 */
export interface ClaudeStreamParser {
  push(chunk: string): ClaudeLineMapping[]
  end(): ClaudeLineMapping[]
}

export function createClaudeStreamParser(turn: number): ClaudeStreamParser {
  const toolNames = new Map<string, string>()
  let buffer = ''
  const map = (line: string): ClaudeLineMapping => {
    const mapping = mapClaudeLine(line, { turn, toolNames })
    for (const use of mapping.toolUses) toolNames.set(use.id, use.name)
    return mapping
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
