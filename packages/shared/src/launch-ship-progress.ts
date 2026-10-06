/**
 * How a ship is SAID (issue #22) — the one wording of "where is my change", shared by the session
 * page's timeline, the app page's lists and status chip, and `launch sessions ship --follow` / `ls`.
 * Pure words over the facts the session already carries (`sessions.landing`, the `ship.*` rows,
 * `sessionShippingOf`); nothing here reads a row or decides a state.
 *
 * The ship is one ordered walk of {@link SHIP_PROGRESS_STAGES}: checking the change (lint, types and
 * tests, as one stage) → the pull request → the automatic checks → a review, only when one is
 * required → merging → releasing → live on staging → ready to promote to production. Each stage is
 * in one {@link ShipProgressState}: done, now, next, needs you (the only loud one) or failed.
 *
 * Plain English for a reader who is not an engineer: no commands, no check names, no branch names —
 * those stay under the session page's Details.
 */
import {
  type LandingReviewMode,
  SHIP_CI_MAX_MINUTES,
  SHIP_GATE_ATTEMPTS,
  SHIP_MAIN_CI_MAX_MINUTES,
  type ShipGateRunningPhase,
  type ShipGateStep,
  type ShipLandingStage,
  type ShipMainCiVerdict,
  type ShipReopenReason,
  type ShipStalledReason,
} from './launch-sessions'

// ---- the walk ----------------------------------------------------------------------------------

export const SHIP_PROGRESS_STAGES = [
  'check',
  'pr',
  'checks',
  'review',
  'merge',
  'release',
  'staging',
  'promote',
] as const
export type ShipProgressStage = (typeof SHIP_PROGRESS_STAGES)[number]

/**
 * `needs_you`: a person has to act (a review to give, a failure Claude couldn't fix, a stall);
 * `failed`: the stage went wrong and nothing more happens on it (the change was given back).
 */
export const SHIP_PROGRESS_STATES = ['done', 'now', 'next', 'needs_you', 'failed'] as const
export type ShipProgressState = (typeof SHIP_PROGRESS_STATES)[number]

/** A stage still to come, by name. */
export const SHIP_STAGE_NEXT_TEXT: Record<ShipProgressStage, string> = {
  check: 'Check your change: lint, types and tests',
  pr: 'Open a pull request',
  checks: 'Automatic checks',
  review: 'Review',
  merge: 'Merge',
  release: 'Release',
  staging: 'Live on staging',
  promote: 'Ready to promote to production',
}

/** `v1.4.2` — a version as people write it. */
export function shipVersionText(version: string): string {
  return version.startsWith('v') ? version : `v${version}`
}

/** What a stage's sentence may name, when it is known. */
export interface ShipStageFacts {
  prNumber?: number | null
  version?: string | null
  /** Review: who decided it (done, failed) or who it waits on (now). */
  reviewer?: string | null
  /** Review: how it ended when it went wrong (a reopen's `review_*`, or a cancelled request). */
  reviewOutcome?: 'rejected' | 'expired' | 'cancelled' | null
  /** Release: still waiting for the merge commit's own checks on the default branch. */
  waitingForMainChecks?: boolean
  /** Staging: deployed, its health being checked. */
  checkingHealth?: boolean
  /** Merge: a person merged it on GitHub. */
  mergedOnGitHub?: boolean
  /** Why the landing gave the change back (the stage it names is the one that failed). */
  reopen?: ShipReopenReason | null
  /** Why the landing stalled after the merge. */
  stalled?: ShipStalledReason | null
  /** Check: how many tries the gate had, when it gave up. */
  attempts?: number
}

/** One sentence for a stage in a state. Pure. */
export function shipStageText(
  stage: ShipProgressStage,
  state: ShipProgressState,
  facts: ShipStageFacts = {}
): string {
  if (state === 'next') return SHIP_STAGE_NEXT_TEXT[stage]
  const bad = state === 'failed' || state === 'needs_you'
  switch (stage) {
    case 'check':
      if (state === 'done') return 'Your change passed lint, types and tests'
      if (bad) {
        const tries = facts.attempts ?? 0
        return tries > 1
          ? `Your change still didn’t pass its checks after ${tries} tries`
          : 'Your change didn’t pass its checks'
      }
      return 'Checking your change'
    case 'pr':
      if (state === 'done')
        return facts.prNumber ? `Pull request #${facts.prNumber} opened` : 'Pull request opened'
      if (bad) return 'The pull request wasn’t opened'
      return 'Opening a pull request'
    case 'checks':
      if (state === 'done') return 'The automatic checks passed'
      if (bad) {
        if (facts.reopen === 'ci_timeout')
          return `The automatic checks didn’t finish within ${SHIP_CI_MAX_MINUTES / 60} hours`
        if (facts.reopen === 'ci_none') return 'No automatic checks reported on the pull request'
        return 'The automatic checks found a problem'
      }
      return 'Waiting for the automatic checks'
    case 'review': {
      const by = facts.reviewer ? ` by ${facts.reviewer}` : ''
      if (state === 'done') return `Approved${by}`
      if (state === 'needs_you') return 'Waiting for your review'
      if (bad) {
        if (facts.reviewOutcome === 'expired' || facts.reopen === 'review_expired')
          return 'Nobody reviewed it within two days'
        if (facts.reviewOutcome === 'cancelled') return 'The review was cancelled'
        return `Sent back${by}`
      }
      return facts.reviewer ? `Waiting for ${facts.reviewer} to review it` : 'Waiting for a review'
    }
    case 'merge':
      if (state === 'done') return facts.mergedOnGitHub ? 'Merged on GitHub' : 'Merged'
      if (bad) {
        if (facts.reopen === 'pr_closed') return 'The pull request was closed'
        if (facts.reopen === 'merge_refused') return 'GitHub refused to merge it'
        if (facts.reopen === 'head_moved') return 'The pull request changed after Launch checked it'
        return 'Not merged'
      }
      return 'Merging'
    case 'release':
      if (state === 'done')
        return facts.version ? `Released ${shipVersionText(facts.version)}` : 'Released'
      if (bad) {
        if (facts.stalled === 'main_ci_failed') return 'Main’s checks failed after the merge'
        return 'Launch couldn’t cut the release'
      }
      if (facts.waitingForMainChecks) return MAIN_CHECKS_WAIT_TEXT
      return facts.version ? `Releasing ${shipVersionText(facts.version)}` : 'Releasing'
    case 'staging':
      if (state === 'done') return 'Live on staging'
      if (bad) {
        if (facts.stalled === 'deploy_timeout') return 'Staging didn’t pick it up in time'
        if (facts.stalled === 'unhealthy') return 'Staging isn’t passing its health check'
        return 'The staging deploy failed'
      }
      if (facts.checkingHealth) return 'Checking staging is healthy'
      return facts.version
        ? `Deploying ${shipVersionText(facts.version)} to staging`
        : 'Deploying to staging'
    case 'promote':
      return 'Ready to promote to production'
  }
}

/**
 * Why a review is part of this ship, and who decides it — the Review stage's second line. An
 * organisation's `session.merge` policy wins over the app's own setting (`reviewMode: 'policy'`);
 * null when no review is required.
 */
export function reviewReasonText(mode: LandingReviewMode): string | null {
  switch (mode) {
    case 'policy':
      return 'Your organisation’s approval policy requires a review before it merges.'
    case 'app_owners':
      return 'The app’s Ship settings ask one of its owners to approve it.'
    case 'groups':
      return 'The app’s Ship settings ask someone from the chosen teams to approve it.'
    case 'none':
      return null
  }
}

// ---- checking the change (the sandbox gate) ----------------------------------------------------

/** What the gate step running now is doing. */
export function gateStepNowText(step: ShipGateStep, phase?: ShipGateRunningPhase): string {
  if (phase === 'database') return 'Preparing a test copy of the database'
  switch (step) {
    case 'lint':
      return 'Checking the code style (lint)'
    case 'typecheck':
      return 'Checking the types'
    case 'test':
      return 'Running the tests'
  }
}

/** "The tests found a problem" — a red gate step, without its log. */
export function gateProblemText(step: ShipGateStep | undefined): string {
  switch (step) {
    case 'lint':
      return 'Lint found a problem'
    case 'typecheck':
      return 'The type check found a problem'
    case 'test':
      return 'The tests found a problem'
    default:
      return 'A check found a problem'
  }
}

/** "try 2 of 3". */
export function gateTryText(attempt: number, max: number = SHIP_GATE_ATTEMPTS): string {
  return `try ${attempt} of ${max}`
}

/** "The tests found a problem. Claude is fixing it (try 2 of 3)." — a red step being fixed. */
export function gateFixingText(
  step: ShipGateStep | undefined,
  agent: string,
  nextAttempt: number,
  max: number = SHIP_GATE_ATTEMPTS
): string {
  return `${gateProblemText(step)}. ${agent} is fixing it (${gateTryText(nextAttempt, max)}).`
}

const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth']

const STEP_SHORT: Record<ShipGateStep, string> = {
  lint: 'lint',
  typecheck: 'types',
  test: 'tests',
}

/**
 * An earlier try, collapsed to one line: "First try: tests failed, fixed automatically" (a later
 * try got past that step) or "Second try: lint failed".
 */
export function earlierTryText(
  attempt: number,
  step: ShipGateStep | undefined,
  fixed: boolean
): string {
  const which = ORDINALS[attempt - 1] ?? `Try ${attempt}`
  const what = step ? `${STEP_SHORT[step]} failed` : 'the checks failed'
  return `${which} try: ${what}${fixed ? ', fixed automatically' : ''}`
}

/** "12 s", "3 min 4 s", "1 h 5 min" — an elapsed or measured time. */
export function shipDurationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

/** "about 6 minutes", "under a minute". */
function roughly(ms: number): string {
  if (ms < 60_000) return 'under a minute'
  const minutes = Math.round(ms / 60_000)
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`
}

const STEP_SUBJECT: Record<ShipGateStep, { noun: string; plural: boolean }> = {
  lint: { noun: 'Lint', plural: false },
  typecheck: { noun: 'The type check', plural: false },
  test: { noun: 'The tests', plural: true },
}

/**
 * How long a step typically takes, from the times it took before in this session (oldest first):
 * "The tests took about 6 minutes last time" from one, "The tests usually take about 6 minutes"
 * (the median) from more; null with none — nothing is said rather than a guess.
 */
export function typicalDurationText(
  step: ShipGateStep,
  samplesMs: readonly number[]
): string | null {
  if (samplesMs.length === 0) return null
  const { noun, plural } = STEP_SUBJECT[step]
  if (samplesMs.length === 1) return `${noun} took ${roughly(samplesMs[0] as number)} last time`
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] as number
  return `${noun} usually ${plural ? 'take' : 'takes'} ${roughly(median)}`
}

// ---- the automatic checks (the PR's CI) -------------------------------------------------------

/**
 * "2 of 3 passed, 1 running" — the PR's checks counted, never named. `queued` (of `pending`) are
 * checks GitHub has not started yet: all of them queued reads "Waiting for GitHub to start the
 * checks", so a GitHub backlog never looks like Launch being stuck.
 */
export function checksCountText(checks: {
  passed: number
  failed: number
  pending: number
  queued?: number
}): string {
  const total = checks.passed + checks.failed + checks.pending
  if (total === 0) return 'Waiting for the checks to report'
  const queued = Math.min(checks.queued ?? 0, checks.pending)
  const running = checks.pending - queued
  if (checks.passed === 0 && checks.failed === 0 && running === 0)
    return 'Waiting for GitHub to start the checks'
  const parts = [`${checks.passed} of ${total} passed`]
  if (checks.failed) parts.push(`${checks.failed} failed`)
  if (running) parts.push(`${running} running`)
  if (queued) parts.push(`${queued} waiting for GitHub to start`)
  return parts.join(', ')
}

// ---- after the merge ----------------------------------------------------------------------------

export const MAIN_CHECKS_WAIT_TEXT = 'Waiting for main’s checks before releasing'

/** The limit on that wait, in words. */
export const MAIN_CHECKS_LIMIT_TEXT = `Launch releases anyway after ${SHIP_MAIN_CI_MAX_MINUTES} minutes`

/** What `land.main-ci`'s verdict means for the reader, when it is worth saying. */
export function mainChecksVerdictText(
  verdict: ShipMainCiVerdict | null | undefined
): string | null {
  switch (verdict) {
    case 'timeout':
      return 'Main’s checks were slow, so the deploy will check it again.'
    case 'override':
      return 'Released without main’s checks, so the deploy will check it again.'
    default:
      return null
  }
}

/**
 * A ship in flight in a few words, for a list row, the CLI's `ls` and a chip's title: "Waiting for
 * the automatic checks", "Merged, waiting for main’s checks", "Deploying v1.4.2 to staging".
 * `mainCi` null while releasing: the release waits for the merge commit's checks.
 */
export function shippingSummaryText(shipping: {
  stage: ShipLandingStage
  stalledReason?: ShipStalledReason | null
  version?: string | null
  mainCi?: ShipMainCiVerdict | null
}): string {
  switch (shipping.stage) {
    case 'ci':
      return 'Waiting for the automatic checks'
    case 'approval':
      return 'Waiting for a review'
    case 'merging':
      return 'Merging'
    case 'releasing':
      if (!shipping.mainCi) return 'Merged, waiting for main’s checks'
      return shipping.version
        ? `Merged, releasing ${shipVersionText(shipping.version)}`
        : 'Merged, releasing'
    case 'deploying':
      return shipping.version
        ? `Deploying ${shipVersionText(shipping.version)} to staging`
        : 'Deploying to staging'
    case 'stalled':
      if (shipping.stalledReason === 'main_ci_failed') return 'Merged, but main’s checks failed'
      if (shipping.stalledReason === 'release_failed') return 'Merged, but the release failed'
      return 'Merged, not live on staging yet'
    case 'live':
      return 'Live on staging'
    case 'pr':
      return 'Pull request open'
  }
}

/** The status chip's word for a ship in flight — short, the same stage the summary names. */
export function shippingChipText(shipping: {
  stage: ShipLandingStage
  waitingOn?: 'review' | 'retry' | null
}): string {
  if (shipping.waitingOn === 'retry') return 'Needs you'
  switch (shipping.stage) {
    case 'ci':
      return 'Checks running'
    case 'approval':
      return 'In review'
    case 'merging':
      return 'Merging'
    case 'releasing':
      return 'Releasing'
    case 'deploying':
      return 'Deploying'
    case 'stalled':
      return 'Needs you'
    case 'live':
      return 'Live on staging'
    case 'pr':
      return 'Pull request'
  }
}

/** "under a minute", "2 min", "1 h 5 min" — how long a list row's stage has lasted. */
export function shippingElapsedText(ms: number): string {
  if (ms < 60_000) return 'under a minute'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
}

/**
 * A ship in flight as one line for a list row and `launch sessions ls`: "PR #6 · Merged, waiting
 * for main’s checks · 2 min (releases anyway after 30 min)". `nowMs` is the reader's clock; the
 * stage's time counts from `since` (when the stage last changed).
 */
export function shippingLineText(
  shipping: {
    stage: ShipLandingStage
    stalledReason?: ShipStalledReason | null
    version?: string | null
    mainCi?: ShipMainCiVerdict | null
    prNumber: number
    since: string
  },
  nowMs: number
): string {
  const elapsed = Math.max(0, nowMs - Date.parse(shipping.since))
  const waitingForMain = shipping.stage === 'releasing' && !shipping.mainCi
  const limit = waitingForMain ? ` (releases anyway after ${SHIP_MAIN_CI_MAX_MINUTES} min)` : ''
  const clock = Number.isFinite(elapsed) ? ` · ${shippingElapsedText(elapsed)}${limit}` : ''
  return `PR #${shipping.prNumber} · ${shippingSummaryText(shipping)}${clock}`
}
