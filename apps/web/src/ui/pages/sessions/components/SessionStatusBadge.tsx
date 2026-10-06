/**
 * A coding session's status as the kit's `.status-badge` (Launch P3). The words are for a person
 * ("asleep", not `suspended`; "over budget", not `blocked`), the tone is `data-status` in
 * `index.css`, and — as with `RunStatusBadge` — only a session the server is actively moving
 * pulses and announces itself: `ready`, `blocked` and `suspended` wait on a person.
 *
 * Markdown-free and light on purpose: the app page's sessions card and the admin list import it,
 * and neither may pull the session page's chunk in with it.
 */

import type {
  SessionShipping,
  SessionShippingWait,
  SessionStatus,
} from '@launch/shared/launch-sessions'
import { shippingChipText } from '@launch/shared/launch-ship-progress'
import { sessionIsMoving, shippingIsMoving } from '@/ui/hooks/useSessions'

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

/** A ship in flight's tone: moving, parked on a reviewer, or stalled on a person. */
const SHIPPING_TONE: Record<'moving' | SessionShippingWait, string> = {
  moving: 'running',
  review: 'pending',
  retry: 'blocked',
}

/**
 * `shipping` (the summary's derived ship in flight, when the caller has it) wins over the status:
 * after the merge the row is `shipped` while the landing still releases and deploys, and the
 * badge names the stage until it is live — "Checks running", "In review", "Releasing",
 * "Deploying", "Needs you" (`shippingChipText`, issue #22: the words the session page and the CLI
 * use) — pulsing only while Launch moves it.
 */
export function SessionStatusBadge({
  status,
  shipping = null,
}: {
  status: SessionStatus
  shipping?: Pick<SessionShipping, 'waitingOn' | 'stage'> | null
}) {
  const live = shipping ? shippingIsMoving(shipping) : sessionIsMoving(status)
  const tone = shipping ? SHIPPING_TONE[shipping.waitingOn ?? 'moving'] : TONE[status]
  return (
    <span
      className={`status-badge ${live ? 'animate-pulse' : ''}`}
      data-status={tone}
      data-session-status={status}
      data-shipping={shipping ? (shipping.waitingOn ?? 'moving') : undefined}
      aria-live={live ? 'polite' : undefined}
    >
      {shipping ? shippingChipText(shipping) : SESSION_STATUS_LABELS[status]}
    </span>
  )
}
