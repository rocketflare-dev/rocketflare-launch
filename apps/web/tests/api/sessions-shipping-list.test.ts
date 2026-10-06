/**
 * A ship in flight stays in the `active` lists whatever the session's status (the bug: after the
 * merge a session is `shipped` — settled — while its landing still releases, deploys, or waits on
 * a person, and the app page showed nothing). `shipping` is DERIVED from `status` + `landing`
 * (`sessionShippingOf`), and the lists' SQL (`shipInFlightSql`) is the same predicate:
 *
 * - a `shipped` row whose landing is `releasing` / `deploying`, or stalled BEFORE its release
 *   (`main_ci_failed`, `release_failed` — a person moves it on), is listed with its stage;
 * - a `shipping` row parked on a review is listed and says it waits on a `review`;
 * - live, `pr`-mode, a stall after the release, and an ended session are not;
 * - another organisation's in-flight ship never appears.
 */
import {
  adminSessionListResponseSchema,
  type SessionLanding,
  type SessionStatus,
  sessionDetailResponseSchema,
  sessionLandingSchema,
  sessionListResponseSchema,
} from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'
import {
  createTestGlobalAdmin,
  createTestSession,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { json, request } from '../helpers/request'
import { insertSession, seedSessionApp } from '../helpers/sessions'

const db = setupTestDatabase()

const APPROVAL = '00000000-0000-4000-8000-00000000e001'

function landing(over: Partial<SessionLanding>): SessionLanding {
  const at = new Date().toISOString()
  return sessionLandingSchema.parse({
    mode: 'staging',
    stage: 'ci',
    prNumber: 7,
    gateSha: 'a'.repeat(40),
    startedAt: at,
    stageAt: at,
    reviewMode: 'none',
    ...over,
  })
}

const listOf = async (appId: string, cookie: Record<string, string>, scope = 'active') =>
  sessionListResponseSchema.parse(
    await json(await request(`/api/apps/${appId}/sessions?scope=${scope}`, { headers: cookie }))
  ).items

describe('GET /api/apps/:id/sessions?scope=active — a ship in flight', () => {
  it('lists a merged landing still releasing, deploying or stalled before its release; not a finished one', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const add = (title: string, status: SessionStatus, l: Partial<SessionLanding> | null) =>
      insertSession(db, f, { title, status, landing: l ? landing(l) : null })

    const releasing = await add('releasing', 'shipped', { stage: 'releasing', mergeSha: 'b1' })
    const deploying = await add('deploying', 'shipped', {
      stage: 'deploying',
      version: '1.4.2',
      mergeSha: 'b2',
    })
    const mainCi = await add('main ci', 'shipped', {
      stage: 'stalled',
      stalledReason: 'main_ci_failed',
    })
    const review = await add('review', 'shipping', {
      stage: 'approval',
      reviewMode: 'app_owners',
      approvalId: APPROVAL,
      containerReleased: true,
    })
    // Finished: none of these is in flight.
    await add('live', 'shipped', { stage: 'live' })
    await add('pr mode', 'shipped', { mode: 'pr', stage: 'pr' })
    await add('deploy failed', 'shipped', { stage: 'stalled', stalledReason: 'deploy_failed' })
    await add('ended', 'ended', null)
    await add('shipped before issue 5', 'shipped', null)

    const items = await listOf(f.app.id, f.cookie)
    expect(items.map(i => i.title).sort()).toEqual(
      ['deploying', 'main ci', 'releasing', 'review'].sort()
    )
    const byId = new Map(items.map(i => [i.id, i]))
    expect(byId.get(releasing.id)).toMatchObject({
      status: 'shipped',
      shipping: { stage: 'releasing', waitingOn: null, prNumber: 7 },
    })
    expect(byId.get(deploying.id)?.shipping).toMatchObject({
      stage: 'deploying',
      version: '1.4.2',
      waitingOn: null,
    })
    expect(byId.get(mainCi.id)?.shipping).toMatchObject({
      stage: 'stalled',
      stalledReason: 'main_ci_failed',
      waitingOn: 'retry',
    })
    expect(byId.get(review.id)).toMatchObject({
      status: 'shipping',
      shipping: { stage: 'approval', waitingOn: 'review', approvalId: APPROVAL },
    })

    // `all` lists everything, and a finished ship carries no `shipping`.
    const all = await listOf(f.app.id, f.cookie, 'all')
    expect(all).toHaveLength(9)
    expect(all.find(i => i.title === 'live')?.shipping).toBeNull()
    expect(all.find(i => i.title === 'deploy failed')?.shipping).toBeNull()

    // The detail says the same.
    const detail = sessionDetailResponseSchema.parse(
      await json(await request(`/api/sessions/${deploying.id}`, { headers: f.cookie }))
    ).session
    expect(detail.shipping).toMatchObject({ stage: 'deploying', version: '1.4.2' })
  })

  it('another organisation’s ship in flight never appears; the operator’s list has it', async () => {
    const a = await seedSessionApp(db, createFakeCloud())
    const b = await seedSessionApp(db, createFakeCloud())
    const theirs = await insertSession(db, b, {
      status: 'shipped',
      landing: landing({ stage: 'releasing' }),
    })
    expect(await listOf(a.app.id, a.cookie)).toEqual([])
    // A's cookie cannot read B's app at all.
    expect(
      (await request(`/api/apps/${b.app.id}/sessions?scope=active`, { headers: a.cookie })).status
    ).toBe(404)
    expect((await listOf(b.app.id, b.cookie)).map(i => i.id)).toEqual([theirs.id])

    const admin = await createTestGlobalAdmin(db)
    await linkUserToTenant(db, admin.id, a.tenant.id, 'admin')
    const cookie = sessionCookieHeader(await createTestSession(db, admin.id, a.tenant.id))
    const ops = adminSessionListResponseSchema.parse(
      await json(await request('/api/admin/sessions?scope=active', { headers: cookie }))
    )
    expect(ops.items.find(i => i.id === theirs.id)?.shipping).toMatchObject({
      stage: 'releasing',
    })
  })
})
