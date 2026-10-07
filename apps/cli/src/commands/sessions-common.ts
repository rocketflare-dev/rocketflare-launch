/**
 * What `sessions.ts` (start, say, ship…) and `sessions-debug.ts` (show, logs, the debug actions)
 * both read: the session's path, the session itself and its durable event log, all pages.
 */
import {
  type Session,
  type SessionEvent,
  sessionDetailResponseSchema,
  sessionEventsResponseSchema,
} from '@launch/shared/launch-sessions'
import type { ApiClient } from '../api'

export const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export const sessionPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`

/** `$1.23` from microcents. Pure. */
export const usd = (microcents: number) => `$${(microcents / 100_000_000).toFixed(2)}`

/** `0.4s`, `12.3s` — a boot phase's duration. Pure. */
export const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`

export async function getSession(client: ApiClient, id: string): Promise<Session> {
  return (await client.get(sessionPath(id), { schema: sessionDetailResponseSchema })).session
}

/** Every row after `afterSeq`, all pages. */
export async function readEventsAfter(
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
