/**
 * `releaseFailedStage` (app page P2, plan decision 7) — the one derivation of where a release is
 * stuck, which the server stamps on every release and the UI's Retry and the CLI read. Pure.
 */
import {
  RELEASE_FAILED_STAGES,
  RELEASE_RETRY_LABELS,
  RELEASE_STAGING_TIMEOUT_MINUTES,
  type ReleaseStageFacts,
  releaseFailedStage,
  releaseSchema,
} from '@launch/shared/launch-releases'
import { describe, expect, it } from 'vitest'

const NOW = new Date('2026-10-02T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

const facts = (over: Partial<ReleaseStageFacts> = {}): ReleaseStageFacts => ({
  status: 'staging_active',
  version: '1.4.2',
  error: null,
  productionTicketId: null,
  updatedAt: minutesAgo(5),
  tagRunSeen: true,
  staging: { lastDeployVersion: '1.4.2', healthStatus: 'up' },
  production: { lastDeployVersion: '1.4.1', healthStatus: 'up' },
  ...over,
})

describe('releaseFailedStage', () => {
  it('names the environment a failed release failed in, by its error', () => {
    expect(releaseFailedStage(facts({ status: 'failed', error: 'staging: refused' }), NOW)).toBe(
      'staging_deploy'
    )
    expect(
      releaseFailedStage(
        facts({ status: 'failed', error: 'production: the run ended', productionTicketId: 'x' }),
        NOW
      )
    ).toBe('production_deploy')
    // No prefix: production's when a production run was recorded, else staging's.
    expect(releaseFailedStage(facts({ status: 'failed', error: null }), NOW)).toBe('staging_deploy')
    expect(
      releaseFailedStage(facts({ status: 'failed', error: 'odd', productionTicketId: 'x' }), NOW)
    ).toBe('production_deploy')
  })

  it('a rejected release asks for approval again', () => {
    expect(releaseFailedStage(facts({ status: 'rejected' }), NOW)).toBe('approval_rejected')
  })

  it('a tagged release is stuck at the tag only once it stalled with no run seen', () => {
    const stalled = minutesAgo(RELEASE_STAGING_TIMEOUT_MINUTES + 1)
    expect(
      releaseFailedStage(facts({ status: 'tagged', updatedAt: stalled, tagRunSeen: false }), NOW)
    ).toBe('tag')
    expect(
      releaseFailedStage(
        facts({ status: 'tagged', updatedAt: minutesAgo(1), tagRunSeen: false }),
        NOW
      )
    ).toBeNull()
    expect(
      releaseFailedStage(facts({ status: 'tagged', updatedAt: stalled, tagRunSeen: true }), NOW)
    ).toBeNull()
  })

  it('health counts only on the environment running THIS version, and only when down', () => {
    const down = { lastDeployVersion: '1.4.2', healthStatus: 'down' }
    expect(releaseFailedStage(facts({ staging: down }), NOW)).toBe('staging_health')
    expect(
      releaseFailedStage(facts({ staging: { ...down, lastDeployVersion: '1.4.3' } }), NOW)
    ).toBeNull()
    expect(
      releaseFailedStage(facts({ staging: { ...down, healthStatus: 'unknown' } }), NOW)
    ).toBeNull()
    expect(releaseFailedStage(facts({ status: 'production_active', production: down }), NOW)).toBe(
      'production_health'
    )
  })

  it('in-flight and settled releases are not stuck', () => {
    for (const status of ['staging', 'awaiting_approval', 'promoting'] as const) {
      expect(releaseFailedStage(facts({ status }), NOW)).toBeNull()
    }
    expect(releaseFailedStage(facts({ status: 'production_active' }), NOW)).toBeNull()
  })

  it('every stage has a Retry label, and an answer without the field parses as null', () => {
    for (const stage of RELEASE_FAILED_STAGES) expect(RELEASE_RETRY_LABELS[stage]).toBeTruthy()
    const parsed = releaseSchema.parse({
      id: 'a0000000-0000-4000-8000-000000000001',
      appId: 'a0000000-0000-4000-8000-000000000002',
      version: '1.4.2',
      tag: '1.4.2',
      sha: 'c'.repeat(40),
      previousTag: null,
      prs: [],
      status: 'failed',
      createdByUserId: null,
      approvalId: null,
      stagingTicketId: null,
      productionTicketId: null,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(parsed.failedStage).toBeNull()
  })
})
