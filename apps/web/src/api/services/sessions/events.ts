/**
 * The Workflow's side of the session event log (Launch P3, plan §2): an emitter for the lifecycle
 * steps (boot progress, `preview.ready`, status changes, errors), the realtime nudge, and the one
 * sentence-maker for a failure a person will read.
 *
 * The log itself is `event-log.ts` — the reads, the batched writer a turn uses, and
 * `appendSessionEvents` (`seq = max + 1`, one INSERT). The Workflow is the ONE writer,
 * and only one step runs at a time per session, so the read-then-insert cannot interleave; this
 * emitter is `appendSessionEvents` plus the `entity.changed { entity: 'session', id }` nudge.
 *
 * **No secret ever goes in `data`.** The events are what the page, the CLI and the audit replay
 * show; a step hands in ids, counts, labels and `safeErrorMessage` sentences only.
 */
import { SESSION_REALTIME_ENTITY, type SessionEventInput } from '@launch/shared/launch-sessions'
import type { Database } from '../../../db/client'
import { nudge, type Realtime, realtimeEvent } from '../realtime'
import { appendSessionEvents } from './event-log'
import { redactModelKeyText } from './model-key'

export interface SessionRef {
  id: string
  tenantId: string
}

/** Appends to one session's log (one INSERT for a batch), then nudges. */
export type SessionEmitter = (
  events: SessionEventInput | readonly SessionEventInput[]
) => Promise<void>

/** Nudge the session's page: something about `session` changed. */
export function nudgeSession(realtime: Realtime | undefined, session: SessionRef): void {
  nudge(
    realtime,
    realtimeEvent('entity.changed', session.tenantId, {
      entity: SESSION_REALTIME_ENTITY,
      id: session.id,
    })
  )
}

export function createSessionEmitter(
  db: Database,
  session: SessionRef,
  realtime?: Realtime
): SessionEmitter {
  return async input => {
    const list = (Array.isArray(input) ? input : [input]) as SessionEventInput[]
    if (list.length === 0) return
    await appendSessionEvents(db, session, list)
    nudgeSession(realtime, session)
  }
}

/**
 * A short, secret-free message for an event or `sessions.error`: the first line of the error, with
 * anything that looks like a connection string, a model key or a GitHub token masked. A step's
 * failure text is shown to the person on the session page, so it must never carry a credential a
 * vendor or a child process echoed.
 */
export function safeErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const text = raw.trim()
  if (!text) return fallback
  return redactModelKeyText(text)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"@/]*:[^\s'"@/]*@[^\s'"]*/gi, '<connection string>')
    .replace(/\b(gh[psuor]_[A-Za-z0-9]{8,}|x-access-token:[^\s@]+)/g, '<secret>')
    .slice(0, 600)
}
