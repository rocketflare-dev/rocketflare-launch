/**
 * The create-an-app UI's pure parts (Launch P2, slice 2e): when the pipeline and the deploys list
 * poll (ui.md: only while the server owes an answer), how a pipeline view becomes rows, phases and
 * a summary, the slug suggested from a name, the host preview, and the apps domain a created app's
 * staging URL reveals.
 */
import type { AppSummary } from '@launch/shared/launch-apps'
import {
  APP_LAUNCH_VIEW_STEPS,
  APP_TEARDOWN_STEPS,
  newAppSlugProblem,
  type PipelineStep,
} from '@launch/shared/launch-pipeline'
import { describe, expect, it } from 'vitest'
import { DEPLOYS_POLL_MS, deployInFlight, deploysPollInterval } from '@/ui/hooks/useDeploys'
import {
  appAwaitsPipeline,
  appsDomainFromCatalogue,
  PIPELINE_POLL_MS,
  pipelinePollInterval,
} from '@/ui/hooks/usePipeline'
import { pendingProduction, ticketBadge, ticketVersion } from '@/ui/pages/apps/app/appPageModel'
import { hostPreview, slugFromName } from '@/ui/pages/apps/components/CreateAppModal'
import {
  groupPhases,
  pipelineRows,
  stepDuration,
  summarisePipeline,
} from '@/ui/pages/apps/components/PipelineProgress'

describe('pipelinePollInterval', () => {
  it('polls every 3 s while the run is running, and never once it settles', () => {
    expect(PIPELINE_POLL_MS).toBe(3000)
    expect(pipelinePollInterval('running')).toBe(3000)
    for (const status of ['succeeded', 'failed', 'none', undefined] as const) {
      expect(pipelinePollInterval(status)).toBe(false)
    }
  })

  it('polls while the app row says a launch is owed, before the Workflow writes its first step', () => {
    expect(appAwaitsPipeline('requested')).toBe(true)
    expect(appAwaitsPipeline('provisioning')).toBe(true)
    for (const status of ['live', 'failed', 'archived', undefined] as const) {
      expect(appAwaitsPipeline(status)).toBe(false)
    }
    expect(pipelinePollInterval('none', { appBusy: true })).toBe(3000)
    expect(pipelinePollInterval('none', { appBusy: false })).toBe(false)
  })

  it('keeps polling a settled view only inside the grace window after this tab started a run', () => {
    const now = 1_000_000
    expect(pipelinePollInterval('failed', { expectUntil: now + 1, now })).toBe(3000)
    expect(pipelinePollInterval('failed', { expectUntil: now, now })).toBe(false)
    expect(pipelinePollInterval('succeeded', { expectUntil: null, now })).toBe(false)
  })
})

describe('ticketBadge', () => {
  it('reads a ticket finished without an activation as not deployed', () => {
    const at = new Date()
    expect(ticketBadge({ status: 'finished', activatedAt: at })).toEqual({
      tone: 'completed',
      label: 'finished',
    })
    expect(ticketBadge({ status: 'finished', activatedAt: null })).toEqual({
      tone: 'failed',
      label: 'not activated',
    })
    expect(ticketBadge({ status: 'active', activatedAt: at }).label).toBe('live')
  })
})

describe('deploysPollInterval', () => {
  const now = Date.parse('2026-09-27T10:00:00Z')
  const soon = new Date(now + 60_000)
  const past = new Date(now - 1)

  it('polls while a deploy is in flight, not while it waits on a person or has settled', () => {
    expect(deployInFlight({ status: 'uploaded', expiresAt: null }, now)).toBe(true)
    expect(deployInFlight({ status: 'approved', expiresAt: soon }, now)).toBe(true)
    expect(deployInFlight({ status: 'approved', expiresAt: past }, now)).toBe(false)
    for (const status of ['pending', 'rejected', 'active', 'finished', 'failed'] as const) {
      expect(deployInFlight({ status, expiresAt: soon }, now)).toBe(false)
    }
    expect(
      deploysPollInterval(
        [
          { status: 'finished', expiresAt: null },
          { status: 'uploaded', expiresAt: null },
        ],
        now
      )
    ).toBe(DEPLOYS_POLL_MS)
    expect(deploysPollInterval([{ status: 'pending', expiresAt: soon }], now)).toBe(false)
    expect(deploysPollInterval(undefined, now)).toBe(false)
  })
})

const step = (key: string, status: PipelineStep['status'], extra: Partial<PipelineStep> = {}) => ({
  step: key,
  label: key,
  status,
  attempt: status === 'pending' ? 0 : 1,
  error: null,
  startedAt: null,
  finishedAt: null,
  ...extra,
})

describe('pipeline rows, summary and phases', () => {
  it('lists every defined step in order, with placeholders, and keeps an unknown one at the end', () => {
    const rows = pipelineRows({
      kind: 'create',
      steps: [step('repo', 'succeeded'), step('reserve', 'succeeded'), step('mystery', 'failed')],
    })
    expect(rows.map(r => r.step)).toEqual([...APP_LAUNCH_VIEW_STEPS.map(s => s.step), 'mystery'])
    expect(rows[2]).toMatchObject({
      step: 'scaffold',
      label: 'Scaffold from the template',
      status: 'pending',
      attempt: 0,
    })
    expect(pipelineRows({ kind: 'teardown', steps: [] })).toHaveLength(APP_TEARDOWN_STEPS.length)
  })

  it('summarises progress, the current step and the failure', () => {
    const rows = [
      step('a', 'succeeded', { startedAt: new Date(1000), finishedAt: new Date(3000) }),
      step('b', 'skipped'),
      step('c', 'failed', { startedAt: new Date(4000), finishedAt: new Date(9000) }),
      step('d', 'pending'),
    ]
    const summary = summarisePipeline(rows)
    expect(summary).toMatchObject({ done: 2, total: 4 })
    expect(summary.current?.step).toBe('c')
    expect(summary.failed?.step).toBe('c')
    expect(summary.startedAt).toEqual(new Date(1000))
    expect(summary.finishedAt).toEqual(new Date(9000))
    expect(stepDuration(rows[0] as PipelineStep)).toBe('2s')
    expect(stepDuration(rows[3] as PipelineStep)).toBeNull()
  })

  it('groups every launch step into a phase, each with a status from its steps', () => {
    const rows = pipelineRows({
      kind: 'create',
      steps: [step('reserve', 'succeeded'), step('repo', 'running')],
    })
    const phases = groupPhases('create', rows)
    expect(phases.map(p => p.label)).toEqual(['Repository', 'Infrastructure', 'Staging', 'Go live'])
    expect(phases.flatMap(p => p.rows).map(r => r.step)).toEqual(
      APP_LAUNCH_VIEW_STEPS.map(s => s.step)
    )
    expect(phases.map(p => p.rows.length)).toEqual([3, 8, 2, 2])
    expect(phases.map(p => p.status)).toEqual(['running', 'pending', 'pending', 'pending'])

    const teardown = groupPhases('teardown', pipelineRows({ kind: 'teardown', steps: [] }))
    expect(teardown.flatMap(p => p.rows).map(r => r.step)).toEqual(
      APP_TEARDOWN_STEPS.map(s => s.step)
    )
  })
})

describe('the Create modal helpers', () => {
  it('suggests a slug the server accepts from a display name', () => {
    expect(slugFromName('Expense Tracker')).toBe('expense-tracker')
    expect(slugFromName('  Café Menu — 2026 ')).toBe('cafe-menu-2026')
    expect(slugFromName('3D Printer Queue')).toBe('d-printer-queue')
    expect(slugFromName('x'.repeat(60))).toHaveLength(40)
    for (const name of ['Expense Tracker', 'HR portal!', 'a b c']) {
      expect(newAppSlugProblem(slugFromName(name))).toBeNull()
    }
  })

  it('previews the hosts only for a valid slug and a known domain', () => {
    expect(hostPreview('expenses', 'clewro.com')).toEqual({
      staging: 'expenses-staging.clewro.com',
      production: 'expenses.clewro.com',
    })
    expect(hostPreview('expenses', null)).toBeNull()
    expect(hostPreview('launch-pad', 'clewro.com')).toBeNull()
  })

  it('reads the apps domain from a created app, never from an imported one', () => {
    const app = (source: 'created' | 'imported', slug: string, url: string | null) =>
      ({
        slug,
        source,
        environments: [{ name: 'staging', url }],
      }) as unknown as AppSummary
    expect(
      appsDomainFromCatalogue([
        app('imported', 'legacy', 'https://legacy-staging.old.example'),
        app('created', 'broken', null),
        app('created', 'atlas', 'https://atlas-staging.clewro.com'),
      ])
    ).toBe('clewro.com')
    expect(appsDomainFromCatalogue([app('created', 'odd', 'https://elsewhere.example')])).toBeNull()
    expect(appsDomainFromCatalogue([])).toBeNull()
  })
})

describe('the deploys card helpers', () => {
  it('names a deploy by version, else short sha, and picks the oldest pending production ticket', () => {
    expect(ticketVersion({ version: '1.2.0', sha: 'abc' })).toBe('1.2.0')
    expect(ticketVersion({ version: null, sha: 'abcdef0123456789' })).toBe('abcdef0')
    expect(ticketVersion({ version: null, sha: null })).toBe('—')
    const t = (id: string, environment: 'staging' | 'production', status: 'pending' | 'active') =>
      ({ id, environment, status }) as never
    expect(
      pendingProduction([t('new', 'production', 'pending'), t('old', 'production', 'pending')])?.id
    ).toBe('old')
    expect(pendingProduction([t('s', 'staging', 'pending'), t('p', 'production', 'active')])).toBe(
      null
    )
  })
})
