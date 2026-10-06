/**
 * A coding session's event log, read back as AG-UI (Launch P3, slice 3c) — the session's twin of
 * `services/agents/agui-projection.ts`, and a PROJECTION in the same sense: `session_events` stays
 * the durable record, written by the Workflow alone, and this maps it at read time. Nothing in the
 * turn runner knows AG-UI exists.
 *
 * One session is one AG-UI thread and one long "run" (`threadId` = `runId` = the session id): it
 * opens with `RUN_STARTED` + `STATE_SNAPSHOT` and only ends when the SESSION does — `RUN_FINISHED`
 * for `shipped` / `ended`, `RUN_ERROR` (`session_failed`) for `failed`. A turn is a STEP inside it:
 *
 * | row                  | frames                                                          |
 * |----------------------|-----------------------------------------------------------------|
 * | `user.message`       | `TEXT_MESSAGE_START (role user) → CONTENT → END`               |
 * | `turn.start`         | `STEP_STARTED turn#N`                                           |
 * | `text`               | `TEXT_MESSAGE_START (assistant) → CONTENT → END`               |
 * | `tool.start`         | `TOOL_CALL_START → ARGS → END`                                  |
 * | `tool.end`           | `TOOL_CALL_RESULT` (paired on the model's `toolCallId`)        |
 * | `turn.end` / `turn.failed` / `turn.interrupted` | `STEP_FINISHED turn#N` + the row as `launch.session.event` |
 * | `step`               | `STEP_STARTED`/`STEP_FINISHED` + `kit.agent.step` (as a run's); a `running` row for an open step is progress: `kit.agent.step` only |
 * | everything else      | the row as `launch.session.event`                               |
 *
 * `launch.session.event` is LAUNCH's CUSTOM event (an app's own prefix, never `kit.`): its value is
 * the row itself (`sessionEventSchema`'s shape, `at` as ISO), so the session page folds the facts
 * AG-UI has no event for — the preview is ready, the budget was reached, the ship gate's result, the
 * PR — from the one stream, and a third-party client ignores it for free.
 *
 * Pure: no database, no clock. Every AG-UI id derives from a row id, so two projections of the
 * same log are byte-identical and a replayed group is harmless (the stream's rule 1).
 */
import { AguiEventType, KIT_CUSTOM_EVENTS, type KitAguiEvent } from '@launch/shared/ai/agui'
import {
  SESSION_CUSTOM_EVENTS,
  type SessionEvent,
  type SessionStatus,
  TERMINAL_SESSION_STATUSES,
} from '@launch/shared/launch-sessions'
import { kitCustom } from '../ai/agui'

/** The rows whose facts travel as `launch.session.event` (with or without other frames). */
const CUSTOM_ROW_TYPES = new Set<SessionEvent['type']>([
  'turn.end',
  'turn.failed',
  'turn.interrupted',
  'status',
  'preview.ready',
  'budget.reached',
  'ship.gate',
  'ship.pr',
  'error',
  // P5: the shared config the PR needs (ShipPanel's "needs" line reads it from here).
  'ship.config_needs',
  // Issue #8: what each phase of a finished boot took.
  'boot.timing',
])

export interface SessionProjectionState {
  id: string
  status: SessionStatus
  error?: string | null
}

export interface SessionProjector {
  /** `RUN_STARTED` + `STATE_SNAPSHOT`. Only a stream starting from the beginning emits it. */
  head(): KitAguiEvent[]
  /** The frames for ONE row. */
  push(event: SessionEvent): KitAguiEvent[]
  /** The terminal event for the session AS IT IS NOW, or `[]` while it is still live. */
  finish(current: SessionProjectionState): KitAguiEvent[]
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined

const isTerminal = (status: SessionStatus) =>
  (TERMINAL_SESSION_STATUSES as readonly SessionStatus[]).includes(status)

/** The row as `launch.session.event` carries it. */
function customRow(event: SessionEvent): KitAguiEvent {
  return {
    type: AguiEventType.CUSTOM,
    name: SESSION_CUSTOM_EVENTS.event,
    value: {
      id: event.id,
      sessionId: event.sessionId,
      seq: event.seq,
      turn: event.turn,
      type: event.type,
      data: event.data,
      at: new Date(event.at).toISOString(),
    },
  }
}

export function createSessionProjector(session: SessionProjectionState): SessionProjector {
  /** Open `tool.start`s by the model's call id (or the tool name), → the start row's id. */
  const openToolCalls = new Map<string, string>()
  /** Boot steps with a `STEP_STARTED` and no `STEP_FINISHED` yet, by key. */
  const openSteps = new Set<string>()
  let lastMessageId = session.id

  const textGroup = (
    messageId: string,
    role: 'user' | 'assistant',
    text: string
  ): KitAguiEvent[] => [
    { type: AguiEventType.TEXT_MESSAGE_START, messageId, role },
    { type: AguiEventType.TEXT_MESSAGE_CONTENT, messageId, delta: text },
    { type: AguiEventType.TEXT_MESSAGE_END, messageId },
  ]

  return {
    head: () => [
      { type: AguiEventType.RUN_STARTED, threadId: session.id, runId: session.id },
      {
        type: AguiEventType.STATE_SNAPSHOT,
        snapshot: { sessionId: session.id, status: session.status },
      },
    ],

    push(event) {
      const out: KitAguiEvent[] = []
      const data = asRecord(event.data)
      switch (event.type) {
        case 'user.message': {
          const text = asString(data.text)
          if (text) out.push(...textGroup(event.id, 'user', text))
          break
        }
        case 'turn.start':
          out.push({ type: AguiEventType.STEP_STARTED, stepName: `turn#${event.turn}` })
          break
        case 'turn.end':
        case 'turn.failed':
        case 'turn.interrupted':
          out.push({ type: AguiEventType.STEP_FINISHED, stepName: `turn#${event.turn}` })
          break
        case 'text': {
          const text = asString(data.text)
          if (!text) break
          lastMessageId = event.id
          out.push(...textGroup(event.id, 'assistant', text))
          break
        }
        case 'tool.start': {
          const name = asString(data.name) ?? 'tool'
          openToolCalls.set(asString(data.toolCallId) ?? name, event.id)
          out.push(
            {
              type: AguiEventType.TOOL_CALL_START,
              toolCallId: event.id,
              toolCallName: name,
              parentMessageId: lastMessageId,
            },
            {
              type: AguiEventType.TOOL_CALL_ARGS,
              toolCallId: event.id,
              delta: JSON.stringify(data.input ?? {}),
            },
            { type: AguiEventType.TOOL_CALL_END, toolCallId: event.id }
          )
          break
        }
        case 'tool.end': {
          const key = asString(data.toolCallId) ?? asString(data.name) ?? 'tool'
          const toolCallId = openToolCalls.get(key) ?? event.id
          openToolCalls.delete(key)
          out.push({
            type: AguiEventType.TOOL_CALL_RESULT,
            messageId: event.id,
            toolCallId,
            content: JSON.stringify(data),
            role: 'tool',
          })
          break
        }
        case 'step': {
          const name = asString(data.key) ?? 'step'
          const status = asString(data.status) ?? 'running'
          // A `running` row for a step already open is PROGRESS (its detail changed): no second
          // STEP_STARTED, only the `kit.agent.step` that carries the new detail.
          const progress = status === 'running' && openSteps.has(name)
          if (status === 'running') openSteps.add(name)
          else openSteps.delete(name)
          if (!progress) {
            out.push({
              type: status === 'running' ? AguiEventType.STEP_STARTED : AguiEventType.STEP_FINISHED,
              stepName: name,
            })
          }
          out.push(
            kitCustom(KIT_CUSTOM_EVENTS.agentStep, {
              key: name,
              label: asString(data.label) ?? name,
              status: status === 'done' || status === 'error' ? status : 'running',
              ...(asString(data.detail) ? { detail: asString(data.detail) } : {}),
            })
          )
          break
        }
        default:
          break
      }
      if (CUSTOM_ROW_TYPES.has(event.type)) out.push(customRow(event))
      return out
    },

    finish(current) {
      if (!isTerminal(current.status)) return []
      if (current.status === 'failed') {
        return [
          {
            type: AguiEventType.RUN_ERROR,
            message: current.error ?? 'The session failed',
            code: 'session_failed',
          },
        ]
      }
      return [
        {
          type: AguiEventType.RUN_FINISHED,
          threadId: current.id,
          runId: current.id,
          result: { status: current.status },
        },
      ]
    },
  }
}

/** The whole log at once — a fold over the projector, so a read and a tail cannot disagree. */
export function projectSessionToAgui(
  session: SessionProjectionState,
  events: SessionEvent[]
): KitAguiEvent[] {
  const projector = createSessionProjector(session)
  return [
    ...projector.head(),
    ...events.flatMap(event => projector.push(event)),
    ...projector.finish(session),
  ]
}
