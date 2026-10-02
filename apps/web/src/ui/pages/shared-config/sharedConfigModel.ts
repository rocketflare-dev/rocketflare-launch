/**
 * What the Secrets pages (shared resources) SAY (Launch P5, spec/09), decided here and nowhere else — pure, so
 * the list, the resource page, its panels and the tests describe one resource one way.
 *
 * - `valueLine(env)` — "Set — version 3, rotated 2 days ago by Carol" or "Not set": the most
 *   anyone ever sees of a value (plan §1.3);
 * - `missingKeys(items, env)` — items the active version does not carry (added after the last set);
 * - `pushProgress(push)` — the N/M bar's numbers and words;
 * - `PUSH_STATUS`, `PUSH_REASON`, `HOLDER_STATUS` — the badge tones and the words;
 * - `holderBehind(holder, env)` — a holder whose Worker still has an older version.
 */
import type {
  GrantPushReason,
  GrantPushStatus,
  GrantPushSummary,
  GrantStatus,
  SharedResourceEnvironment,
  SharedResourceHolder,
  SharedResourceItem,
} from '@launch/shared/launch-grants'
import { timeAgo } from '@/ui/lib/format'

type Person = { name: string | null; email: string } | null

export function personLabel(person: Person): string | null {
  if (!person) return null
  return person.name?.trim() || person.email
}

/** The one line that stands in for a value. */
export function valueLine(
  env: Pick<SharedResourceEnvironment, 'version' | 'setAt' | 'setBy'>
): string {
  if (env.version === null) return 'Not set'
  const parts = [`Set — version ${env.version}`]
  if (env.setAt) {
    const when = timeAgo(env.setAt)
    parts.push(env.version === 1 ? `set ${when}` : `rotated ${when}`)
  }
  const who = personLabel(env.setBy)
  const line = parts.join(', ')
  return who ? `${line} by ${who}` : line
}

/** Items the active version does not carry — only meaningful once a version exists. */
export function missingKeys(
  items: readonly Pick<SharedResourceItem, 'key'>[],
  env: Pick<SharedResourceEnvironment, 'version' | 'keysSet'>
): string[] {
  if (env.version === null) return []
  const set = new Set(env.keysSet)
  return items.map(item => item.key).filter(key => !set.has(key))
}

/** "1 app holds it" / "3 apps hold it" / "No app holds it yet". */
export function holdersLine(count: number): string {
  if (count === 0) return 'No app holds it yet'
  return count === 1 ? '1 app holds it' : `${count} apps hold it`
}

export const PUSH_STATUS: Record<GrantPushStatus, { tone: string; label: string }> = {
  queued: { tone: 'queued', label: 'Queued' },
  running: { tone: 'running', label: 'Pushing' },
  succeeded: { tone: 'completed', label: 'Done' },
  partial: { tone: 'blocked', label: 'Partly failed' },
  failed: { tone: 'failed', label: 'Failed' },
}

export const PUSH_REASON: Record<GrantPushReason, string> = {
  grant: 'New grant',
  rotate: 'Rotation',
  revoke: 'Revoke',
  expire: 'Expiry',
  repair: 'Repair after a deploy',
}

export const HOLDER_STATUS: Record<GrantStatus, { tone: string; label: string }> = {
  requested: { tone: 'awaiting-review', label: 'Requested' },
  active: { tone: 'active', label: 'Holds it' },
  revoking: { tone: 'running', label: 'Revoking' },
  revoked: { tone: 'revoked', label: 'Revoked' },
  rejected: { tone: 'rejected', label: 'Rejected' },
  expired: { tone: 'expired', label: 'Expired' },
}

/** Whether a push may be retried (the server's rule: a settled push that did not fully succeed). */
export function mayRetry(status: GrantPushStatus): boolean {
  return status === 'partial' || status === 'failed'
}

/** The bar's numbers: settled targets of all, and the words under it. */
export function pushProgress(
  push: Pick<GrantPushSummary, 'status' | 'total' | 'succeeded' | 'failed'>
): { value: number; max: number; label: string } {
  const max = Math.max(push.total, 0)
  const value = Math.min(push.succeeded + push.failed, max)
  if (push.status === 'queued') return { value: 0, max, label: 'Waiting to start' }
  if (max === 0) return { value: 0, max: 1, label: 'No app to update' }
  const noun = max === 1 ? 'app' : 'apps'
  const parts = [`${push.succeeded} of ${max} ${noun} updated`]
  if (push.failed > 0) parts.push(`${push.failed} failed`)
  return { value, max, label: parts.join(' · ') }
}

/** A holder whose Worker has an older version than the environment's active one. */
export function holderBehind(
  holder: Pick<SharedResourceHolder, 'status' | 'pushedVersion' | 'environment'>,
  envs: readonly Pick<SharedResourceEnvironment, 'environment' | 'version'>[]
): boolean {
  if (holder.status !== 'active') return false
  const active = envs.find(env => env.environment === holder.environment)?.version ?? null
  if (active === null || holder.pushedVersion === null) return false
  return holder.pushedVersion < active
}
