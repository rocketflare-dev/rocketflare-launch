/**
 * The pure half of following a release tag's deploy run (`releases/tag-run.ts`): the contract
 * (`candidateRun` defaults to null, so an older answer still parses), how a GitHub run and its jobs
 * fold into `candidateRunSchema`, the error a failed run leaves on the release, and what the
 * strip's pure `promotionState` says for each. The read, the throttle and the settle are
 * `tests/api/promotion-tag-run.test.ts`.
 */
import {
  type AppPromotion,
  appPromotionSchema,
  type CandidateRun,
  candidateRunFailed,
} from '@launch/shared/launch-promotion'
import type { Release } from '@launch/shared/launch-releases'
import { describe, expect, it } from 'vitest'
import type { GitHubWorkflowJob, GitHubWorkflowRun } from '@/api/services/launch/github-app'
import { tagRunFailureError, toCandidateRun } from '@/api/services/launch/releases/tag-run'
import { promotionState } from '@/ui/pages/apps/components/promotionModel'

const NOW = new Date('2026-09-28T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)
const RUN_URL = 'https://github.com/acme/hola-world/actions/runs/9'

const release = (over: Partial<Release> = {}): Release => ({
  id: 'a0000000-0000-4000-8000-000000000001',
  appId: 'a0000000-0000-4000-8000-000000000002',
  version: '0.15.7',
  tag: '0.15.7',
  sha: 'c'.repeat(40),
  previousTag: '0.15.6',
  prs: [],
  status: 'tagged',
  createdByUserId: null,
  approvalId: null,
  stagingTicketId: null,
  productionTicketId: null,
  error: null,
  createdAt: minutesAgo(3),
  updatedAt: minutesAgo(3),
  ...over,
})

const run = (over: Partial<CandidateRun> = {}): CandidateRun => ({
  status: 'in_progress',
  conclusion: null,
  url: RUN_URL,
  currentJob: 'ci / Gate',
  failedJob: null,
  ...over,
})

const view = (candidate: Release, candidateRun: CandidateRun | null): AppPromotion => ({
  candidate,
  staging: null,
  production: null,
  changes: [],
  changesTruncated: false,
  approval: null,
  candidateRun,
})

describe('appPromotionSchema.candidateRun', () => {
  it('defaults to null, so an answer from before it still parses', () => {
    const parsed = appPromotionSchema.parse({
      candidate: null,
      staging: null,
      production: null,
      changes: [],
      changesTruncated: false,
      approval: null,
    })
    expect(parsed.candidateRun).toBeNull()
  })

  it('carries a run', () => {
    const parsed = appPromotionSchema.parse({ ...view(release(), run()) })
    expect(parsed.candidateRun).toEqual(run())
  })

  it('refuses a status GitHub folds away', () => {
    expect(() =>
      appPromotionSchema.parse(view(release(), run({ status: 'waiting' as never })))
    ).toThrow()
  })
})

describe('toCandidateRun', () => {
  const ghRun = (over: Partial<GitHubWorkflowRun> = {}): GitHubWorkflowRun => ({
    id: 9,
    status: 'in_progress',
    conclusion: null,
    head_branch: '0.15.7',
    event: 'push',
    html_url: RUN_URL,
    ...over,
  })
  const job = (
    name: string,
    status: string,
    conclusion: string | null = null
  ): GitHubWorkflowJob => ({
    id: name.length,
    name,
    status,
    conclusion,
  })

  it('names the job running now', () => {
    const jobs = [
      job('guard', 'completed', 'success'),
      job('ci / Gate', 'in_progress'),
      job('Deploy to staging', 'queued'),
    ]
    expect(toCandidateRun(ghRun(), jobs)).toEqual(run())
  })

  it('names the first job still queued when none is running', () => {
    const jobs = [job('guard', 'completed', 'success'), job('Deploy to staging', 'queued')]
    expect(toCandidateRun(ghRun({ status: 'queued' }), jobs)).toMatchObject({
      status: 'queued',
      currentJob: 'Deploy to staging',
    })
  })

  it('folds GitHub’s waiting statuses to queued', () => {
    expect(toCandidateRun(ghRun({ status: 'waiting' }), []).status).toBe('queued')
    expect(toCandidateRun(ghRun({ status: 'requested' }), []).status).toBe('queued')
  })

  it('a completed run: its conclusion and the job that failed, no current job', () => {
    const jobs = [
      job('guard', 'completed', 'success'),
      job('ci / Gate', 'completed', 'failure'),
      job('Deploy to staging', 'completed', 'skipped'),
    ]
    const folded = toCandidateRun(ghRun({ status: 'completed', conclusion: 'failure' }), jobs)
    expect(folded).toEqual(
      run({ status: 'completed', conclusion: 'failure', currentJob: null, failedJob: 'ci / Gate' })
    )
    expect(candidateRunFailed(folded)).toBe(true)
  })

  it('success, skipped and neutral are not failures', () => {
    for (const conclusion of ['success', 'skipped', 'neutral']) {
      expect(candidateRunFailed(run({ status: 'completed', conclusion }))).toBe(false)
    }
    expect(candidateRunFailed(run({ status: 'in_progress', conclusion: 'failure' }))).toBe(false)
  })
})

describe('tagRunFailureError', () => {
  it('names the job and the run', () => {
    expect(
      tagRunFailureError(
        run({ status: 'completed', conclusion: 'failure', failedJob: 'ci / Gate' })
      )
    ).toBe(`staging: the deploy run failed at "ci / Gate" (${RUN_URL})`)
  })
  it('falls back to the conclusion without a job', () => {
    expect(
      tagRunFailureError(run({ status: 'completed', conclusion: 'cancelled', url: null }))
    ).toBe('staging: the deploy run ended cancelled')
  })
})

describe('promotionState with the tag run', () => {
  it('tagged with a run in flight: GitHub is checking it, with the job and the link', () => {
    expect(promotionState(view(release(), run()), NOW)).toMatchObject({
      kind: 'blocked',
      reason: 'v0.15.7 is tagged — GitHub is checking it before it deploys to staging',
      run: { detail: 'Running: ci / Gate', url: RUN_URL },
    })
  })

  it('tagged past 45 minutes with a run still going is not "never reached staging"', () => {
    const state = promotionState(view(release({ createdAt: minutesAgo(50) }), run()), NOW)
    expect(state).toMatchObject({ kind: 'blocked' })
    expect(state.kind === 'blocked' && state.reason).toMatch(/is tagged — GitHub is checking/)
  })

  it('tagged with no run: still deploying, then never reached staging after 45 minutes', () => {
    expect(promotionState(view(release(), null), NOW)).toMatchObject({
      reason: 'Staging is still deploying',
    })
    expect(promotionState(view(release({ createdAt: minutesAgo(46) }), null), NOW)).toMatchObject({
      reason: 'v0.15.7 never reached staging',
    })
  })

  it('staging: deploying to staging, with the run when there is one', () => {
    expect(
      promotionState(view(release({ status: 'staging' }), run({ currentJob: 'Deploy' })), NOW)
    ).toMatchObject({
      reason: 'Deploying v0.15.7 to staging…',
      run: { detail: 'Running: Deploy', url: RUN_URL },
    })
    const plain = promotionState(view(release({ status: 'staging' }), null), NOW)
    expect(plain).toMatchObject({ reason: 'Deploying v0.15.7 to staging…' })
    expect(plain.kind === 'blocked' && plain.run).toBeFalsy()
  })

  it('a run that failed (the release failed, or not yet moved): the job that failed', () => {
    const failed = run({
      status: 'completed',
      conclusion: 'failure',
      currentJob: null,
      failedJob: 'ci / Gate',
    })
    for (const status of ['failed', 'tagged'] as const) {
      expect(promotionState(view(release({ status }), failed), NOW)).toMatchObject({
        kind: 'blocked',
        reason: 'v0.15.7 did not deploy: ci / Gate failed',
        run: { detail: null, url: RUN_URL },
      })
    }
    expect(
      promotionState(view(release({ status: 'failed' }), { ...failed, failedJob: null }), NOW)
    ).toMatchObject({ reason: 'v0.15.7 did not deploy' })
  })

  it('a failed release without a run: did not deploy, no link', () => {
    const state = promotionState(view(release({ status: 'failed' }), null), NOW)
    expect(state).toMatchObject({ reason: 'v0.15.7 did not deploy' })
    expect(state.kind === 'blocked' && state.run).toBeFalsy()
  })

  it('ignores the run once staging is live', () => {
    const state = promotionState(view(release({ status: 'staging_active' }), run()), NOW)
    expect(state.kind === 'blocked' && state.run).toBeFalsy()
  })
})
