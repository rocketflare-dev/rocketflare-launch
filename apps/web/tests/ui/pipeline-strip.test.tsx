/**
 * The app page's pipeline strip (rocketflare-launch#5 part 8): staging → [Promote to production] →
 * production, read from `GET /api/apps/:id/promotion`. Each state — enabled; disabled with its
 * reason (still deploying, unhealthy, production already runs it, nothing on staging) — and,
 * before staging, the tag's deploy run on GitHub (checking, deploying, which job failed, with
 * "View on GitHub"); waiting
 * for approval with who and the request's link; deploying; live with the production link — the
 * read-only strip for somebody who may not promote, what the promotion ships in plain words, and
 * that pressing Promote calls the existing promote route and then shows who it waits on.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared'
import { PipelineStrip } from '@/ui/pages/apps/components/PipelineStrip'
import { APP_ID, APPROVAL_ID, RELEASE_ID, releaseRow } from './helpers/approvals'
import {
  makeSession,
  type RouteTable,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useToastStore.setState({ toasts: [] })
})

const PROMOTION = `/api/apps/${APP_ID}/promotion`
const PROMOTE = `POST /api/apps/${APP_ID}/releases/${RELEASE_ID}/promote`
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

const environment = (overrides: Record<string, unknown> = {}) => ({
  version: '1.4.2',
  deployedAt: minutesAgo(10),
  healthStatus: 'up',
  url: 'https://expenses-staging.apps.test',
  releaseId: RELEASE_ID,
  ...overrides,
})

function view(overrides: Record<string, unknown> = {}, release: Record<string, unknown> = {}) {
  return {
    candidate: releaseRow({ version: '1.4.2', tag: '1.4.2', ...release }),
    staging: environment(),
    production: environment({
      version: '1.4.1',
      deployedAt: minutesAgo(60 * 24),
      url: 'https://expenses.apps.test',
      releaseId: null,
    }),
    changes: [
      {
        version: '1.4.2',
        number: 41,
        title: 'Fix the export button',
        url: 'https://github.com/acme/expenses/pull/41',
        sessionId: 'aaaaaaaa-0000-4000-8000-000000000041',
        sessionTitle: 'Make the export button work again',
      },
      {
        version: '1.4.2',
        number: 40,
        title: 'Add a receipts column',
        url: null,
        sessionId: null,
        sessionTitle: null,
      },
    ],
    changesTruncated: false,
    approval: null,
    ...overrides,
  }
}

function renderStrip(routes: RouteTable, canPromote = true) {
  const fetchMock = stubFetch(routes)
  renderWithProviders(
    <Routes>
      <Route
        path="/apps/:slug"
        element={<PipelineStrip appId={APP_ID} canPromote={canPromote} ownerTeam="Finance" />}
      />
    </Routes>,
    { session: makeSession(), route: '/apps/expenses' }
  )
  return fetchMock
}

const promoteButton = () => screen.findByRole('button', { name: /Promote to production/ })

describe('PipelineStrip', () => {
  it('offers Promote when staging runs a newer, healthy release — with what it ships', async () => {
    renderStrip({ [PROMOTION]: view() })
    expect(await promoteButton()).toBeEnabled()
    expect(screen.getByText('Staging: v1.4.2')).toBeInTheDocument()
    expect(screen.getByText(/healthy,/)).toHaveTextContent('healthy, 10 minutes ago')
    expect(screen.getByText('Production: v1.4.1')).toBeInTheDocument()
    const ships = screen.getByRole('list', { name: 'What this promotion ships' })
    // The session's own words lead; the PR title follows; never a SHA.
    expect(within(ships).getByText('Make the export button work again')).toBeInTheDocument()
    expect(within(ships).getByText(/Fix the export button/)).toBeInTheDocument()
    expect(within(ships).getByText('Add a receipts column')).toBeInTheDocument()
    expect(within(ships).getByRole('link', { name: 'change #41' })).toHaveAttribute(
      'href',
      'https://github.com/acme/expenses/pull/41'
    )
    expect(ships).not.toHaveTextContent('cccc')
  })

  it('says under each PR title what it changed, from the stored ship summary (#5)', async () => {
    const base = view()
    renderStrip({
      [PROMOTION]: view({
        changes: [
          {
            ...base.changes[0],
            summary:
              '## What changed\n\n- The **export** button downloads a CSV again\n- Dates use the `en-GB` format\n\nMore detail on the PR.',
          },
          // No session, no stored summary (or a server from before #5): the title alone.
          base.changes[1],
        ],
      }),
    })
    const ships = await screen.findByRole('list', { name: 'What this promotion ships' })
    const rows = within(ships).getAllByRole('listitem')
    // The first paragraph with words in it, as plain text: no heading, list or code marks.
    expect(
      within(rows[0] as HTMLElement).getByText(/The export button downloads/)
    ).toHaveTextContent('The export button downloads a CSV again Dates use the en-GB format')
    expect((rows[0] as HTMLElement).querySelector('[data-change-summary]')).not.toBeNull()
    expect((rows[1] as HTMLElement).querySelector('[data-change-summary]')).toBeNull()
  })

  it.each([
    [
      // Tagged, and no run on GitHub found (yet): the old words.
      'still deploying',
      view({}, { status: 'tagged', createdAt: minutesAgo(5) }),
      'Staging is still deploying.',
    ],
    [
      // The staging job has called Launch (a ticket is open).
      'deploying to staging',
      view({}, { status: 'staging', createdAt: minutesAgo(5) }),
      'Deploying v1.4.2 to staging…',
    ],
    [
      // Past the deploy window (RELEASE_STAGING_TIMEOUT_MINUTES): stuck, not deploying.
      'a release never reached staging',
      view({}, { status: 'tagged', createdAt: minutesAgo(60 * 24 * 3) }),
      'v1.4.2 never reached staging.',
    ],
    [
      // A build that is not a release keeps its own name — no "v" in front of it.
      'staging runs a build that is not the release',
      view({ staging: environment({ version: 'main-64a36e6', releaseId: null }) }),
      'Staging runs main-64a36e6, not v1.4.2.',
    ],
    [
      'unhealthy',
      view({ staging: environment({ healthStatus: 'down' }) }),
      'Staging is unhealthy.',
    ],
    [
      'production already runs it',
      view({ production: environment({ version: '1.4.2' }) }),
      'Production already runs v1.4.2.',
    ],
    [
      'nothing on staging',
      view({ candidate: null, staging: environment({ version: null }), changes: [] }),
      'Nothing on staging yet.',
    ],
  ])('disables Promote when %s, and says why', async (_label, body, reason) => {
    renderStrip({ [PROMOTION]: body })
    const button = await promoteButton()
    expect(button).toBeDisabled()
    expect(screen.getByText(reason)).toBeInTheDocument()
    expect(button).toHaveAttribute('aria-describedby', 'pipeline-reason')
  })

  describe('the tag’s deploy run on GitHub (candidateRun)', () => {
    const RUN_URL = 'https://github.com/acme/expenses/actions/runs/77'
    const run = (overrides: Record<string, unknown> = {}) => ({
      status: 'in_progress',
      conclusion: null,
      url: RUN_URL,
      currentJob: 'ci / Gate',
      failedJob: null,
      ...overrides,
    })
    const reasonLine = () => document.getElementById('pipeline-reason') as HTMLElement

    it('says GitHub is checking a tagged release, with the job it is on and its link', async () => {
      renderStrip({
        [PROMOTION]: view({ candidateRun: run() }, { status: 'tagged', createdAt: minutesAgo(3) }),
      })
      expect(await promoteButton()).toBeDisabled()
      expect(reasonLine()).toHaveTextContent(
        'v1.4.2 is tagged — GitHub is checking it before it deploys to staging. Running: ci / Gate.'
      )
      expect(screen.getByRole('link', { name: /View on GitHub/ })).toHaveAttribute('href', RUN_URL)
      expect(screen.queryByText(/still deploying/)).toBeNull()
    })

    it('keeps following a run past 45 minutes: a slow gate is not a stuck release', async () => {
      renderStrip({
        [PROMOTION]: view(
          { candidateRun: run({ status: 'queued', currentJob: null }) },
          { status: 'tagged', createdAt: minutesAgo(50) }
        ),
      })
      await promoteButton()
      expect(reasonLine()).toHaveTextContent(/^v1\.4\.2 is tagged — GitHub is checking it/)
      expect(reasonLine()).not.toHaveTextContent('Running:')
      expect(screen.queryByText(/never reached staging/)).toBeNull()
    })

    it('says "Deploying to staging…" once the staging job has called Launch', async () => {
      renderStrip({
        [PROMOTION]: view(
          { candidateRun: run({ currentJob: 'Deploy to staging' }) },
          { status: 'staging', createdAt: minutesAgo(8) }
        ),
      })
      await promoteButton()
      expect(reasonLine()).toHaveTextContent(
        'Deploying v1.4.2 to staging… Running: Deploy to staging.'
      )
      expect(screen.getByRole('link', { name: /View on GitHub/ })).toHaveAttribute('href', RUN_URL)
    })

    it('names the job that failed, with the run’s link', async () => {
      renderStrip({
        [PROMOTION]: view(
          {
            candidateRun: run({
              status: 'completed',
              conclusion: 'failure',
              currentJob: null,
              failedJob: 'ci / Gate',
            }),
          },
          {
            status: 'failed',
            error: `staging: the deploy run failed at "ci / Gate" (${RUN_URL})`,
            createdAt: minutesAgo(9),
          }
        ),
      })
      expect(await promoteButton()).toBeDisabled()
      expect(reasonLine()).toHaveTextContent('v1.4.2 did not deploy: ci / Gate failed.')
      expect(screen.getByRole('link', { name: /View on GitHub/ })).toHaveAttribute('href', RUN_URL)
    })

    it('a failed release with no run says only that it did not deploy', async () => {
      renderStrip({
        [PROMOTION]: view(
          {},
          { status: 'failed', error: 'staging: refused', createdAt: minutesAgo(9) }
        ),
      })
      await promoteButton()
      expect(reasonLine()).toHaveTextContent('v1.4.2 did not deploy.')
      expect(screen.queryByRole('link', { name: /View on GitHub/ })).toBeNull()
    })
  })

  it('waits for approval, naming the approvers and linking the request to share', async () => {
    renderStrip({
      [PROMOTION]: view(
        {
          approval: {
            id: APPROVAL_ID,
            status: 'pending',
            approvers: [
              { id: 'b0000000-0000-4000-8000-000000000001', name: 'Bob Byrne', email: 'b@x.test' },
              { id: 'b0000000-0000-4000-8000-000000000002', name: null, email: 'dana@x.test' },
            ],
          },
        },
        { status: 'awaiting_approval', approvalId: APPROVAL_ID }
      ),
    })
    expect(
      await screen.findByText(/Waiting for approval from Bob Byrne and dana@x\.test\./)
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See the request' })).toHaveAttribute(
      'href',
      `/approvals/${APPROVAL_ID}`
    )
    expect(screen.getByRole('button', { name: /Copy link/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Promote to production/ })).not.toBeInTheDocument()
  })

  it('shows the production deploy under way', async () => {
    renderStrip({ [PROMOTION]: view({}, { status: 'promoting', approvalId: APPROVAL_ID }) })
    expect(await screen.findByText('Deploying to production…')).toBeInTheDocument()
    expect(screen.getByText(/v1\.4\.2 is on its way to production/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Promote to production/ })).not.toBeInTheDocument()
  })

  it('says it is live in production, with the production link', async () => {
    renderStrip({
      [PROMOTION]: view(
        { production: environment({ url: 'https://expenses.apps.test' }) },
        { status: 'production_active' }
      ),
    })
    const live = await screen.findByText(/Live in production: v1\.4\.2/)
    expect(within(live).getByRole('link', { name: /Open production/ })).toHaveAttribute(
      'href',
      'https://expenses.apps.test'
    )
    // Only the live line: no disabled Promote and no "already runs" reason beside it.
    expect(screen.queryByRole('button', { name: /Promote to production/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Production already runs/)).not.toBeInTheDocument()
    expect(
      screen.getByRole('list', { name: 'What v1.4.2 brought to production' })
    ).toBeInTheDocument()
  })

  it('is read-only for somebody who may not promote, saying who can', async () => {
    renderStrip({ [PROMOTION]: view() }, false)
    expect(await screen.findByText('Ready to promote')).toBeInTheDocument()
    expect(
      screen.getByText('The Finance team and organisation admins can promote to production.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Promote to production/ })).not.toBeInTheDocument()
  })

  it('promotes through the existing route, then shows who the request waits on', async () => {
    let promoted = false
    const fetchMock = renderStrip({
      [PROMOTION]: () =>
        promoted
          ? view(
              {
                approval: {
                  id: APPROVAL_ID,
                  status: 'pending',
                  approvers: [
                    {
                      id: 'b0000000-0000-4000-8000-000000000001',
                      name: 'Bob Byrne',
                      email: 'b@x.test',
                    },
                  ],
                },
              },
              { status: 'awaiting_approval', approvalId: APPROVAL_ID }
            )
          : view(),
      [PROMOTE]: () => {
        promoted = true
        return {
          release: releaseRow({
            version: '1.4.2',
            status: 'awaiting_approval',
            approvalId: APPROVAL_ID,
          }),
          approvalId: APPROVAL_ID,
        }
      },
    })
    fireEvent.click(await promoteButton())
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Promote 1.4.2 to production?')).toBeInTheDocument()
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Month end needs the export fix' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ask for approval' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, PROMOTE)).toEqual({ reason: 'Month end needs the export fix' })
    )
    // The strip stays on the page and moves on to the request.
    expect(await screen.findByText(/Waiting for approval from Bob Byrne\./)).toBeInTheDocument()
  })
})
