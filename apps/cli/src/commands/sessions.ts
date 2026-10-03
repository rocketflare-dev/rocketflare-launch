/**
 * `launch sessions start|say|ship|end|ls|preview-url` — coding sessions (Launch P3, spec/07) from a
 * terminal: start one on an app, talk to it, ship it, end it. The same routes and the same
 * `@launch/shared/launch-sessions` schemas as the web page.
 *
 * - `start <app> [--runtime <claude_code|codex>]` resolves the app by slug (`GET /api/apps/:slug`),
 *   then `POST /api/apps/:id/sessions`, and prints the session id and its page's URL. `--runtime`
 *   (§18.22) picks the coding agent; an unknown name is a usage error before any request, and one
 *   the deployment does not run is the server's 409 `session_runtime_disabled`.
 * - `say <id> <message> [--follow]` posts one turn; `--follow` tails the session's DURABLE rows
 *   (`GET /api/sessions/:id/events?afterSeq=`) until the turn ends — Claude's text, one line per
 *   tool call, and the turn's footnote. A failed turn exits 1. With `--json` it prints ONE document
 *   at the end, `{ session, events }` (`ship` in `pr` mode adds `pr`), so it pipes into `jq`.
 * - `ship <id> [--no-wait]` asks for the ship and, by default, follows it to the end, one line per
 *   stage row (issue #5): the gate, the PR, CI (a red check with its log tail), the review, the
 *   merge, the release and the staging deploy — exit 0 once live on staging; exit 1 when the ship
 *   is given back before the merge (`ship.reopened`), stalls after it, or opens no PR. In the
 *   app's `pr` mode it ends as before: the PR, then its CI. `--no-wait` returns once it started;
 *   `--wait` is still accepted and changes nothing.
 * - `end <id>`, `ls <app> [--all]`, `preview-url <id> [--open]` (a 60-second grant URL — it is a
 *   credential for that preview, so it is printed only when asked for and never logged).
 *
 * Polling, not SSE: the rows are the contract, `api.ts` is the one `fetch` site and speaks JSON,
 * and a CLI tailing a turn every second is cheap. `sleep` and `pollMs` are injectable so the tests
 * run in-process without waiting.
 */
import {
  AGENT_RUNTIMES,
  type AgentRuntimeId,
  agentRuntimeSchema,
} from '@launch/shared/launch-agents'
import { appDetailSchema } from '@launch/shared/launch-apps'
import {
  isActiveSessionStatus,
  previewGrantResponseSchema,
  type Session,
  type SessionEvent,
  type SessionShipReopenedData,
  type SessionStatus,
  SHIP_GATE_STEP_LABELS,
  sessionDetailResponseSchema,
  sessionEventsResponseSchema,
  sessionListResponseSchema,
  sessionPrResponseSchema,
  sessionShipCiDataSchema,
  sessionShipGateDataSchema,
  sessionShipMergedDataSchema,
  sessionShipPrDataSchema,
  sessionShipReleasedDataSchema,
  sessionShipReopenedDataSchema,
  sessionShipReviewDataSchema,
  sessionShipStagingDataSchema,
  sessionTurnEndDataSchema,
  sessionTurnFailedDataSchema,
  sessionTurnInterruptedDataSchema,
  sessionUserMessageDataSchema,
} from '@launch/shared/launch-sessions'
import chalk from 'chalk'
import type { ApiClient } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import { formatDate, renderTable } from '../utils/output'

export interface SessionPollOptions {
  /** Between polls. Default 1 s. */
  pollMs?: number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Give up after this long. Default: the session's turn limit plus five minutes. */
  timeoutMs?: number
  now?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const sessionPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`

const usd = (microcents: number) => `$${(microcents / 100_000_000).toFixed(2)}`

/** `v1.4.2`. Pure. */
const versionLabel = (version: string) => (version.startsWith('v') ? version : `v${version}`)

/** The last lines of a red CI check's log (redacted by the server) a follow prints. */
const CI_TAIL_LINES = 20

function sessionUrl(ctx: CommandContext, appSlug: string, id: string): string {
  return `${ctx.config.serverUrl.replace(/\/+$/, '')}/apps/${appSlug}/sessions/${id}`
}

async function resolveApp(client: ApiClient, app: string) {
  return client.get(`/api/apps/${encodeURIComponent(app)}`, { schema: appDetailSchema })
}

async function getSession(client: ApiClient, id: string): Promise<Session> {
  return (await client.get(sessionPath(id), { schema: sessionDetailResponseSchema })).session
}

// ---- start / ls / end ----------------------------------------------------------------------

export interface SessionsStartOptions {
  title?: string
  base?: string
  /** §18.22: the coding agent (`AGENT_RUNTIMES`); omitted = the deployment's default. */
  runtime?: string
}

export async function runSessionsStart(
  ctx: CommandContext,
  app: string,
  options: SessionsStartOptions = {}
): Promise<void> {
  let runtime: AgentRuntimeId | undefined
  if (options.runtime) {
    const parsed = agentRuntimeSchema.safeParse(options.runtime)
    if (!parsed.success) {
      throw new CliError(`Unknown runtime "${options.runtime}"`, {
        hint: `Use one of: ${AGENT_RUNTIMES.join(', ')}`,
      })
    }
    runtime = parsed.data
  }
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('POST', `/api/apps/${detail.id}/sessions`, {
    schema: sessionDetailResponseSchema,
    body: {
      ...(options.title ? { title: options.title } : {}),
      ...(options.base ? { baseRef: options.base } : {}),
      ...(runtime ? { runtime } : {}),
    },
  })
  const { session } = data
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Started session ${chalk.bold(session.id)} on ${detail.slug} (${session.status})`,
      chalk.dim(`  ${sessionUrl(ctx, detail.slug, session.id)}`),
      chalk.dim(`  Next: ${ctx.binName} sessions say ${session.id} "…" --follow`),
    ].join('\n')
  )
}

export async function runSessionsList(
  ctx: CommandContext,
  app: string,
  options: { all?: boolean } = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('GET', `/api/apps/${detail.id}/sessions`, {
    schema: sessionListResponseSchema,
    query: { scope: options.all ? 'all' : 'active' },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Id', value: s => s.id },
      { header: 'Title', value: s => s.title },
      { header: 'Status', value: s => s.status },
      { header: 'Turns', value: s => s.turnCount },
      { header: 'Cost', value: s => usd(s.costMicrocents) },
      { header: 'PR', value: s => s.prUrl },
      { header: 'Active', value: s => formatDate(s.lastActivityAt ?? s.createdAt) },
    ])
  )
}

export async function runSessionsEnd(ctx: CommandContext, id: string): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('POST', `${sessionPath(id)}/end`, {
    schema: sessionDetailResponseSchema,
  })
  ctx.out.data(raw, () => {
    const branch = data.session.branch ? ` Changes stay on ${data.session.branch}.` : ''
    return `${chalk.green('✓')} Ending session ${id}.${branch}`
  })
}

export async function runSessionsPreviewUrl(
  ctx: CommandContext,
  id: string,
  options: { open?: boolean } = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request(
    'POST',
    `${sessionPath(id)}/preview-grant`,
    { schema: previewGrantResponseSchema }
  )
  if (options.open) await ctx.open(data.url)
  ctx.out.data(raw, () =>
    [
      data.url,
      chalk.dim('  Valid for one minute — open it once; the preview keeps you signed in.'),
    ].join('\n')
  )
}

// ---- following the event log ---------------------------------------------------------------

/** Every row after `afterSeq`, all pages. */
async function readEventsAfter(
  client: ApiClient,
  id: string,
  afterSeq: number
): Promise<{ items: SessionEvent[]; nextSeq: number }> {
  let cursor = afterSeq
  const items: SessionEvent[] = []
  for (let page = 0; page < 100; page++) {
    const batch = await client.get(`${sessionPath(id)}/events`, {
      schema: sessionEventsResponseSchema,
      query: { afterSeq: cursor },
    })
    if (batch.items.length === 0 || batch.nextSeq <= cursor) break
    items.push(...batch.items)
    cursor = batch.nextSeq
  }
  return { items, nextSeq: cursor }
}

/** One row as a human line, or null for rows a terminal reader does not need. Pure. */
export function formatSessionEvent(event: SessionEvent): string | null {
  const data = (event.data ?? {}) as Record<string, unknown>
  switch (event.type) {
    case 'user.message': {
      const parsed = sessionUserMessageDataSchema.safeParse(event.data)
      return parsed.success ? chalk.cyan(`> ${parsed.data.text}`) : null
    }
    case 'text':
      return typeof data.text === 'string' ? data.text : null
    case 'tool.start': {
      const input = (data.input ?? {}) as Record<string, unknown>
      const target =
        (typeof input.file_path === 'string' && input.file_path) ||
        (typeof input.command === 'string' && input.command.split('\n')[0]) ||
        (typeof input.pattern === 'string' && input.pattern) ||
        ''
      return chalk.dim(`  · ${String(data.name ?? 'tool')}${target ? ` ${target}` : ''}`)
    }
    case 'tool.end':
      return data.isError ? chalk.red(`  ✗ ${String(data.name ?? 'tool')} failed`) : null
    case 'turn.end': {
      const parsed = sessionTurnEndDataSchema.safeParse(event.data)
      if (!parsed.success) return chalk.green('✓ turn done')
      const parts = [
        parsed.data.durationMs !== undefined
          ? `${Math.round(parsed.data.durationMs / 1000)}s`
          : null,
        parsed.data.costMicrocents !== undefined ? usd(parsed.data.costMicrocents) : null,
      ].filter(Boolean)
      return chalk.green(
        `✓ turn ${parsed.data.turn} done${parts.length ? ` · ${parts.join(' · ')}` : ''}`
      )
    }
    case 'turn.failed': {
      const parsed = sessionTurnFailedDataSchema.safeParse(event.data)
      return chalk.red(`✗ turn failed: ${parsed.success ? parsed.data.message : 'unknown error'}`)
    }
    case 'turn.interrupted': {
      const parsed = sessionTurnInterruptedDataSchema.safeParse(event.data)
      return chalk.yellow(`! turn interrupted (${parsed.success ? parsed.data.reason : 'unknown'})`)
    }
    case 'budget.reached':
      return chalk.yellow('! budget reached — extend it in the web UI to keep going')
    case 'ship.gate': {
      const parsed = sessionShipGateDataSchema.safeParse(event.data)
      if (!parsed.success) return null
      // One row per step Launch ran (issue #1); a row without `step` is the whole gate (older).
      const what = parsed.data.step ? SHIP_GATE_STEP_LABELS[parsed.data.step].toLowerCase() : 'gate'
      return parsed.data.passed
        ? chalk.green(`✓ ${what} passed (attempt ${parsed.data.attempt})`)
        : chalk.yellow(`! ${what} failed (attempt ${parsed.data.attempt})`)
    }
    case 'ship.pr': {
      const parsed = sessionShipPrDataSchema.safeParse(event.data)
      return parsed.success
        ? chalk.green(`✓ opened PR #${parsed.data.number} ${parsed.data.url}`)
        : null
    }
    case 'ship.ci': {
      const parsed = sessionShipCiDataSchema.safeParse(event.data)
      if (!parsed.success) return null
      const ci = parsed.data
      if (ci.state === 'success') return chalk.green('✓ CI passed')
      if (ci.state === 'failure') {
        const check = ci.failedCheck
        const lines = [
          chalk.red(
            `✗ CI failed${check ? `: ${check.name}` : ''}${check?.url ? ` ${check.url}` : ''}`
          ),
        ]
        const tail = check?.logTail?.trim().split('\n').slice(-CI_TAIL_LINES)
        if (tail?.length) lines.push(...tail.map(line => chalk.dim(`    ${line}`)))
        return lines.join('\n')
      }
      return chalk.dim(
        `  … CI: ${ci.passed} passed${ci.failed ? `, ${ci.failed} failed` : ''}${ci.pending ? `, ${ci.pending} running` : ''}`
      )
    }
    case 'ship.review': {
      const parsed = sessionShipReviewDataSchema.safeParse(event.data)
      if (!parsed.success) return null
      const by = parsed.data.by ? ` by ${parsed.data.by}` : ''
      const note = parsed.data.note ? `: ${parsed.data.note}` : ''
      switch (parsed.data.status) {
        case 'requested':
          return chalk.cyan(`… waiting for a review in Launch (approval ${parsed.data.approvalId})`)
        case 'approved':
          return chalk.green(`✓ approved${by}${note}`)
        case 'rejected':
          return chalk.yellow(`! sent back${by}${note}`)
        case 'expired':
          return chalk.yellow('! the review request lapsed')
        case 'cancelled':
          return chalk.dim('  the review request was withdrawn')
      }
      return null
    }
    case 'ship.merged': {
      const parsed = sessionShipMergedDataSchema.safeParse(event.data)
      return parsed.success
        ? chalk.green(
            `✓ merged PR #${parsed.data.number}${parsed.data.by === 'github' ? ' on GitHub' : ''} (${parsed.data.sha.slice(0, 7)})`
          )
        : null
    }
    case 'ship.released': {
      const parsed = sessionShipReleasedDataSchema.safeParse(event.data)
      return parsed.success
        ? chalk.green(
            `✓ released ${versionLabel(parsed.data.version)}${parsed.data.shared ? ' (shared with another merge)' : ''}`
          )
        : null
    }
    case 'ship.staging': {
      const parsed = sessionShipStagingDataSchema.safeParse(event.data)
      if (!parsed.success) return null
      const { status, url, error } = parsed.data
      const version = versionLabel(parsed.data.version)
      switch (status) {
        case 'deploying':
          return chalk.dim(`  … deploying ${version} to staging`)
        case 'active':
          return chalk.dim(`  … ${version} is on staging; checking its health`)
        case 'live':
          return chalk.green(`✓ live on staging: ${url ?? 'staging'} (${version})`)
        default:
          return chalk.red(`✗ ${error ?? `${version} did not go live on staging (${status})`}`)
      }
    }
    case 'ship.reopened': {
      const parsed = sessionShipReopenedDataSchema.safeParse(event.data)
      return parsed.success
        ? chalk.yellow(`! not merged (${parsed.data.reason}): ${parsed.data.message}`)
        : null
    }
    case 'error':
      return chalk.red(`✗ ${typeof data.message === 'string' ? data.message : 'error'}`)
    case 'step':
      return data.status === 'running' && typeof data.label === 'string'
        ? chalk.dim(`  … ${data.label}`)
        : null
    default:
      return null
  }
}

/** Human lines as rows arrive; with `--json` the rows are collected and printed once at the end. */
function emit(ctx: CommandContext, seen: SessionEvent[], event: SessionEvent): void {
  seen.push(event)
  if (ctx.json) return
  const line = formatSessionEvent(event)
  if (line !== null) ctx.out.text(line)
}

const TURN_SETTLED = new Set(['turn.end', 'turn.failed', 'turn.interrupted', 'budget.reached'])

/** Statuses in which the session is not going to write more rows for this wait. */
const SETTLED_FOR_TURN: readonly SessionStatus[] = [
  'ready',
  'blocked',
  'suspended',
  'shipped',
  'ended',
  'failed',
]

export interface SessionsSayOptions extends SessionPollOptions {
  follow?: boolean
}

export async function runSessionsSay(
  ctx: CommandContext,
  id: string,
  message: string,
  options: SessionsSayOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const text = message.trim()
  if (!text) throw new CliError('The message is empty')

  // Where the log is now, so --follow prints only what this turn writes.
  const start = options.follow ? (await readEventsAfter(client, id, 0)).nextSeq : 0
  const { data, raw } = await client.request('POST', `${sessionPath(id)}/turns`, {
    schema: sessionDetailResponseSchema,
    body: { message: text },
  })
  if (!options.follow) {
    ctx.out.data(raw, () => `${chalk.green('✓')} Sent. The session is ${data.session.status}.`)
    return
  }

  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeoutMs ?? (data.session.policy.maxTurnMinutes + 5) * 60_000)
  let cursor = start
  let sawUserMessage = false
  const seen: SessionEvent[] = []
  const finish = async (failed: boolean) => {
    if (ctx.json) ctx.out.data({ session: await getSession(client, id), events: seen }, () => '')
    if (failed) throw new CliError('The turn failed')
  }
  while (now() < deadline) {
    const batch = await readEventsAfter(client, id, cursor)
    cursor = batch.nextSeq
    for (const event of batch.items) {
      emit(ctx, seen, event)
      if (event.type === 'user.message') sawUserMessage = true
      if (sawUserMessage && TURN_SETTLED.has(event.type))
        return finish(event.type === 'turn.failed')
    }
    if (batch.items.length === 0 && sawUserMessage) {
      // Nothing new: make sure the session is still going to write something.
      const session = await getSession(client, id)
      if (SETTLED_FOR_TURN.includes(session.status) && !session.pendingMessage) return finish(false)
    }
    await sleep(options.pollMs ?? 1000)
  }
  throw new CliError('Timed out waiting for the turn to finish', {
    hint: `It may still be running — \`${ctx.binName} sessions say\` again once it settles.`,
  })
}

// ---- ship ----------------------------------------------------------------------------------

export interface SessionsShipOptions extends SessionPollOptions {
  /**
   * Follow the ship to its end (the default). `false` is `--no-wait`: return once it has started.
   * `--wait` is still accepted and changes nothing.
   */
  wait?: boolean
}

/** Where a followed ship stands. */
export type ShipFollowState = 'moving' | 'live' | 'stalled' | 'reopened' | 'pr' | 'no_pr'

/**
 * Where a ship stands from the session row and whether a `ship.reopened` row was seen (issue #5):
 * still moving (the gate, then `ci → [approval] → merging` while `shipping`, then `releasing →
 * deploying` once `shipped`), live on staging, stalled after the merge, given back before it, an
 * open PR (`pr` mode, or a server from before issue #5 — no landing), or no PR at all. Pure.
 */
export function shipFollowState(
  session: Pick<Session, 'status' | 'requestedAction' | 'prNumber' | 'landing'>,
  sawReopen: boolean
): ShipFollowState {
  const stage = session.landing?.stage
  if (session.status === 'shipping') return 'moving'
  if (session.status === 'shipped') {
    if (!session.landing || stage === 'pr') return session.prNumber === null ? 'no_pr' : 'pr'
    if (stage === 'live') return 'live'
    if (stage === 'stalled') return 'stalled'
    return 'moving'
  }
  if (session.requestedAction === 'ship' && isActiveSessionStatus(session.status)) return 'moving'
  return sawReopen ? 'reopened' : 'no_pr'
}

export async function runSessionsShip(
  ctx: CommandContext,
  id: string,
  options: SessionsShipOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const wait = options.wait !== false
  const start = wait ? (await readEventsAfter(client, id, 0)).nextSeq : 0
  const { data, raw } = await client.request('POST', `${sessionPath(id)}/ship`, {
    schema: sessionDetailResponseSchema,
  })
  if (!wait) {
    ctx.out.data(
      raw,
      () =>
        `${chalk.green('✓')} Shipping. Follow it on the session's page, or with \`${ctx.binName} sessions ls <app>\`.`
    )
    return
  }

  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  // CI may take two hours (SHIP_CI_MAX_MINUTES), the staging follow most of one more.
  const deadline = now() + (options.timeoutMs ?? 4 * 60 * 60_000)
  const pollMs = options.pollMs ?? 1000
  let cursor = start
  let session = data.session
  const seen: SessionEvent[] = []
  let reopened: SessionShipReopenedData | null = null
  let state: ShipFollowState = 'moving'

  const readRows = async () => {
    const batch = await readEventsAfter(client, id, cursor)
    cursor = batch.nextSeq
    for (const event of batch.items) {
      emit(ctx, seen, event)
      if (event.type === 'ship.reopened') {
        const parsed = sessionShipReopenedDataSchema.safeParse(event.data)
        if (parsed.success) reopened = parsed.data
      }
    }
  }

  // 1. The gate, the PR and (issue #5) the landing: follow the rows until the ship settles.
  while (now() < deadline) {
    await readRows()
    session = await getSession(client, id)
    state = shipFollowState(session, reopened !== null)
    // The row can settle before its last rows are read: read once more before calling it.
    if (state !== 'moving') {
      await readRows()
      state = shipFollowState(session, reopened !== null)
      break
    }
    // Past the PR, the Workflow works in rounds of 30 s – 2 min.
    await sleep(session.landing ? Math.max(pollMs, 1000) * 10 : pollMs)
  }

  const finish = (extra: Record<string, unknown> = {}) => {
    if (ctx.json) ctx.out.data({ session, events: seen, ...extra }, () => '')
  }
  switch (state) {
    case 'moving':
      finish()
      throw new CliError(
        session.landing?.stage === 'approval'
          ? 'Still waiting for a review in Launch'
          : 'Timed out waiting for the ship to finish',
        { hint: 'The ship carries on without the CLI — see it on the session’s page.' }
      )
    case 'live': {
      finish()
      const sawLive = seen.some(
        event =>
          event.type === 'ship.staging' && (event.data as { status?: unknown })?.status === 'live'
      )
      if (!ctx.json && !sawLive) {
        const version = session.landing?.version
          ? ` (${versionLabel(session.landing.version)})`
          : ''
        ctx.out.text(
          chalk.green(`✓ live on staging: ${session.landing?.stagingUrl ?? 'staging'}${version}`)
        )
      }
      return
    }
    case 'stalled':
      finish()
      throw new CliError(
        session.landing?.error ?? 'Merged, but the change did not make it live on staging',
        { hint: 'Nothing is lost — release, retry or promote from the app’s page.' }
      )
    case 'reopened': {
      finish()
      const why = reopened as SessionShipReopenedData | null
      throw new CliError(`Not merged: ${why?.message ?? 'the ship was given back'}`, {
        hint: `The session is open again — fix it with \`${ctx.binName} sessions say ${id} "…"\`, then ship again.`,
      })
    }
    case 'no_pr':
      finish()
      // An End while the landing waited (CI, a review) abandons it with no reopen row: the PR
      // opened, and stays open on GitHub, but nothing merges.
      if (seen.some(event => event.type === 'ship.pr') && session.prNumber !== null) {
        throw new CliError(
          `Not merged: the session is ${session.status}, so PR #${session.prNumber} was left open`,
          { hint: session.prUrl ?? undefined }
        )
      }
      throw new CliError(
        `The ship did not open a pull request (session is ${session.status})`,
        session.error ? { hint: session.error } : {}
      )
    case 'pr':
      break
  }
  // `pr` mode (or a server from before issue #5): today's ending — the PR, then its CI.
  if (!ctx.json) ctx.out.text(`${chalk.green('✓')} PR #${session.prNumber} ${session.prUrl ?? ''}`)

  // 2. Its CI, until it settles.
  while (now() < deadline) {
    const pr = await client.get(`${sessionPath(id)}/pr`, { schema: sessionPrResponseSchema })
    const state = pr.checks?.state ?? 'pending'
    if (state !== 'pending') {
      if (ctx.json) ctx.out.data({ session, events: seen, pr }, () => '')
      else {
        for (const check of pr.checks?.checks ?? []) {
          const mark =
            check.state === 'success'
              ? chalk.green('✓')
              : check.state === 'failure'
                ? chalk.red('✗')
                : '·'
          ctx.out.text(`  ${mark} ${check.name}`)
        }
      }
      if (state === 'failure') throw new CliError(`CI failed on PR #${session.prNumber}`)
      if (!ctx.json)
        ctx.out.text(chalk.green(state === 'none' ? '✓ no CI checks reported' : '✓ CI passed'))
      return
    }
    await sleep(Math.max(options.pollMs ?? 1000, 1000) * 10)
  }
  throw new CliError('Timed out waiting for CI', { hint: session.prUrl ?? undefined })
}
