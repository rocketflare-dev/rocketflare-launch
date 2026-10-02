/**
 * What the app page says, decided in `pages/apps/app/appPageModel.ts` (pure): when the first build
 * holds the Overview, the in-flight line per environment, what lands in Needs you (and for whom),
 * and the Releases tab's one row per version merged from releases and deploy tickets.
 */
import type { DeployProgress } from '@launch/shared/launch-apps'
import type { DeployTicket } from '@launch/shared/launch-pipeline'
import type { Release } from '@launch/shared/launch-releases'
import { describe, expect, it } from 'vitest'
import {
  appStage,
  liveInFlight,
  needsYou,
  releaseCell,
  releaseRows,
  settingsPath,
  stagingInFlight,
} from '@/ui/pages/apps/app/appPageModel'
import { changesNotLive, type PromotionState } from '@/ui/pages/apps/components/promotionModel'

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)

const release = (overrides: Partial<Release> = {}): Release => ({
  id: 'r0000000-0000-4000-8000-000000000001',
  appId: 'a0000000-0000-4000-8000-000000000001',
  version: '1.4.2',
  tag: '1.4.2',
  sha: 'c'.repeat(40),
  previousTag: '1.4.1',
  prs: [],
  status: 'staging_active',
  createdByUserId: null,
  approvalId: null,
  stagingTicketId: null,
  productionTicketId: null,
  error: null,
  createdAt: at(30),
  updatedAt: at(20),
  ...overrides,
})

let ticketSeq = 0
const ticket = (overrides: Partial<DeployTicket> = {}): DeployTicket => {
  ticketSeq += 1
  return {
    id: `t0000000-0000-4000-8000-${String(ticketSeq).padStart(12, '0')}`,
    appId: 'a0000000-0000-4000-8000-000000000001',
    environmentId: 'e0000000-0000-4000-8000-000000000001',
    environment: 'staging',
    purpose: 'deploy',
    status: 'active',
    repository: 'acme/expenses',
    runId: '1',
    runAttempt: 1,
    sha: 'a'.repeat(40),
    ref: null,
    actor: null,
    version: '1.4.2',
    cfVersionId: null,
    activatedAt: at(10),
    refused: null,
    decisionSource: 'auto',
    decidedByUserId: null,
    decidedAt: null,
    expiresAt: null,
    error: null,
    createdAt: at(15),
    updatedAt: at(10),
    finishedAt: null,
    releaseId: null,
    approvalId: null,
    ...overrides,
  }
}

const progress = (overrides: Partial<DeployProgress> = {}): DeployProgress => ({
  ticketId: 't0000000-0000-4000-8000-0000000000ff',
  environment: 'staging',
  phase: 'migrating',
  reached: 'uploaded',
  inProgress: true,
  version: '1.4.3',
  sha: 'b'.repeat(40),
  ref: null,
  actor: null,
  runUrl: null,
  error: null,
  approvalId: null,
  startedAt: at(1),
  updatedAt: at(0),
  activatedAt: null,
  finishedAt: null,
  ...overrides,
})

describe('appStage', () => {
  const app = { source: 'created' as const, status: 'provisioning' as const }
  it('holds a created app until its first build succeeds, and while it waits on its approval', () => {
    expect(
      appStage(app, { waitingForApproval: false, appBusy: true, createStatus: undefined })
    ).toEqual({ launching: true, holding: true })
    expect(
      appStage(
        { ...app, status: 'requested' },
        { waitingForApproval: true, appBusy: false, createStatus: undefined }
      )
    ).toEqual({ launching: false, holding: true })
    expect(
      appStage(
        { ...app, status: 'live' },
        { waitingForApproval: false, appBusy: false, createStatus: 'succeeded' }
      )
    ).toEqual({ launching: false, holding: false })
    // An imported app never launches.
    expect(
      appStage(
        { source: 'imported', status: 'live' },
        { waitingForApproval: false, appBusy: false, createStatus: 'failed' }
      ).holding
    ).toBe(false)
  })
})

describe('the in-flight line', () => {
  it('follows a running staging deploy, else a candidate on its way; never a failure', () => {
    expect(stagingInFlight(progress(), null)).toMatchObject({
      kind: 'moving',
      version: 'v1.4.3',
      what: 'migrating',
    })
    const moving: PromotionState = {
      kind: 'blocked',
      reason: 'v1.4.2 is tagged — GitHub is checking it before it deploys to staging',
      release: release({ status: 'tagged' }),
      progress: 'moving',
    }
    expect(stagingInFlight(undefined, moving)).toMatchObject({
      what: 'GitHub is checking it',
    })
    expect(
      stagingInFlight(undefined, { ...moving, progress: 'failed', reason: 'v1.4.2 did not deploy' })
    ).toBeNull()
  })

  it('names who a shipped release waits on, then the Live deploy', () => {
    const awaiting: PromotionState = {
      kind: 'awaiting',
      release: release({ status: 'awaiting_approval', approvalId: 'p1' }),
      approval: {
        id: 'p0000000-0000-4000-8000-000000000001',
        status: 'pending',
        approvers: [{ id: 'u1', name: 'Bob', email: 'b@x.test' }],
      },
    }
    expect(liveInFlight(undefined, awaiting)).toEqual({
      kind: 'awaiting',
      version: 'v1.4.2',
      approvers: 'Bob',
      approvalId: 'p0000000-0000-4000-8000-000000000001',
    })
    expect(
      liveInFlight(progress({ environment: 'production', phase: 'activating' }), null)
    ).toMatchObject({ kind: 'moving', what: 'activating' })
  })
})

describe('needsYou', () => {
  const base = {
    state: null,
    latest: [],
    tickets: [],
    config: null,
    viewerId: 'u1',
    viewerCanDeploy: true,
  }

  it('says nothing when nothing needs a person', () => {
    expect(needsYou(base)).toEqual([])
  })

  it('lists a failed release once, not again as its failed deploy', () => {
    const items = needsYou({
      ...base,
      state: {
        kind: 'blocked',
        reason: 'v1.4.2 did not deploy: ci / Gate failed',
        release: release({ status: 'failed', error: 'staging: failed' }),
        progress: 'failed',
      },
      latest: [progress({ phase: 'failed', inProgress: false, version: '1.4.2' })],
    })
    expect(items.map(i => i.kind)).toEqual(['release-failed'])
    expect(items[0]).toMatchObject({ detail: 'staging: failed', canAct: true })
  })

  it('lists an approval only for one of its approvers', () => {
    const state: PromotionState = {
      kind: 'awaiting',
      release: release({ status: 'awaiting_approval' }),
      approval: {
        id: 'p0000000-0000-4000-8000-000000000001',
        status: 'pending',
        approvers: [{ id: 'u2', name: null, email: 'x@x.test' }],
      },
    }
    expect(needsYou({ ...base, state })).toEqual([])
    expect(needsYou({ ...base, state, viewerId: 'u2' }).map(i => i.kind)).toEqual(['approval'])
  })

  it('decides a pending Live deploy in place without the engine, and links one with it', () => {
    const legacy = ticket({ environment: 'production', status: 'pending', approvalId: null })
    expect(needsYou({ ...base, tickets: [legacy] })[0]).toMatchObject({
      kind: 'deploy-decision',
    })
    const engine = ticket({
      environment: 'production',
      status: 'pending',
      approvalId: 'p0000000-0000-4000-8000-000000000009',
    })
    expect(needsYou({ ...base, viewerCanDeploy: false, tickets: [engine] })[0]).toMatchObject({
      kind: 'approval',
      href: '/approvals/p0000000-0000-4000-8000-000000000009',
      canAct: false,
    })
  })
})

describe('the Releases tab', () => {
  it('merges releases and tickets into one row per version, newest first', () => {
    const r = release()
    const rows = releaseRows(
      [r],
      [
        ticket({ environment: 'production', releaseId: r.id, createdAt: at(5) }),
        ticket({ environment: 'staging', version: '1.4.2', createdAt: at(15) }),
        ticket({ environment: 'staging', version: null, sha: 'f'.repeat(40), createdAt: at(1) }),
        ticket({ purpose: 'scaffold' as DeployTicket['purpose'] }),
      ]
    )
    expect(rows.map(row => row.label)).toEqual(['fffffff', 'v1.4.2'])
    const versioned = rows[1]
    expect(versioned?.staging?.version).toBe('1.4.2')
    expect(versioned?.production?.releaseId).toBe(r.id)
    expect(releaseCell(versioned as never, 'production')).toEqual({ tone: 'active', label: 'live' })
  })

  it('reads the release where the ticket cannot say it', () => {
    const row = {
      release: release({ status: 'awaiting_approval' }),
      staging: null,
      production: null,
    }
    expect(releaseCell(row, 'production')).toEqual({
      tone: 'awaiting-review',
      label: 'awaiting approval',
    })
    expect(releaseCell({ ...row, release: release({ status: 'tagged' }) }, 'staging')).toEqual({
      tone: 'queued',
      label: 'tagged',
    })
  })
})

describe('words and paths', () => {
  it('counts the changes not live, and nothing once Live has them', () => {
    const r = release()
    const view = { changes: [{}, {}, {}] as never, changesTruncated: false }
    expect(changesNotLive(view, { kind: 'ready', release: r, askedBefore: false })).toBe(
      '3 changes not live'
    )
    expect(
      changesNotLive({ ...view, changesTruncated: true }, { kind: 'deploying', release: r })
    ).toBe('3+ changes not live')
    expect(changesNotLive(view, { kind: 'live', release: r })).toBeNull()
  })

  it('spells the Settings sections the old /config and /access links redirect to', () => {
    expect(settingsPath('expenses', 'config')).toBe('/apps/expenses/settings/config')
    expect(settingsPath('my app')).toBe('/apps/my%20app/settings/general')
  })
})
