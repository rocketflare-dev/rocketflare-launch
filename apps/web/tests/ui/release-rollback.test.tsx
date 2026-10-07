/**
 * Rollback and main-ahead on the app page (app page P3, plan decisions 5 and 8):
 *
 * - the Overview's `main  N commits ahead  [Release to staging ▸]` row above Staging — a plain
 *   button (Ship or Build it stays the one hero), opening the release dialog with the commits,
 *   patch by default; hidden when main is not ahead or a release is already on its way to
 *   staging; no button for somebody who may not deploy;
 * - the Live row says "(rolled back from v1.4.2)", and a rollback waiting for approval is its
 *   in-flight line;
 * - a Releases row's ⋯ offers "Roll back to here…" only on an earlier release that was live, the
 *   confirm warns that migrations and secrets don't revert, and it calls the rollback route;
 *   a member sees no such item; the release page has the same button.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared'
import AppPage from '@/ui/pages/apps/AppPage'
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
const COMPARE = `/api/apps/${APP_ID}/releases/compare`
const RELEASES = `/api/apps/${APP_ID}/releases`
const OLD_ID = 'e1e1e1e1-0000-4000-8000-000000000141'
const ROLLBACK = `POST ${RELEASES}/${OLD_ID}/rollback`
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

const appEnv = (name: 'staging' | 'production', version: string) => ({
  id:
    name === 'staging'
      ? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      : 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  name,
  url: `https://expenses${name === 'staging' ? '-staging' : ''}.apps.test`,
  healthStatus: 'up',
  healthCheckedAt: minutesAgo(2),
  healthChangedAt: minutesAgo(60),
  healthVersion: version,
  healthLatencyMs: 80,
  healthError: null,
  workerName: name === 'staging' ? 'expenses-staging' : 'expenses',
  resources: {},
  lastDeployVersion: version,
  lastDeployAt: minutesAgo(10),
  lastDeployBy: 'octocat',
})

const appDetail = (overrides: Record<string, unknown> = {}) => ({
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
  environments: [appEnv('staging', '1.4.2'), appEnv('production', '1.4.2')],
  createdAt: '2026-09-01T00:00:00Z',
  templateContractVersion: '1',
  defaultBranch: 'main',
  updatedAt: '2026-09-01T00:00:00Z',
  viewerCanDeploy: true,
  ...overrides,
})

/** 1.4.2 is live; 1.4.1 was live before it. */
const current = releaseRow({ version: '1.4.2', tag: '1.4.2', status: 'production_active' })
const earlier = releaseRow({
  id: OLD_ID,
  version: '1.4.1',
  tag: '1.4.1',
  previousTag: '1.4.0',
  status: 'production_active',
})

const env = (version: string, overrides: Record<string, unknown> = {}) => ({
  version,
  deployedAt: minutesAgo(10),
  healthStatus: 'up',
  url: 'https://expenses.apps.test',
  releaseId: RELEASE_ID,
  ...overrides,
})

const promotion = (overrides: Record<string, unknown> = {}) => ({
  candidate: current,
  staging: env('1.4.2'),
  production: env('1.4.2'),
  changes: [],
  changesTruncated: false,
  approval: null,
  candidateRun: null,
  rollback: null,
  ...overrides,
})

const compare = (aheadBy: number) => ({
  branch: 'main',
  base: '1.4.2',
  headSha: aheadBy ? 'f'.repeat(40) : null,
  aheadBy,
  commits: [
    { sha: 'f'.repeat(40), message: 'Fix the export button (#41)', author: 'Ana', prNumber: 41 },
    { sha: 'e'.repeat(40), message: 'Tidy the footer', author: 'Ben', prNumber: null },
  ].slice(0, aheadBy),
  compareUrl: 'https://github.com/acme/expenses/compare/1.4.2...main',
  checkedAt: minutesAgo(0),
  error: null,
})

const pipelineNone = (kind: 'create' | 'teardown') => ({
  appId: APP_ID,
  runId: null,
  kind,
  status: 'none',
  steps: [],
  canRescaffold: false,
  templateTag: null,
  rescaffoldChecksDatabase: false,
})

function render(
  routes: RouteTable,
  {
    session = makeSession(),
    route = '/apps/expenses',
    detail = appDetail(),
  }: { session?: ReturnType<typeof makeSession>; route?: string; detail?: unknown } = {}
) {
  const fetchMock = stubFetch({
    '/api/apps/expenses': detail,
    [`/api/apps/${APP_ID}/pipeline`]: (_init: RequestInit | undefined, url: URL) =>
      pipelineNone(url.searchParams.get('kind') === 'create' ? 'create' : 'teardown'),
    [`/api/apps/${APP_ID}/sessions`]: { items: [] },
    [`/api/apps/${APP_ID}/deploys`]: { items: [] },
    [`/api/apps/${APP_ID}/deploys/latest`]: { items: [] },
    [RELEASES]: { items: [current, earlier] },
    [`${RELEASES}/${OLD_ID}/chain`]: { release: earlier, events: [] },
    [PROMOTION]: promotion(),
    [COMPARE]: compare(2),
    ...routes,
  })
  renderWithProviders(
    <Routes>
      <Route path="/apps/:slug/*" element={<AppPage />} />
    </Routes>,
    { session, route }
  )
  return fetchMock
}

const notDeployer = () => appDetail({ viewerCanDeploy: false })

describe('main ahead on the Overview', () => {
  it('shows main N commits ahead with Release to staging, which cuts a patch release', async () => {
    const fetchMock = render({
      [`POST ${RELEASES}`]: { ...current, id: OLD_ID, version: '1.4.3', tag: '1.4.3' },
    })
    const main = await screen.findByTestId('env-main')
    expect(main).toHaveTextContent('main')
    expect(main).toHaveTextContent('2 commits ahead')
    const button = within(main).getByRole('button', { name: 'Release to staging ▸' })
    // One hero per view: this is a plain button.
    expect(button).not.toHaveClass('btn-flame')
    fireEvent.click(button)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Release to staging')).toBeInTheDocument()
    expect(within(dialog).getByText('Fix the export button (#41)')).toBeInTheDocument()
    expect(within(dialog).getByText('Tidy the footer')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Release 1.4.3' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST ${RELEASES}`)).toEqual({ bump: 'patch' })
    )
  })

  it('is hidden when main is not ahead, or a release is already on its way to staging', async () => {
    // The compare was asked for and its answer had time to render.
    const asked = async (mock: ReturnType<typeof render>) => {
      await waitFor(() =>
        expect(mock.mock.calls.some(([input]) => String(input).endsWith(COMPARE))).toBe(true)
      )
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const notAhead = render({ [COMPARE]: compare(0) })
    await screen.findByTestId('env-staging')
    await asked(notAhead)
    await screen.findByText('v1.4.2', { selector: '[data-testid="env-staging"] *' })
    expect(screen.queryByTestId('env-main')).not.toBeInTheDocument()
    cleanup()
    const inFlight = render({
      [PROMOTION]: promotion({ candidate: { ...current, status: 'tagged' } }),
    })
    await screen.findByTestId('env-staging')
    await asked(inFlight)
    expect(screen.queryByTestId('env-main')).not.toBeInTheDocument()
  })

  it('waits while a session’s landing is releasing this app, and says why (issue #22)', async () => {
    render({
      [`/api/apps/${APP_ID}/sessions`]: {
        items: [
          {
            id: '5e551000-0000-4000-8000-000000000001',
            appId: APP_ID,
            kind: 'session',
            shortId: 'abcdefghijkl',
            title: 'Friendlier home page',
            status: 'shipped',
            createdByUserId: null,
            branch: 'session/abcdefghijkl',
            turnCount: 3,
            costMicrocents: 0,
            prNumber: 6,
            prUrl: 'https://github.com/acme/expenses/pull/6',
            lastActivityAt: minutesAgo(1),
            createdAt: minutesAgo(30),
            shipping: {
              stage: 'releasing',
              waitingOn: null,
              stalledReason: null,
              approvalId: null,
              prNumber: 6,
              version: null,
              since: minutesAgo(2),
            },
          },
        ],
      },
    })
    const main = await screen.findByTestId('env-main')
    const button = within(main).getByRole('button', { name: 'Release to staging ▸' })
    await waitFor(() => expect(button).toBeDisabled())
    expect(main).toHaveTextContent(
      'Launch is releasing pull request #6 to staging, with everything on main.'
    )
  })

  it('a reader who may not deploy sees the count and no button', async () => {
    render({}, { detail: notDeployer() })
    const main = await screen.findByTestId('env-main')
    expect(main).toHaveTextContent('2 commits ahead')
    expect(within(main).queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('the Live row after and during a rollback', () => {
  it('says what a rollback replaced', async () => {
    render({
      '/api/apps/expenses': appDetail({
        environments: [appEnv('staging', '1.4.2'), appEnv('production', '1.4.1')],
      }),
      [PROMOTION]: promotion({
        candidate: { ...current, status: 'rolled_back' },
        production: env('1.4.1', { releaseId: OLD_ID, rolledBackFrom: '1.4.2' }),
      }),
    })
    const live = await screen.findByTestId('env-production')
    await waitFor(() =>
      expect(within(live).getByTestId('rolled-back-note')).toHaveTextContent(
        '(rolled back from v1.4.2)'
      )
    )
    expect(within(live).getByText('v1.4.1')).toBeInTheDocument()
  })

  it('shows a rollback waiting for approval as the Live row’s line', async () => {
    render({
      [PROMOTION]: promotion({
        rollback: {
          releaseId: OLD_ID,
          version: '1.4.1',
          from: '1.4.2',
          approval: {
            id: APPROVAL_ID,
            status: 'pending',
            approvers: [{ id: 'c0000000-0000-4000-8000-000000000001', name: 'Bob', email: 'b@x' }],
          },
        },
      }),
    })
    const live = await screen.findByTestId('env-production')
    await waitFor(() =>
      expect(live).toHaveTextContent('→ v1.4.1 (rollback) · Waiting for approval from Bob')
    )
  })
})

describe('Roll back to here', () => {
  it('a Releases row’s ⋯ offers it on an earlier live release, warns, and calls the route', async () => {
    const fetchMock = render(
      {
        [ROLLBACK]: {
          release: earlier,
          from: '1.4.2',
          approvalId: APPROVAL_ID,
          approvalStatus: 'pending',
        },
      },
      { route: '/apps/expenses/releases' }
    )
    const table = await screen.findByRole('table', { name: 'Releases' })
    // Not on what Live runs now (its row has nothing in a ⋯ at all).
    expect(within(table).queryByLabelText('Actions for v1.4.2')).toBeNull()

    fireEvent.click(within(table).getByLabelText('Actions for v1.4.1'))
    fireEvent.click(await within(table).findByRole('button', { name: 'Roll back to here…' }))
    const confirm = await screen.findByRole('button', { name: 'Roll back to v1.4.1' })
    const dialog = confirm.closest('dialog') as HTMLElement
    expect(dialog).toHaveTextContent('Roll Live back to v1.4.1?')
    expect(dialog).toHaveTextContent('Migrations and secrets don’t revert')
    fireEvent.click(confirm)
    await waitFor(() => expect(requestBody(fetchMock, ROLLBACK)).toEqual({}))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map(t => t.message)).toContain(
        'Rollback to v1.4.1 requested — waiting for approval'
      )
    )
  })

  it('is hidden from a reader who may not deploy', async () => {
    render({}, { route: '/apps/expenses/releases', detail: notDeployer() })
    const table = await screen.findByRole('table', { name: 'Releases' })
    const menu = within(table).queryByLabelText('Actions for v1.4.1')
    if (menu) fireEvent.click(menu)
    expect(within(table).queryByRole('button', { name: 'Roll back to here…' })).toBeNull()
  })

  it('the release page offers it beside the release', async () => {
    render({}, { route: '/apps/expenses/releases/1.4.1' })
    expect(await screen.findByRole('button', { name: 'Roll back to here' })).toBeInTheDocument()
  })
})
