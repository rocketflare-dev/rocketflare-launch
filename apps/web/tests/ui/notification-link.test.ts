/**
 * `notificationLink` — where a notification goes when clicked. Launch P4 adds the three approval
 * types, all of which open the request (`approvalPath`); a malformed id is no link at all.
 */
import {
  APPROVAL_NOTIFICATION_TYPES,
  APPROVAL_REALTIME_ENTITY,
} from '@launch/shared/launch-approvals'
import {
  APP_CONFIG_REALTIME_ENTITY,
  GRANT_NOTIFICATION_TYPES,
  GRANT_PUSH_REALTIME_ENTITY,
  SHARED_RESOURCE_REALTIME_ENTITY,
} from '@launch/shared/launch-grants'
import { RELEASE_REALTIME_ENTITY } from '@launch/shared/launch-releases'
import { describe, expect, it } from 'vitest'
import { notificationLink } from '@/ui/lib/notificationLink'
import { queryKeys } from '@/ui/lib/query-keys'

const ID = '6f1c1a3e-2b1f-4d5e-9a3b-1c2d3e4f5a6b'

describe('notificationLink', () => {
  it('sends every approval notification to the request', () => {
    for (const type of Object.values(APPROVAL_NOTIFICATION_TYPES)) {
      expect(notificationLink({ type, data: { approvalId: ID, kind: 'app.access' } })).toBe(
        `/approvals/${ID}`
      )
      expect(notificationLink({ type, data: { approvalId: 'nope' } })).toBeNull()
    }
  })

  it('sends P5 grant notifications to the app config page or the resource page', () => {
    for (const type of [GRANT_NOTIFICATION_TYPES.needed, GRANT_NOTIFICATION_TYPES.expiring]) {
      expect(notificationLink({ type, data: { appId: ID, appSlug: 'shop' } })).toBe(
        '/apps/shop/config'
      )
      // A slug is a slug, never a path smuggled in through `data`.
      expect(notificationLink({ type, data: { appSlug: '../admin' } })).toBeNull()
      expect(notificationLink({ type, data: {} })).toBeNull()
    }
    for (const type of [
      GRANT_NOTIFICATION_TYPES.pushFailed,
      GRANT_NOTIFICATION_TYPES.rotationDue,
      GRANT_NOTIFICATION_TYPES.rotated,
    ]) {
      expect(notificationLink({ type, data: { resourceId: ID } })).toBe(`/secrets/${ID}`)
      expect(notificationLink({ type, data: { resourceId: 'nope' } })).toBeNull()
    }
  })

  it('still links an agent run and nothing else', () => {
    expect(notificationLink({ type: 'agent_run_awaiting_input', data: { runId: ID } })).toBe(
      `/agents/runs/${ID}`
    )
    expect(notificationLink({ type: 'access_request_decided', data: {} })).toBeNull()
  })
})

describe('P4 query keys', () => {
  it('the approvals and releases roots ARE the realtime entities the server nudges', () => {
    expect(queryKeys.approvals.all).toEqual([APPROVAL_REALTIME_ENTITY])
    expect(queryKeys.releases.all).toEqual([RELEASE_REALTIME_ENTITY])
    expect(queryKeys.approvals.detail(ID).slice(0, 1)).toEqual([APPROVAL_REALTIME_ENTITY])
    expect(queryKeys.releases.chain(ID).slice(0, 1)).toEqual([RELEASE_REALTIME_ENTITY])
  })

  it('the P5 roots are the realtime entities the grants services nudge', () => {
    expect(queryKeys.sharedResources.all).toEqual([SHARED_RESOURCE_REALTIME_ENTITY])
    expect(queryKeys.grantPushes.all).toEqual([GRANT_PUSH_REALTIME_ENTITY])
    expect(queryKeys.appConfig.all).toEqual([APP_CONFIG_REALTIME_ENTITY])
    expect(queryKeys.grantPushes.detail(ID).slice(0, 1)).toEqual([GRANT_PUSH_REALTIME_ENTITY])
    expect(queryKeys.appConfig.detail(ID).slice(0, 1)).toEqual([APP_CONFIG_REALTIME_ENTITY])
  })
})
