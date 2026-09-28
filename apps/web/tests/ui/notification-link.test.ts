/**
 * `notificationLink` — where a notification goes when clicked. Launch P4 adds the three approval
 * types, all of which open the request (`approvalPath`); a malformed id is no link at all.
 */
import {
  APPROVAL_NOTIFICATION_TYPES,
  APPROVAL_REALTIME_ENTITY,
} from '@launch/shared/launch-approvals'
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
})
