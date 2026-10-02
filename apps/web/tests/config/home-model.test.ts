/**
 * What Home says about an app, decided in `pages/home/homeModel.ts` (pure): the one attention word
 * per row, the version each environment runs, and the order (apps that need somebody first).
 */
import {
  type AppCatalogueItem,
  type AppEnvironmentSummary,
  type DeployProgress,
  HEALTH_NOT_DEPLOYED_ERROR,
} from '@launch/shared/launch-apps'
import { describe, expect, it } from 'vitest'
import { appAttention, homeAppRows, runningVersion } from '@/ui/pages/home/homeModel'

const env = (
  name: 'staging' | 'production',
  overrides: Partial<AppEnvironmentSummary> = {}
): AppEnvironmentSummary => ({
  id:
    name === 'staging'
      ? 'e0000000-0000-4000-8000-000000000001'
      : 'e0000000-0000-4000-8000-000000000002',
  name,
  url: null,
  healthStatus: 'up',
  healthCheckedAt: new Date(),
  healthChangedAt: new Date(),
  healthVersion: '1.4.2',
  healthLatencyMs: 80,
  healthError: null,
  ...overrides,
})

const deploy = (overrides: Partial<DeployProgress> = {}): DeployProgress => ({
  ticketId: 'd0000000-0000-4000-8000-000000000001',
  environment: 'production',
  phase: 'done',
  reached: 'done',
  inProgress: false,
  version: '1.4.2',
  sha: null,
  ref: null,
  actor: null,
  runUrl: null,
  error: null,
  approvalId: null,
  startedAt: new Date(),
  updatedAt: new Date(),
  activatedAt: new Date(),
  finishedAt: new Date(),
  ...overrides,
})

const app = (overrides: Partial<AppCatalogueItem> = {}): AppCatalogueItem => ({
  id: 'a0000000-0000-4000-8000-000000000001',
  slug: 'expenses',
  displayName: 'Expenses',
  description: null,
  status: 'live',
  source: 'created',
  template: 'rocketflare',
  templateVersion: '0.15.0',
  repoOwner: null,
  repoName: null,
  ownerGroup: null,
  environments: [env('staging'), env('production')],
  createdAt: new Date(),
  latestDeploy: deploy(),
  thumbnail: null,
  ...overrides,
})

const notDeployed = { healthStatus: 'unknown' as const, healthError: HEALTH_NOT_DEPLOYED_ERROR }

describe('appAttention', () => {
  it('says nothing for a live app with nothing moving', () => {
    expect(appAttention(app())).toBeNull()
  })

  it('names the app states that need somebody, before anything a deploy says', () => {
    expect(appAttention(app({ status: 'failed' }))).toEqual({ word: 'setup failed', tone: 'error' })
    expect(appAttention(app({ status: 'requested' }))).toEqual({
      word: 'awaiting approval',
      tone: 'warning',
    })
    expect(appAttention(app({ status: 'provisioning' }))?.tone).toBe('muted')
  })

  it('reads the latest deploy: failed, waiting on a person, or under way', () => {
    expect(appAttention(app({ latestDeploy: deploy({ phase: 'failed' }) }))).toEqual({
      word: 'Live deploy failed',
      tone: 'error',
    })
    expect(
      appAttention(app({ latestDeploy: deploy({ phase: 'awaiting_approval', inProgress: true }) }))
    ).toEqual({ word: 'awaiting approval', tone: 'warning' })
    expect(
      appAttention(
        app({
          latestDeploy: deploy({ environment: 'staging', phase: 'migrating', inProgress: true }),
        })
      )
    ).toEqual({ word: 'deploying to Staging', tone: 'muted' })
  })

  it('says "not live yet" when Live is missing or has never been deployed', () => {
    expect(appAttention(app({ environments: [env('staging')], latestDeploy: null }))?.word).toBe(
      'not live yet'
    )
    expect(
      appAttention(app({ environments: [env('staging'), env('production', notDeployed)] }))?.word
    ).toBe('not live yet')
  })
})

describe('runningVersion', () => {
  it('is the reported version, v-prefixed for a release, and nothing before a first deploy', () => {
    expect(runningVersion(env('production'))).toBe('v1.4.2')
    expect(runningVersion(env('staging', { healthVersion: 'main-64a36e6' }))).toBe('main-64a36e6')
    expect(runningVersion(env('production', notDeployed))).toBeNull()
    expect(runningVersion(env('production', { healthVersion: null }))).toBeNull()
    expect(runningVersion(undefined)).toBeNull()
  })
})

describe('homeAppRows', () => {
  it('drops archived apps and puts failed, then waiting, ahead of the rest by name', () => {
    const rows = homeAppRows([
      app({ id: '1', displayName: 'Alpha' }),
      app({ id: '2', displayName: 'Beta', status: 'requested' }),
      app({ id: '3', displayName: 'Gamma', latestDeploy: deploy({ phase: 'failed' }) }),
      app({ id: '4', displayName: 'Delta', status: 'archived' }),
      app({ id: '5', displayName: 'Aardvark', environments: [env('staging')], latestDeploy: null }),
    ])
    expect(rows.map(r => r.app.displayName)).toEqual(['Gamma', 'Beta', 'Aardvark', 'Alpha'])
  })
})
