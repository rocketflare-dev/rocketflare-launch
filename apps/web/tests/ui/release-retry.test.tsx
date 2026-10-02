/**
 * Stage-aware Retry, "Fix in a session" and Cancel release on the app page (app page P2, plan
 * decision 7):
 *
 * - Needs you lists a stuck release with ONE Retry labelled for its stage ("Retry staging
 *   deploy", "Check staging again"…), sending the stage it saw, and "Fix in a session", which
 *   starts a session seeded from the release and opens it;
 * - a reader who may not deploy sees no Retry;
 * - a Releases row's ⋯ carries Retry, Fix in a session and Cancel release (after a confirm);
 * - the release page says where the release is stuck and lists each GitHub run attempt.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared'
import AppPage from '@/ui/pages/apps/AppPage'
import { APP_ID, RELEASE_ID, releaseRow } from './helpers/approvals'
import {
  IDS,
  makeSession,
  type RouteTable,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'
import { sessionRow } from './helpers/sessions'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useToastStore.setState({ toasts: [] })
})

const PROMOTION = `/api/apps/${APP_ID}/promotion`
const RETRY = `/api/apps/${APP_ID}/releases/${RELEASE_ID}/retry`
const CANCEL = `/api/apps/${APP_ID}/releases/${RELEASE_ID}/cancel`
const SESSIONS = `/api/apps/${APP_ID}/sessions`
const RUN_URL = 'https://github.com/acme/expenses/actions/runs/77'
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
  environments: [appEnv('staging', '1.4.1'), appEnv('production', '1.4.1')],
  createdAt: '2026-09-01T00:00:00Z',
  templateContractVersion: '1',
  defaultBranch: 'main',
  updatedAt: '2026-09-01T00:00:00Z',
  viewerCanDeploy: true,
  ...overrides,
})

const failed = releaseRow({
  version: '1.4.2',
  tag: '1.4.2',
  status: 'failed',
  error: 'staging: refused',
  failedStage: 'staging_deploy',
  stagingTicketId: '56565656-5656-4565-8565-565656565656',
})

const promotion = (candidate: Record<string, unknown>) => ({
  candidate,
  staging: null,
  production: null,
  changes: [],
  changesTruncated: false,
  approval: null,
  candidateRun: null,
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

const ticket = (overrides: Record<string, unknown> = {}) => ({
  id: '56565656-5656-4565-8565-565656565656',
  appId: APP_ID,
  environmentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  environment: 'staging',
  purpose: 'deploy',
  status: 'failed',
  repository: 'acme/expenses',
  runId: '77',
  runAttempt: 1,
  sha: 'c'.repeat(40),
  ref: 'refs/tags/1.4.2',
  actor: 'octocat',
  version: '1.4.2',
  cfVersionId: null,
  activatedAt: null,
  refused: null,
  decisionSource: 'auto',
  decidedByUserId: null,
  decidedAt: minutesAgo(12),
  expiresAt: null,
  error: 'refused',
  createdAt: minutesAgo(12),
  updatedAt: minutesAgo(11),
  finishedAt: minutesAgo(11),
  releaseId: RELEASE_ID,
  approvalId: null,
  ...overrides,
})

const retryAnswer = {
  release: { ...failed, status: 'staging', error: null, failedStage: null },
  stage: 'staging_deploy',
  action: 'rerun',
  attempt: 2,
  runUrl: RUN_URL,
  approvalId: null,
  health: null,
}

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
    [SESSIONS]: { items: [] },
    [`/api/apps/${APP_ID}/deploys`]: { items: [] },
    [`/api/apps/${APP_ID}/deploys/latest`]: { items: [] },
    [`/api/apps/${APP_ID}/releases`]: { items: [failed] },
    [`/api/apps/${APP_ID}/releases/${RELEASE_ID}/chain`]: { release: failed, events: [] },
    [PROMOTION]: promotion(failed),
    ...routes,
  })
  renderWithProviders(
    <Routes>
      <Route path="/apps/:slug/sessions/:id" element={<p>The session page</p>} />
      <Route path="/apps/:slug/*" element={<AppPage />} />
    </Routes>,
    { session, route }
  )
  return fetchMock
}

async function needsYouItem() {
  const band = (await screen.findByRole('heading', { name: /Needs you|Attention/ })).closest(
    'section'
  ) as HTMLElement
  const item = within(band)
    .getAllByRole('listitem')
    .find(li => li.textContent?.includes('v1.4.2'))
  if (!item) throw new Error('no Needs-you item for v1.4.2')
  return item
}

describe('Needs you — a stuck release', () => {
  it('retries the stage it is stuck at, labelled with what it does', async () => {
    const fetchMock = render({ [`POST ${RETRY}`]: retryAnswer })
    const item = await needsYouItem()
    fireEvent.click(within(item).getByRole('button', { name: 'Retry staging deploy' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST ${RETRY}`)).toEqual({ stage: 'staging_deploy' })
    )
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map(t => t.message)).toContain(
        'Re-running the failed jobs on GitHub (attempt 2)'
      )
    )
  })

  it('names the health check for an environment that is down', async () => {
    render({
      [PROMOTION]: promotion(
        releaseRow({ version: '1.4.2', tag: '1.4.2', failedStage: 'staging_health' })
      ),
    })
    expect(await screen.findByText('Staging runs v1.4.2 but is down')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check staging again' })).toBeInTheDocument()
  })

  it('starts a session seeded from the release and opens it', async () => {
    const fetchMock = render({
      [`POST ${SESSIONS}`]: { session: sessionRow({ title: 'Fix 1.4.2: staging deploy failed' }) },
    })
    const item = await needsYouItem()
    fireEvent.click(within(item).getByRole('button', { name: 'Fix in a session' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST ${SESSIONS}`)).toEqual({
        fixRelease: { releaseId: RELEASE_ID },
      })
    )
    expect(await screen.findByText('The session page')).toBeInTheDocument()
  })

  it('offers no Retry to somebody who may not deploy the app', async () => {
    render(
      {},
      {
        detail: appDetail({ viewerCanDeploy: false }),
        session: makeSession({
          tenant: { id: IDS.tenant, name: 'Acme', slug: 'acme', role: 'member' },
        }),
      }
    )
    const item = await needsYouItem()
    expect(within(item).queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument()
    // Members may still start a session to fix it.
    expect(within(item).getByRole('button', { name: 'Fix in a session' })).toBeInTheDocument()
  })
})

describe('the Releases tab and the release page', () => {
  it('a row’s ⋯ retries, and cancels an in-flight release after a confirm', async () => {
    const deploying = releaseRow({
      id: 'e1e1e1e1-0000-4000-8000-000000000002',
      version: '1.4.3',
      tag: '1.4.3',
      status: 'staging',
    })
    const fetchMock = render(
      {
        [`/api/apps/${APP_ID}/releases`]: { items: [deploying, failed] },
        [`POST ${RETRY}`]: retryAnswer,
        [`POST /api/apps/${APP_ID}/releases/${deploying.id}/cancel`]: {
          release: { ...deploying, status: 'failed', failedStage: 'staging_deploy' },
          runUrl: RUN_URL,
        },
      },
      { route: '/apps/expenses/releases' }
    )
    const table = await screen.findByRole('table', { name: 'Releases' })
    fireEvent.click(within(table).getByLabelText('Actions for v1.4.2'))
    fireEvent.click(within(table).getByRole('button', { name: 'Retry staging deploy' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST ${RETRY}`)).toEqual({ stage: 'staging_deploy' })
    )

    fireEvent.click(within(table).getByLabelText('Actions for v1.4.3'))
    fireEvent.click(within(table).getByRole('button', { name: 'Cancel release…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel the run' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            init?.method === 'POST' && String(input).endsWith(`/releases/${deploying.id}/cancel`)
        )
      ).toBe(true)
    )
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(CANCEL))).toBe(false)
  })

  it('the release page says where it is stuck and lists each run attempt', async () => {
    render(
      {
        [`/api/apps/${APP_ID}/deploys`]: {
          items: [
            ticket({
              id: '57575757-5757-4575-8575-575757575757',
              runAttempt: 2,
              status: 'approved',
              error: null,
              createdAt: minutesAgo(1),
            }),
            ticket(),
          ],
        },
      },
      { route: '/apps/expenses/releases/1.4.2' }
    )
    expect(await screen.findByTestId('failed-stage')).toHaveTextContent('Stuck at: Staging deploy')
    expect(screen.getByRole('button', { name: 'Retry staging deploy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fix in a session' })).toBeInTheDocument()
    const deploys = screen.getAllByTestId('deploy-staging')
    expect(deploys).toHaveLength(2)
    expect(deploys[0]).toHaveTextContent('attempt 2')
    expect(deploys[1]).not.toHaveTextContent('attempt')
  })
})
