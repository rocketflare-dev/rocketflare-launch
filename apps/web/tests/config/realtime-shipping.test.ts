/**
 * Shipping in real time: the contract of the nudges a ship, a landing and a release send
 * (`entity.changed { entity, id, appId? }`), what `invalidationsFor` makes of them — the named row's
 * queries, never a sibling's — and the polling decisions, which slow to a fallback while the
 * realtime socket is open and keep today's pace while it is not.
 */
import { RELEASE_REALTIME_ENTITY } from '@launch/shared/launch-releases'
import { SESSION_REALTIME_ENTITY } from '@launch/shared/launch-sessions'
import {
  entityChangedPayloadSchema,
  invalidationsFor,
  type RealtimeEvent,
  realtimeEventSchema,
} from '@launch/shared/realtime'
import { describe, expect, it } from 'vitest'
import {
  APPROVAL_APPLY_CONNECTED_POLL_MS,
  APPROVAL_APPLY_POLL_MS,
  approvalPollInterval,
} from '@/ui/hooks/useApprovals'
import {
  PROMOTION_FOLLOW_POLL_MS,
  promotionPollInterval,
  RELEASES_CONNECTED_POLL_MS,
  RELEASES_POLL_MS,
  releasesPollInterval,
} from '@/ui/hooks/useReleases'
import {
  SESSION_CONNECTED_POLL_MS,
  SESSION_LANDING_CONNECTED_POLL_MS,
  SESSION_LANDING_POLL_MS,
  SESSION_POLL_MS,
  SESSION_PR_CONNECTED_POLL_MS,
  SESSION_PR_POLL_MS,
  sessionListPollInterval,
  sessionPollInterval,
  sessionPrPollInterval,
} from '@/ui/hooks/useSessions'

const TENANT = '00000000-0000-4000-8000-000000000001'
const SESSION = '00000000-0000-4000-8000-0000000000a1'
const RELEASE = '00000000-0000-4000-8000-0000000000b1'
const APP = '00000000-0000-4000-8000-0000000000c1'

const entityEvent = (payload: unknown): RealtimeEvent =>
  realtimeEventSchema.parse({
    type: 'entity.changed',
    tenantId: TENANT,
    at: new Date().toISOString(),
    payload,
  })

describe('the shipping nudges (contract)', () => {
  it('carries ids only: entity, the row id and, for a per-app row, the app id', () => {
    expect(
      entityChangedPayloadSchema.parse({ entity: RELEASE_REALTIME_ENTITY, id: RELEASE, appId: APP })
    ).toEqual({ entity: 'release', id: RELEASE, appId: APP })
    // A deploy run names its app, not a release (`nudgeDeployMoved`).
    expect(entityChangedPayloadSchema.parse({ entity: 'release', appId: APP })).toEqual({
      entity: 'release',
      appId: APP,
    })
    expect(entityChangedPayloadSchema.safeParse({ entity: '' }).success).toBe(false)
    expect(entityChangedPayloadSchema.safeParse({ entity: 'release', appId: 7 }).success).toBe(
      false
    )
  })

  it('a session nudge refreshes that session and the lists, never another session', () => {
    expect(invalidationsFor(entityEvent({ entity: SESSION_REALTIME_ENTITY, id: SESSION }))).toEqual(
      [
        ['session', 'detail', SESSION],
        ['session', 'pr', SESSION],
        ['session', 'events', SESSION],
        ['session', 'app'],
        ['session', 'admin'],
      ]
    )
    // Without a row, the whole family.
    expect(invalidationsFor(entityEvent({ entity: 'session' }))).toEqual([['session']])
  })

  it("a release nudge refreshes that app's card, strip and compare, and the release's own keys", () => {
    expect(invalidationsFor(entityEvent({ entity: 'release', id: RELEASE, appId: APP }))).toEqual([
      ['release', 'app', APP],
      ['release', 'promotion', APP],
      ['release', 'compare', APP],
      ['release', 'detail', RELEASE],
      ['release', 'chain', RELEASE],
    ])
    expect(invalidationsFor(entityEvent({ entity: 'release', appId: APP }))).toEqual([
      ['release', 'app', APP],
      ['release', 'promotion', APP],
      ['release', 'compare', APP],
    ])
    // No app named: every app's release views (the old behaviour).
    expect(invalidationsFor(entityEvent({ entity: 'release', id: RELEASE }))).toEqual([['release']])
  })

  it('leaves every other entity at its root', () => {
    expect(invalidationsFor(entityEvent({ entity: 'apps', id: APP }))).toEqual([['apps']])
    expect(invalidationsFor(entityEvent({ entity: 'approval', id: 'x' }))).toEqual([['approval']])
  })
})

describe('polling while the socket is open vs closed', () => {
  const base = { pendingMessage: false, requestedAction: null } as const
  const landing = (stage: string) => ({ stage }) as never

  it('a moving session polls at the fallback pace when connected', () => {
    const working = { ...base, status: 'working' } as const
    expect(sessionPollInterval(working, false)).toBe(SESSION_POLL_MS)
    expect(sessionPollInterval(working, true)).toBe(SESSION_CONNECTED_POLL_MS)
    expect(sessionPollInterval(working)).toBe(SESSION_POLL_MS)
    // A settled or person-parked one never, connected or not.
    expect(sessionPollInterval({ ...base, status: 'ready' }, true)).toBe(false)
    expect(
      sessionPollInterval({ ...base, status: 'shipping', landing: landing('approval') }, true)
    ).toBe(false)
  })

  it('a landing polls at its own fallback pace when connected', () => {
    const deploying = { ...base, status: 'shipped', landing: landing('deploying') } as const
    expect(sessionPollInterval(deploying, false)).toBe(SESSION_LANDING_POLL_MS)
    expect(sessionPollInterval(deploying, true)).toBe(SESSION_LANDING_CONNECTED_POLL_MS)
    expect(
      sessionPollInterval({ ...base, status: 'shipped', landing: landing('live') }, true)
    ).toBe(false)
  })

  it('session lists and the PR panel slow down when connected', () => {
    expect(sessionListPollInterval([{ status: 'shipping' }], false)).toBe(SESSION_POLL_MS)
    expect(sessionListPollInterval([{ status: 'shipping' }], true)).toBe(SESSION_CONNECTED_POLL_MS)
    expect(sessionListPollInterval([{ status: 'ready' }], true)).toBe(false)
  })

  it('a listed ship in flight counts as moving, at the landing’s pace; one parked on a person does not', () => {
    const ship = (waitingOn: 'review' | 'retry' | null, stage = 'deploying') =>
      ({ stage, waitingOn }) as never
    // After the merge the row is `shipped` — settled — yet its landing still moves.
    expect(sessionListPollInterval([{ status: 'shipped', shipping: ship(null) }], false)).toBe(
      SESSION_LANDING_POLL_MS
    )
    expect(sessionListPollInterval([{ status: 'shipped', shipping: ship(null) }], true)).toBe(
      SESSION_LANDING_CONNECTED_POLL_MS
    )
    // A review and a stall wait on a person: their nudges move them, not a poll.
    expect(
      sessionListPollInterval([{ status: 'shipping', shipping: ship('review', 'approval') }])
    ).toBe(false)
    expect(
      sessionListPollInterval([{ status: 'shipped', shipping: ship('retry', 'stalled') }])
    ).toBe(false)
    // A booting row beside a landing keeps the faster pace.
    expect(
      sessionListPollInterval([
        { status: 'shipped', shipping: ship(null) },
        { status: 'booting', shipping: null },
      ])
    ).toBe(SESSION_POLL_MS)
    // The gate (no landing yet) is still `shipping` and moving.
    expect(sessionListPollInterval([{ status: 'shipping', shipping: null }])).toBe(SESSION_POLL_MS)

    const pending = { checks: { state: 'pending' } } as never
    const green = { checks: { state: 'success' } } as never
    expect(sessionPrPollInterval(pending, false)).toBe(SESSION_PR_POLL_MS)
    expect(sessionPrPollInterval(pending, true)).toBe(SESSION_PR_CONNECTED_POLL_MS)
    // Not read yet: still owed.
    expect(sessionPrPollInterval({ checks: null }, true)).toBe(SESSION_PR_CONNECTED_POLL_MS)
    expect(sessionPrPollInterval({ checks: null })).toBe(SESSION_PR_POLL_MS)
    expect(sessionPrPollInterval(green, false)).toBe(false)
    expect(sessionPrPollInterval(undefined, false)).toBe(false)
  })

  it('releases and the pipeline strip slow down when connected; the tag run keeps its pace', () => {
    expect(releasesPollInterval([{ status: 'staging' }], false)).toBe(RELEASES_POLL_MS)
    expect(releasesPollInterval([{ status: 'staging' }], true)).toBe(RELEASES_CONNECTED_POLL_MS)
    expect(releasesPollInterval([{ status: 'staging_active' }], true)).toBe(false)

    const strip = (status: string) => ({ candidate: { status } }) as never
    expect(promotionPollInterval(strip('tagged'), false)).toBe(RELEASES_POLL_MS)
    // The strip's read follows the tag's deploy run on GitHub: it keeps the server's 20 s window.
    expect(promotionPollInterval(strip('tagged'), true)).toBe(PROMOTION_FOLLOW_POLL_MS)
    expect(promotionPollInterval(strip('staging'), true)).toBe(PROMOTION_FOLLOW_POLL_MS)
    expect(promotionPollInterval(strip('promoting'), true)).toBe(RELEASES_CONNECTED_POLL_MS)
    expect(promotionPollInterval(strip('staging_active'), true)).toBe(false)
    expect(promotionPollInterval({ candidate: null }, true)).toBe(false)
  })

  it("an approval's owed apply slows down when connected", () => {
    const owed = { status: 'approved', appliedAt: null, applyError: null } as const
    expect(approvalPollInterval(owed, false)).toBe(APPROVAL_APPLY_POLL_MS)
    expect(approvalPollInterval(owed, true)).toBe(APPROVAL_APPLY_CONNECTED_POLL_MS)
    expect(approvalPollInterval({ ...owed, status: 'pending' }, true)).toBe(false)
  })

  it('every connected interval is slower than its disconnected one', () => {
    expect(SESSION_CONNECTED_POLL_MS).toBeGreaterThan(SESSION_POLL_MS)
    expect(SESSION_LANDING_CONNECTED_POLL_MS).toBeGreaterThan(SESSION_LANDING_POLL_MS)
    expect(SESSION_PR_CONNECTED_POLL_MS).toBeGreaterThan(SESSION_PR_POLL_MS)
    expect(RELEASES_CONNECTED_POLL_MS).toBeGreaterThan(RELEASES_POLL_MS)
    expect(PROMOTION_FOLLOW_POLL_MS).toBeGreaterThan(RELEASES_POLL_MS)
    expect(APPROVAL_APPLY_CONNECTED_POLL_MS).toBeGreaterThan(APPROVAL_APPLY_POLL_MS)
  })
})
