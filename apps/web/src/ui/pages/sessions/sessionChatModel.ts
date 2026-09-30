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
 * Plus the three selectors the page needs from the same rows, so nothing re-derives them:
 * `bootSteps` (the boot panel), `latestTurnEndSeq` (the preview reloads when it moves) and
 * `shipGates` (the ship panel).
 */
import {
  type AgentStepEventData,
  agentErrorEventDataSchema,
  agentStepEventDataSchema,
} from '@launch/shared/ai/agents'
import {
  type SessionEvent,
  SHIP_GATE_STEP_LABELS,
  type ShipGateStep,
  sessionBudgetReachedDataSchema,
  sessionShipGateDataSchema,
  sessionShipPrDataSchema,
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
 * The `seq` of the newest row after which the app's code may have changed — a finished, failed or
 * interrupted turn, or the dev server coming (back) up. The preview reloads whenever it moves. Pure.
 */
export function latestPreviewChangeSeq(events: readonly SessionEvent[]): number {
  let seq = 0
  for (const event of events) {
    if (
      (event.type === 'turn.end' ||
        event.type === 'turn.failed' ||
        event.type === 'turn.interrupted' ||
        event.type === 'preview.ready') &&
      event.seq > seq
    ) {
      seq = event.seq
    }
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
