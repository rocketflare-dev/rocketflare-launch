/**
 * A coding session's status as the kit's `.status-badge` (Launch P3). The words are for a person
 * ("asleep", not `suspended`; "over budget", not `blocked`), the tone is `data-status` in
 * `index.css`, and — as with `RunStatusBadge` — only a session the server is actively moving
 * pulses and announces itself: `ready`, `blocked` and `suspended` wait on a person.
 *
 * Markdown-free and light on purpose: the app page's sessions card and the admin list import it,
 * and neither may pull the session page's chunk in with it.
 */
import type { SessionStatus } from '@launch/shared/launch-sessions'
import { sessionIsMoving } from '@/ui/hooks/useSessions'

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  requested: 'Starting',
  booting: 'Starting',
  ready: 'Ready',
  working: 'Working',
  blocked: 'Over budget',
  suspended: 'Asleep',
  shipping: 'Shipping',
  shipped: 'Shipped',
  ending: 'Ending',
  ended: 'Ended',
  failed: 'Failed',
}

const TONE: Record<SessionStatus, string> = {
  requested: 'queued',
  booting: 'running',
  ready: 'active',
  working: 'running',
  blocked: 'blocked',
  suspended: 'suspended',
  shipping: 'running',
  shipped: 'completed',
  ending: 'pending',
  ended: 'archived',
  failed: 'failed',
}

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  const live = sessionIsMoving(status)
  return (
    <span
      className={`status-badge ${live ? 'animate-pulse' : ''}`}
      data-status={TONE[status]}
      data-session-status={status}
      aria-live={live ? 'polite' : undefined}
    >
      {SESSION_STATUS_LABELS[status]}
    </span>
  )
}
