/**
 * `launch chat ls|show|stats|new|send|rm|compact` — chat from a terminal, and debugging a thread
 * (D17).
 *
 * - `ls` — your conversations, most recent first (`GET /api/chat/conversations`).
 * - `show <id>` — the thread with every message: role, time, model, tokens, tool calls and the
 *   content (clipped unless `--full`). Points at `launch traces list --conversation <id>` for the
 *   span trees of its turns.
 * - `stats <id>` — the chat inspector (`GET /:id/stats`, admin+ on top of ownership): what will
 *   answer the next turn, the context budget and what fills it, compaction, tokens and cost.
 *
 * - `new [--title]` — `POST /conversations` (503 when no model is configured: nothing is created).
 * - `send <id> <message>` / `send --new [--title] <message>` — one turn: `POST /:id/messages`,
 *   whose reply is an AG-UI SSE stream (`ApiClient.stream`). Each frame is validated with
 *   `kitAguiEventSchema` (an unknown one is skipped, as the web UI does). Human output writes the
 *   assistant's text to stdout as it arrives and each tool call as a dim line on stderr; `--json`
 *   is NDJSON, one event per line. A `RUN_ERROR`, or a stream that closes with no terminal event,
 *   exits 1. `--new` starts the conversation first; `-` reads the message from stdin.
 * - `rm <id>` — `DELETE /:id`, confirmed with the page's words ("Its messages are removed for good").
 * - `compact <id>` — `POST /:id/compact` (admin+): queue a summary of what has fallen outside the
 *   context window now; nothing to summarise is the server's 409 sentence, exit 1.
 *
 * The server only ever returns the CALLER's own conversations; anybody else's is a 404.
 *
 * `cli.ts` calls `registerChatCommands(program, action)` once.
 */
import {
  AguiEventType,
  KIT_CUSTOM_EVENTS,
  type KitAguiEvent,
  kitAguiEventSchema,
  parseKitCustom,
} from '@launch/shared/ai/agui'
import {
  type Conversation,
  type ConversationWithMessages,
  compactConversationResponseSchema,
  conversationSchema,
  conversationStatsSchema,
  conversationWithMessagesSchema,
  createConversationRequestSchema,
  sendMessageRequestSchema,
} from '@launch/shared/ai/chat'
import { paginatedResponse } from '@launch/shared/pagination'
import chalk from 'chalk'
import type { Command } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import {
  type ConfirmOptions,
  confirmAction,
  type InputSeams,
  parseBody,
  positiveInt,
  readTextArg,
} from '../utils/input'
import { formatDate, formatPagination, renderTable } from '../utils/output'
import { readSseData } from '../utils/sse'
import { formatCost } from './ai'

export const conversationsResponseSchema = paginatedResponse(conversationSchema)

const conversationPath = (id: string) => `/api/chat/conversations/${encodeURIComponent(id)}`

export interface ChatListOptions {
  page?: number
  pageSize?: number
}

export async function runChatList(ctx: CommandContext, options: ChatListOptions = {}) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/chat/conversations', {
    schema: conversationsResponseSchema,
    query: { page: options.page, pageSize: options.pageSize },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Last message', value: c => formatDate(c.lastMessageAt ?? c.createdAt) },
      { header: 'Id', value: c => c.id },
      { header: 'Title', value: c => c.title },
      { header: 'Model', value: c => `${c.provider} ${c.model}` },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}

const CLIP = 600
function clip(text: string, full: boolean): string {
  return !full && text.length > CLIP
    ? `${text.slice(0, CLIP)}… (+${text.length - CLIP} chars)`
    : text
}

export function renderConversation(c: ConversationWithMessages, full = false): string {
  const lines = [
    chalk.bold(c.title),
    chalk.dim(
      `conversation ${c.id} · ${c.provider} ${c.model} · ${c.messages.length} message(s) · ` +
        `created ${formatDate(c.createdAt)}`
    ),
  ]
  for (const m of c.messages) {
    const meta = [formatDate(m.createdAt)]
    if (m.model) meta.push(`${m.provider ?? ''} ${m.model}`.trim())
    if (m.usage) meta.push(`${m.usage.inputTokens}→${m.usage.outputTokens} tok`)
    meta.push(m.id)
    lines.push('', `${chalk.bold(m.role)}  ${chalk.dim(meta.join(' · '))}`)
    for (const call of m.toolCalls ?? []) {
      const status = call.isError ? chalk.red(' error') : ''
      lines.push(
        `  ${chalk.cyan('→')} ${call.name}${status} ${chalk.dim(clip(JSON.stringify(call.input) ?? '', full))}`
      )
    }
    if (m.content) lines.push(clip(m.content, full))
  }
  return lines.join('\n')
}

export interface ChatShowOptions {
  full?: boolean
}

export async function runChatShow(ctx: CommandContext, id: string, options: ChatShowOptions = {}) {
  const { data, raw } = await requireClient(ctx).request('GET', conversationPath(id), {
    schema: conversationWithMessagesSchema,
  })
  ctx.out.data(raw, () =>
    [
      renderConversation(data, options.full),
      '',
      chalk.dim(
        `Traces of its turns: \`${ctx.binName} traces list --conversation ${data.id}\` · ` +
          `context and cost: \`${ctx.binName} chat stats ${data.id}\``
      ),
    ].join('\n')
  )
}

export async function runChatStats(ctx: CommandContext, id: string) {
  const { data: s, raw } = await requireClient(ctx).request(
    'GET',
    `${conversationPath(id)}/stats`,
    {
      schema: conversationStatsSchema,
    }
  )
  ctx.out.data(raw, () => {
    const pct = (n: number) =>
      s.context.totalChars ? `${Math.round((n / s.context.totalChars) * 100)}%` : '0%'
    const comp = s.context.composition
    const lines = [
      `${chalk.bold('Next turn:')}  ${
        s.next.ready
          ? chalk.green(`${s.next.provider} ${s.next.model}`)
          : chalk.red('no model (503)')
      } ${chalk.dim(`(${s.next.source}; knowledge tools: ${s.next.knowledgeTools.join(', ') || 'off'}; up to ${s.next.maxToolTurns} tool turns)`)}`,
      `${chalk.bold('Context:')}    ${s.context.totalChars} chars sent per turn (≈${Math.round(s.context.totalChars / s.context.charsPerToken)} tokens) · budget ${s.context.budgetChars} · headroom ${s.context.headroomChars}`,
      chalk.dim(
        `            system prompt ${pct(comp.systemPrompt)} · summary ${pct(comp.summary)} · tool schemas ${pct(comp.toolSchemas)} · user ${pct(comp.userMessages)} · assistant ${pct(comp.assistantMessages)}`
      ),
      `${chalk.bold('Window:')}     ${s.context.windowMessages} message(s) replayed · ${s.context.droppedMessages} dropped (${s.context.droppedChars} chars)`,
      `${chalk.bold('Compaction:')} ${
        s.compaction.summary
          ? `summary covers ${s.compaction.summarisedMessages} message(s)`
          : 'no summary yet'
      } · ${s.compaction.pendingMessages} message(s) / ${s.compaction.pendingChars} chars not yet summarised (next at ${s.compaction.minChars})`,
      `${chalk.bold('Turns:')}      ${s.turns.user} user · ${s.turns.assistant} assistant · ${s.turns.toolCalls} tool call(s)`,
      `${chalk.bold('Usage:')}      ${s.usage.inputTokens}→${s.usage.outputTokens} tokens · ${formatCost(s.costMicrocents) ?? 'cost unknown'}${s.unpricedTurns ? chalk.dim(` (${s.unpricedTurns} unpriced turn(s) left out)`) : ''}`,
    ]
    if (s.byModel.length > 1) {
      lines.push(
        '',
        renderTable(s.byModel, [
          { header: 'Provider', value: m => m.provider },
          { header: 'Model', value: m => m.model },
          { header: 'Turns', value: m => m.turns },
          { header: 'Tokens', value: m => `${m.usage.inputTokens}→${m.usage.outputTokens}` },
          { header: 'Cost', value: m => formatCost(m.costMicrocents) },
        ])
      )
    }
    return lines.join('\n')
  })
}

/** `POST /conversations` — shared by `chat new` and `chat send --new`. */
async function createConversation(ctx: CommandContext, title?: string) {
  const body = parseBody(
    createConversationRequestSchema,
    title !== undefined ? { title } : {},
    'conversation'
  )
  return requireClient(ctx).request('POST', '/api/chat/conversations', {
    schema: conversationSchema,
    body,
  })
}

const startedLine = (c: Conversation) =>
  `${chalk.green('✓')} Started "${c.title}" (${c.id}) · ${c.provider} ${c.model}`

export async function runChatNew(ctx: CommandContext, options: { title?: string } = {}) {
  const { data, raw } = await createConversation(ctx, options.title)
  ctx.out.data(raw, () =>
    [
      startedLine(data),
      chalk.dim(
        `Send a message: \`${ctx.binName} chat send ${data.id} "…"\`; read it back with \`${ctx.binName} chat show ${data.id}\`.`
      ),
    ].join('\n')
  )
}

export interface ChatSendOptions extends InputSeams {
  /** Start a conversation first (the only positional is then the message). */
  new?: boolean
  /** With `--new`: its title. */
  title?: string
}

const TOOL_ARGS_CLIP = 160

/**
 * One turn, streamed. `ref` is the conversation id (or, with `--new`, the message when `message`
 * is absent). Resolves when the run finishes; a `RUN_ERROR` or a stream that ends with no
 * terminal event is exit 1.
 */
export async function runChatSend(
  ctx: CommandContext,
  ref: string | undefined,
  message: string | undefined,
  options: ChatSendOptions = {}
): Promise<void> {
  let id = ref
  let text = message
  if (options.new) {
    if (message !== undefined) {
      throw new CliError('With --new, give only the message', {
        hint: `${ctx.binName} chat send --new "…"  or  ${ctx.binName} chat send <id> "…"`,
      })
    }
    id = undefined
    text = ref
  } else if (options.title !== undefined) {
    throw new CliError('--title only applies with --new')
  }
  if (!options.new && !id) {
    throw new CliError('Give a conversation id, or --new', {
      hint: `List yours: ${ctx.binName} chat ls`,
    })
  }
  if (text === undefined) throw new CliError('Give the message to send (or - to read stdin)')
  const content = text === '-' ? await readTextArg('-', { ...options, label: 'message' }) : text
  // Checked before anything is created or sent.
  const body = parseBody(sendMessageRequestSchema, { content }, 'message')

  if (options.new) {
    const { data } = await createConversation(ctx, options.title)
    ctx.log.info(startedLine(data))
    id = data.id
  }
  const conversationId = id as string

  const { body: stream } = await requireClient(ctx).stream(
    'POST',
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    { body }
  )

  let midLine = false
  const endLine = () => {
    if (midLine) ctx.out.write('\n')
    midLine = false
  }
  const toolArgs = new Map<string, { name: string; args: string }>()
  let finished = false
  let failure: { message: string; code?: string } | undefined
  let usage: { inputTokens: number; outputTokens: number } | undefined
  let model: string | undefined

  for await (const data of readSseData(stream)) {
    let json: unknown
    try {
      json = JSON.parse(data)
    } catch {
      ctx.log.debug(`skipped a frame that is not JSON: ${data.slice(0, 80)}`)
      continue
    }
    const parsed = kitAguiEventSchema.safeParse(json)
    if (!parsed.success) {
      // A newer server may emit an event this build does not know: never a reason to stop.
      ctx.log.debug(`skipped an unknown frame: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
      continue
    }
    const event: KitAguiEvent = parsed.data
    if (event.type === AguiEventType.RUN_FINISHED) finished = true
    if (event.type === AguiEventType.RUN_ERROR)
      failure = { message: event.message, code: event.code ?? undefined }
    if (event.type === AguiEventType.CUSTOM) {
      const ids = parseKitCustom(KIT_CUSTOM_EVENTS.chatIds, event)
      if (ids) model = ids.model
      const used = parseKitCustom(KIT_CUSTOM_EVENTS.usage, event)
      if (used) usage = used.usage
    }
    if (ctx.json) {
      ctx.out.write(`${JSON.stringify(event)}\n`)
      continue
    }
    switch (event.type) {
      case AguiEventType.TEXT_MESSAGE_CONTENT:
        ctx.out.write(event.delta)
        midLine = !event.delta.endsWith('\n')
        break
      case AguiEventType.TEXT_MESSAGE_END:
        endLine()
        break
      case AguiEventType.TOOL_CALL_START:
        toolArgs.set(event.toolCallId, { name: event.toolCallName, args: '' })
        break
      case AguiEventType.TOOL_CALL_ARGS: {
        const call = toolArgs.get(event.toolCallId)
        if (call) call.args += event.delta
        break
      }
      case AguiEventType.TOOL_CALL_END: {
        const call = toolArgs.get(event.toolCallId)
        if (!call) break
        endLine()
        const args =
          call.args.length > TOOL_ARGS_CLIP ? `${call.args.slice(0, TOOL_ARGS_CLIP)}…` : call.args
        ctx.log.hint(`→ ${call.name} ${args}`.trimEnd())
        break
      }
      case AguiEventType.CUSTOM: {
        const notice = parseKitCustom(KIT_CUSTOM_EVENTS.notice, event)
        if (notice) {
          endLine()
          ctx.log.hint(`note: ${notice.message ?? notice.code}`)
        }
        const document = parseKitCustom(KIT_CUSTOM_EVENTS.document, event)
        if (document) {
          endLine()
          ctx.log.hint(`document: ${document.card.title}`)
        }
        break
      }
      default:
        break
    }
  }
  endLine()

  const tracesHint = `Its trace: \`${ctx.binName} traces list --conversation ${conversationId}\``
  if (failure) {
    throw new CliError(`The reply failed: ${failure.message}`, {
      hint: `${failure.code ? `code ${failure.code} · ` : ''}${tracesHint}`,
    })
  }
  if (!finished) {
    throw new CliError('The stream closed before the reply finished', {
      hint: `What was saved: \`${ctx.binName} chat show ${conversationId}\` · ${tracesHint}`,
    })
  }
  const meta = [model, usage && `${usage.inputTokens}→${usage.outputTokens} tok`].filter(Boolean)
  if (meta.length > 0) ctx.log.hint(meta.join(' · '))
  ctx.log.hint(tracesHint)
}

export async function runChatRemove(ctx: CommandContext, id: string, options: ConfirmOptions = {}) {
  const client = requireClient(ctx)
  const conversation = await client.get(conversationPath(id), {
    schema: conversationWithMessagesSchema,
  })
  const question = `Delete "${conversation.title}"? Its messages are removed for good.`
  if (!(await confirmAction(question, options))) {
    ctx.log.info('Nothing deleted.')
    return
  }
  await client.request('DELETE', conversationPath(conversation.id))
  ctx.out.data(
    { deleted: conversation.id },
    () => `${chalk.green('✓')} Deleted "${conversation.title}".`
  )
}

export async function runChatCompact(ctx: CommandContext, id: string) {
  const { data, raw } = await requireClient(ctx).request(
    'POST',
    `${conversationPath(id)}/compact`,
    { schema: compactConversationResponseSchema }
  )
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Summarising ${data.pendingMessages} message(s) (${data.pendingChars} chars) outside the context window.`,
      chalk.dim(
        `A job writes the summary; \`${ctx.binName} chat stats ${data.conversationId}\` shows it.`
      ),
    ].join('\n')
  )
}

export function registerChatCommands(program: Command, action: ActionWrapper): void {
  const chat = program
    .command('chat')
    .description('your chat conversations — read, start, delete and compact a thread')
  chat
    .command('ls')
    .description('list your conversations, most recent first')
    .option('--page <n>', 'page number', positiveInt('--page'))
    .option('--page-size <n>', 'items per page (max 200)', positiveInt('--page-size'))
    .action(action((ctx, cmd) => runChatList(ctx, cmd.opts<ChatListOptions>())))
  chat
    .command('show <id>')
    .description('print a conversation with its messages, models, tokens and tool calls')
    .option('--full', 'print message content unclipped')
    .action(action((ctx, cmd) => runChatShow(ctx, cmd.args[0] ?? '', cmd.opts())))
  chat
    .command('stats <id>')
    .description('what answers the next turn, what fills its context, tokens and cost (admin+)')
    .action(action((ctx, cmd) => runChatStats(ctx, cmd.args[0] ?? '')))
  chat
    .command('new')
    .description('start a conversation on the model chat resolves to now')
    .option('--title <title>', 'its title (default: the first message titles it)')
    .action(action((ctx, cmd) => runChatNew(ctx, cmd.opts())))
  chat
    .command('send [id] [message]')
    .description(
      'send a message and stream the reply (AG-UI); --new starts a conversation first, - reads stdin'
    )
    .option('--new', 'start a conversation first: `chat send --new "<message>"`')
    .option('--title <title>', 'with --new: its title')
    .action(
      action((ctx, cmd) => runChatSend(ctx, cmd.args[0], cmd.args[1], cmd.opts<ChatSendOptions>()))
    )
  chat
    .command('rm <id>')
    .description('delete a conversation and its messages (asks first)')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(action((ctx, cmd) => runChatRemove(ctx, cmd.args[0] ?? '', cmd.opts())))
  chat
    .command('compact <id>')
    .description('summarise what has fallen outside the context window, now (admin+)')
    .action(action((ctx, cmd) => runChatCompact(ctx, cmd.args[0] ?? '')))
}
