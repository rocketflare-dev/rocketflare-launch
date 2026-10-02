/**
 * Deploy progress in the UI: the release page's milestones (`DeploySteps` — the step a deploy is
 * on, or where it stopped), the catalogue's deploy line, and the pure halves — `deployStepStates`
 * and the poll decision `deployProgressPollInterval` (never while waiting on a person). The
 * Overview's one-line version is in `app-overview.test.tsx`.
 */
import type { DeployProgress } from '@launch/shared/launch-apps'
import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEPLOY_PROGRESS_POLL_MS, deployProgressPollInterval } from '@/ui/hooks/useDeploys'
import { DeploySteps } from '@/ui/pages/apps/app/DeploySteps'
import CataloguePage from '@/ui/pages/apps/CataloguePage'
import { deployStepStates, deployTitle } from '@/ui/pages/apps/components/deployProgressModel'
import { makeSession, renderWithProviders, stubFetch } from './helpers/renderWithProviders'

const APP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const RUN_URL = 'https://github.com/acme/expenses/actions/runs/123'
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()

const deploy = (overrides: Partial<Record<keyof DeployProgress, unknown>> = {}) => ({
  ticketId: '11111111-1111-4111-8111-111111111111',
  environment: 'production',
  phase: 'migrating',
  reached: 'migrating',
  inProgress: true,
  version: '1.4.0',
  sha: 'a'.repeat(40),
  ref: 'refs/tags/1.4.0',
  actor: 'octocat',
  runUrl: RUN_URL,
  error: null,
  approvalId: null,
  startedAt: minutesAgo(4),
  updatedAt: minutesAgo(1),
  activatedAt: null,
  finishedAt: null,
  ...overrides,
})

afterEach(() => vi.unstubAllGlobals())

describe('deployStepStates', () => {
  it('marks the steps up to the one reached done and the next one current', () => {
    expect(deployStepStates({ phase: 'migrating', reached: 'migrating' })).toEqual([
      { step: 'dispatched', state: 'done' },
      { step: 'approved', state: 'done' },
      { step: 'uploaded', state: 'done' },
      { step: 'migrating', state: 'done' },
      { step: 'activating', state: 'current' },
      { step: 'done', state: 'todo' },
    ])
  })

  it('fails the step after the last one reached, and waits on approval after dispatch', () => {
    const failed = deployStepStates({ phase: 'failed', reached: 'uploaded' })
    expect(failed.find(s => s.state === 'failed')?.step).toBe('migrating')
    const waiting = deployStepStates({ phase: 'awaiting_approval', reached: 'dispatched' })
    expect(waiting.find(s => s.step === 'approved')?.state).toBe('waiting')
    expect(
      deployStepStates({ phase: 'done', reached: 'done' }).every(s => s.state === 'done')
    ).toBe(true)
  })

  it('names the deploy by its version, else its commit', () => {
    expect(deployTitle({ environment: 'production', version: '1.4.0', sha: null })).toBe(
      'Production deploy of 1.4.0'
    )
    expect(deployTitle({ environment: 'staging', version: null, sha: 'abcdef1234' })).toBe(
      'Staging deploy of abcdef1'
    )
  })
})

describe('deployProgressPollInterval', () => {
  it('polls while a deploy runs, never while it waits on a person or has settled', () => {
    expect(deployProgressPollInterval([{ inProgress: true, phase: 'migrating' }])).toBe(
      DEPLOY_PROGRESS_POLL_MS
    )
    expect(deployProgressPollInterval([{ inProgress: true, phase: 'awaiting_approval' }])).toBe(
      false
    )
    expect(deployProgressPollInterval([{ inProgress: false, phase: 'done' }, null])).toBe(false)
    expect(deployProgressPollInterval(undefined)).toBe(false)
  })
})

describe('DeploySteps (the release page)', () => {
  it('marks each milestone, and names its state for a screen reader', () => {
    renderWithProviders(<DeploySteps deploy={deploy() as never} />, { session: makeSession() })
    const steps = within(screen.getByRole('list', { name: 'Deploy steps' })).getAllByRole(
      'listitem'
    )
    expect(steps.map(s => s.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'done',
      'done',
      'current',
      'todo',
    ])
    expect(screen.getByText(/Activating/)).toHaveTextContent('in progress')
  })

  it('says where a failed deploy stopped', () => {
    renderWithProviders(
      <DeploySteps deploy={deploy({ phase: 'failed', reached: 'uploaded' }) as never} />,
      {
        session: makeSession(),
      }
    )
    expect(screen.getByText(/Migrating/)).toHaveTextContent('failed here')
  })
})

describe('CataloguePage — latest deploy', () => {
  it('shows a deploy in progress on the app’s card', async () => {
    stubFetch({
      '/api/apps': {
        appsDomain: null,
        items: [
          {
            id: APP_ID,
            slug: 'expenses',
            displayName: 'Expense Tracker',
            description: null,
            status: 'live',
            source: 'created',
            template: 'rocketflare',
            templateVersion: '0.15.0',
            repoOwner: 'acme',
            repoName: 'expenses',
            ownerGroup: null,
            environments: [],
            createdAt: '2026-09-01T00:00:00Z',
            latestDeploy: deploy({ phase: 'activating', reached: 'activating' }),
          },
        ],
      },
    })
    renderWithProviders(<CataloguePage />, { session: makeSession() })
    const line = await screen.findByTestId('catalogue-deploy')
    expect(line).toHaveTextContent('deploying · activating')
    expect(line).toHaveTextContent('Production deploy of 1.4.0')
  })
})
