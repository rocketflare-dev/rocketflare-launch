/**
 * Creating an app (Launch P2, slice 2e): the Create modal's live slug check, host preview and
 * navigation; the launch's progress with a failed step and "Retry from failed step"; the Archive
 * modal's typed confirmation; and a pending production deploy decided on the app page. The server
 * is a `stubFetch` route table built from the shared P2 contracts' shapes.
 */
import { APP_LAUNCH_STEPS } from '@launch/shared/launch-pipeline'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes, useParams } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AppDetailPage from '@/ui/pages/apps/AppDetailPage'
import CataloguePage from '@/ui/pages/apps/CataloguePage'
import {
  errorResponse,
  IDS,
  jsonResponse,
  makeSession,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const APP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const STAGING_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PRODUCTION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const RUN_ID = '12121212-1212-4212-8212-121212121212'
const TEARDOWN_RUN_ID = '34343434-3434-4343-8343-343434343434'
const TICKET_ID = '56565656-5656-4565-8565-565656565656'
const GROUP_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

const env = (id: string, name: 'staging' | 'production', slug = 'expenses') => ({
  id,
  name,
  url: `https://${slug}${name === 'staging' ? '-staging' : ''}.apps.test`,
  healthStatus: 'unknown',
  healthCheckedAt: null,
  healthChangedAt: null,
  healthVersion: null,
  healthLatencyMs: null,
  healthError: null,
})

const summary = (overrides: Record<string, unknown> = {}) => ({
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
  environments: [env(STAGING_ID, 'staging'), env(PRODUCTION_ID, 'production')],
  createdAt: '2026-09-27T00:00:00Z',
  ...overrides,
})

const detail = (overrides: Record<string, unknown> = {}) => ({
  // The server's answer for the caller; an admin's (or an owner's) by default.
  viewerCanDeploy: true,
  ...summary(overrides),
  templateContractVersion: '1',
  defaultBranch: 'main',
  environments: [env(STAGING_ID, 'staging'), env(PRODUCTION_ID, 'production')].map(e => ({
    ...e,
    workerName: e.name === 'staging' ? 'expenses-staging' : 'expenses',
    resources: {},
    lastDeployVersion: null,
    lastDeployAt: null,
    lastDeployBy: null,
  })),
  updatedAt: '2026-09-27T00:00:00Z',
})

const t0 = Date.parse('2026-09-27T10:00:00Z')
const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString()

/** A launch view: every step before `failedAt` succeeded, that one failed, the rest pending. */
function launchView(failedAt: string | null, status: 'running' | 'failed' | 'succeeded') {
  const failedIndex = APP_LAUNCH_STEPS.findIndex(s => s.step === failedAt)
  return {
    appId: APP_ID,
    runId: RUN_ID,
    kind: 'create',
    status,
    steps: APP_LAUNCH_STEPS.map((def, i) => {
      const state =
        failedIndex === -1 || i < failedIndex
          ? 'succeeded'
          : i === failedIndex
            ? 'failed'
            : 'pending'
      return {
        step: def.step,
        label: def.label,
        status: state === 'failed' && status === 'running' ? 'running' : state,
        attempt: state === 'pending' ? 0 : state === 'failed' ? 3 : 1,
        error:
          state === 'failed' && status === 'failed'
            ? 'R2: bucket expenses-files-staging: HTTP 500 internal error'
            : null,
        startedAt: state === 'pending' ? null : at(i * 10),
        finishedAt:
          state === 'succeeded' || (state === 'failed' && status === 'failed')
            ? at(i * 10 + 4)
            : null,
      }
    }),
  }
}

const ticket = (overrides: Record<string, unknown> = {}) => ({
  id: TICKET_ID,
  appId: APP_ID,
  environmentId: PRODUCTION_ID,
  environment: 'production',
  purpose: 'deploy',
  status: 'pending',
  repository: 'acme/expenses',
  runId: '9001',
  runAttempt: 1,
  sha: 'a'.repeat(40),
  ref: 'refs/tags/v1.2.0',
  actor: 'octocat',
  version: '1.2.0',
  cfVersionId: null,
  refused: null,
  decisionSource: null,
  decidedByUserId: null,
  decidedAt: null,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  error: null,
  createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
  updatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
  finishedAt: null,
  ...overrides,
})

const member = () =>
  makeSession({ tenant: { id: IDS.tenant, name: 'Acme', slug: 'acme', role: 'member' } })

afterEach(() => vi.unstubAllGlobals())

function AppMarker() {
  const { slug } = useParams()
  return <p>App page for {slug}</p>
}

describe('CreateAppModal', () => {
  function renderCatalogue(routes: Record<string, unknown> = {}) {
    const fetchMock = stubFetch({
      '/api/apps': {
        appsDomain: null,
        items: [
          summary({
            slug: 'atlas',
            displayName: 'Atlas',
            environments: [env(STAGING_ID, 'staging', 'atlas')],
          }),
        ],
      },
      '/api/groups': {
        items: [
          {
            id: GROUP_ID,
            tenantId: IDS.tenant,
            groupTypeId: GROUP_ID,
            typeName: 'Team',
            name: 'Finance',
            description: null,
            memberCount: 3,
            createdAt: '2026-09-01T00:00:00Z',
            updatedAt: '2026-09-01T00:00:00Z',
          },
        ],
      },
      ...routes,
    })
    renderWithProviders(
      <Routes>
        <Route path="/apps" element={<CataloguePage />} />
        <Route path="/apps/:slug" element={<AppMarker />} />
      </Routes>,
      { session: makeSession(), route: '/apps' }
    )
    return fetchMock
  }

  it('suggests the slug from the name, checks it live, previews the host, then opens the new app', async () => {
    const fetchMock = renderCatalogue({
      'POST /api/apps': () =>
        jsonResponse(
          {
            app: summary({
              status: 'requested',
              slug: 'expense-tracker',
              displayName: 'Expense Tracker',
            }),
            runId: RUN_ID,
          },
          202
        ),
    })
    fireEvent.click(await screen.findByRole('button', { name: /Create app/ }))
    const dialog = screen.getByRole('dialog')

    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Expense Tracker' },
    })
    const slug = within(dialog).getByLabelText('Slug')
    expect(slug).toHaveValue('expense-tracker')
    // The apps domain, as a created app's staging URL reveals it.
    expect(await within(dialog).findByTestId('host-preview')).toHaveTextContent(
      'expense-tracker-staging.apps.test'
    )

    // The server's own rules, as they are typed — including the P2 `launch-` one.
    fireEvent.change(slug, { target: { value: 'launch-pad' } })
    expect(within(dialog).getByText(/may not start with launch-/)).toBeInTheDocument()
    expect(within(dialog).queryByTestId('host-preview')).not.toBeInTheDocument()
    fireEvent.change(slug, { target: { value: 'Expense' } })
    expect(within(dialog).getByText(/start with a lower-case letter/)).toBeInTheDocument()
    fireEvent.submit(document.getElementById('create-app-form') as HTMLFormElement)
    expect(requestBody(fetchMock, 'POST /api/apps')).toBeUndefined()

    // Editing the slug by hand detaches it from the name.
    fireEvent.change(slug, { target: { value: 'expense-tracker' } })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Expenses 2' } })
    expect(slug).toHaveValue('expense-tracker')

    await within(dialog).findByRole('option', { name: 'Finance (Team)' })
    fireEvent.change(within(dialog).getByLabelText(/Owner team/), { target: { value: GROUP_ID } })
    fireEvent.change(within(dialog).getByLabelText(/Description/), {
      target: { value: 'Receipts in, reimbursements out' },
    })
    fireEvent.click(within(dialog).getByLabelText(/Deploy staging now/))
    fireEvent.submit(document.getElementById('create-app-form') as HTMLFormElement)

    expect(await screen.findByText('App page for expense-tracker')).toBeInTheDocument()
    expect(requestBody(fetchMock, 'POST /api/apps')).toEqual({
      slug: 'expense-tracker',
      displayName: 'Expenses 2',
      description: 'Receipts in, reimbursements out',
      ownerGroupId: GROUP_ID,
      options: { deployStaging: false },
    })
  })

  it('renders a taken slug inside the modal, with what to do', async () => {
    renderCatalogue({
      'POST /api/apps': errorResponse(409, 'An app called atlas already exists', 'conflict'),
    })
    fireEvent.click(await screen.findByRole('button', { name: /Create app/ }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Atlas' } })
    fireEvent.submit(document.getElementById('create-app-form') as HTMLFormElement)
    expect(
      await within(dialog).findByText('An app called atlas already exists')
    ).toBeInTheDocument()
    expect(within(dialog).getByText(/Pick another slug/)).toBeInTheDocument()
  })

  it('shows no host preview while the apps domain is unknown', async () => {
    // An empty catalogue reveals no domain, and a tenant admin cannot read the setup settings.
    const fetchMock = stubFetch({
      '/api/apps': { items: [], appsDomain: null },
      '/api/groups': { items: [] },
    })
    renderWithProviders(<CataloguePage />, { session: makeSession() })
    fireEvent.click(await screen.findByRole('button', { name: /Create app/ }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Atlas' } })
    expect(within(dialog).queryByTestId('host-preview')).not.toBeInTheDocument()
    expect(within(dialog).getByText(/cannot be changed later/)).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/admin/setup'))).toBe(
      false
    )
  })
})

describe('AppDetailPage — the launch', () => {
  function renderDetail(
    session: ReturnType<typeof makeSession>,
    app: Record<string, unknown>,
    routes: Record<string, unknown> = {}
  ) {
    const fetchMock = stubFetch({
      '/api/apps/expenses': detail(app),
      [`/api/apps/${APP_ID}/health`]: { since: '2026-09-26T00:00:00Z', items: [] },
      [`/api/apps/${APP_ID}/operations`]: { items: [] },
      [`/api/apps/${APP_ID}/oidc-client`]: { client: null },
      [`/api/apps/${APP_ID}/deploys`]: { items: [] },
      ...routes,
    })
    renderWithProviders(
      <Routes>
        <Route path="/apps/:slug" element={<AppDetailPage />} />
      </Routes>,
      { session, route: '/apps/expenses' }
    )
    return fetchMock
  }

  const pipelineRoute = (
    create: unknown,
    teardown: unknown = { appId: APP_ID, runId: null, kind: 'teardown', status: 'none', steps: [] }
  ) => ({
    [`/api/apps/${APP_ID}/pipeline`]: (_init: RequestInit | undefined, url: URL) =>
      url.searchParams.get('kind') === 'teardown' ? teardown : create,
  })

  it('shows every step with its state while the launch runs', async () => {
    renderDetail(
      makeSession(),
      { status: 'provisioning' },
      pipelineRoute(launchView('cloudflare', 'running'))
    )
    // Before the first read the panel already says a launch is owed; then the steps arrive.
    await screen.findByRole('heading', { name: /Launching · Create storage, queue and KV/ })
    const panel = screen.getByRole('region', { name: 'Launch progress' })
    for (const def of APP_LAUNCH_STEPS)
      expect(within(panel).getByText(def.label)).toBeInTheDocument()
    expect(within(panel).getAllByRole('img', { name: 'Done' })).toHaveLength(6)
    expect(within(panel).getAllByRole('img', { name: 'Running' })).toHaveLength(1)
    expect(within(panel).getByTitle('attempt 3')).toBeInTheDocument()
    expect(within(panel).getAllByText('4s').length).toBeGreaterThan(0)
    // The sign-in card waits: the pipeline registers the client itself.
    expect(screen.queryByRole('button', { name: /Register OIDC client/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Check now/ })).not.toBeInTheDocument()
  })

  it('shows the failed step with its error and retries from it', async () => {
    let retried = false
    const fetchMock = renderDetail(
      makeSession(),
      { status: 'failed' },
      {
        ...pipelineRoute(launchView('cloudflare', 'failed')),
        [`POST /api/apps/${APP_ID}/pipeline/retry`]: () => {
          retried = true
          return jsonResponse({ runId: RUN_ID, instanceId: `${RUN_ID}-r1` }, 202)
        },
      }
    )
    const panel = await screen.findByRole('region', { name: 'Launch progress' })
    const alert = within(panel).getByRole('alert')
    expect(alert).toHaveTextContent('Create storage, queue and KV failed after 3 attempts')
    expect(alert).toHaveTextContent('R2: bucket expenses-files-staging: HTTP 500 internal error')
    fireEvent.click(within(alert).getByRole('button', { name: /Retry from failed step/ }))
    await waitFor(() => expect(retried).toBe(true))
    expect(requestBody(fetchMock, `POST /api/apps/${APP_ID}/pipeline/retry`)).toEqual({
      kind: 'create',
    })
  })

  it('tells a member who cannot retry who can', async () => {
    renderDetail(member(), { status: 'failed' }, pipelineRoute(launchView('neon', 'failed')))
    const panel = await screen.findByRole('region', { name: 'Launch progress' })
    expect(
      within(panel).getByText('An administrator can retry from this step.')
    ).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Archive app/ })).not.toBeInTheDocument()
  })
})

describe('AppDetailPage — archive and deploys', () => {
  function renderLive(
    session: ReturnType<typeof makeSession>,
    routes: Record<string, unknown> = {}
  ) {
    const fetchMock = stubFetch({
      '/api/apps/expenses': detail(),
      [`/api/apps/${APP_ID}/health`]: { since: '2026-09-26T00:00:00Z', items: [] },
      [`/api/apps/${APP_ID}/operations`]: { items: [] },
      [`/api/apps/${APP_ID}/oidc-client`]: { client: null },
      [`/api/apps/${APP_ID}/deploys`]: { items: [] },
      [`/api/apps/${APP_ID}/pipeline`]: {
        appId: APP_ID,
        runId: null,
        kind: 'teardown',
        status: 'none',
        steps: [],
      },
      ...routes,
    })
    renderWithProviders(
      <Routes>
        <Route path="/apps/:slug" element={<AppDetailPage />} />
      </Routes>,
      { session, route: '/apps/expenses' }
    )
    return fetchMock
  }

  it('archives only once the slug is typed, and warns before deleting the repository', async () => {
    const fetchMock = renderLive(makeSession(), {
      [`POST /api/apps/${APP_ID}/teardown`]: () => jsonResponse({ runId: TEARDOWN_RUN_ID }, 202),
    })
    fireEvent.click(await screen.findByRole('button', { name: /Archive app/ }))
    const dialog = screen.getByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Archive app' })
    expect(confirm).toBeDisabled()

    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'expense' } })
    expect(confirm).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'expenses' } })
    expect(confirm).toBeEnabled()

    expect(within(dialog).queryByText(/deleted for good/)).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByLabelText(/Also delete the GitHub repository/))
    expect(within(dialog).getByText(/deleted for good/)).toBeInTheDocument()

    fireEvent.click(confirm)
    expect(await within(dialog).findByText(/Starting the teardown/)).toBeInTheDocument()
    expect(requestBody(fetchMock, `POST /api/apps/${APP_ID}/teardown`)).toEqual({
      confirmSlug: 'expenses',
      deleteRepo: true,
    })
  })

  it('puts a pending production deploy above the list, focuses its heading, and approves it', async () => {
    let decided = false
    const fetchMock = renderLive(makeSession(), {
      [`/api/apps/${APP_ID}/deploys`]: () => ({
        items: [
          decided ? ticket({ status: 'approved', decisionSource: 'user' }) : ticket(),
          ticket({
            id: '78787878-7878-4787-8787-787878787878',
            environment: 'staging',
            environmentId: STAGING_ID,
            status: 'finished',
            version: '1.1.0',
            decisionSource: 'auto',
          }),
        ],
      }),
      [`POST /api/apps/${APP_ID}/deploys/${TICKET_ID}/decide`]: () => {
        decided = true
        return ticket({ status: 'approved', decisionSource: 'user' })
      },
    })
    const heading = await screen.findByRole('heading', {
      name: 'Production deploy of 1.2.0 is waiting for approval',
    })
    await waitFor(() => expect(heading).toHaveFocus())
    const table = screen.getByRole('table')
    expect(within(table).getByText('awaiting approval')).toBeInTheDocument()
    expect(within(table).getByText('finished')).toBeInTheDocument()
    expect(within(table).getAllByText('octocat')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: /waiting for approval/ })
      ).not.toBeInTheDocument()
    )
    expect(requestBody(fetchMock, `POST /api/apps/${APP_ID}/deploys/${TICKET_ID}/decide`)).toEqual({
      decision: 'approve',
    })
  })

  it('renders a decision somebody else made first as information, not an error', async () => {
    renderLive(makeSession(), {
      [`/api/apps/${APP_ID}/deploys`]: { items: [ticket()] },
      [`POST /api/apps/${APP_ID}/deploys/${TICKET_ID}/decide`]: errorResponse(
        409,
        'Ticket is not pending',
        'conflict'
      ),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    expect(await screen.findByText(/Someone else decided this deploy/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('shows a member one sentence instead of the decision buttons, and no production button', async () => {
    renderLive(member(), {
      '/api/apps/expenses': detail({ viewerCanDeploy: false }),
      [`/api/apps/${APP_ID}/deploys`]: { items: [ticket()] },
    })
    expect(
      await screen.findByText(/Waiting for an app owner or an administrator/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Deploy to production/ })).not.toBeInTheDocument()
  })

  it('lets a member who OWNS the app approve and deploy, as the server does', async () => {
    renderLive(member(), { [`/api/apps/${APP_ID}/deploys`]: { items: [ticket()] } })
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Deploy to production/ })).toBeInTheDocument()
    // Retry and archive stay with admins.
    expect(screen.queryByRole('button', { name: /Archive app/ })).not.toBeInTheDocument()
  })

  it('confirms before deploying to production', async () => {
    const fetchMock = renderLive(makeSession(), {
      [`POST /api/apps/${APP_ID}/deploys/production`]: () =>
        jsonResponse(
          { ticket: ticket({ status: 'approved', decisionSource: 'intent', runId: null }) },
          202
        ),
    })
    fireEvent.click(await screen.findByRole('button', { name: /Deploy to production/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/next 15 minutes/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deploy to production' }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    )
  })
})
