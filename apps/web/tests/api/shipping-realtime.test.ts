/**
 * Shipping in real time (server side): the two choke points every landing and PR-panel change
 * passes through announce it on the tenant's hub — `casLanding` (every landing move, whichever of a
 * poll round, the cron or a webhook advanced it) and `refreshChecks` (a changed CI verdict, from the
 * panel's GET or the cron). Each sends `entity.changed { entity: 'session', id }` — ids only — to
 * the session's own tenant, and nothing when nothing moved.
 */
import type { PrChecks, SessionLanding } from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'
import { createStepRealtime } from '@/api/services/agents/runtime'
import { casLanding } from '@/api/services/sessions/land'
import type { RepoHostPort } from '@/api/services/sessions/ports'
import { refreshChecks } from '@/api/services/sessions/ship'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const cloud = createFakeCloud()
const logger = { info: () => {}, warn: () => {}, error: () => {} } as never

/** The `entity.changed` payloads each tenant's hub was sent. */
function nudges(env: TestEnv, tenantId: string) {
  return stubs(env)
    .hub.broadcasts.filter(b => b.tenantId === tenantId && b.args[0] === 'broadcast')
    .map(b => (b.args[1] as { type: string; payload: unknown }).payload)
}

function landing(stage: SessionLanding['stage']): SessionLanding {
  const at = new Date().toISOString()
  return {
    mode: 'staging',
    stage,
    prNumber: 1,
    gateSha: 'a'.repeat(40),
    gateTree: null,
    mainCi: null,
    startedAt: at,
    stageAt: at,
    reviewMode: 'none',
    approvalId: null,
    mergeSha: null,
    mergedAt: null,
    releaseId: null,
    version: null,
    tag: null,
    stagingUrl: null,
    containerReleased: false,
    stalledReason: null,
    error: null,
  }
}

function checks(state: PrChecks['state'], passed = 0, pending = 1): PrChecks {
  return {
    state,
    headSha: 'a'.repeat(40),
    checkedAt: new Date(),
    total: passed + pending,
    passed,
    failed: 0,
    pending,
    checks: [
      {
        name: 'Gate',
        source: 'check_run',
        state: state === 'success' ? 'success' : 'pending',
        url: null,
      },
    ],
  }
}

describe('a landing move nudges its session', () => {
  it('casLanding announces a move that landed, to the session’s tenant only, and nothing for a miss', async () => {
    const f = await seedSessionApp(db, cloud)
    const other = await seedSessionApp(db, cloud)
    const row = await insertSession(db, f, { status: 'shipping', landing: landing('ci') })
    const env = createTestEnv()
    const { realtime, settle } = createStepRealtime(env, logger)
    const scope = { db, params: { tenantId: f.tenant.id, sessionId: row.id }, realtime }

    const moved = await casLanding(
      scope,
      { statuses: ['shipping'], stages: ['ci'] },
      { stage: 'merging', stageAt: new Date().toISOString() }
    )
    expect(moved?.landing?.stage).toBe('merging')
    await settle()
    expect(nudges(env, f.tenant.id)).toEqual([{ entity: 'session', id: row.id }])
    expect(nudges(env, other.tenant.id)).toEqual([])

    // The row has moved on: the compare-and-set misses and announces nothing.
    const missed = await casLanding(
      scope,
      { statuses: ['shipping'], stages: ['ci'] },
      { stage: 'approval' }
    )
    expect(missed).toBeNull()
    await settle()
    expect(nudges(env, f.tenant.id)).toHaveLength(1)

    // Another tenant's scope cannot move (or announce) this session.
    const foreign = await casLanding(
      { db, params: { tenantId: other.tenant.id, sessionId: row.id }, realtime },
      { statuses: ['shipping'], stages: ['merging'] },
      { stage: 'releasing' }
    )
    expect(foreign).toBeNull()
    await settle()
    expect(nudges(env, other.tenant.id)).toEqual([])
  })
})

describe('a changed CI verdict nudges its session', () => {
  it('refreshChecks announces a new verdict, not a repeated one', async () => {
    const f = await seedSessionApp(db, cloud)
    const row = await insertSession(db, f, { status: 'shipped', prNumber: 1, prChecks: null })
    let next = checks('pending')
    const repoHost = { getChecks: async () => next } as unknown as RepoHostPort
    const env = createTestEnv()
    const { realtime, settle } = createStepRealtime(env, logger)

    await refreshChecks(db, repoHost, row, { realtime })
    await settle()
    expect(nudges(env, f.tenant.id)).toEqual([{ entity: 'session', id: row.id }])

    // Same verdict, read again (stored now): nothing new to say.
    await refreshChecks(db, repoHost, { ...row, prChecks: next }, { realtime })
    await settle()
    expect(nudges(env, f.tenant.id)).toHaveLength(1)

    const pending = next
    next = checks('success', 1, 0)
    await refreshChecks(db, repoHost, { ...row, prChecks: pending }, { realtime })
    await settle()
    expect(nudges(env, f.tenant.id)).toHaveLength(2)

    // Without a `realtime` (a caller with nowhere to send it) the read still works, silently.
    await refreshChecks(db, repoHost, { ...row, prChecks: null })
    await settle()
    expect(nudges(env, f.tenant.id)).toHaveLength(2)
  })
})
