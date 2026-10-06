/**
 * Ship a session (Launch P3, plan §1.10; issue #1, docs/CONCEPTS.md §18.13) — the parts of the ship
 * that are not the gate: the pull request's title and body, the PR itself, and its CI.
 *
 * The ship is a sequence of Workflow steps (`workflows/session.ts`, bodies in `ship-steps.ts`):
 * `ship.claim` → `ship.save` → per attempt `ship.gate` (lint, typecheck) → `ship.db` → `ship.gate`
 * (tests, on a throwaway Neon branch) → `ship.db-clean` → on red `ship.fix` → … → green: `ship.commit`
 * → `ship.attest` (issue #9, `gate-attest.ts`) → `ship.summary` → `ship.pr`. LAUNCH runs the gate (`gate.ts`) and its exit codes alone decide;
 * a green gate makes no model call to decide anything. What this file adds:
 *
 * - **The summary** (`summarizeShip`, the `shipSummary` hook): ONE cheap model call, no tools,
 *   over the person's own messages and the branch's diff stat, answering `{ title, body }` as JSON
 *   (`parseShipSummary`). Through the AI conventions (`services/ai/CLAUDE.md`): `resolveChat` with
 *   the `session-ship-summary` prompt key (an `agent_models` assignment picks the model; without
 *   one an Anthropic provider uses {@link SHIP_SUMMARY_ANTHROPIC_MODEL}), else — no tenant or
 *   platform chat configured — the key sessions already spend (`resolveModelKey`) on the same small
 *   model. Its usage is an `ai_usage` row billed to the session (feature
 *   {@link SHIP_SUMMARY_FEATURE}) and added to its totals, like every other call it makes. Any
 *   failure — no model at all, a provider error, a reply that does not parse — falls back to
 *   `fallbackShipSummary` (the session's title or the first request, and the diff stat): a PR
 *   never waits on the summary.
 * - **The PR** (`openShipPullRequest`): head `session/<short>`, base the app's default branch, and
 *   ONE compare-and-set recording the row's `pr_number` / `pr_url`, `sessions.landing` and
 *   `sessions.ship_summary` (issue #5: the title and body as written, without Launch's footer, the
 *   summary's source and the diff stat — overwritten on a re-ship) — `shipping → shipped` (stage
 *   `pr`) in `pr` mode, still `shipping` with the landing in `ci` in `staging` mode (the
 *   Workflow's `land` rounds, `land.ts`, take it from there) — a `ship.pr` event (with the title),
 *   audit `session.shipped`, the config the PR declares (`deps.scanConfig` → `ship.config_needs`,
 *   never fatal), and a first `refreshChecks`. Idempotent: a session already `shipped` answers its
 *   PR, and a `staging` one already landing answers `landing`.
 *
 * `refreshChecks` is also what `GET /api/sessions/:id/pr` (at most every 30 s) and the `*\/5`
 * cron (`sessionsChecksTask`, while `pending`) call.
 */
import type { TokenUsage } from '@launch/shared/ai/chat'
import type { AiProvider } from '@launch/shared/ai/config'
import type { SessionShipMode } from '@launch/shared/launch-apps'
import {
  type LandingReviewMode,
  type PrChecks,
  requiredCheckState,
  type SessionEventInput,
  type SessionLanding,
  type SessionShipConfigNeedsData,
  type SessionShipSummary,
  type SessionStatus,
  SHIP_GATE_ATTEMPTS,
  SHIP_SUMMARY_BODY_MAX,
  SHIP_SUMMARY_DIFFSTAT_MAX,
  SHIP_SUMMARY_TITLE_MAX,
  sessionBranchName,
  sessionUserMessageDataSchema,
} from '@launch/shared/launch-sessions'
import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { apps, type SessionRow, sessionEvents, sessions, tenants, users } from '../../../db/schema'
import { NotFoundError } from '../../utils/core/errors'
import type { Logger } from '../../utils/core/logger'
import { createChatClient } from '../ai/client'
import { AiNotConfiguredError } from '../ai/errors'
import { resolveChat } from '../ai/resolve'
import type { AiEnv, ChatClient } from '../ai/types'
import type { ScanShipConfigInput } from '../grants/detect'
import { recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import { upgradePrOpened } from '../launch/upgrades'
import { resolvePrompt } from '../prompts'
import type { Realtime } from '../realtime'
import { recordSessionUsage } from './egress/anthropic'
import { nudgeSession } from './events'
import { shipGateCommands } from './gate'
import { redactModelKeyText, resolveModelKey } from './model-key'
import type { RepoHostPort, RepoRef } from './ports'

/** How many times the gate runs before the ship gives up (a fix turn between each red run). */
export const DEFAULT_SHIP_ATTEMPTS = SHIP_GATE_ATTEMPTS
/** `GET /:id/pr` refreshes checks older than this. */
export const PR_CHECKS_MAX_AGE_MS = 30_000
/** The summary's model when the provider is Anthropic and no agent model is assigned. */
export const SHIP_SUMMARY_ANTHROPIC_MODEL = 'claude-haiku-4-5'
/** The summary is a title and a short body: this is plenty, and caps what a bad reply costs. */
export const SHIP_SUMMARY_MAX_TOKENS = 1_000
/** `ai_usage.feature` of the summary call. */
export const SHIP_SUMMARY_FEATURE = 'session:ship-summary'
/** At most this many of the person's messages, each clipped, go into the summary call. */
export const SHIP_SUMMARY_MAX_REQUESTS = 20
const REQUEST_MAX_CHARS = 1_000
const DIFF_STAT_MAX_CHARS = 6_000

/** Appends events to the session's log — the Workflow's emitter (`events.ts`) in production. */
export type ShipEventEmitter = (events: SessionEventInput[]) => Promise<void>

// ---- the summary -------------------------------------------------------------------------------

/** What the PR says. */
export interface ShipSummary {
  title: string
  body: string
}

/** What the summary call is given. No secret: the person's words and file names. */
export interface ShipSummaryInput {
  appName: string
  userName: string
  /** The person's messages, oldest first (redacted, clipped). */
  requests: string[]
  /** `git diff --stat` of the branch against its base; '' when it could not be read. */
  diffStat: string
  /** The session's own title, if it has one — the fallback's first choice. */
  sessionTitle?: string | null
  shortId: string
}

export interface ShipSummaryResult extends ShipSummary {
  /** `model` — the call answered; `fallback` — it did not, or there was no model. */
  source: 'model' | 'fallback'
}

/**
 * `ship.summary#N`'s result (issue #5): the summary and the diff stat it was written from — both
 * stored on the session (`sessions.ship_summary`) by `ship.pr`.
 */
export interface ShipSummaryStepResult extends ShipSummaryResult {
  diffStat: string
}

/**
 * The `{ title, body }` object the summary prompt asks for: the LAST parseable JSON object in the
 * reply that has a string `title` (a fenced block, the last line, or the whole reply). Null when
 * there is none.
 */
export function parseShipSummary(text: string | null | undefined): ShipSummary | null {
  if (!text) return null
  const candidates: string[] = []
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (match[1]) candidates.push(match[1])
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.push(trimmed)
  }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))

  let found: ShipSummary | null = null
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim()) as Record<string, unknown>
      if (!value || typeof value !== 'object' || typeof value.title !== 'string') continue
      const title = value.title.replace(/\s+/g, ' ').trim()
      if (!title) continue
      found = {
        title: title.slice(0, 200),
        body: typeof value.body === 'string' ? value.body.slice(0, 20_000) : '',
      }
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return found
}

/** One line, at most `max` characters. */
const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** The PR's title and body when there is no model answer: never empty, never invented. */
export function fallbackShipSummary(input: ShipSummaryInput): ShipSummary {
  const title =
    (input.sessionTitle && oneLine(input.sessionTitle, 70)) ||
    (input.requests[0] && oneLine(input.requests[0], 70)) ||
    `Changes from Launch session ${input.shortId}`
  const lines = ['Changes made in a Launch coding session.']
  if (input.requests.length > 0) {
    lines.push('', 'What was asked for:', ...input.requests.map(r => `- ${oneLine(r, 200)}`))
  }
  if (input.diffStat.trim()) lines.push('', '```', input.diffStat.trim(), '```')
  return { title, body: lines.join('\n') }
}

/** The summary call's user message: the requests, then the diff stat. */
export function shipSummaryMessage(input: ShipSummaryInput): string {
  const requests = input.requests.length
    ? input.requests.map((r, i) => `${i + 1}. ${r}`).join('\n\n')
    : '(no messages)'
  return [
    `What ${input.userName} asked for, oldest first:\n\n${requests}`,
    `The branch's diff stat:\n\n${input.diffStat.trim() || '(not available)'}`,
  ].join('\n\n---\n\n')
}

/** The person's messages in the session, oldest first — redacted and clipped for the summary. */
export async function shipRequests(
  db: Database,
  session: Pick<SessionRow, 'id' | 'tenantId'>
): Promise<string[]> {
  const rows = await db
    .select({ data: sessionEvents.data })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, session.tenantId),
        eq(sessionEvents.sessionId, session.id),
        eq(sessionEvents.type, 'user.message')
      )
    )
    .orderBy(sessionEvents.seq)
  const texts = rows.flatMap(row => {
    const parsed = sessionUserMessageDataSchema.safeParse(row.data)
    const text = parsed.success ? parsed.data.text.trim() : ''
    return text ? [oneLine(redactModelKeyText(text), REQUEST_MAX_CHARS)] : []
  })
  // The first request says what the session is for; the latest ones what it became.
  if (texts.length <= SHIP_SUMMARY_MAX_REQUESTS) return texts
  return [texts[0] as string, ...texts.slice(-(SHIP_SUMMARY_MAX_REQUESTS - 1))]
}

/** A diff stat for the prompt: colour-free, clipped from the front (the totals line is last). */
export function clipDiffStat(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes in git's output
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '').trim()
  return clean.length > DIFF_STAT_MAX_CHARS ? `…${clean.slice(-DIFF_STAT_MAX_CHARS)}` : clean
}

export interface SummarizeShipOptions {
  logger?: Pick<Logger, 'warn'>
  /** Tests: the chat client instead of resolving one. */
  client?: { client: ChatClient; provider: AiProvider; model: string }
}

/** The client and model for the summary — see the header. Null when there is no model at all. */
async function summaryClient(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string
): Promise<{ client: ChatClient; provider: AiProvider; model: string } | null> {
  try {
    const resolved = await resolveChat(db, cfg, env, tenantId, {
      promptKey: 'session-ship-summary',
    })
    const model =
      resolved.source !== 'agent' && resolved.provider === 'anthropic'
        ? SHIP_SUMMARY_ANTHROPIC_MODEL
        : resolved.model
    return { client: resolved.client, provider: resolved.provider, model }
  } catch (err) {
    if (!(err instanceof AiNotConfiguredError)) throw err
  }
  const key = await resolveModelKey(db, cfg)
  if (!key) return null
  return {
    client: createChatClient({ provider: 'anthropic', apiKey: key.apiKey }),
    provider: 'anthropic',
    model: SHIP_SUMMARY_ANTHROPIC_MODEL,
  }
}

/**
 * The PR's title and body from ONE model call (see the header), or the fallback. Never throws for
 * the model; its usage is billed to the session.
 */
export async function summarizeShip(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  session: Pick<SessionRow, 'id' | 'tenantId' | 'createdByUserId'>,
  input: ShipSummaryInput,
  opts: SummarizeShipOptions = {}
): Promise<ShipSummaryResult> {
  const fallback = (): ShipSummaryResult => ({ ...fallbackShipSummary(input), source: 'fallback' })
  try {
    const target = opts.client ?? (await summaryClient(db, cfg, env, session.tenantId))
    if (!target) return fallback()
    const system = await resolvePrompt(db, session.tenantId, 'session-ship-summary', {
      appName: input.appName,
      userName: input.userName,
    })
    const result = await target.client.complete({
      model: target.model,
      system,
      messages: [{ role: 'user', content: shipSummaryMessage(input) }],
      maxTokens: SHIP_SUMMARY_MAX_TOKENS,
    })
    await billSummary(db, session, target, result.model || target.model, result.usage).catch(err =>
      opts.logger?.warn({ err }, 'ship summary: usage write failed')
    )
    const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    const parsed = parseShipSummary(text)
    if (!parsed) {
      opts.logger?.warn({ sessionId: session.id }, 'ship summary: the reply did not parse')
      return fallback()
    }
    return {
      title: oneLine(redactModelKeyText(parsed.title), 200),
      body: redactModelKeyText(parsed.body).trim() || fallbackShipSummary(input).body,
      source: 'model',
    }
  } catch (err) {
    opts.logger?.warn({ err }, 'ship summary: the model call failed; using the fallback')
    return fallback()
  }
}

async function billSummary(
  db: Database,
  session: Pick<SessionRow, 'id' | 'tenantId' | 'createdByUserId'>,
  target: { provider: AiProvider },
  model: string,
  usage: TokenUsage
): Promise<void> {
  await recordSessionUsage(db, session, model, usage, {
    provider: target.provider,
    feature: SHIP_SUMMARY_FEATURE,
  })
}

// ---- helpers -----------------------------------------------------------------------------------

async function loadSession(db: Database, tenantId: string, sessionId: string): Promise<SessionRow> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId)))
    .limit(1)
  if (!row) throw new NotFoundError('Session not found', 'session_not_found')
  return row
}

/** Compare-and-set the status; the updated row, or null when it was not in `from`. */
async function transition(
  db: Database,
  session: Pick<SessionRow, 'id' | 'tenantId'>,
  from: readonly SessionStatus[],
  set: Partial<typeof sessions.$inferInsert>
): Promise<SessionRow | null> {
  const [row] = await db
    .update(sessions)
    .set(set)
    .where(
      and(
        eq(sessions.tenantId, session.tenantId),
        eq(sessions.id, session.id),
        inArray(sessions.status, [...from])
      )
    )
    .returning()
  return row ?? null
}

/** The app's repo as the repo port takes it, tenant-first. */
export async function sessionRepo(
  db: Database,
  session: Pick<SessionRow, 'tenantId' | 'appId'>
): Promise<RepoRef & { defaultBranch: string; displayName: string }> {
  const [app] = await db
    .select({
      repoOwner: apps.repoOwner,
      repoName: apps.repoName,
      defaultBranch: apps.defaultBranch,
      displayName: apps.displayName,
    })
    .from(apps)
    .where(and(eq(apps.tenantId, session.tenantId), eq(apps.id, session.appId)))
    .limit(1)
  if (!app?.repoOwner || !app.repoName) {
    throw new NotFoundError('The session’s app has no repository', 'app_repo_missing')
  }
  return {
    owner: app.repoOwner,
    repo: app.repoName,
    defaultBranch: app.defaultBranch ?? 'main',
    displayName: app.displayName,
  }
}

// ---- checks ------------------------------------------------------------------------------------

/** Whether `next` says something `prev` did not (the panel's `ship.ci` row is per change). */
export function prChecksChanged(prev: PrChecks | null, next: PrChecks): boolean {
  if (!prev || prev.headSha !== next.headSha) return true
  return (
    prev.state !== next.state ||
    // Issue #9: `Gate` reporting can leave the fold's counts as they were (`launch/gate` beside it).
    requiredCheckState(prev.checks) !== requiredCheckState(next.checks) ||
    prev.passed !== next.passed ||
    prev.failed !== next.failed ||
    prev.pending !== next.pending ||
    // Issue #22: GitHub starting a queued run is news ("waiting for GitHub" → "running").
    (prev.queued ?? 0) !== (next.queued ?? 0)
  )
}

/**
 * The PR's CI, refreshed from the repo host when the stored verdict is older than `maxAgeMs`
 * (0 forces it) and written back to `pr_checks`. Null when the session has no PR. A reading that
 * changed the verdict nudges the session (`realtime`), so every open PR panel refreshes — not only
 * the reader whose GET (or the cron) took it.
 */
export async function refreshChecks(
  db: Database,
  repoHost: RepoHostPort,
  session: SessionRow,
  opts: { maxAgeMs?: number; now?: Date; realtime?: Realtime } = {}
): Promise<PrChecks | null> {
  if (!session.prNumber) return null
  const now = opts.now ?? new Date()
  const stored = session.prChecks
  if (
    stored &&
    opts.maxAgeMs !== undefined &&
    now.getTime() - new Date(stored.checkedAt).getTime() < opts.maxAgeMs
  ) {
    return stored
  }
  const repo = await sessionRepo(db, session)
  const checks = await repoHost.getChecks(repo, {
    prNumber: session.prNumber,
    headSha: session.headSha ?? session.branch ?? sessionBranchName(session.shortId),
  })
  await db
    .update(sessions)
    .set({ prChecks: checks })
    .where(and(eq(sessions.tenantId, session.tenantId), eq(sessions.id, session.id)))
  if (prChecksChanged(stored ?? null, checks)) nudgeSession(opts.realtime, session)
  return checks
}

// ---- the pull request --------------------------------------------------------------------------

export interface OpenShipPullRequestDeps {
  repoHost: RepoHostPort
  emit: ShipEventEmitter
  now?: () => Date
  /** The PR head's declared config needs (`scanShipConfig`); absent = no `ship.config_needs`. */
  scanConfig?: (input: ScanShipConfigInput) => Promise<SessionShipConfigNeedsData>
}

export type ShipPrOutcome =
  | { status: 'shipped'; prNumber: number; prUrl: string; checks: PrChecks | null }
  /** Issue #5 `staging` mode: the PR is open and the session stays `shipping`, landing in `ci`. */
  | { status: 'landing'; prNumber: number; prUrl: string; checks: PrChecks | null }
  | { status: 'skipped'; reason: string }

/**
 * Issue #5: where this ship ends (`ship.pr` snapshots it onto `sessions.landing`). Absent = `pr`
 * mode, the flow before issue #5.
 */
export interface ShipLandingInput {
  mode: SessionShipMode
  reviewMode: LandingReviewMode
}

const clipText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** `` / ` after one fix turn` / ` after 2 fix turns`. */
const fixed = (n: number) => (n > 0 ? ` after ${n} fix turn${n === 1 ? '' : 's'}` : '')

/** The PR body: the summary, then Launch's own line about the session and the gate. */
export function shipPrBody(
  summaryBody: string,
  session: Pick<SessionRow, 'shortId'>,
  opts: { creatorName?: string | null; fixTurns: number; gate?: readonly string[] }
): string {
  const gate = (opts.gate ?? shipGateCommands().map(g => g.command))
    .map(command => `\`${command}\``)
    .join(', ')
  return [
    summaryBody.trim() || 'Changes made in a Launch coding session.',
    '',
    '---',
    `Opened by Launch from coding session \`${session.shortId}\`${opts.creatorName ? ` for ${opts.creatorName}` : ''}. Launch ran the gate itself — ${gate}, the tests on a throwaway database branch — and it passed${fixed(opts.fixTurns)}.`,
  ].join('\n')
}

/**
 * The green half of a ship, after the gate and the final checkpoint: open (or find) the PR, and —
 * in `pr` mode — `shipping → shipped`, stage `pr`; in `staging` mode (issue #5) the session stays
 * `shipping` with its landing in `ci` (the Workflow's `land` rounds take it from there). Either
 * way the same compare-and-set records the PR, the landing and the ship summary
 * (`sessions.ship_summary`, overwritten on a re-ship). See the header.
 */
export async function openShipPullRequest(
  db: Database,
  deps: OpenShipPullRequestDeps,
  ref: { tenantId: string; sessionId: string },
  /**
   * `gate`: the commands the green attempt ran (default: the `pnpm gate` steps); `source` and
   * `diffStat`: what `ship.summary` wrote it from; `landing`: issue #5's mode (default `pr`).
   */
  input: ShipSummary & {
    fixTurns: number
    gate?: readonly string[]
    source?: ShipSummaryResult['source']
    diffStat?: string
    landing?: ShipLandingInput
    /** Issue #9: the tree the gate ran on (= `head_sha`'s, asserted at `ship.commit`). */
    gateTree?: string
  }
): Promise<ShipPrOutcome> {
  const now = deps.now ?? (() => new Date())
  const session = await loadSession(db, ref.tenantId, ref.sessionId)
  if (session.status === 'shipped' && session.prNumber && session.prUrl) {
    return {
      status: 'shipped',
      prNumber: session.prNumber,
      prUrl: session.prUrl,
      checks: session.prChecks ?? null,
    }
  }
  if (session.status !== 'shipping') {
    return { status: 'skipped', reason: `session is ${session.status}` }
  }
  // A retried `ship.pr` of a `staging` ship: the PR is open and the landing under way already.
  if (session.landing && session.prNumber && session.prUrl) {
    return {
      status: 'landing',
      prNumber: session.prNumber,
      prUrl: session.prUrl,
      checks: session.prChecks ?? null,
    }
  }
  const repo = await sessionRepo(db, session)
  const [creator] = session.createdByUserId
    ? await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, session.createdByUserId))
        .limit(1)
    : []
  const branch = session.branch ?? sessionBranchName(session.shortId)
  const pr = await deps.repoHost.openPullRequest(repo, {
    head: branch,
    base: repo.defaultBranch,
    title: input.title,
    body: shipPrBody(input.body, session, {
      creatorName: creator?.name ?? null,
      fixTurns: input.fixTurns,
      ...(input.gate ? { gate: input.gate } : {}),
    }),
  })
  const at = now()
  const mode = input.landing?.mode ?? 'pr'
  const gateSha = session.headSha ?? ''
  const landing: SessionLanding = {
    mode,
    stage: mode === 'staging' ? 'ci' : 'pr',
    prNumber: pr.number,
    gateSha,
    gateTree: input.gateTree ?? null,
    startedAt: at.toISOString(),
    stageAt: at.toISOString(),
    reviewMode: input.landing?.reviewMode ?? 'none',
    approvalId: null,
    mergeSha: null,
    mergedAt: null,
    mainCi: null,
    releaseId: null,
    version: null,
    tag: null,
    stagingUrl: null,
    containerReleased: false,
    stalledReason: null,
    error: null,
  }
  const shipSummary: SessionShipSummary = {
    title: clipText(input.title, SHIP_SUMMARY_TITLE_MAX),
    body: clipText(input.body.trim(), SHIP_SUMMARY_BODY_MAX),
    source: input.source ?? 'fallback',
    diffStat: clipText(input.diffStat ?? '', SHIP_SUMMARY_DIFFSTAT_MAX),
    prNumber: pr.number,
    gateSha: session.headSha ?? null,
    gateTree: input.gateTree ?? null,
    at: at.toISOString(),
  }
  const shipped = await transition(db, session, ['shipping'], {
    status: mode === 'staging' ? 'shipping' : 'shipped',
    prNumber: pr.number,
    prUrl: pr.url,
    landing,
    shipSummary,
    lastActivityAt: at,
  })
  if (!shipped) {
    return { status: 'skipped', reason: 'the session left shipping while its PR opened' }
  }
  const turn = shipped.turnCount
  await deps.emit([
    { type: 'ship.pr', turn, data: { number: pr.number, url: pr.url, title: shipSummary.title } },
  ])
  await recordAudit(db, {
    ...SYSTEM_ACTOR,
    tenantId: session.tenantId,
    action: 'session.shipped',
    targetType: 'session',
    targetId: session.id,
    appId: session.appId,
    summary: {
      after: {
        prNumber: pr.number,
        prUrl: pr.url,
        branch,
        headSha: shipped.headSha,
        title: input.title,
        fixTurns: input.fixTurns,
        mode,
      },
    },
  })

  // P6 6c: a kit upgrade's PR is the upgrade's (`pr_open`).
  await upgradePrOpened(db, shipped, { number: pr.number, url: pr.url })

  // The shared config the PR's plugins need and the app does not hold (never fails the ship).
  if (deps.scanConfig) {
    try {
      const needs = await deps.scanConfig({
        tenantId: session.tenantId,
        appId: session.appId,
        sha: shipped.headSha ?? branch,
      })
      if (needs.needs.length > 0) {
        await deps.emit([{ type: 'ship.config_needs', turn, data: needs }])
      }
    } catch {
      // The PR is open; the config page's own scan (at the Release) will say it.
    }
  }

  // The PR's first CI reading (a failure here is not a failed ship: the cron reads it again).
  let checks: PrChecks | null = null
  try {
    checks = await refreshChecks(db, deps.repoHost, shipped, { now: now() })
  } catch {
    checks = null
  }
  return {
    status: mode === 'staging' ? 'landing' : 'shipped',
    prNumber: pr.number,
    prUrl: pr.url,
    checks,
  }
}

// ---- the cron ----------------------------------------------------------------------------------

/** Shipped sessions whose checks are still worth reading: pending (or never read), started < 7 days ago. */
const CHECKS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/**
 * How long after the ship a `none` verdict is read again. The first reading is taken the moment
 * the PR opens, before GitHub has queued the repo's workflows — so `none` then usually means "not
 * yet", not "this repo has no CI". After this, `none` is believed and the cron stops asking.
 */
export const CHECKS_NONE_GRACE_MS = 60 * 60 * 1000

/**
 * The `sessions.checks` cron body: every shipped session's PR whose CI is pending (or unread, or
 * `none` within `CHECKS_NONE_GRACE_MS` of the ship — CI not registered yet), refreshed. One tenant at a time, tenant-first, like `runPruneAiSpans`.
 */
export async function runSessionChecks(
  db: Database,
  repoHostFor: (db: Database) => RepoHostPort,
  opts: { now?: Date; limitPerTenant?: number; realtime?: Realtime } = {}
): Promise<{ refreshed: number; failed: number }> {
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - CHECKS_WINDOW_MS)
  const noneSince = new Date(now.getTime() - CHECKS_NONE_GRACE_MS)
  const tenantIds = await db.select({ tenantId: tenants.id }).from(tenants)
  let refreshed = 0
  let failed = 0
  const host = repoHostFor(db)
  for (const { tenantId } of tenantIds) {
    const rows = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tenantId, tenantId),
          eq(sessions.status, 'shipped'),
          isNotNull(sessions.prNumber),
          sql`(${sessions.prChecks} IS NULL OR ${sessions.prChecks}->>'state' = 'pending' OR (${sessions.prChecks}->>'state' = 'none' AND coalesce(${sessions.endedAt}, ${now.toISOString()}::timestamptz) > ${noneSince.toISOString()}::timestamptz))`,
          gt(sessions.createdAt, since)
        )
      )
      .limit(opts.limitPerTenant ?? 50)
    for (const row of rows) {
      try {
        await refreshChecks(db, host, row, { now, realtime: opts.realtime })
        refreshed++
      } catch {
        failed++
      }
    }
  }
  return { refreshed, failed }
}
