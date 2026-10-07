/**
 * `launch agents ls|runs|run|logs|interrupts|cancel|start` — the agent registry and its runs
 * (`/api/agents`, D7), for seeing what the agents are doing from a terminal (issue #6).
 *
 * Members see, cancel and start their OWN runs; admin+ every run in the organisation — the server
 * decides, so another member's run is the same 404 as none.
 *
 * - `run <id>` reads `GET /runs/:id` (the row, its durable events, asks and artifacts) and prints
 *   the status, each step's latest state, the error, pending asks and artifacts. It then looks the
 *   run's trace up (`GET /api/traces?runId=`, admin+) for its tokens and trace id; a member's 403
 *   there is not an error, the trace is simply not shown. There is no per-run cost: `ai_usage` rows
 *   carry no run column (see `agui-projection.ts`), so `ai usage` is the ledger.
 * - `logs <id>` reads the run projected to AG-UI (`GET /runs/:id/agui`, plain JSON) and prints it
 *   as lines. `--follow` POLLS that endpoint rather than reading the SSE stream, so `api.ts` stays
 *   the one JSON fetch site: each poll prints the events past the ones already printed (the
 *   projection is a pure function of the append-only rows, so the prefix is stable), and it stops
 *   at a terminal event — `RUN_ERROR` (failed or cancelled, exit 1), `RUN_FINISHED` (exit 0), or a
 *   `RUN_FINISHED` with an interrupt outcome (the run waits on a person; exit 0 with the hint).
 *   `sleep` and `pollMs` are injectable for the tests.
 *
 * - `answer <run> [interrupt]` — `POST /runs/:id/interrupts/:interruptId`: answer what the run
 *   asks. It reads the ask from `GET /runs/:id` (the only pending one when no id is given; else an
 *   id, 8-char prefix or the ask's key) and builds the payload FOR ITS KIND — `--approve` /
 *   `--reject` (approval, `--edited-input` when the ask allows edits), `--choice <value>`,
 *   `--text <text>`, `--field name=value…` (form; typed per field), or the whole payload as
 *   `--data` — then validates it with the same `interruptPayloadSchema(spec)` the route and the
 *   page use, so a bad answer exits 1 listing the issues before any request. With no answer flag
 *   it prints the question and how to answer it (exit 1). `--reject` declines any kind
 *   (`cancelled`, with an optional `--note`). Someone answering first is the server's 409, exit 1.
 * - `steer <run> <note>` — `POST /runs/:id/steering`: a note the agent reads at its next turn
 *   (a settled run is the server's 409).
 *
 * `cli.ts` calls `registerAgentsCommands(program, action)` once.
 */
import {
  type AgentRun,
  type AgentRunWithEvents,
  agentListResponseSchema,
  agentRunEventSchema,
  agentRunSchema,
  agentRunStatusSchema,
  agentRunWithEventsSchema,
  agentStepEventDataSchema,
  createAgentRunRequestSchema,
  createAgentRunResponseSchema,
  isRunActive,
} from '@launch/shared/ai/agents'
import {
  AguiEventType,
  agentRunAguiResponseSchema,
  KIT_CUSTOM_EVENTS,
  type KitAguiEvent,
  parseKitCustom,
} from '@launch/shared/ai/agui'
import {
  type AgentRunInterrupt,
  agentInterruptStatusSchema,
  agentRunInterruptSchema,
  createSteeringNoteRequestSchema,
  interruptInboxItemSchema,
  interruptPayloadSchema,
  interruptRejectionPayloadSchema,
  resolveInterruptRequestSchema,
} from '@launch/shared/ai/interrupts'
import { traceListResponseSchema } from '@launch/shared/ai/traces'
import { paginatedResponse } from '@launch/shared/pagination'
import chalk from 'chalk'
import { type Command, InvalidArgumentError, Option } from 'commander'
import { CliApiError } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError, EXIT_ERROR } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { type InputSeams, parseBody, positiveInt, readDataArg } from '../utils/input'
import { formatDate, formatPagination, renderTable } from '../utils/output'
import { formatDuration } from './traces'

export const agentRunsResponseSchema = paginatedResponse(agentRunSchema)
export const interruptInboxResponseSchema = paginatedResponse(interruptInboxItemSchema)

const runPath = (id: string) => `/api/agents/runs/${encodeURIComponent(id)}`

function took(run: Pick<AgentRun, 'startedAt' | 'finishedAt'>): string | null {
  if (!run.startedAt) return null
  const end = run.finishedAt ?? new Date()
  return formatDuration(Math.max(0, end.getTime() - run.startedAt.getTime()))
}

function colourStatus(status: string): string {
  if (status === 'succeeded') return chalk.green(status)
  if (status === 'failed') return chalk.red(status)
  if (status === 'cancelled') return chalk.dim(status)
  if (status === 'awaiting_input') return chalk.yellow(status)
  return chalk.cyan(status)
}

const CLIP = 300
function clip(value: unknown, full = false): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return ''
  return !full && text.length > CLIP
    ? `${text.slice(0, CLIP)}… (+${text.length - CLIP} chars)`
    : text
}

// ---- ls --------------------------------------------------------------------------------------

export async function runAgentsList(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/agents', {
    schema: agentListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Agent', value: a => a.key },
      { header: 'Title', value: a => a.title },
      { header: 'Exclusive', value: a => (a.exclusive ? 'yes' : 'no') },
      { header: 'Approvers', value: a => a.approvers },
      { header: 'Description', value: a => clip(a.description.split('\n')[0] ?? '', false) },
    ])
  )
}

// ---- runs ------------------------------------------------------------------------------------

export interface AgentsRunsOptions {
  agent?: string
  status?: string
  limit?: number
  page?: number
}

export async function runAgentsRuns(
  ctx: CommandContext,
  options: AgentsRunsOptions = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/agents/runs', {
    schema: agentRunsResponseSchema,
    query: {
      agentKey: options.agent,
      status: options.status,
      pageSize: options.limit,
      page: options.page,
    },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Created', value: r => formatDate(r.createdAt) },
      { header: 'Run', value: r => r.id },
      { header: 'Agent', value: r => r.agentKey },
      { header: 'Status', value: r => colourStatus(r.status) },
      { header: 'Took', value: r => took(r) },
      { header: 'Error', value: r => (r.error ? clip(r.error.split('\n')[0]) : null) },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}

// ---- run <id> --------------------------------------------------------------------------------

/** Each step's LATEST state, in the order the steps first appeared. */
export function stepLines(run: AgentRunWithEvents): string[] {
  const steps = new Map<string, { label: string; status: string; detail?: string }>()
  for (const event of run.events) {
    if (event.type !== 'step') continue
    const parsed = agentStepEventDataSchema.safeParse(event.data)
    if (!parsed.success) continue
    steps.set(parsed.data.key, parsed.data)
  }
  return [...steps.values()].map(step => {
    const mark =
      step.status === 'done'
        ? chalk.green('✓')
        : step.status === 'error'
          ? chalk.red('✗')
          : chalk.cyan('…')
    return `  ${mark} ${step.label}${step.detail ? chalk.dim(` — ${step.detail}`) : ''}`
  })
}

export interface AgentsRunOptions {
  full?: boolean
}

export async function runAgentsRun(
  ctx: CommandContext,
  id: string,
  options: AgentsRunOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const { data: run, raw } = await client.request('GET', runPath(id), {
    schema: agentRunWithEventsSchema,
  })
  if (ctx.out.json) {
    ctx.out.data(raw, () => '')
    return
  }
  // The trace carries the tokens and the trace id; reading it is admin+, so a member skips it.
  let trace: { traceId: string; inputTokens: number; outputTokens: number } | null = null
  try {
    const traces = await client.get('/api/traces', {
      schema: traceListResponseSchema,
      query: { runId: run.id, pageSize: 1 },
    })
    trace = traces.items[0] ?? null
  } catch (error) {
    if (!(error instanceof CliApiError)) throw error
    ctx.log.debug(`trace lookup skipped: ${error.message}`)
  }

  const lines = [
    `${chalk.bold(run.agentKey)}  ${colourStatus(run.status)}`,
    chalk.dim(
      `run ${run.id} · created ${formatDate(run.createdAt)}` +
        (run.startedAt ? ` · took ${took(run)}` : '') +
        (run.attempt > 1 ? ` · attempt ${run.attempt}` : '') +
        (run.cancelRequestedAt && isRunActive(run.status) ? ' · cancel requested' : '')
    ),
  ]
  if (trace) {
    lines.push(
      chalk.dim(
        `trace ${trace.traceId} · ${trace.inputTokens}→${trace.outputTokens} tokens (cost: \`${ctx.binName} ai usage\`)`
      )
    )
  }
  const steps = stepLines(run)
  if (steps.length) lines.push('', chalk.bold('Steps'), ...steps)
  if (run.error) lines.push('', chalk.red(`Error: ${run.error}`))
  const pending = run.interrupts.filter(i => i.status === 'pending')
  if (pending.length) {
    lines.push('', chalk.bold('Waiting on'))
    for (const ask of pending) lines.push(`  ? ${ask.kind}: ${ask.message ?? ask.key}`)
    lines.push(chalk.dim(`  Answer it: \`${ctx.binName} agents answer ${run.id}\``))
  }
  if (run.artifacts.length) {
    lines.push('', chalk.bold('Artifacts'))
    for (const a of run.artifacts) lines.push(`  ${a.title} ${chalk.dim(`(${a.kind}, ${a.key})`)}`)
  }
  if (run.output !== null && run.output !== undefined) {
    lines.push('', chalk.bold('Output'), clip(run.output, options.full))
  }
  lines.push(
    '',
    chalk.dim(
      `Timeline: \`${ctx.binName} agents logs ${run.id}\` · trace: \`${ctx.binName} traces show ${trace?.traceId ?? run.id}\``
    )
  )
  ctx.out.data(raw, () => lines.join('\n'))
}

// ---- logs <id> [--follow] --------------------------------------------------------------------

/** `RUN_FINISHED` / `RUN_ERROR` — present only once the run settled (or parked on a question). */
function isTerminal(event: KitAguiEvent): boolean {
  return event.type === AguiEventType.RUN_FINISHED || event.type === AguiEventType.RUN_ERROR
}

/** One AG-UI event as a line, or null for frames that carry nothing a reader needs. */
export function aguiLine(event: KitAguiEvent, options: { full?: boolean } = {}): string | null {
  switch (event.type) {
    case AguiEventType.RUN_STARTED:
      return chalk.dim(`run ${event.runId} started`)
    case AguiEventType.TEXT_MESSAGE_CONTENT:
      return event.delta
    case AguiEventType.TOOL_CALL_START:
      return `${chalk.cyan('→')} ${chalk.bold(event.toolCallName)}`
    case AguiEventType.TOOL_CALL_ARGS:
      return chalk.dim(`    in:  ${clip(event.delta, options.full)}`)
    case AguiEventType.TOOL_CALL_RESULT:
      return chalk.dim(`    out: ${clip(event.content, options.full)}`)
    case AguiEventType.RUN_ERROR:
      return chalk.red(`✗ ${event.message}${event.code ? ` (${event.code})` : ''}`)
    case AguiEventType.RUN_FINISHED: {
      const outcome = (event as { outcome?: { type?: string; interrupts?: unknown[] } }).outcome
      if (outcome?.type === 'interrupt') {
        return chalk.yellow(`? waiting on ${outcome.interrupts?.length ?? 1} answer(s)`)
      }
      return chalk.green('✓ finished')
    }
    case AguiEventType.CUSTOM: {
      const step = parseKitCustom(KIT_CUSTOM_EVENTS.agentStep, event)
      if (step) {
        const mark =
          step.status === 'done'
            ? chalk.green('✓')
            : step.status === 'error'
              ? chalk.red('✗')
              : chalk.cyan('…')
        return `${mark} ${step.label}${step.detail ? chalk.dim(` — ${step.detail}`) : ''}`
      }
      const retry = parseKitCustom(KIT_CUSTOM_EVENTS.agentRetry, event)
      if (retry) {
        return chalk.yellow(
          `! retrying${retry.attempt ? ` (attempt ${retry.attempt})` : ''}: ${retry.message}`
        )
      }
      const ask = parseKitCustom(KIT_CUSTOM_EVENTS.agentInterrupt, event)
      if (ask)
        return chalk.yellow(
          `? asks (${ask.interrupt.kind}): ${ask.interrupt.message ?? ask.interrupt.key}`
        )
      const answered = parseKitCustom(KIT_CUSTOM_EVENTS.agentInterruptResolved, event)
      if (answered) return chalk.dim(`  answered: ${answered.status}`)
      const note = parseKitCustom(KIT_CUSTOM_EVENTS.agentSteering, event)
      if (note) return `${chalk.dim('note:')} ${note.note.text}`
      const artifact = parseKitCustom(KIT_CUSTOM_EVENTS.agentArtifact, event)
      if (artifact) return `${chalk.dim('artifact:')} ${artifact.artifact.title}`
      const notice = parseKitCustom(KIT_CUSTOM_EVENTS.notice, event)
      if (notice) return chalk.dim(`notice: ${notice.message ?? notice.code}`)
      return null
    }
    default:
      return null
  }
}

export interface AgentsLogsOptions {
  follow?: boolean
  full?: boolean
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function runAgentsLogs(
  ctx: CommandContext,
  id: string,
  options: AgentsLogsOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const sleep = options.sleep ?? defaultSleep
  const read = () =>
    client.request('GET', `${runPath(id)}/agui`, { schema: agentRunAguiResponseSchema })

  if (!options.follow) {
    const { data, raw } = await read()
    ctx.out.data(raw, () =>
      data.events
        .map(e => aguiLine(e, options))
        .filter((line): line is string => line !== null)
        .join('\n')
    )
    return
  }

  // Follow: print what is new each poll; stop at a terminal event. With --json, ONE document at
  // the end (the last body read), so the output still parses.
  let printed = 0
  while (true) {
    const { data, raw } = await read()
    const terminal = data.events.at(-1)
    const done = terminal !== undefined && isTerminal(terminal)
    const body = done ? data.events.slice(0, -1) : data.events
    for (const event of body.slice(printed)) {
      const line = aguiLine(event, options)
      if (line !== null) ctx.out.text(line)
    }
    printed = Math.max(printed, body.length)
    if (done && terminal) {
      if (ctx.out.json) ctx.out.data(raw, () => '')
      else {
        const line = aguiLine(terminal, options)
        if (line) ctx.out.text(line)
      }
      if (terminal.type === AguiEventType.RUN_ERROR) {
        throw new CliError(
          `agent run ${terminal.code === 'agent_run_cancelled' ? 'cancelled' : 'failed'}: ${terminal.message}`,
          {
            exitCode: EXIT_ERROR,
            hint: `\`${ctx.binName} agents run ${id}\` shows its steps; \`${ctx.binName} traces show ${id}\` its spans.`,
          }
        )
      }
      const outcome = (terminal as { outcome?: { type?: string } }).outcome
      if (outcome?.type === 'interrupt') {
        ctx.out.text(
          chalk.dim(`The run is waiting on a person: \`${ctx.binName} agents interrupts\`.`)
        )
      }
      return
    }
    await sleep(options.pollMs ?? 1000)
  }
}

// ---- interrupts ------------------------------------------------------------------------------

export interface AgentsInterruptsOptions {
  status?: string
  limit?: number
  page?: number
}

export async function runAgentsInterrupts(
  ctx: CommandContext,
  options: AgentsInterruptsOptions = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/agents/interrupts', {
    schema: interruptInboxResponseSchema,
    query: { status: options.status, pageSize: options.limit, page: options.page },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Asked', value: i => formatDate(i.createdAt) },
      { header: 'Run', value: i => i.run.id },
      { header: 'Agent', value: i => i.run.agentKey },
      { header: 'Kind', value: i => i.kind },
      { header: 'Status', value: i => i.status },
      { header: 'You can answer', value: i => (i.canAnswer ? 'yes' : 'no') },
      { header: 'Question', value: i => clip(i.message ?? i.key) },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}

// ---- cancel <id> -----------------------------------------------------------------------------

export async function runAgentsCancel(ctx: CommandContext, id: string): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('POST', `${runPath(id)}/cancel`, {
    schema: agentRunSchema,
  })
  ctx.out.data(raw, () =>
    data.status === 'cancelled'
      ? `Cancelled run ${data.id} (${data.agentKey}).`
      : isRunActive(data.status)
        ? `Cancel requested for run ${data.id} (${data.agentKey}); it stops at its next step.`
        : `Run ${data.id} had already ${data.status}; nothing to cancel.`
  )
}

// ---- start <agent> --data <json|@file|-> ----------------------------------------------------

export interface AgentsStartOptions extends InputSeams {
  /** The agent's input: inline JSON, `@file`, or `-` for stdin. */
  data?: string
  /** Deprecated (hidden) alias of `--data`. */
  input?: string
}

export async function runAgentsStart(
  ctx: CommandContext,
  agentKey: string,
  options: AgentsStartOptions = {}
): Promise<void> {
  if (options.input !== undefined && options.data !== undefined)
    throw new CliError('Pass --data or --input, not both', { hint: '--input is now --data.' })
  if (options.input !== undefined) ctx.log.warn('--input is deprecated; use --data.')
  const source = options.data ?? options.input
  const label = options.data !== undefined ? '--data' : '--input'
  let input: unknown = {}
  if (source !== undefined) {
    try {
      input = await readDataArg(source, { ...options, label })
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      throw new CliError(error.message, {
        exitCode: EXIT_ERROR,
        hint: `e.g. --data '{"text":"…"}' — \`${ctx.binName} agents ls --json\` shows each agent's input schema.`,
      })
    }
  }
  const body = parseBody(createAgentRunRequestSchema, { agentKey, input }, 'agent run')
  const { data, raw } = await requireClient(ctx).request('POST', '/api/agents/runs', {
    schema: createAgentRunResponseSchema,
    body,
  })
  ctx.out.data(raw, () =>
    [
      data.deduplicated
        ? `${data.agentKey} already has a run in flight: ${data.id} (${data.status}).`
        : `Started ${data.agentKey}: run ${data.id} (${data.status}).`,
      chalk.dim(`Follow it: \`${ctx.binName} agents logs ${data.id} --follow\``),
    ].join('\n')
  )
}

// ---- answer <run> [interrupt] ----------------------------------------------------------------

/** The ask, in words, with the flags that answer it. */
export function describeAsk(ask: AgentRunInterrupt, binName: string, runId: string): string[] {
  const spec = ask.spec
  const cmd = `${binName} agents answer ${runId} ${ask.id.slice(0, 8)}`
  const lines = [
    `${chalk.bold(spec.title ?? `The agent asks (${spec.kind})`)}  ${chalk.dim(`${ask.status} · ${ask.id}`)}`,
    spec.message,
  ]
  switch (spec.kind) {
    case 'approval':
      if (spec.tool) {
        lines.push(chalk.dim(`  tool ${spec.tool.name}: ${clip(spec.tool.input)}`))
        if (spec.tool.allowEdits)
          lines.push(chalk.dim('  the input may be edited before approving'))
      }
      lines.push(
        '',
        `  ${cmd} --approve${spec.tool?.allowEdits ? " [--edited-input '<json>']" : ''}`,
        `  ${cmd} --reject [--note "why"]`
      )
      break
    case 'choice':
      for (const o of spec.options) {
        lines.push(
          `  ${chalk.bold(o.value)}  ${o.label}${o.description ? chalk.dim(` — ${o.description}`) : ''}`
        )
      }
      if (spec.allowOther) lines.push(chalk.dim('  (or any other answer)'))
      lines.push('', `  ${cmd} --choice <value>`, `  ${cmd} --reject`)
      break
    case 'input':
      if (spec.placeholder) lines.push(chalk.dim(`  e.g. ${spec.placeholder}`))
      lines.push('', `  ${cmd} --text "…"`, `  ${cmd} --reject`)
      break
    case 'form':
      for (const f of spec.fields) {
        const opts = f.options ? ` one of ${f.options.map(o => o.value).join(' | ')}` : ''
        lines.push(
          `  ${chalk.bold(f.name)} ${chalk.dim(`(${f.type}${f.required ? ', required' : ''}${opts})`)} ${f.label}`
        )
      }
      lines.push('', `  ${cmd} --field name=value [--field …]`, `  ${cmd} --reject`)
      break
  }
  return lines
}

/** The run's ask by id, 8-char id prefix or key — or the only pending one when `ref` is absent. */
export function pickInterrupt(run: AgentRunWithEvents, ref?: string): AgentRunInterrupt {
  if (ref) {
    const found = run.interrupts.find(
      i => i.id === ref || i.key === ref || (ref.length >= 8 && i.id.startsWith(ref))
    )
    if (!found) {
      throw new CliError(`Run ${run.id} has no question "${ref}"`, {
        hint: 'Its questions: `agents run <id>`.',
      })
    }
    return found
  }
  const pending = run.interrupts.filter(i => i.status === 'pending')
  if (pending.length === 1 && pending[0]) return pending[0]
  if (pending.length === 0) throw new CliError(`Run ${run.id} is not waiting on an answer`)
  throw new CliError(`Run ${run.id} is waiting on ${pending.length} answers — name one`, {
    hint: pending.map(i => `${i.id.slice(0, 8)}  ${i.kind}: ${i.message ?? i.key}`).join('\n'),
  })
}

/** `--field name=value` → a value typed for that form field (the schema then checks it). */
function fieldValue(type: string, raw: string): unknown {
  if (type === 'number') {
    const n = Number(raw)
    return raw.trim() !== '' && Number.isFinite(n) ? n : raw
  }
  if (type === 'boolean') {
    if (/^(true|yes|y|1)$/i.test(raw)) return true
    if (/^(false|no|n|0)$/i.test(raw)) return false
    return raw
  }
  return raw
}

export interface AgentsAnswerOptions extends InputSeams {
  approve?: boolean
  reject?: boolean
  choice?: string
  text?: string
  field?: string[]
  editedInput?: string
  note?: string
  data?: string
}

export async function runAgentsAnswer(
  ctx: CommandContext,
  runId: string,
  ref: string | undefined,
  options: AgentsAnswerOptions = {}
): Promise<void> {
  if (options.approve && options.reject) throw new CliError('--approve or --reject, not both')
  const client = requireClient(ctx)
  const run = await client.get(runPath(runId), { schema: agentRunWithEventsSchema })
  const ask = pickInterrupt(run, ref)
  if (ask.status !== 'pending') {
    throw new CliError(`That question is ${ask.status}; there is nothing to answer`)
  }
  const spec = ask.spec
  const note = options.note !== undefined ? { note: options.note } : {}

  let status: 'resolved' | 'cancelled' = 'resolved'
  let payload: unknown
  if (options.reject) {
    status = 'cancelled'
    payload = { ...note }
  } else if (options.data !== undefined) {
    payload = await readDataArg(options.data, options)
  } else if (spec.kind === 'approval' && options.approve) {
    payload = {
      ...note,
      ...(options.editedInput !== undefined
        ? {
            editedInput: await readDataArg(options.editedInput, {
              ...options,
              label: '--edited-input',
            }),
          }
        : {}),
    }
  } else if (spec.kind === 'choice' && options.choice !== undefined) {
    payload = { ...note, value: options.choice }
  } else if (spec.kind === 'input' && options.text !== undefined) {
    payload = { ...note, text: options.text }
  } else if (spec.kind === 'form' && options.field?.length) {
    const values: Record<string, unknown> = {}
    for (const pair of options.field) {
      const eq = pair.indexOf('=')
      if (eq <= 0) throw new CliError(`--field ${pair} is not name=value`)
      const name = pair.slice(0, eq)
      const field = spec.fields.find(f => f.name === name)
      if (!field) {
        throw new CliError(`This form has no field "${name}"`, {
          hint: `Its fields: ${spec.fields.map(f => f.name).join(', ')}`,
        })
      }
      values[name] = fieldValue(field.type, pair.slice(eq + 1))
    }
    payload = { ...note, values }
  } else {
    // No answer that fits this kind: show the question and how to answer it.
    ctx.out.text(describeAsk(ask, ctx.binName, run.id).join('\n'))
    throw new CliError(`Say how to answer this ${spec.kind} question`, {
      hint: 'The flags it takes are listed above.',
    })
  }

  const checked = parseBody(
    status === 'resolved' ? interruptPayloadSchema(spec) : interruptRejectionPayloadSchema,
    payload,
    'answer'
  )
  const body = parseBody(resolveInterruptRequestSchema, { status, payload: checked }, 'answer')
  const { data, raw } = await client.request(
    'POST',
    `${runPath(run.id)}/interrupts/${encodeURIComponent(ask.id)}`,
    { schema: agentRunInterruptSchema, body }
  )
  const verb =
    data.status === 'cancelled'
      ? spec.kind === 'approval'
        ? (spec.rejectLabel ?? 'Rejected')
        : 'Declined'
      : spec.kind === 'approval'
        ? (spec.confirmLabel ?? 'Approved')
        : 'Answered'
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} ${verb}: ${spec.message}`,
      chalk.dim(`Follow the run: \`${ctx.binName} agents logs ${run.id} --follow\``),
    ].join('\n')
  )
}

// ---- steer <run> <note> ----------------------------------------------------------------------

export async function runAgentsSteer(ctx: CommandContext, runId: string, text: string) {
  const body = parseBody(createSteeringNoteRequestSchema, { text }, 'note')
  const { data, raw } = await requireClient(ctx).request('POST', `${runPath(runId)}/steering`, {
    schema: agentRunEventSchema,
    body,
  })
  ctx.out.data(
    raw,
    () =>
      `${chalk.green('✓')} Note sent to run ${data.runId} (#${data.seq}); the agent reads it at its next turn.`
  )
}

// ---- registration ----------------------------------------------------------------------------

function runStatus(value: string): string {
  const parsed = agentRunStatusSchema.safeParse(value)
  if (!parsed.success) {
    throw new InvalidArgumentError(
      `--status must be one of ${agentRunStatusSchema.options.join(', ')}`
    )
  }
  return parsed.data
}

export function registerAgentsCommands(program: Command, action: ActionWrapper): void {
  const agents = program
    .command('agents')
    .description('AI agents and their runs — what is running, what failed, what waits on a person')
  agents
    .command('ls')
    .description('list the agents this server registers')
    .action(action(ctx => runAgentsList(ctx)))
  agents
    .command('runs')
    .description('list agent runs, newest first (yours; every run for admin+)')
    .option('--agent <key>', 'only this agent')
    .option('--status <status>', agentRunStatusSchema.options.join(' | '), runStatus)
    .option('--limit <n>', 'runs per page (max 200)', positiveInt('--limit'))
    .option('--page <n>', 'page number', positiveInt('--page'))
    .action(action((ctx, cmd) => runAgentsRuns(ctx, cmd.opts<AgentsRunsOptions>())))
  agents
    .command('run <id>')
    .description('show one run: status, steps, error, asks, artifacts, tokens and its trace id')
    .option('--full', 'print the output unclipped')
    .action(action((ctx, cmd) => runAgentsRun(ctx, cmd.args[0] ?? '', cmd.opts())))
  agents
    .command('logs <id>')
    .description("print a run's timeline (its AG-UI events) as lines")
    .option('--follow', 'keep printing until the run finishes, fails or waits on a person')
    .option('--full', 'print tool input and output unclipped')
    .action(action((ctx, cmd) => runAgentsLogs(ctx, cmd.args[0] ?? '', cmd.opts())))
  agents
    .command('interrupts')
    .description('questions agent runs are waiting on (pending by default)')
    .option(
      '--status <status>',
      agentInterruptStatusSchema.options.join(' | '),
      (value: string) => {
        const parsed = agentInterruptStatusSchema.safeParse(value)
        if (!parsed.success) {
          throw new InvalidArgumentError(
            `--status must be one of ${agentInterruptStatusSchema.options.join(', ')}`
          )
        }
        return parsed.data
      }
    )
    .option('--limit <n>', 'items per page (max 200)', positiveInt('--limit'))
    .option('--page <n>', 'page number', positiveInt('--page'))
    .action(action((ctx, cmd) => runAgentsInterrupts(ctx, cmd.opts<AgentsInterruptsOptions>())))
  agents
    .command('cancel <id>')
    .description('cancel a run (it stops at its next step)')
    .action(action((ctx, cmd) => runAgentsCancel(ctx, cmd.args[0] ?? '')))
  agents
    .command('start <agent>')
    .description('start a run of an agent')
    .option('--data <json|@file|->', "the agent's input as JSON (see `agents ls --json`)")
    .addOption(new Option('--input <json>', 'deprecated: use --data').hideHelp())
    .action(action((ctx, cmd) => runAgentsStart(ctx, cmd.args[0] ?? '', cmd.opts())))
  agents
    .command('answer <run> [question]')
    .description("answer a run's question (no flags: print it and how to answer)")
    .option('--approve', 'approve (an approval question)')
    .option('--reject', 'reject an approval, or decline any other question')
    .option('--choice <value>', 'the option to choose (a choice question)')
    .option('--text <text>', 'the answer (an input question)')
    .option(
      '--field <name=value>',
      'one form field; repeat for each',
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .option('--edited-input <json|@file|->', "approve with the tool's input changed, if allowed")
    .option('--note <text>', 'a note with the answer')
    .option('--data <json|@file|->', 'the whole answer payload as JSON')
    .action(
      action((ctx, cmd) =>
        runAgentsAnswer(ctx, cmd.args[0] ?? '', cmd.args[1], cmd.opts<AgentsAnswerOptions>())
      )
    )
  agents
    .command('steer <run> <note>')
    .description('send a note to a running agent; it reads it at its next turn')
    .action(action((ctx, cmd) => runAgentsSteer(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '')))
}
