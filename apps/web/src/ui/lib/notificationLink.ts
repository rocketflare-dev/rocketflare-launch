/**
 * Where a notification goes when you click it.
 *
 * The bell and `/notifications` both render rows whose whole purpose is "something needs you", and
 * until now neither read `data` at all — every row landed on the list itself, which is one more
 * click and no context. `type` + `data` is the deep link, and the mapping is a pure function of
 * them so both surfaces cannot drift.
 *
 * A type with no useful destination returns `null` and the row stays unclickable. That is the
 * honest answer for `access_request_decided`: the decision IS the notification, and the requester
 * has no page to open.
 */
import { APPROVAL_NOTIFICATION_TYPES, approvalPath } from '@launch/shared/launch-approvals'
import type { Notification } from '@launch/shared/notifications'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const id = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value : null

export function notificationLink(notification: Pick<Notification, 'type' | 'data'>): string | null {
  switch (notification.type) {
    // issue #17: an agent parked on a question. The run page is where it is answered, in front of
    // the timeline that explains why it is being asked.
    case 'agent_run_awaiting_input': {
      const runId = id(notification.data.runId)
      return runId ? `/agents/runs/${runId}` : null
    }
    // Launch P4: an approval was requested of you, or yours was decided or expired. The request's
    // page is where it is decided (or read), with the context that explains it.
    case APPROVAL_NOTIFICATION_TYPES.requested:
    case APPROVAL_NOTIFICATION_TYPES.decided:
    case APPROVAL_NOTIFICATION_TYPES.expired: {
      const approvalId = id(notification.data.approvalId)
      return approvalId ? approvalPath(approvalId) : null
    }
    default:
      return null
  }
}
