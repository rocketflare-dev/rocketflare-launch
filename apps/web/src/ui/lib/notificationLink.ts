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
import {
  appConfigPath,
  GRANT_NOTIFICATION_TYPES,
  sharedResourcePath,
} from '@launch/shared/launch-grants'
import type { Notification } from '@launch/shared/notifications'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const id = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value : null

/** An app slug as spec/04 spells one — never a path fragment smuggled in through `data`. */
const SLUG = /^[a-z][a-z0-9-]{0,62}$/

const slug = (value: unknown): string | null =>
  typeof value === 'string' && SLUG.test(value) ? value : null

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
    // Launch P5: an app needs a secret (shared config), or one of its grants is about to lapse — the app's
    // config page is where it is requested (or renewed).
    case GRANT_NOTIFICATION_TYPES.needed:
    case GRANT_NOTIFICATION_TYPES.expiring: {
      const appSlug = slug(notification.data.appSlug)
      return appSlug ? appConfigPath(appSlug) : null
    }
    // Launch P5: a push failed for some holders, a secret is due for rotation, or a rotation
    // reached everyone (revoke the old credential at the vendor) — the resource's page is where
    // the owners retry, set new values or read the push.
    case GRANT_NOTIFICATION_TYPES.pushFailed:
    case GRANT_NOTIFICATION_TYPES.rotationDue:
    case GRANT_NOTIFICATION_TYPES.rotated: {
      const resourceId = id(notification.data.resourceId)
      return resourceId ? sharedResourcePath(resourceId) : null
    }
    default:
      return null
  }
}
