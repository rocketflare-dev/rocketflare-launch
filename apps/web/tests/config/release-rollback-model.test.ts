/**
 * Rollback and main-ahead, the pure halves (app page P3): who may be rolled back to
 * (`rollbackRefusal`, `canRollBackTo`), what a tag dispatch deployed (`taggedRunVersion`), how a
 * GitHub comparison becomes the contract (`toReleaseCompare`, `prNumberOfMessage`,
 * `highestVersionTag`), and what the Overview says about it (`liveInFlight` with a pending
 * rollback, `rolledBackNote`, `promotionState` of a rolled-back release).
 */
import type { PromotionRollback } from '@launch/shared/launch-promotion'
import {
  compareReleaseVersions,
  prNumberOfMessage,
  RELEASE_COMPARE_MAX_COMMITS,
  type Release,
  rollbackRefusal,
  taggedRunVersion,
} from '@launch/shared/launch-releases'
import { describe, expect, it } from 'vitest'
import { highestVersionTag, toReleaseCompare } from '@/api/services/launch/releases/compare'
import { canRollBackTo, liveInFlight, rolledBackNote } from '@/ui/pages/apps/app/appPageModel'
import { promotionState } from '@/ui/pages/apps/components/promotionModel'

describe('rollbackRefusal', () => {
  it('accepts an earlier release that was live', () => {
    expect(rollbackRefusal({ status: 'production_active', version: '1.4.1' }, '1.4.2')).toBeNull()
    expect(rollbackRefusal({ status: 'rolled_back', version: '1.3.0' }, '1.4.1')).toBeNull()
  })

  it('refuses the current or a later version, one never live, and a Live with no version', () => {
    expect(rollbackRefusal({ status: 'production_active', version: '1.4.2' }, '1.4.2')).toMatch(
      /only an earlier release/
    )
    expect(rollbackRefusal({ status: 'rolled_back', version: '1.4.2' }, '1.4.1')).toMatch(
      /only an earlier release/
    )
    expect(rollbackRefusal({ status: 'staging_active', version: '1.4.1' }, '1.4.2')).toMatch(
      /never live/
    )
    expect(rollbackRefusal({ status: 'production_active', version: '1.4.1' }, null)).toMatch(
      /no release version/
    )
    expect(
      rollbackRefusal({ status: 'production_active', version: '1.4.1' }, 'main-abc1234')
    ).toMatch(/no release version/)
  })

  it('orders versions numerically, not as strings', () => {
    expect(compareReleaseVersions('1.10.0', '1.9.9')).toBe(1)
    expect(rollbackRefusal({ status: 'production_active', version: '1.9.9' }, '1.10.0')).toBeNull()
  })
})

describe('taggedRunVersion', () => {
  const sha = `abc1234${'0'.repeat(33)}`
  it('reads a tag dispatch’s `<tag>-<sha7>` label as the tag', () => {
    expect(taggedRunVersion('1.4.1-abc1234', { ref: 'refs/tags/1.4.1', sha })).toBe('1.4.1')
  })

  it('leaves everything else as it came', () => {
    expect(taggedRunVersion('1.4.1', { ref: 'refs/tags/1.4.1', sha })).toBe('1.4.1')
    expect(taggedRunVersion('main-abc1234', { ref: 'refs/heads/main', sha })).toBe('main-abc1234')
    // Another commit than the run's, or another tag: not this release.
    expect(taggedRunVersion('1.4.1-def5678', { ref: 'refs/tags/1.4.1', sha })).toBe('1.4.1-def5678')
    expect(taggedRunVersion('1.4.0-abc1234', { ref: 'refs/tags/1.4.1', sha })).toBe('1.4.0-abc1234')
    expect(taggedRunVersion('1.4.1-abc1234', { ref: 'refs/tags/1.4.1', sha: null })).toBe(
      '1.4.1-abc1234'
    )
  })
})

describe('main-ahead compare', () => {
  it('finds a PR number in a squash or a merge commit message', () => {
    expect(prNumberOfMessage('Add the orders page (#12)')).toBe(12)
    expect(prNumberOfMessage('Merge pull request #7 from acme/fix\n\nFix it')).toBe(7)
    expect(prNumberOfMessage('Tidy up\n\n(#9) in the body does not count')).toBeNull()
  })

  it('picks the highest X.Y.Z tag', () => {
    expect(highestVersionTag(['0.9.0', 'v2.0.0', '0.10.0', 'nightly'])).toBe('0.10.0')
    expect(highestVersionTag(['nightly'])).toBeNull()
  })

  it('lists the newest commit first, capped, first lines only', () => {
    const commits = Array.from({ length: RELEASE_COMPARE_MAX_COMMITS + 5 }, (_, i) => ({
      sha: `sha${i}`,
      commit: { message: `Change ${i} (#${i + 1})\n\nbody`, author: { name: 'Ana' } },
    }))
    const at = new Date('2026-10-02T10:00:00Z')
    const view = toReleaseCompare(
      {
        ahead_by: commits.length,
        html_url: 'https://github.com/a/b/compare/1.0.0...main',
        commits,
      },
      { branch: 'main', base: '1.0.0', checkedAt: at }
    )
    expect(view).toMatchObject({ aheadBy: commits.length, headSha: `sha${commits.length - 1}` })
    expect(view.commits).toHaveLength(RELEASE_COMPARE_MAX_COMMITS)
    expect(view.commits[0]).toEqual({
      sha: `sha${commits.length - 1}`,
      message: `Change ${commits.length - 1} (#${commits.length})`,
      author: 'Ana',
      prNumber: commits.length,
    })
  })
})

describe('the Overview’s rollback lines', () => {
  const pending: PromotionRollback = {
    releaseId: 'a0000000-0000-4000-8000-000000000001',
    version: '1.4.1',
    from: '1.4.2',
    approval: {
      id: 'b0000000-0000-4000-8000-000000000001',
      status: 'pending',
      approvers: [{ id: 'c0000000-0000-4000-8000-000000000001', name: 'Bob', email: 'b@x.io' }],
    },
  }

  it('shows a pending rollback as the Live row’s waiting line', () => {
    expect(liveInFlight(undefined, null, pending)).toEqual({
      kind: 'awaiting',
      version: 'v1.4.1',
      approvers: 'Bob',
      approvalId: pending.approval.id,
      rollback: true,
    })
    expect(liveInFlight(undefined, null, null)).toBeNull()
  })

  it('says what a rollback replaced', () => {
    expect(rolledBackNote('1.4.2')).toBe('rolled back from v1.4.2')
    expect(rolledBackNote(null)).toBeNull()
  })

  it('offers Roll back only to a deployer, when Live is free and the server would accept', () => {
    const r = { status: 'production_active' as const, version: '1.4.1' }
    const ok = { liveVersion: '1.4.2', viewerCanDeploy: true, busy: false }
    expect(canRollBackTo(r, ok)).toBe(true)
    expect(canRollBackTo(r, { ...ok, viewerCanDeploy: false })).toBe(false)
    expect(canRollBackTo(r, { ...ok, busy: true })).toBe(false)
    expect(canRollBackTo(r, { ...ok, liveVersion: '1.4.1' })).toBe(false)
  })

  it('does not offer Ship for a rolled-back release', () => {
    const release = {
      id: 'a0000000-0000-4000-8000-000000000002',
      appId: 'a0000000-0000-4000-8000-000000000003',
      version: '1.4.2',
      tag: '1.4.2',
      sha: 'c'.repeat(40),
      previousTag: '1.4.1',
      prs: [],
      status: 'rolled_back',
      createdByUserId: null,
      approvalId: null,
      stagingTicketId: null,
      productionTicketId: null,
      error: null,
      failedStage: null,
      rolledBackFrom: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Release
    const state = promotionState({
      candidate: release,
      staging: null,
      production: null,
      changes: [],
      changesTruncated: false,
      approval: null,
      candidateRun: null,
      rollback: null,
    })
    expect(state).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/rolled back/) })
  })
})
