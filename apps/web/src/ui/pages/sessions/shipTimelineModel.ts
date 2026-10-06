/**
 * The ship as one plain-language timeline (issue #22) — pure, over the rows and the row the page
 * already holds, worded by `@launch/shared/launch-ship-progress` (the CLI and the app page's lists
 * say the same). Nothing here is new state: the gate is the current ship's `ship.gate` rows
 * (`shipGates`, `shipGateRunning`), the rest is `landingTimeline` (`sessions.landing` + the
 * `ship.*` rows after the PR), the PR's live checks and the review request when the caller has them.
 *
 * One ordered walk — check → PR → automatic checks → review (only when one is required) → merge →
 * release → live on staging → ready to promote — each stage done, now, next, needs you or failed,
 * with exactly one "current" stage (now or needs you) while the ship moves. Earlier gate tries
 * collapse to one line each; everything an engineer wants (commands, check names, the Neon branch,
 * each try's steps and output) is the panel's Details, not this.
 *
 * `needsYou` is the one thing a person must do, with the one action that does it: give the review,
 * ask Claude to fix what the checks found, move a stall on, or open the app page to release by hand.
 */

import {
  isShipGateRunning,
  type LandingReviewMode,
  landingRetryable,
  type PrChecks,
  type Session,
  type SessionEvent,
  type SessionShipCiData,
  type SessionShipStagingData,
  SHIP_GATE_ATTEMPTS,
  type ShipGateStep,
  sessionShipCiDataSchema,
  sessionShipGateDataSchema,
  sessionShipReviewDataSchema,
  sessionShipStagingDataSchema,
} from '@launch/shared/launch-sessions'
import {
  checksCountText,
  earlierTryText,
  gateFixingText,
  gateProblemText,
  gateStepNowText,
  gateTryText,
  MAIN_CHECKS_LIMIT_TEXT,
  mainChecksVerdictText,
  reviewReasonText,
  SHIP_STAGE_NEXT_TEXT,
  type ShipProgressStage,
  type ShipProgressState,
  type ShipStageFacts,
  shipStageText,
  typicalDurationText,
} from '@launch/shared/launch-ship-progress'
import {
  type FailedCheck,
  type LandingStepKey,
  type LandingStepStatus,
  type LandingView,
  landingTimeline,
  type OpenTurn,
  openTurn,
  type ShipGate,
  type ShipGateRunning,
  shipGateAttempts,
  shipGateRunning,
  shipGates,
} from './sessionChatModel'

export interface ShipTimelineStage {
  key: ShipProgressStage
  state: ShipProgressState
  /** The stage's one sentence. */
  text: string
  /** A second line in plain words: what runs, the checks counted, who reviews and why, a limit. */
  detail?: string
  /** The check stage: each earlier try, one line ("First try: tests failed, fixed automatically"). */
  history?: string[]
  /** The current stage: what its clock counts from (a durable row's time). */
  since?: Date
  /** "The tests usually take about 6 minutes" — only when this session has timed it before. */
  typical?: string
  link?: { href: string; label: string }
  /** A red gate step that Claude is fixing: now, worded as a problem being dealt with. */
  fixing?: boolean
}

/** The one thing a person must do, and the one action that does it. */
export type ShipNeedsYouAction =
  | { kind: 'review'; approvalId: string | null }
  | { kind: 'fix_gate'; step: ShipGateStep | undefined; output: string | null }
  | { kind: 'fix_ci'; check: FailedCheck }
  | { kind: 'retry_stall' }
  | { kind: 'app_page' }
  | { kind: 'ship_again' }

export interface ShipNeedsYou {
  text: string
  note: string | null
  action: ShipNeedsYouAction
}

/**
 * `moving` (Launch or GitHub is on it), `live` (on staging), `pr` (left as a pull request),
 * `handed_back` (given back before the merge: the session is open again), `stalled` (merged, not
 * live). A review the reader may give is `moving` with `needsYou` set.
 */
export type ShipTimelineOutcome = 'moving' | 'live' | 'pr' | 'handed_back' | 'stalled'

export interface ShipTimelineView {
  stages: ShipTimelineStage[]
  /** The stage that is now, or needs you; null once the ship settled. */
  current: ShipTimelineStage | null
  outcome: ShipTimelineOutcome
  headline: string
  needsYou: ShipNeedsYou | null
  /** For Details: the current ship's gate steps, its running step, and the landing walk. */
  gates: ShipGate[]
  running: ShipGateRunning | null
  landing: LandingView | null
  /** The fix turn under way (a red gate step being fixed), for its first-reply line. */
  fixTurn: OpenTurn | null
}

export interface ShipTimelineInput {
  events: readonly SessionEvent[]
  session: Pick<
    Session,
    'status' | 'landing' | 'prNumber' | 'prUrl' | 'requestedAction' | 'error' | 'shipping'
  >
  /** "Claude" / "Codex" — who fixes a red step. */
  agent: string
  /**
   * What the app will do once the PR is open, before the landing snapshots it: its ship mode and
   * who reviews (`policy` when an organisation policy forces it). Null: not known (no review shown).
   */
  plan?: { mode: 'staging' | 'pr'; review: LandingReviewMode } | null
  /** The PR's live checks (`GET /:id/pr`), while they are the stage — they know about queued runs. */
  checks?: PrChecks | null
  /** The open review: who it waits on, and whether THIS reader may give it. */
  review?: { waitingOn: string | null; canDecide: boolean } | null
  /** For "Ready to promote": the app's page. */
  appPath?: string
}

/**
 * The current ship's rows: a ship starts again after a `ship.reopened`, when the attempt number
 * goes back down, or when a step's start row repeats within an attempt — a ship the gate gave up
 * on, then shipped again, starts back at attempt 1. Pure.
 */
export function currentShipEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  let start = 0
  let lastAttempt = 0
  let boundary = false
  let seen = new Set<string>()
  for (const [index, event] of ordered.entries()) {
    if (event.type === 'ship.pr' || event.type === 'ship.reopened') {
      boundary = event.type === 'ship.reopened'
      continue
    }
    if (event.type !== 'ship.gate') continue
    const parsed = sessionShipGateDataSchema.safeParse(event.data)
    if (!parsed.success) continue
    const data = parsed.data
    // A step's start is written once per (attempt, step, phase) — a second one is a new ship. A
    // verdict seen twice is a retried write, never a new ship.
    const key = isShipGateRunning(data) ? `${data.attempt}:${data.step}:${data.phase ?? ''}` : null
    if (boundary || data.attempt < lastAttempt || (key !== null && seen.has(key))) {
      start = index
      seen = new Set()
    }
    boundary = false
    lastAttempt = data.attempt
    if (key !== null) seen.add(key)
  }
  return ordered.slice(start)
}

/** Earlier gate durations of `step` in this session (every ship), for "usually takes". Pure. */
function samplesFor(events: readonly SessionEvent[], step: ShipGateStep): number[] {
  return shipGates(events)
    .filter(g => g.step === step && g.passed && g.durationMs !== undefined)
    .map(g => g.durationMs as number)
}

/** The current ship's earlier tries, one line each, oldest first. Pure. */
function historyLines(gates: readonly ShipGate[], currentAttempt: number | null): string[] {
  const attempts = shipGateAttempts(gates)
  return attempts
    .filter(a => !a.passed && a.attempt !== currentAttempt)
    .map(a => {
      const red = a.steps.find(s => !s.passed)
      const later = attempts.filter(b => b.attempt > a.attempt)
      const fixed = later.some(b =>
        b.steps.some(s => s.passed && (s.step === red?.step || (s.step ?? 'test') === 'test'))
      )
      return earlierTryText(a.attempt, red?.step, fixed)
    })
}

const LANDING_STAGE: Record<LandingStepKey, ShipProgressStage> = {
  gate: 'check',
  pr: 'pr',
  ci: 'checks',
  approval: 'review',
  merged: 'merge',
  released: 'release',
  staging: 'staging',
}

/** The latest `ship.ci` / `ship.staging` / review rows of the current landing (after its PR). */
function landingRows(events: readonly SessionEvent[]) {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  let prIndex = -1
  for (const [index, event] of ordered.entries()) if (event.type === 'ship.pr') prIndex = index
  let ci: SessionShipCiData | null = null
  let staging: SessionShipStagingData | null = null
  let reviewer: string | null = null
  let reviewOutcome: ShipStageFacts['reviewOutcome'] = null
  for (const event of prIndex >= 0 ? ordered.slice(prIndex + 1) : []) {
    if (event.type === 'ship.ci') {
      const parsed = sessionShipCiDataSchema.safeParse(event.data)
      if (parsed.success) ci = parsed.data
    } else if (event.type === 'ship.staging') {
      const parsed = sessionShipStagingDataSchema.safeParse(event.data)
      if (parsed.success) staging = parsed.data
    } else if (event.type === 'ship.review') {
      const parsed = sessionShipReviewDataSchema.safeParse(event.data)
      if (!parsed.success) continue
      reviewer = parsed.data.by ?? reviewer
      const status = parsed.data.status
      reviewOutcome =
        status === 'rejected' || status === 'expired' || status === 'cancelled' ? status : null
    }
  }
  return { ci, staging, reviewer, reviewOutcome }
}

const STATE_OF: Record<LandingStepStatus, ShipProgressState> = {
  done: 'done',
  active: 'now',
  pending: 'next',
  failed: 'failed',
}

/** The stages a ship walks, for its mode and whether it is reviewed. */
function stageKeys(mode: 'staging' | 'pr', reviewed: boolean): ShipProgressStage[] {
  if (mode === 'pr') return ['check', 'pr', 'checks']
  return [
    'check',
    'pr',
    'checks',
    ...(reviewed ? (['review'] as const) : []),
    'merge',
    'release',
    'staging',
    'promote',
  ]
}

const HEADLINE: Record<ShipTimelineOutcome, string> = {
  moving: 'Shipping your change',
  live: 'Live on staging',
  pr: 'Pull request open',
  handed_back: 'Not shipped yet',
  stalled: 'Merged, not live yet',
}

/**
 * The timeline, or null when there is no ship to show (none yet, or an old one from before the
 * session's latest turns with nothing of it on the row). Pure.
 */
export function shipTimeline(input: ShipTimelineInput): ShipTimelineView | null {
  const { session } = input
  const events = currentShipEvents(input.events)
  const view = landingTimeline(input.events, session.landing, session.status)
  const gates = shipGates(events)
  const shippingNow = session.status === 'shipping' || session.requestedAction === 'ship'
  const running = shippingNow && !view ? shipGateRunning(events) : null
  const turn = openTurn(input.events)
  const last = gates.at(-1)
  const fixTurn = shippingNow && turn && last && !last.passed && turn.at >= last.at ? turn : null

  if (view) return fromLanding(input, view, gates)

  const prOpen = session.prNumber !== null && events.some(e => e.type === 'ship.pr')
  if (!shippingNow && gates.length === 0 && !prOpen) return null

  const mode = input.plan?.mode ?? 'staging'
  const reviewed = Boolean(input.plan && input.plan.review !== 'none')
  const keys = stageKeys(prOpen ? 'pr' : mode, reviewed)
  const stages = new Map<ShipProgressStage, ShipTimelineStage>(
    keys.map(key => [key, { key, state: 'next', text: SHIP_STAGE_NEXT_TEXT[key] }])
  )
  const set = (key: ShipProgressStage, stage: Omit<ShipTimelineStage, 'key'>) => {
    if (stages.has(key)) stages.set(key, { key, ...stage })
  }
  if (reviewed && input.plan) {
    const reason = reviewReasonText(input.plan.review)
    const review = stages.get('review')
    if (review && reason) review.detail = reason
  }

  let outcome: ShipTimelineOutcome = 'moving'
  let needsYou: ShipNeedsYou | null = null
  const lastGreen = last?.passed === true && (last.step ?? 'test') === 'test'

  if (prOpen) {
    // A PR from before issue #5's landing (or one an End left open): the PR and its checks.
    outcome = 'pr'
    const history = historyLines(gates, null)
    set('check', {
      state: 'done',
      text: shipStageText('check', 'done'),
      ...(history.length ? { history } : {}),
    })
    set('pr', prStage(session))
    const checks = input.checks
    if (checks && checks.state !== 'pending') {
      set('checks', {
        state: checks.state === 'failure' ? 'failed' : 'done',
        text:
          checks.state === 'failure'
            ? shipStageText('checks', 'failed')
            : checks.state === 'none'
              ? 'No automatic checks reported'
              : shipStageText('checks', 'done'),
        detail: checksCountText(checks),
      })
    } else {
      set('checks', {
        state: 'now',
        text: shipStageText('checks', 'now'),
        detail: checks ? checksCountText(checks) : 'Waiting for the checks to report',
      })
    }
  } else if (shippingNow) {
    const history = historyLines(gates, running?.attempt ?? last?.attempt ?? null)
    if (running) {
      const typical =
        running.phase === 'database'
          ? null
          : typicalDurationText(running.step, samplesFor(input.events, running.step))
      set('check', {
        state: 'now',
        text: shipStageText('check', 'now'),
        detail:
          running.attempt > 1
            ? `${gateStepNowText(running.step, running.phase)} (${gateTryText(running.attempt)})`
            : gateStepNowText(running.step, running.phase),
        since: running.at,
        ...(typical ? { typical } : {}),
        ...(history.length ? { history } : {}),
      })
    } else if (last && !last.passed) {
      const next = last.attempt + 1
      set('check', {
        state: 'now',
        text:
          next <= SHIP_GATE_ATTEMPTS
            ? gateFixingText(last.step, input.agent, next)
            : `${gateProblemText(last.step)}.`,
        fixing: next <= SHIP_GATE_ATTEMPTS,
        since: fixTurn?.at ?? last.at,
        ...(history.length ? { history } : {}),
      })
    } else if (lastGreen) {
      set('check', {
        state: 'done',
        text: shipStageText('check', 'done'),
        ...(history.length ? { history } : {}),
      })
      set('pr', { state: 'now', text: shipStageText('pr', 'now'), since: last.at })
    } else {
      set('check', {
        state: 'now',
        text: shipStageText('check', 'now'),
        detail: last ? 'Moving on to the next check' : 'Getting ready to check your change',
        ...(last ? { since: last.at } : {}),
        ...(history.length ? { history } : {}),
      })
    }
  } else {
    // The ship ended before a pull request: the gate gave up, or something else stopped it.
    outcome = 'handed_back'
    const history = historyLines(gates, last?.attempt ?? null)
    if (last && !last.passed) {
      const text = shipStageText('check', 'needs_you', { attempts: last.attempt })
      set('check', {
        state: 'needs_you',
        text,
        detail: `${gateProblemText(last.step)}.`,
        ...(history.length ? { history } : {}),
      })
      needsYou = {
        text: `${gateProblemText(last.step)}${last.attempt > 1 ? ` after ${last.attempt} tries` : ''}, and ${input.agent} couldn’t fix it on its own.`,
        note: null,
        action: { kind: 'fix_gate', step: last.step, output: last.output ?? null },
      }
    } else {
      set('check', {
        state: 'done',
        text: shipStageText('check', 'done'),
        ...(history.length ? { history } : {}),
      })
      set('pr', { state: 'failed', text: shipStageText('pr', 'failed') })
      needsYou = {
        text: session.error ?? 'The ship stopped before it opened a pull request.',
        note: null,
        action: { kind: 'ship_again' },
      }
    }
  }

  const list = keys.map(key => stages.get(key) as ShipTimelineStage)
  const current = list.find(s => s.state === 'now' || s.state === 'needs_you') ?? null
  return {
    stages: list,
    current: outcome === 'moving' ? current : (list.find(s => s.state === 'needs_you') ?? null),
    outcome,
    headline: HEADLINE[outcome],
    needsYou,
    gates,
    running,
    landing: null,
    fixTurn,
  }
}

function prStage(session: Pick<Session, 'prNumber' | 'prUrl'>): Omit<ShipTimelineStage, 'key'> {
  return {
    state: 'done',
    text: shipStageText('pr', 'done', { prNumber: session.prNumber }),
    ...(session.prUrl ? { link: { href: session.prUrl, label: 'Open on GitHub' } } : {}),
  }
}

/** After the PR: `landingTimeline`'s walk, in the shared words. Pure. */
function fromLanding(
  input: ShipTimelineInput,
  view: LandingView,
  gates: ShipGate[]
): ShipTimelineView {
  const { session } = input
  const landing = session.landing
  const rows = landingRows(input.events)
  const stalledReason = view.stalled?.reason ?? null
  const reopen = view.reopen?.reason ?? null
  const reviewing = view.outcome === 'moving' && view.stage === 'approval'
  const canReview = reviewing && Boolean(input.review?.canDecide)
  const facts: ShipStageFacts = {
    prNumber: view.prNumber,
    version: view.version,
    reopen,
    stalled: stalledReason,
    reviewOutcome: rows.reviewOutcome,
    mergedOnGitHub: view.steps.some(s => s.key === 'merged' && s.label === 'Merged on GitHub'),
    waitingForMainChecks: view.stage === 'releasing' && !landing?.mainCi,
    checkingHealth: view.stage === 'deploying' && rows.staging?.status === 'active',
  }
  const since = landing?.stageAt ? new Date(landing.stageAt) : undefined
  const history = historyLines(gates, null)
  const outcome: ShipTimelineOutcome =
    view.outcome === 'reopened'
      ? 'handed_back'
      : view.outcome === 'stalled'
        ? 'stalled'
        : view.outcome === 'live'
          ? 'live'
          : view.outcome === 'pr'
            ? 'pr'
            : 'moving'

  const stages: ShipTimelineStage[] = view.steps.map(step => {
    const key = LANDING_STAGE[step.key]
    let state = STATE_OF[step.status]
    if (state === 'failed' && outcome === 'stalled') state = 'needs_you'
    if (state === 'now' && key === 'review' && canReview) state = 'needs_you'
    const stage: ShipTimelineStage = {
      key,
      state,
      text: shipStageText(key, state, {
        ...facts,
        reviewer: key === 'review' && state !== 'done' ? (input.review?.waitingOn ?? null) : null,
        ...(key === 'review' && (state === 'done' || state === 'failed')
          ? { reviewer: rows.reviewer }
          : {}),
      }),
    }
    if (key === 'check' && history.length) stage.history = history
    if (key === 'pr' && view.prUrl) stage.link = { href: view.prUrl, label: 'Open on GitHub' }
    if ((state === 'now' || state === 'needs_you') && since) stage.since = since
    if (key === 'checks' && state === 'now') {
      const counts = input.checks ?? rows.ci
      stage.detail = counts ? checksCountText(counts) : 'Waiting for the checks to report'
    }
    if (key === 'review' && landing) {
      const reason = reviewReasonText(landing.reviewMode)
      if (reason && state !== 'done') stage.detail = reason
    }
    if (key === 'release') {
      if (state === 'now' && facts.waitingForMainChecks) stage.detail = MAIN_CHECKS_LIMIT_TEXT
      const verdict = mainChecksVerdictText(landing?.mainCi?.verdict)
      if (verdict && state !== 'next') stage.detail = verdict
    }
    if (key === 'staging' && state === 'done' && view.stagingUrl) {
      stage.link = { href: view.stagingUrl, label: 'Open staging' }
    }
    return stage
  })
  if (view.mode !== 'pr' && outcome !== 'pr') {
    stages.push({
      key: 'promote',
      state: 'next',
      text: SHIP_STAGE_NEXT_TEXT.promote,
      ...(outcome === 'live' && input.appPath
        ? { link: { href: input.appPath, label: 'Promote from the app’s page' } }
        : {}),
    })
  }
  if (outcome === 'pr') {
    // `pr` mode: the PR is the end; its checks are what is left to watch.
    const checks = input.checks
    stages.push({
      key: 'checks',
      state:
        checks && checks.state !== 'pending'
          ? checks.state === 'failure'
            ? 'failed'
            : 'done'
          : 'now',
      text:
        checks?.state === 'failure'
          ? shipStageText('checks', 'failed')
          : checks?.state === 'success'
            ? shipStageText('checks', 'done')
            : checks?.state === 'none'
              ? 'No automatic checks reported'
              : shipStageText('checks', 'now'),
      detail: checks ? checksCountText(checks) : 'Waiting for the checks to report',
    })
  }

  let needsYou: ShipNeedsYou | null = null
  if (view.outcome === 'reopened' && view.reopen) {
    needsYou = {
      text: view.reopen.text,
      note: view.reopen.note,
      action: view.failedCheck
        ? { kind: 'fix_ci', check: view.failedCheck }
        : { kind: 'ship_again' },
    }
  } else if (view.outcome === 'stalled' && view.stalled) {
    needsYou = {
      text: view.stalled.text,
      note: view.stalled.note && view.stalled.note !== view.stalled.text ? view.stalled.note : null,
      action: landingRetryable(landing) ? { kind: 'retry_stall' } : { kind: 'app_page' },
    }
  } else if (canReview) {
    needsYou = {
      text: 'This change is waiting for your review before it merges.',
      note: null,
      action: { kind: 'review', approvalId: view.approvalId },
    }
  }

  const current =
    stages.find(s => s.state === 'needs_you') ??
    (outcome === 'moving' ? (stages.find(s => s.state === 'now') ?? null) : null)
  return {
    stages,
    current,
    outcome,
    headline: HEADLINE[outcome],
    needsYou,
    gates,
    running: null,
    landing: view,
    fixTurn: null,
  }
}

/** Whether the ship is still under way — the preview pane gives way to the timeline. Pure. */
export function shipInProgress(
  session: Pick<Session, 'status' | 'requestedAction' | 'shipping'>
): boolean {
  if (session.status === 'shipping') return true
  if (session.requestedAction === 'ship' && session.status !== 'shipped') return true
  return session.status === 'shipped' && session.shipping !== null
}

/**
 * What "Ask Claude to fix it" sends when the gate gave up: what failed and the ask, then as much of
 * the step's output as fits under `maxChars`. Pure.
 */
export function gateFixMessage(
  step: ShipGateStep | undefined,
  output: string | null,
  maxChars: number
): string {
  const head = `${gateProblemText(step)} when Launch checked the change before shipping, and the automatic fixes didn’t clear it. Find the cause and fix it, then make sure lint, typecheck and the tests pass.`
  const tail = output?.trim()
  if (!tail) return head
  const intro = '\n\nThe end of its output:\n\n```\n'
  const room = maxChars - head.length - intro.length - 4
  if (room < 200) return head
  const clipped = tail.length > room ? tail.slice(tail.length - room) : tail
  return `${head}${intro}${clipped}\n\`\`\``
}
