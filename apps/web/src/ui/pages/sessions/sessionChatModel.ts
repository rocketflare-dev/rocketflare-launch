/**
 * A coding session's transcript as things a person reads (Launch P3) — pure, like the run
 * timeline's `timelineModel.ts`, and built ON it: `session_events` are shaped like
 * `agent_run_events` on purpose (`SESSION_EVENT_TYPES`), so the tool pairing, the dedupe by id and
 * the "`at` is the call's START" rule all come from `buildTimeline` unchanged.
 *
 * What this file adds is the chat's shape rather than a stage timeline's:
 *
 * - `user.message` is the person's bubble, `text` Claude's;
 * - consecutive tool calls fold into ONE `tools` item — a turn that reads nine files is one quiet
 *   block of one-liners between two bubbles, not nine rows shouting over the answer;
 * - the lifecycle rows a person needs to know about become `notice`s (a failed or cut-off turn,
 *   the budget, the ship gate, the PR); the ones they do not (`turn.start`, `step`, `status`,
 *   `preview.ready`) render nothing here — boot has its own panel and the preview its own pane;
 * - `turn.end` becomes a footnote (how long, what it cost).
 *
 * Plus the selectors the page needs from the same rows, so nothing re-derives them:
 * `bootSteps` (the boot panel), `latestPreviewChangeSeq` (the preview reloads when the dev server comes back up),
 * `shipGates` (the ship panel) and `landingTimeline` (issue #5: what follows the PR — CI, review,
 * merge, release, live on staging — folded from the `ship.*` rows and the session's `landing`).
 */
import {
  type AgentStepEventData,
  agentErrorEventDataSchema,
  agentStepEventDataSchema,
} from '@launch/shared/ai/agents'
import {
  type SessionEvent,
  type SessionLanding,
  type SessionShipCiData,
  type SessionShipMergedData,
  type SessionShipReleasedData,
  type SessionShipReopenedData,
  type SessionShipReviewData,
  type SessionShipStagingData,
  type SessionStatus,
  SHIP_CI_MAX_MINUTES,
  SHIP_GATE_STEP_LABELS,
  type ShipGateStep,
  type ShipLandingStage,
  type ShipReopenReason,
  type ShipStalledReason,
  sessionBudgetReachedDataSchema,
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
import type { z } from 'zod'
import {
  buildTimeline,
  humaniseToolName,
  type ToolRow,
} from '@/ui/pages/agents/run/timeline/timelineModel'

export type NoticeTone = 'info' | 'success' | 'warning' | 'error'

export type ChatItem =
  | { kind: 'user'; id: string; seq: number; text: string; at: Date }
  | { kind: 'assistant'; id: string; seq: number; text: string; at: Date }
  | { kind: 'tools'; id: string; seq: number; rows: ToolRow[] }
  | {
      kind: 'turn-end'
      id: string
      seq: number
      turn: number
      durationMs?: number
      costMicrocents?: number
    }
  | { kind: 'notice'; id: string; seq: number; tone: NoticeTone; text: string; at: Date }

const CHAT_TIMELINE_TYPES = new Set(['text', 'tool.start', 'tool.end'])

const INTERRUPTED_TEXT: Record<z.infer<typeof sessionTurnInterruptedDataSchema>['reason'], string> =
  {
    cancelled: 'Stopped. Nothing after this point was applied.',
    rollout: 'Cut off by a Launch update. Resume the session to carry on from here.',
    container_lost:
      'The sandbox stopped (most likely it ran out of memory). Send a message to carry on from the last save.',
    timeout: 'Stopped: the turn ran past its time limit.',
  }

const usd = (microcents: number) => {
  const dollars = microcents / 100_000_000
  return dollars < 0.01 && dollars > 0 ? '<$0.01' : `$${dollars.toFixed(2)}`
}

/** One `session_events` row that is not text or a tool → at most one chat item. */
function lifecycleItem(event: SessionEvent): ChatItem | null {
  const base = { id: event.id, seq: event.seq, at: event.at }
  switch (event.type) {
    case 'user.message': {
      const parsed = sessionUserMessageDataSchema.safeParse(event.data)
      return parsed.success ? { kind: 'user', ...base, text: parsed.data.text } : null
    }
    case 'turn.end': {
      const parsed = sessionTurnEndDataSchema.safeParse(event.data)
      if (!parsed.success) return null
      return {
        kind: 'turn-end',
        id: event.id,
        seq: event.seq,
        turn: parsed.data.turn,
        ...(parsed.data.durationMs !== undefined ? { durationMs: parsed.data.durationMs } : {}),
        ...(parsed.data.costMicrocents !== undefined
          ? { costMicrocents: parsed.data.costMicrocents }
          : {}),
      }
    }
    case 'turn.failed': {
      const parsed = sessionTurnFailedDataSchema.safeParse(event.data)
      return {
        kind: 'notice',
        ...base,
        tone: 'error',
        text: `This turn failed: ${parsed.success ? parsed.data.message : 'unknown error'}`,
      }
    }
    case 'turn.interrupted': {
      const parsed = sessionTurnInterruptedDataSchema.safeParse(event.data)
      const reason = parsed.success ? parsed.data.reason : 'cancelled'
      return {
        kind: 'notice',
        ...base,
        tone: reason === 'cancelled' ? 'info' : 'warning',
        text: INTERRUPTED_TEXT[reason],
      }
    }
    case 'budget.reached': {
      const parsed = sessionBudgetReachedDataSchema.safeParse(event.data)
      const scope =
        parsed.success && parsed.data.scope === 'app_month' ? "app's monthly" : 'session'
      return {
        kind: 'notice',
        ...base,
        tone: 'warning',
        text: parsed.success
          ? `The ${scope} budget is used up (${usd(parsed.data.spentMicrocents)} of ${usd(parsed.data.capMicrocents)}).`
          : 'The budget is used up.',
      }
    }
    case 'ship.gate': {
      const parsed = sessionShipGateDataSchema.safeParse(event.data)
      if (!parsed.success) return null
      return {
        kind: 'notice',
        ...base,
        tone: parsed.data.passed ? 'success' : 'warning',
        text: shipGateText(parsed.data),
      }
    }
    case 'ship.pr': {
      const parsed = sessionShipPrDataSchema.safeParse(event.data)
      return parsed.success
        ? {
            kind: 'notice',
            ...base,
            tone: 'success',
            text: `Opened pull request #${parsed.data.number}.`,
          }
        : null
    }
    case 'ship.ci':
    case 'ship.review':
    case 'ship.merged':
    case 'ship.released':
    case 'ship.staging':
    case 'ship.reopened': {
      const notice = landingNotice(event)
      return notice ? { kind: 'notice', ...base, ...notice } : null
    }
    case 'error': {
      const parsed = agentErrorEventDataSchema.safeParse(event.data)
      return {
        kind: 'notice',
        ...base,
        tone: 'error',
        text: parsed.success ? parsed.data.message : 'The session reported an error.',
      }
    }
    default:
      // turn.start, step, status, preview.ready: someone else's panel, or nothing to say.
      return null
  }
}

/** Rows → chat items, in `seq` order. Idempotent under duplicated rows (the timeline dedupes). */
export function buildSessionChat(events: readonly SessionEvent[]): ChatItem[] {
  const unique = new Map<string, SessionEvent>()
  for (const event of events) if (!unique.has(event.id)) unique.set(event.id, event)
  const ordered = [...unique.values()].sort((a, b) => a.seq - b.seq)

  const units: ChatItem[] = []
  for (const row of buildTimeline(ordered.filter(e => CHAT_TIMELINE_TYPES.has(e.type)))) {
    if (row.kind === 'text') {
      if (row.text.trim()) {
        units.push({ kind: 'assistant', id: row.id, seq: row.seq, text: row.text, at: row.at })
      }
    } else if (row.kind === 'tool') {
      units.push({ kind: 'tools', id: row.id, seq: row.seq, rows: [row] })
    }
  }
  for (const event of ordered) {
    if (CHAT_TIMELINE_TYPES.has(event.type)) continue
    const item = lifecycleItem(event)
    if (item) units.push(item)
  }
  units.sort((a, b) => a.seq - b.seq)

  // Fold runs of tool calls into one block, keyed by the first call so it never remounts.
  const items: ChatItem[] = []
  for (const unit of units) {
    const last = items.at(-1)
    if (unit.kind === 'tools' && last?.kind === 'tools') {
      items[items.length - 1] = { ...last, rows: [...last.rows, ...unit.rows] }
    } else {
      items.push(unit)
    }
  }
  return items
}

// ---- tool one-liners -----------------------------------------------------------------------

/** The tail of a path — the part a person recognises — never the sandbox's absolute prefix. */
export function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : parts.join('/') || path
}

const clip = (text: string, max = 80) => {
  const line = text.split('\n')[0] ?? ''
  return line.length > max || text.includes('\n') ? `${line.slice(0, max).trimEnd()}…` : line
}

const str = (input: Record<string, unknown>, key: string): string | null =>
  typeof input[key] === 'string' && (input[key] as string).trim() ? (input[key] as string) : null

/**
 * What a Claude Code tool call DID, in words, from its input — "Edited …/components/Header.tsx",
 * "Ran pnpm test". Unknown tools fall back to the humanised name. Pure.
 */
export function toolSummary(name: string, input: unknown): { verb: string; target?: string } {
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const file = str(args, 'file_path') ?? str(args, 'path') ?? str(args, 'notebook_path')
  switch (name) {
    case 'Read':
      return file ? { verb: 'Read', target: shortPath(file) } : { verb: 'Read a file' }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? { verb: 'Edited', target: shortPath(file) } : { verb: 'Edited a file' }
    case 'Write':
      return file ? { verb: 'Wrote', target: shortPath(file) } : { verb: 'Wrote a file' }
    case 'Bash': {
      const command = str(args, 'command')
      return command ? { verb: 'Ran', target: clip(command) } : { verb: 'Ran a command' }
    }
    case 'Glob': {
      const pattern = str(args, 'pattern')
      return pattern ? { verb: 'Listed', target: pattern } : { verb: 'Listed files' }
    }
    case 'Grep': {
      const pattern = str(args, 'pattern')
      return pattern ? { verb: 'Searched for', target: clip(pattern, 60) } : { verb: 'Searched' }
    }
    case 'LS':
      return file ? { verb: 'Listed', target: shortPath(file) } : { verb: 'Listed a folder' }
    case 'TodoWrite':
      return { verb: 'Updated its plan' }
    case 'WebFetch': {
      const url = str(args, 'url')
      return url ? { verb: 'Fetched', target: clip(url) } : { verb: 'Fetched a page' }
    }
    case 'WebSearch': {
      const query = str(args, 'query')
      return query
        ? { verb: 'Searched the web for', target: clip(query, 60) }
        : { verb: 'Searched the web' }
    }
    case 'Task': {
      const description = str(args, 'description')
      return description
        ? { verb: 'Delegated', target: clip(description, 60) }
        : { verb: 'Delegated a task' }
    }
    default:
      return { verb: humaniseToolName(name) }
  }
}

// ---- selectors -----------------------------------------------------------------------------

export interface BootStep {
  key: string
  label: string
  status: AgentStepEventData['status']
  detail?: string
  at: Date
}

/**
 * The steps of the CURRENT boot: the `step` rows after the last `preview.ready` (a resume boots
 * again, and its steps must not be drawn over the first boot's finished ones). A `done` merges into
 * its `running` row in place, as on the run timeline. Pure.
 */
export function bootSteps(events: readonly SessionEvent[]): BootStep[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  const lastReady = ordered.reduce((seq, e) => (e.type === 'preview.ready' ? e.seq : seq), 0)
  const steps: BootStep[] = []
  const index = new Map<string, number>()
  for (const event of ordered) {
    if (event.type !== 'step' || event.seq <= lastReady) continue
    const parsed = agentStepEventDataSchema.safeParse(event.data)
    if (!parsed.success) continue
    const step: BootStep = {
      key: parsed.data.key,
      label: parsed.data.label,
      status: parsed.data.status,
      ...(parsed.data.detail ? { detail: parsed.data.detail } : {}),
      at: event.at,
    }
    const at = index.get(step.key)
    if (at === undefined) {
      index.set(step.key, steps.length)
      steps.push(step)
    } else {
      steps[at] = { ...step, at: steps[at]?.at ?? step.at }
    }
  }
  return steps
}

/**
 * The `seq` of the newest `preview.ready` — the dev server coming (back) up, after which the
 * frame's HMR socket points at a server that is gone. The preview reloads only when it moves: a
 * turn's edits reach the frame through Vite's HMR as they are saved, and the Reload button forces
 * a fresh load. Pure.
 */
export function latestPreviewChangeSeq(events: readonly SessionEvent[]): number {
  let seq = 0
  for (const event of events) {
    if (event.type === 'preview.ready' && event.seq > seq) seq = event.seq
  }
  return seq
}

export interface ShipGate {
  id: string
  passed: boolean
  attempt: number
  /** One step of the attempt (issue #1); absent on a row from before, which was the whole gate. */
  step?: ShipGateStep
  command?: string
  durationMs?: number
  /** The test step: the target line the kit's `pnpm test` printed first (0.16.0). */
  target?: string
  output?: string
  at: Date
}

/**
 * The chat notice for one `ship.gate` row: `Lint passed (attempt 1).` / `Tests failed on attempt
 * 2.` — or, for a row from before the gate had steps, the whole gate. Pure.
 */
export function shipGateText(gate: { passed: boolean; attempt: number; step?: ShipGateStep }) {
  if (!gate.step) {
    return gate.passed
      ? `Lint, typecheck and tests passed (attempt ${gate.attempt}).`
      : `Lint, typecheck or tests failed on attempt ${gate.attempt}.`
  }
  const label = SHIP_GATE_STEP_LABELS[gate.step]
  return gate.passed
    ? `${label} passed (attempt ${gate.attempt}).`
    : `${label} failed on attempt ${gate.attempt}.`
}

/** The gate rows grouped by attempt, oldest first — the ship panel's list. Pure. */
export function shipGateAttempts(
  gates: readonly ShipGate[]
): { attempt: number; passed: boolean; steps: ShipGate[] }[] {
  const byAttempt = new Map<number, ShipGate[]>()
  for (const gate of gates) {
    const list = byAttempt.get(gate.attempt) ?? []
    list.push(gate)
    byAttempt.set(gate.attempt, list)
  }
  return [...byAttempt.entries()]
    .sort(([a], [b]) => a - b)
    .map(([attempt, steps]) => ({
      attempt,
      steps,
      // Green only when its last row is (a step-less row is the whole gate).
      passed: steps.every(s => s.passed) && (steps.at(-1)?.step ?? 'test') === 'test',
    }))
}

/** Every ship-gate attempt, oldest first. Pure. */
export function shipGates(events: readonly SessionEvent[]): ShipGate[] {
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .flatMap(event => {
      if (event.type !== 'ship.gate') return []
      const parsed = sessionShipGateDataSchema.safeParse(event.data)
      if (!parsed.success) return []
      return [
        {
          id: event.id,
          passed: parsed.data.passed,
          attempt: parsed.data.attempt,
          ...(parsed.data.step ? { step: parsed.data.step } : {}),
          ...(parsed.data.command ? { command: parsed.data.command } : {}),
          ...(parsed.data.durationMs !== undefined ? { durationMs: parsed.data.durationMs } : {}),
          ...(parsed.data.target ? { target: parsed.data.target } : {}),
          ...(parsed.data.output ? { output: parsed.data.output } : {}),
          at: event.at,
        },
      ]
    })
}

// ---- landing: what follows the PR (issue #5) -----------------------------------------------

/** `v1.4.2` — a version as people write it. Pure. */
export function versionLabel(version: string): string {
  return version.startsWith('v') ? version : `v${version}`
}

/** Why the landing gave the session back, in one sentence (`ship.reopened`). */
export const REOPEN_TEXT: Record<ShipReopenReason, string> = {
  ci_failed: 'CI failed on the pull request, so Launch didn’t merge it.',
  ci_timeout: `CI didn’t finish within ${SHIP_CI_MAX_MINUTES / 60} hours, so Launch stopped waiting.`,
  ci_none: 'The repository’s CI never reported on the pull request, so Launch didn’t merge it.',
  head_moved:
    'Someone changed the pull request after Launch checked it, so Launch didn’t merge it.',
  pr_closed: 'The pull request was closed without being merged.',
  review_rejected: 'The reviewer sent the change back instead of approving it.',
  review_expired: 'Nobody reviewed the change within two days, so the request lapsed.',
  merge_refused: 'GitHub refused to merge the pull request.',
}

/**
 * A `review_rejected` reopen whose review was CANCELLED (withdrawn, or Launch cancelled it — the
 * server reopens a cancelled review under that reason): nobody sent the change back.
 */
const REVIEW_CANCELLED_TEXT = 'The review was cancelled, so Launch didn’t merge it.'

/** Why a landing stalled after the merge, in one sentence (the change is merged either way). */
export const STALLED_TEXT: Record<ShipStalledReason, string> = {
  release_failed: 'The change is merged, but Launch couldn’t cut a release for it.',
  deploy_failed: 'The change is merged and released, but the staging deploy failed.',
  deploy_timeout: 'The change is merged and released, but staging didn’t pick it up in time.',
  unhealthy: 'The change is on staging, but staging isn’t passing its health check.',
}

/** The chat notice for one landing row; null for a round with nothing to say yet. Pure. */
function landingNotice(event: SessionEvent): { tone: NoticeTone; text: string } | null {
  switch (event.type) {
    case 'ship.ci': {
      const parsed = sessionShipCiDataSchema.safeParse(event.data)
      if (!parsed.success) return null
      if (parsed.data.state === 'success') return { tone: 'success', text: 'CI passed.' }
      if (parsed.data.state !== 'failure') return null
      const name = parsed.data.failedCheck?.name
      return { tone: 'warning', text: name ? `CI failed: ${name}.` : 'CI failed.' }
    }
    case 'ship.review': {
      const parsed = sessionShipReviewDataSchema.safeParse(event.data)
      if (!parsed.success) return null
      const by = parsed.data.by ? ` by ${parsed.data.by}` : ''
      switch (parsed.data.status) {
        case 'requested':
          return { tone: 'info', text: 'Asked for a review before merging.' }
        case 'approved':
          return { tone: 'success', text: `Approved${by}.` }
        case 'rejected':
          return {
            tone: 'warning',
            text: `Sent back${by}${parsed.data.note ? `: ${parsed.data.note}` : '.'}`,
          }
        case 'expired':
          return { tone: 'warning', text: 'The review request lapsed.' }
        case 'cancelled':
          return { tone: 'info', text: 'The review request was withdrawn.' }
      }
      return null
    }
    case 'ship.merged': {
      const parsed = sessionShipMergedDataSchema.safeParse(event.data)
      return parsed.success
        ? { tone: 'success', text: `Merged pull request #${parsed.data.number}.` }
        : null
    }
    case 'ship.released': {
      const parsed = sessionShipReleasedDataSchema.safeParse(event.data)
      return parsed.success
        ? { tone: 'success', text: `Released ${versionLabel(parsed.data.version)}.` }
        : null
    }
    case 'ship.staging': {
      const parsed = sessionShipStagingDataSchema.safeParse(event.data)
      if (!parsed.success) return null
      const version = versionLabel(parsed.data.version)
      if (parsed.data.status === 'live')
        return { tone: 'success', text: `Live on staging: ${version}.` }
      if (parsed.data.status === 'deploying' || parsed.data.status === 'active') return null
      return { tone: 'error', text: parsed.data.error ?? `${version} didn’t go live on staging.` }
    }
    case 'ship.reopened': {
      const parsed = sessionShipReopenedDataSchema.safeParse(event.data)
      return parsed.success
        ? { tone: 'warning', text: `${REOPEN_TEXT[parsed.data.reason]} The session is open again.` }
        : null
    }
    default:
      return null
  }
}

export type LandingStepKey = 'gate' | 'pr' | 'ci' | 'approval' | 'merged' | 'released' | 'staging'
export type LandingStepStatus = 'done' | 'active' | 'pending' | 'failed'

export interface LandingStep {
  key: LandingStepKey
  status: LandingStepStatus
  label: string
  /** A second line: the CI round so far. */
  detail?: string
  url?: string
}

/**
 * How the ship stands: still moving, live on staging, left as a PR (`pr` mode), given back before
 * the merge (`reopened`), or stuck after it (`stalled` — the change is merged either way).
 */
export type LandingOutcome = 'moving' | 'live' | 'pr' | 'reopened' | 'stalled'

export interface FailedCheck {
  name: string
  url: string | null
  /** The last lines of its log, redacted by the server. */
  logTail?: string
}

export interface LandingView {
  mode: SessionLanding['mode']
  /** `landing.stage`, else the furthest the rows got; null once reopened. */
  stage: ShipLandingStage | null
  outcome: LandingOutcome
  steps: LandingStep[]
  prNumber: number | null
  prUrl: string | null
  version: string | null
  stagingUrl: string | null
  /** The `session.merge` approval, once one was opened. */
  approvalId: string | null
  /** A review is part of this ship (the app's setting, an admin policy, or a `ship.review` row). */
  reviewed: boolean
  reopen: { reason: ShipReopenReason; text: string; note: string | null } | null
  /** The red check behind a `ci_failed` reopen, with its log tail. */
  failedCheck: FailedCheck | null
  stalled: { reason: ShipStalledReason | null; text: string; note: string | null } | null
}

/** "3 of 4 checks passed · 1 running" from one CI round. Pure. */
export function ciRoundText(ci: Pick<SessionShipCiData, 'passed' | 'failed' | 'pending'>): string {
  const total = ci.passed + ci.failed + ci.pending
  if (total === 0) return 'Waiting for CI to report'
  const parts = [`${ci.passed} of ${total} checks passed`]
  if (ci.failed) parts.push(`${ci.failed} failed`)
  if (ci.pending) parts.push(`${ci.pending} running`)
  return parts.join(' · ')
}

const STEP_ORDER: readonly LandingStepKey[] = [
  'gate',
  'pr',
  'ci',
  'approval',
  'merged',
  'released',
  'staging',
]

/** The step a reopen failed at. */
const REOPEN_STEP: Record<ShipReopenReason, LandingStepKey> = {
  ci_failed: 'ci',
  ci_timeout: 'ci',
  ci_none: 'ci',
  review_rejected: 'approval',
  review_expired: 'approval',
  head_moved: 'merged',
  pr_closed: 'merged',
  merge_refused: 'merged',
}

/** The step a stall failed at. */
const STALLED_STEP: Record<ShipStalledReason, LandingStepKey> = {
  release_failed: 'released',
  deploy_failed: 'staging',
  deploy_timeout: 'staging',
  unhealthy: 'staging',
}

/** The step a stage is at. */
const STAGE_STEP: Record<ShipLandingStage, LandingStepKey> = {
  ci: 'ci',
  approval: 'approval',
  merging: 'merged',
  releasing: 'released',
  deploying: 'staging',
  live: 'staging',
  stalled: 'staging',
  pr: 'pr',
}

interface LandingRows {
  ci: SessionShipCiData | null
  failedCheck: FailedCheck | null
  review: SessionShipReviewData | null
  merged: SessionShipMergedData | null
  released: SessionShipReleasedData | null
  staging: SessionShipStagingData | null
  reopened: SessionShipReopenedData | null
  /** A gate row after the reopen: the NEXT ship is under way, before its own PR. */
  reshipped: boolean
}

/** The latest of each landing row among `rows`. Pure. */
function foldLandingRows(rows: readonly SessionEvent[]): LandingRows {
  const out: LandingRows = {
    ci: null,
    failedCheck: null,
    review: null,
    merged: null,
    released: null,
    staging: null,
    reopened: null,
    reshipped: false,
  }
  for (const event of rows) {
    switch (event.type) {
      case 'ship.ci': {
        const parsed = sessionShipCiDataSchema.safeParse(event.data)
        if (!parsed.success) break
        out.ci = parsed.data
        if (parsed.data.failedCheck) out.failedCheck = { ...parsed.data.failedCheck }
        break
      }
      case 'ship.review': {
        const parsed = sessionShipReviewDataSchema.safeParse(event.data)
        if (parsed.success) out.review = parsed.data
        break
      }
      case 'ship.merged': {
        const parsed = sessionShipMergedDataSchema.safeParse(event.data)
        if (parsed.success) out.merged = parsed.data
        break
      }
      case 'ship.released': {
        const parsed = sessionShipReleasedDataSchema.safeParse(event.data)
        if (parsed.success) out.released = parsed.data
        break
      }
      case 'ship.staging': {
        const parsed = sessionShipStagingDataSchema.safeParse(event.data)
        if (parsed.success) out.staging = parsed.data
        break
      }
      case 'ship.reopened': {
        const parsed = sessionShipReopenedDataSchema.safeParse(event.data)
        if (parsed.success) out.reopened = parsed.data
        break
      }
      case 'ship.gate':
        if (out.reopened) out.reshipped = true
        break
    }
  }
  return out
}

/** With no `landing` on the row, the furthest the rows got. Pure. */
function stageFromRows(rows: LandingRows): ShipLandingStage {
  const staging = rows.staging?.status
  if (staging === 'live') return 'live'
  if (staging === 'failed' || staging === 'unhealthy' || staging === 'timeout') return 'stalled'
  if (rows.released || rows.staging) return 'deploying'
  if (rows.merged) return 'releasing'
  if (rows.review?.status === 'requested' || rows.review?.status === 'approved') return 'approval'
  return 'ci'
}

function stepLabel(
  key: LandingStepKey,
  status: LandingStepStatus,
  facts: {
    prNumber: number | null
    version: string | null
    reopen: ShipReopenReason | null
    review: SessionShipReviewData | null
    mergedOnGitHub: boolean
  }
): string {
  switch (key) {
    case 'gate':
      return 'Lint, typecheck and tests passed'
    case 'pr':
      return facts.prNumber ? `Pull request #${facts.prNumber} opened` : 'Pull request opened'
    case 'ci':
      if (status === 'done') return 'CI passed'
      if (status === 'failed')
        return facts.reopen === 'ci_timeout'
          ? 'CI didn’t finish'
          : facts.reopen === 'ci_none'
            ? 'CI never reported'
            : 'CI failed'
      return status === 'active' ? 'Waiting for CI' : 'CI'
    case 'approval': {
      const by = facts.review?.by ? ` by ${facts.review.by}` : ''
      if (status === 'done') return `Approved${by}`
      if (status === 'failed')
        return facts.reopen === 'review_expired'
          ? 'Review lapsed'
          : facts.review?.status === 'cancelled'
            ? 'Review cancelled'
            : `Sent back${by}`
      return status === 'active' ? 'Waiting for a review' : 'Review'
    }
    case 'merged':
      if (status === 'done') return facts.mergedOnGitHub ? 'Merged on GitHub' : 'Merged'
      if (status === 'failed') return facts.reopen === 'pr_closed' ? 'PR closed' : 'Not merged'
      return status === 'active' ? 'Merging' : 'Merge'
    case 'released':
      if (status === 'done')
        return facts.version ? `Released ${versionLabel(facts.version)}` : 'Released'
      if (status === 'failed') return 'Release failed'
      return status === 'active' ? 'Cutting a release' : 'Release'
    case 'staging':
      if (status === 'done') return 'Live on staging'
      if (status === 'failed') return 'Not live on staging'
      return status === 'active' ? 'Deploying to staging' : 'Live on staging'
  }
}

/**
 * The ship after the gate, as the ship panel walks it: gate → PR → CI → [review] → merged →
 * released vX.Y.Z → live on staging, each step done, active, waiting or failed — plus how it ends:
 * live (the staging link), reopened (the reason, and CI's failing check with its log tail),
 * stalled (the reason; the change is merged), or `pr` (the `pr` ship mode: today's "PR opened").
 *
 * It reads the CURRENT ship only — the rows after its last `ship.pr` — and the session's `landing`
 * (null before the PR, and again after a reopen, when the rows carry the story). Null when there
 * is no landing to draw: before the PR, a re-ship's gate after a reopen, or a session shipped
 * before issue #5 (no landing, no landing rows: the panel's PR and CI view). Once `sessions.checks`
 * ADOPTS such a session's hand merge (`land-adopt.ts`) it has a landing and a `ship.merged` row
 * `by: 'github'`: the walk reads gate → PR → "Merged on GitHub" → released → live, with no CI
 * step (Launch never read it). Pure.
 *
 * `status` (the session's, when the caller has it): an End while the landing waited in `ci` or
 * `approval` clears the landing and writes no `ship.reopened` (`endStep`), so landing rows with no
 * landing, no reopen and a session that is neither `shipping` nor `shipped` are an ABANDONED
 * landing — nothing is moving, the PR stays open — and the panel's PR view says that, not
 * "Waiting for CI" for ever.
 */
export function landingTimeline(
  events: readonly SessionEvent[],
  landing: SessionLanding | null,
  status?: SessionStatus
): LandingView | null {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  let prIndex = -1
  for (const [index, event] of ordered.entries()) if (event.type === 'ship.pr') prIndex = index
  const prRow = prIndex >= 0 ? sessionShipPrDataSchema.safeParse(ordered[prIndex]?.data) : null
  const pr = prRow?.success ? prRow.data : null
  const rows = foldLandingRows(prIndex >= 0 ? ordered.slice(prIndex + 1) : [])

  const hasRows = Boolean(
    rows.ci || rows.review || rows.merged || rows.released || rows.staging || rows.reopened
  )
  if (!landing && (rows.reshipped || !hasRows)) return null
  if (!landing && !rows.reopened && status && status !== 'shipping' && status !== 'shipped') {
    return null
  }

  const reopened = !landing && rows.reopened ? rows.reopened : null
  const stage: ShipLandingStage | null = landing?.stage ?? (reopened ? null : stageFromRows(rows))
  const mode = landing?.mode ?? 'staging'
  const outcome: LandingOutcome =
    mode === 'pr' || stage === 'pr'
      ? 'pr'
      : reopened
        ? 'reopened'
        : stage === 'live'
          ? 'live'
          : stage === 'stalled'
            ? 'stalled'
            : 'moving'

  const prNumber = landing?.prNumber ?? pr?.number ?? rows.merged?.number ?? null
  const prUrl = pr?.url ?? rows.merged?.url ?? null
  const version = landing?.version ?? rows.released?.version ?? rows.staging?.version ?? null
  const stagingUrl = landing?.stagingUrl ?? rows.staging?.url ?? null
  const approvalId = landing?.approvalId ?? rows.review?.approvalId ?? null
  const reviewed = Boolean(rows.review) || (landing ? landing.reviewMode !== 'none' : false)
  const stalledReason = landing?.stalledReason ?? null

  // Where the walk is: every step before `at` is done; `at` is active, failed, or (live) done.
  const failedAt: LandingStepKey | null = reopened
    ? REOPEN_STEP[reopened.reason]
    : outcome === 'stalled'
      ? stalledReason
        ? STALLED_STEP[stalledReason]
        : version
          ? 'staging'
          : 'released'
      : null
  const at = failedAt ?? (stage ? STAGE_STEP[stage] : 'ci')
  const position = STEP_ORDER.indexOf(at)
  const statusOf = (key: LandingStepKey): LandingStepStatus => {
    const index = STEP_ORDER.indexOf(key)
    if (outcome === 'pr') return index <= STEP_ORDER.indexOf('pr') ? 'done' : 'pending'
    if (index < position) return 'done'
    if (index > position) return 'pending'
    if (key === failedAt) return 'failed'
    return outcome === 'live' ? 'done' : 'active'
  }

  // Merged by a person on GitHub before Launch read CI (a merge `sessions.checks` adopted, or one
  // made while the landing waited): Launch never saw CI, so the walk claims nothing about it.
  const mergedOnGitHub = rows.merged?.by === 'github'
  const keys = STEP_ORDER.filter(key =>
    outcome === 'pr'
      ? key === 'gate' || key === 'pr'
      : (key !== 'approval' || reviewed) && (key !== 'ci' || !mergedOnGitHub || Boolean(rows.ci))
  )
  const facts = {
    prNumber,
    version,
    reopen: reopened?.reason ?? null,
    review: rows.review,
    mergedOnGitHub,
  }
  const steps = keys.map((key): LandingStep => {
    const status = statusOf(key)
    const step: LandingStep = { key, status, label: stepLabel(key, status, facts) }
    if (key === 'pr' && prUrl) step.url = prUrl
    if (key === 'ci' && status === 'active' && rows.ci) step.detail = ciRoundText(rows.ci)
    if (key === 'staging' && status === 'done' && stagingUrl) step.url = stagingUrl
    return step
  })

  let reopenNote: string | null = null
  const cancelled = reopened?.reason === 'review_rejected' && rows.review?.status === 'cancelled'
  const reopenText = reopened
    ? cancelled
      ? REVIEW_CANCELLED_TEXT
      : REOPEN_TEXT[reopened.reason]
    : null
  if (reopened) {
    const message = reopened.message.trim()
    if (reopened.reason === 'review_rejected' && rows.review?.note) reopenNote = rows.review.note
    else if (message && message !== reopenText) reopenNote = message
  }

  return {
    mode,
    stage,
    outcome,
    steps,
    prNumber,
    prUrl,
    version,
    stagingUrl,
    approvalId,
    reviewed,
    reopen: reopened ? { reason: reopened.reason, text: reopenText ?? '', note: reopenNote } : null,
    failedCheck: reopened?.reason === 'ci_failed' ? rows.failedCheck : null,
    stalled:
      outcome === 'stalled'
        ? {
            reason: stalledReason,
            text: stalledReason
              ? STALLED_TEXT[stalledReason]
              : 'The change is merged, but it didn’t make it live on staging.',
            note: landing?.error ?? rows.staging?.error ?? null,
          }
        : null,
  }
}

/**
 * What "Ask Claude to fix it" sends for a red CI check: the check and the ask, then as much of the
 * log tail as fits under `maxChars` (the server also hands the turn the latest failure). Pure.
 */
export function ciFixMessage(check: FailedCheck, maxChars: number): string {
  const head = `CI failed on the pull request: the check “${check.name}” is red. Find the cause and fix it, then make sure lint, typecheck and the tests pass.`
  const tail = check.logTail?.trim()
  if (!tail) return head
  const intro = '\n\nThe end of its log:\n\n```\n'
  const room = maxChars - head.length - intro.length - 4
  if (room < 200) return head
  const clipped = tail.length > room ? tail.slice(tail.length - room) : tail
  return `${head}${intro}${clipped}\n\`\`\``
}
