/**
 * Debugging a coding session from the terminal (issue #6) — everything the session page shows and
 * does that a person chasing a failure needs, over the same routes and `launch-sessions` schemas:
 *
 * - `show <id>` (issue #8, extended by #6): status, kind, runtime and model, branch and head,
 *   the PR, where the ship stands (`landing`), budget and usage, the last error, and the latest
 *   gate attempt — its failing step with the step's output tail (the newest `ship.gate` rows),
 *   then every boot's phases. `--json`: `{ session, boots, gate, lastError, attachments }`.
 * - `logs <id> [--follow] [--since <seq>] [--type <t>[,<t>]] [--limit n]`: the DURABLE event log
 *   (`GET /events?afterSeq=`), one line per row — seq, UTC time, type, and the follow's words
 *   (`formatSessionEvent`); a row the follow hides is still listed, dim, with its data compacted:
 *   this is the debugging view. A failed gate step adds its command and output tail. `--type`
 *   matches by prefix (`ship.` is every ship row); `--limit` keeps the LAST n matching rows.
 *   `--follow` polls until the session is quiet — settled for now (`ready`, `blocked`,
 *   `suspended`, `shipped`, `ended`, `failed`), no message waiting, no action requested and no
 *   ship in flight. `--json`: one `{ events, nextSeq }` document; with `--follow`, a stream of one
 *   JSON document per row as it arrives (`jq` reads either as is).
 * - `resume`, `cancel` (the running turn), `landing-retry [--release-anyway]`, `budget <id> <usd>
 *   [--reason]`, `withdraw` (the waiting message): one POST each. A refusal is the server's
 *   sentence (409 → exit 1, 403 → exit 3) — `api.ts` maps it.
 * - `attachments <id>`: the images the session's messages carried (there is no list route: read
 *   from the `user.message` rows, plus the waiting message's), and `attachment <id> <aid> --out
 *   <file> [--force]`, streamed by `ApiClient.download` into a `0600` file (`wx` unless `--force`).
 */
import {
  extendBudgetResponseSchema,
  isShipGateRunning,
  landingRetryable,
  SESSION_EVENT_TYPES,
  type Session,
  type SessionAttachment,
  type SessionBootTimingData,
  type SessionEvent,
  SHIP_GATE_ATTEMPTS,
  SHIP_GATE_STEP_LABELS,
  type ShipGateStep,
  sessionBootTimingDataSchema,
  sessionCancelResponseSchema,
  sessionDetailResponseSchema,
  sessionShipCiDataSchema,
  sessionShipGateDataSchema,
  sessionShippingOf,
  sessionShipReopenedDataSchema,
  sessionShipStagingDataSchema,
  sessionTurnEndDataSchema,
  sessionTurnFailedDataSchema,
  sessionTurnInterruptedDataSchema,
  sessionUserMessageDataSchema,
} from '@launch/shared/launch-sessions'
import { shippingLineText } from '@launch/shared/launch-ship-progress'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context'
import { CliError, EXIT_ERROR } from '../errors'
import { downloadToFile } from '../utils/input'
import { formatDate, renderTable } from '../utils/output'
import {
  agentOf,
  CI_TAIL_LINES,
  formatSessionEvent,
  SETTLED_FOR_TURN,
  type SessionPollOptions,
} from './sessions'
import {
  defaultSleep,
  getSession,
  readEventsAfter,
  secs,
  sessionPath,
  usd,
} from './sessions-common'

/** The last lines of a gate step's output `show` and `logs` print. */
const GATE_TAIL_LINES = CI_TAIL_LINES

const tailOf = (text: string | null | undefined, lines: number): string[] =>
  text?.trim() ? text.trimEnd().split('\n').slice(-lines) : []

const sorted = (events: readonly SessionEvent[]) => [...events].sort((a, b) => a.seq - b.seq)

// ---- show ------------------------------------------------------------------------------------

/** One boot as `sessions show` reports it. */
export interface SessionBootReport extends SessionBootTimingData {
  seq: number
  at: Date
  /** How long the first turn after this boot took to answer, when one has ended since. */
  firstTokenMs?: number
}

/** Every `boot.timing` row, oldest first, each with the first turn that ended after it. Pure. */
export function sessionBoots(events: readonly SessionEvent[]): SessionBootReport[] {
  const boots: SessionBootReport[] = []
  let current: SessionBootReport | null = null
  for (const event of sorted(events)) {
    if (event.type === 'boot.timing') {
      const parsed = sessionBootTimingDataSchema.safeParse(event.data)
      if (!parsed.success) continue
      current = { ...parsed.data, seq: event.seq, at: event.at }
      boots.push(current)
    } else if (event.type === 'turn.end' && current) {
      const ms = sessionTurnEndDataSchema.safeParse(event.data).data?.firstTokenMs
      if (ms !== undefined) current.firstTokenMs = ms
      current = null
    }
  }
  return boots
}

/** The latest gate attempt, as the ship panel reads it from the `ship.gate` rows. */
export interface SessionGateReport {
  attempt: number
  maxAttempts: number
  /** true: the attempt passed; false: a step failed; null: no verdict yet. */
  passed: boolean | null
  /** The step running now (its start row is the newest gate row). */
  running: { step: ShipGateStep; command: string } | null
  /** The step that failed in this attempt, with the tail of its (redacted) output. */
  failed: {
    step: ShipGateStep | null
    label: string
    command: string | null
    durationMs: number | null
    target: string | null
    output: string | null
    seq: number
    at: Date
  } | null
  seq: number
  at: Date
}

/**
 * The newest gate attempt: the run of `ship.gate` rows at the end of the log that share its
 * attempt number (a step seen twice means an earlier ship's rows, so the walk stops). Null when
 * the session never ran the gate. Pure.
 */
export function sessionGateReport(events: readonly SessionEvent[]): SessionGateReport | null {
  const rows = sorted(events).flatMap(event => {
    if (event.type !== 'ship.gate') return []
    const parsed = sessionShipGateDataSchema.safeParse(event.data)
    return parsed.success ? [{ event, data: parsed.data }] : []
  })
  const last = rows.at(-1)
  if (!last) return null
  const attempt = last.data.attempt
  const current: typeof rows = []
  const verdicts = new Set<string>()
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!row || row.data.attempt !== attempt) break
    if (!isShipGateRunning(row.data)) {
      const key = row.data.step ?? '(gate)'
      if (verdicts.has(key)) break
      verdicts.add(key)
    }
    current.unshift(row)
  }
  let failed: SessionGateReport['failed'] = null
  let passed: boolean | null = null
  for (const { event, data } of current) {
    if (isShipGateRunning(data)) continue
    if (!data.passed) {
      failed = {
        step: data.step ?? null,
        label: data.step ? SHIP_GATE_STEP_LABELS[data.step] : 'The gate',
        command: data.command ?? null,
        durationMs: data.durationMs ?? null,
        target: data.target ?? null,
        output: data.output ?? null,
        seq: event.seq,
        at: event.at,
      }
      passed = false
    } else if (passed !== false && (!data.step || data.step === 'test')) passed = true
  }
  const running =
    isShipGateRunning(last.data) && !failed
      ? { step: last.data.step, command: last.data.command }
      : null
  return {
    attempt,
    maxAttempts: SHIP_GATE_ATTEMPTS,
    passed,
    running,
    failed,
    seq: last.event.seq,
    at: last.event.at,
  }
}

/** The newest row that says something went wrong. */
export interface SessionErrorReport {
  seq: number
  at: Date
  type: SessionEvent['type']
  message: string
}

/** What a row says went wrong, or null for a row that is not a failure. Pure. */
function errorMessageOf(event: SessionEvent): string | null {
  const data = (event.data ?? {}) as Record<string, unknown>
  switch (event.type) {
    case 'turn.failed':
      return sessionTurnFailedDataSchema.safeParse(event.data).data?.message ?? 'turn failed'
    case 'turn.interrupted': {
      const parsed = sessionTurnInterruptedDataSchema.safeParse(event.data).data
      if (!parsed || parsed.reason === 'cancelled') return null
      return `turn interrupted (${parsed.reason})${parsed.message ? `: ${parsed.message}` : ''}`
    }
    case 'error':
      return typeof data.message === 'string' ? data.message : 'error'
    case 'budget.reached':
      return 'budget reached'
    case 'tool.end':
      return null
    case 'ship.reopened':
      return sessionShipReopenedDataSchema.safeParse(event.data).data?.message ?? 'not merged'
    case 'ship.ci': {
      const ci = sessionShipCiDataSchema.safeParse(event.data).data
      if (ci?.state !== 'failure') return null
      return `CI failed${ci.failedCheck ? `: ${ci.failedCheck.name}` : ''}`
    }
    case 'ship.staging': {
      const staging = sessionShipStagingDataSchema.safeParse(event.data).data
      if (!staging || ['deploying', 'active', 'live'].includes(staging.status)) return null
      return staging.error ?? `staging ${staging.status}`
    }
    case 'ship.gate': {
      const gate = sessionShipGateDataSchema.safeParse(event.data).data
      if (!gate || isShipGateRunning(gate) || gate.passed) return null
      const step = gate.step ? SHIP_GATE_STEP_LABELS[gate.step] : 'The gate'
      return `${step} failed (try ${gate.attempt} of ${SHIP_GATE_ATTEMPTS})`
    }
    default:
      return null
  }
}

/** The newest failure row in the log, or null. Pure. */
export function sessionLastError(events: readonly SessionEvent[]): SessionErrorReport | null {
  for (const event of sorted(events).reverse()) {
    const message = errorMessageOf(event)
    if (message !== null) return { seq: event.seq, at: event.at, type: event.type, message }
  }
  return null
}

/** One image a message carried, read from the log (there is no list route). */
export interface SessionAttachmentReport extends SessionAttachment {
  /** The `user.message` row; null for the message still waiting. */
  seq: number | null
  turn: number | null
  at: Date | null
  /** The message's first line. */
  message: string
}

/** Every image the session's messages carried, oldest first, then the waiting message's. Pure. */
export function sessionAttachments(
  events: readonly SessionEvent[],
  session?: Pick<Session, 'queuedAttachments' | 'queuedMessage'>
): SessionAttachmentReport[] {
  const items: SessionAttachmentReport[] = []
  for (const event of sorted(events)) {
    if (event.type !== 'user.message') continue
    const parsed = sessionUserMessageDataSchema.safeParse(event.data)
    for (const attachment of parsed.data?.attachments ?? []) {
      items.push({
        ...attachment,
        seq: event.seq,
        turn: event.turn,
        at: event.at,
        message: parsed.data?.text.split('\n')[0] ?? '',
      })
    }
  }
  for (const attachment of session?.queuedAttachments ?? []) {
    items.push({
      ...attachment,
      seq: null,
      turn: null,
      at: null,
      message: session?.queuedMessage?.split('\n')[0] ?? '',
    })
  }
  return items
}

const BOOT_KIND_WORDS: Record<SessionBootTimingData['kind'], string> = {
  boot: 'first boot',
  warm: 'warm resume',
  cold: 'cold resume',
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : null)

/** `Label   value`, the label column a fixed width. */
const field = (label: string, value: string) => `  ${chalk.dim(label.padEnd(8))}${value}`

function showLines(
  ctx: CommandContext,
  session: Session,
  gate: SessionGateReport | null,
  lastError: SessionErrorReport | null
): string[] {
  const lines = [`${chalk.bold(session.title ?? '(untitled)')} ${chalk.dim(session.id)}`]
  lines.push(
    field(
      'Status',
      [
        session.status,
        session.kind,
        session.runtime,
        session.model ?? 'the agent’s default model',
        session.credentialSource === 'user' ? 'personal account' : null,
      ]
        .filter(Boolean)
        .join(' · ')
    )
  )
  if (session.branch) {
    const head = short(session.headSha)
    const base = session.baseRef
      ? ` (from ${session.baseRef}${session.baseSha ? ` @ ${short(session.baseSha)}` : ''})`
      : ''
    lines.push(field('Branch', `${session.branch}${head ? ` @ ${head}` : ''}${base}`))
  }
  if (session.prNumber !== null) {
    const landing = session.landing
    const parts = [`#${session.prNumber}`, session.prUrl]
    if (landing?.mergeSha) parts.push(`merged (${short(landing.mergeSha)})`)
    if (session.prChecks) parts.push(`checks ${session.prChecks.state}`)
    lines.push(field('PR', parts.filter(Boolean).join(' · ')))
  }
  const landing = session.landing
  if (landing) {
    const shipping = sessionShippingOf(session)
    const stage = shipping
      ? shippingLineText(shipping, Date.now())
      : `${landing.stage}${landing.stalledReason ? ` (${landing.stalledReason})` : ''}`
    const extra = [
      landing.version ? `v${landing.version.replace(/^v/, '')}` : null,
      landing.stagingUrl,
      `${landing.mode} mode`,
    ].filter(Boolean)
    lines.push(field('Ship', `${stage}${extra.length ? ` · ${extra.join(' · ')}` : ''}`))
    if (landing.error) lines.push(field('', chalk.yellow(landing.error)))
  }
  const { budget, usage } = session
  const extra = budget.extraMicrocents ? ` (incl. ${usd(budget.extraMicrocents)} extra)` : ''
  lines.push(
    field(
      'Budget',
      `${session.turnCount} turns · ${usd(budget.spentMicrocents)} of ${usd(budget.capMicrocents)}${extra} · ${usage.tokensIn.toLocaleString('en')} tokens in, ${usage.tokensOut.toLocaleString('en')} out · container ${Math.round(session.containerSeconds / 60)} min`
    )
  )
  if (session.queuedMessage !== null)
    lines.push(field('Waiting', chalk.cyan(`> ${session.queuedMessage.split('\n')[0]}`)))
  if (session.error) lines.push(field('Error', chalk.red(session.error)))
  if (lastError) {
    lines.push(
      field(
        'Last err',
        `${chalk.red(lastError.message)} ${chalk.dim(`(#${lastError.seq} ${lastError.type}, ${formatDate(lastError.at)})`)}`
      )
    )
  }
  if (gate) {
    const of = `try ${gate.attempt} of ${gate.maxAttempts}`
    if (gate.failed) {
      const f = gate.failed
      const detail = [f.command, f.durationMs !== null ? secs(f.durationMs) : null]
        .filter(Boolean)
        .join(' · ')
      lines.push(
        field('Gate', chalk.red(`${f.label} failed (${of})${detail ? ` · ${detail}` : ''}`))
      )
      if (f.target) lines.push(field('', chalk.dim(f.target)))
      const tail = tailOf(f.output, GATE_TAIL_LINES)
      if (tail.length) lines.push(...tail.map(line => chalk.dim(`    ${line}`)))
      else lines.push(field('', chalk.dim('(no output recorded)')))
    } else if (gate.running) {
      lines.push(
        field(
          'Gate',
          `running ${SHIP_GATE_STEP_LABELS[gate.running.step]} (${of}) · ${gate.running.command}`
        )
      )
    } else {
      lines.push(field('Gate', gate.passed ? chalk.green(`passed (${of})`) : `${of}, no verdict`))
    }
  }
  const next = nextCommands(ctx, session)
  if (next.length) lines.push(...next.map(command => chalk.dim(`  Next: ${command}`)))
  return lines
}

/** The debug action the session's state calls for, if any. Pure. */
function nextCommands(ctx: CommandContext, session: Session): string[] {
  const bin = `${ctx.binName} sessions`
  const out: string[] = []
  if (session.status === 'suspended') out.push(`${bin} resume ${session.id}`)
  if (session.status === 'working') out.push(`${bin} cancel ${session.id}`)
  if (session.queuedMessage !== null) out.push(`${bin} withdraw ${session.id}`)
  if (landingRetryable(session.landing)) out.push(`${bin} landing-retry ${session.id}`)
  if (session.budget.spentMicrocents >= session.budget.capMicrocents)
    out.push(`${bin} budget ${session.id} <usd>`)
  return out
}

export async function runSessionsShow(ctx: CommandContext, id: string): Promise<void> {
  const client = requireClient(ctx)
  const session = await getSession(client, id)
  const { items } = await readEventsAfter(client, id, 0)
  const boots = sessionBoots(items)
  const gate = sessionGateReport(items)
  const lastError = sessionLastError(items)
  const attachments = sessionAttachments(items, session)
  ctx.out.data({ session, boots, gate, lastError, attachments }, () => {
    const lines = showLines(ctx, session, gate, lastError)
    if (boots.length === 0) lines.push(chalk.dim('  No boot timing recorded yet.'))
    for (const boot of boots) {
      const reply =
        boot.firstTokenMs !== undefined ? ` · first reply after ${secs(boot.firstTokenMs)}` : ''
      lines.push(
        '',
        `${BOOT_KIND_WORDS[boot.kind]} ${chalk.dim(formatDate(boot.at))} · ${secs(boot.totalMs)}${reply}`,
        renderTable(boot.phases, [
          { header: 'Phase', value: p => p.phase },
          { header: 'Start', value: p => `+${secs(p.startMs)}` },
          { header: 'Took', value: p => secs(p.ms) },
        ])
      )
      if (boot.traceId) lines.push(chalk.dim(`  ${ctx.binName} traces show ${boot.traceId}`))
    }
    lines.push(chalk.dim(`  The full log: ${ctx.binName} sessions logs ${session.id}`))
    return lines.join('\n')
  })
}

// ---- logs ------------------------------------------------------------------------------------

export interface SessionsLogsOptions extends SessionPollOptions {
  follow?: boolean
  /** Rows after this seq (commander hands a string). */
  since?: string | number
  /** Comma-separated type prefixes. */
  type?: string
  /** Keep the last n matching rows of the backlog. */
  limit?: string | number
}

function intOption(name: string, value: string | number | undefined, min: number) {
  if (value === undefined) return undefined
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < min) {
    throw new CliError(`--${name} must be an integer ≥ ${min}`, { exitCode: EXIT_ERROR })
  }
  return n
}

/** `--type ship.,turn.failed` → the prefixes, each checked against the known types. */
export function parseLogTypes(value: string | undefined): string[] | null {
  if (value === undefined) return null
  const prefixes = value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
  for (const prefix of prefixes) {
    if (!SESSION_EVENT_TYPES.some(type => type.startsWith(prefix))) {
      throw new CliError(`No event type starts with "${prefix}"`, {
        hint: `Types: ${SESSION_EVENT_TYPES.join(', ')}`,
      })
    }
  }
  return prefixes.length ? prefixes : null
}

/** `{"turn":1,…}` cut to one short line. Pure. */
function compactData(data: unknown): string {
  if (data === undefined || data === null) return ''
  const text = JSON.stringify(data) ?? ''
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}

/** `2026-09-28 10:00:00Z`. Pure. */
const utc = (at: Date) => `${at.toISOString().slice(0, 19).replace('T', ' ')}Z`

/**
 * One row as `sessions logs` prints it: `#seq time type  text`, the text being the follow's words
 * (`formatSessionEvent`) or — for a row the follow hides — its data, compacted and dim. A status
 * row says the new status; a failed gate step adds its command and output tail. Pure.
 */
export function formatSessionLogLine(event: SessionEvent, agent = 'Claude'): string {
  const data = (event.data ?? {}) as Record<string, unknown>
  let body: string
  if (event.type === 'status' && typeof data.status === 'string') {
    body = `→ ${data.status}${typeof data.reason === 'string' ? ` (${data.reason})` : ''}`
  } else {
    body = formatSessionEvent(event, agent) ?? chalk.dim(compactData(event.data))
  }
  const extra: string[] = []
  if (event.type === 'ship.gate') {
    const gate = sessionShipGateDataSchema.safeParse(event.data).data
    if (gate && !isShipGateRunning(gate) && !gate.passed) {
      const detail = [gate.command, gate.durationMs !== undefined ? secs(gate.durationMs) : null]
        .filter(Boolean)
        .join(' · ')
      if (detail) extra.push(chalk.dim(`    ${detail}`))
      if (gate.target) extra.push(chalk.dim(`    ${gate.target}`))
      extra.push(...tailOf(gate.output, GATE_TAIL_LINES).map(line => chalk.dim(`    ${line}`)))
    }
  }
  const [first = '', ...rest] = body.split('\n')
  const head = `${chalk.dim(`#${event.seq}`)} ${chalk.dim(utc(event.at))} ${event.type.padEnd(18)}`
  return [`${head} ${first.trim()}`, ...rest.map(line => `  ${line}`), ...extra].join('\n')
}

/**
 * Whether a followed log is done: the session is settled for now, no message waits, no action is
 * requested and no ship is in flight. Pure.
 */
export function sessionLogSettled(
  session: Pick<Session, 'status' | 'pendingMessage' | 'requestedAction' | 'landing'>
): boolean {
  return (
    SETTLED_FOR_TURN.includes(session.status) &&
    !session.pendingMessage &&
    session.requestedAction === null &&
    sessionShippingOf(session) === null
  )
}

export async function runSessionsLogs(
  ctx: CommandContext,
  id: string,
  options: SessionsLogsOptions = {}
): Promise<void> {
  const types = parseLogTypes(options.type)
  const since = intOption('since', options.since, 0) ?? 0
  const limit = intOption('limit', options.limit, 1)
  const matches = (event: SessionEvent) => !types || types.some(t => event.type.startsWith(t))
  const client = requireClient(ctx)
  // The session BEFORE the rows: every row written before it settled is in the read that follows.
  let session = await getSession(client, id)
  const agent = agentOf(session.runtime)
  const first = await readEventsAfter(client, id, since)
  let cursor = first.nextSeq
  let backlog = first.items.filter(matches)
  if (limit !== undefined) backlog = backlog.slice(-limit)

  if (!options.follow) {
    ctx.out.data({ events: backlog, nextSeq: cursor }, () =>
      backlog.length
        ? backlog.map(event => formatSessionLogLine(event, agent)).join('\n')
        : chalk.dim('(no events)')
    )
    return
  }

  // Following: each row as it arrives — a line, or (`--json`) one JSON document per row.
  const print = (event: SessionEvent) => {
    if (ctx.json) ctx.out.data(event, () => '')
    else ctx.out.text(formatSessionLogLine(event, agent))
  }
  backlog.forEach(print)
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? 1000
  const deadline = now() + (options.timeoutMs ?? 4 * 60 * 60_000)
  while (!sessionLogSettled(session)) {
    if (now() >= deadline) {
      throw new CliError('Timed out following the log', {
        hint: `The session carries on — \`${ctx.binName} sessions logs ${id} --since ${cursor} --follow\` picks up here.`,
      })
    }
    // A landing past its PR works in rounds of 30 s – 2 min.
    await sleep(sessionShippingOf(session) ? Math.max(pollMs, 1000) * 10 : pollMs)
    session = await getSession(client, id)
    const batch = await readEventsAfter(client, id, cursor)
    cursor = batch.nextSeq
    batch.items.filter(matches).forEach(print)
  }
  if (!ctx.json) ctx.out.text(chalk.dim(`— the session is ${session.status} (log at #${cursor})`))
}

// ---- debug actions ---------------------------------------------------------------------------

export async function runSessionsResume(ctx: CommandContext, id: string): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('POST', `${sessionPath(id)}/resume`, {
    schema: sessionDetailResponseSchema,
  })
  ctx.out.data(
    raw,
    () =>
      `${chalk.green('✓')} Resuming session ${id} (${data.session.status}). Follow it with \`${ctx.binName} sessions logs ${id} --follow\`.`
  )
}

export async function runSessionsCancel(ctx: CommandContext, id: string): Promise<void> {
  const { raw } = await requireClient(ctx).request('POST', `${sessionPath(id)}/cancel`, {
    schema: sessionCancelResponseSchema,
  })
  ctx.out.data(
    raw,
    () => `${chalk.green('✓')} Asked the running turn to stop — it stops within a few seconds.`
  )
}

export async function runSessionsWithdraw(ctx: CommandContext, id: string): Promise<void> {
  const { raw } = await requireClient(ctx).request('POST', `${sessionPath(id)}/queued/withdraw`, {
    schema: sessionDetailResponseSchema,
  })
  ctx.out.data(raw, () => `${chalk.green('✓')} Withdrew the waiting message.`)
}

export async function runSessionsLandingRetry(
  ctx: CommandContext,
  id: string,
  options: { releaseAnyway?: boolean } = {}
): Promise<void> {
  const action = options.releaseAnyway ? 'release_anyway' : 'retry'
  const { data, raw } = await requireClient(ctx).request(
    'POST',
    `${sessionPath(id)}/landing/retry`,
    { schema: sessionDetailResponseSchema, body: { action } }
  )
  ctx.out.data(raw, () => {
    const stage = data.session.landing?.stage ?? data.session.status
    const what = action === 'release_anyway' ? 'Releasing anyway' : 'Retrying'
    return `${chalk.green('✓')} ${what} (the ship is at ${stage}). Follow it with \`${ctx.binName} sessions logs ${id} --type ship. --follow\`.`
  })
}

export async function runSessionsBudget(
  ctx: CommandContext,
  id: string,
  amount: string,
  options: { reason?: string } = {}
): Promise<void> {
  const extraUsd = Number(amount)
  if (!Number.isFinite(extraUsd) || extraUsd <= 0) {
    throw new CliError(`"${amount}" is not an amount in dollars`, {
      hint: 'For example: 5 or 2.50',
    })
  }
  const { status, data, raw } = await requireClient(ctx).request(
    'POST',
    `${sessionPath(id)}/budget`,
    {
      schema: extendBudgetResponseSchema,
      body: { extraUsd, ...(options.reason ? { reason: options.reason } : {}) },
    }
  )
  ctx.out.data(raw, () => {
    const { budget } = data.session
    if (status === 200)
      return `${chalk.green('✓')} Budget raised: ${usd(budget.spentMicrocents)} of ${usd(budget.capMicrocents)}.`
    const approval = data.approvalId
      ? ` — \`${ctx.binName} approvals show ${data.approvalId}\``
      : ''
    return `${chalk.cyan('…')} Asked for $${extraUsd.toFixed(2)} more; it waits for an approval${approval}.`
  })
}

// ---- attachments -----------------------------------------------------------------------------

export async function runSessionsAttachments(ctx: CommandContext, id: string): Promise<void> {
  const client = requireClient(ctx)
  const session = await getSession(client, id)
  const items = sessionAttachments((await readEventsAfter(client, id, 0)).items, session)
  ctx.out.data({ items }, () =>
    renderTable(items, [
      { header: 'Id', value: a => a.id },
      { header: 'Type', value: a => a.contentType },
      { header: 'Turn', value: a => a.turn ?? 'waiting' },
      { header: 'Sent', value: a => a.at },
      {
        header: 'Message',
        value: a => (a.message.length > 50 ? `${a.message.slice(0, 49)}…` : a.message),
      },
    ])
  )
}

export async function runSessionsAttachment(
  ctx: CommandContext,
  id: string,
  attachmentId: string,
  options: { out: string; force?: boolean }
): Promise<void> {
  if (!options.out) throw new CliError('--out <file> is required')
  const { body, contentType } = await requireClient(ctx).download(
    `${sessionPath(id)}/attachments/${encodeURIComponent(attachmentId)}`
  )
  const bytes = await downloadToFile({ body }, options.out, options.force)
  ctx.out.data(
    { path: options.out, bytes, contentType },
    () =>
      `${chalk.green('✓')} Saved ${bytes} bytes${contentType ? ` (${contentType})` : ''} to ${options.out}`
  )
}
