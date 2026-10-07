/**
 * The app page's Overview (rocketflare-launch#5, the app page plan's decisions 5, 6, 10, 11):
 *
 * - the flow — Staging, "N changes not live" with Ship (the view's one `.btn-flame`), Live — read
 *   from `GET /api/apps/:id/promotion`; what Ship puts live in plain words, each change's stored
 *   summary as one line; Ship opens the confirm dialog, calls the existing promote route, and the
 *   Live row then names who the request waits on;
 * - a release on its way shows as ONE line on the row it is changing — the tag's run on GitHub,
 *   a staging deploy from `GET /deploys/latest`, "Waiting for approval from …", a Live deploy;
 * - Needs you, only when something needs a person: a failed release (which job, the run), a
 *   failed deploy, an approval waiting on THIS reader, missing config; "Attention" and no buttons
 *   for somebody who cannot act;
 * - somebody who may not ship reads who can, never a disabled button;
 * - until the first build is live, the Overview is the takeover and Sessions / Releases are
 *   disabled with the reason.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared'
import AppPage from '@/ui/pages/apps/AppPage'
import { APP_ID, APPROVAL_ID, approvalRow, RELEASE_ID, releaseRow } from './helpers/approvals'
import { appConfigView } from './helpers/grants'
import {
  IDS,
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
const LATEST = `/api/apps/${APP_ID}/deploys/latest`
const PROMOTE = `POST /api/apps/${APP_ID}/releases/${RELEASE_ID}/promote`
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
  lastDeployAt: minutesAgo(name === 'staging' ? 10 : 60 * 24),
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
  ownerGroup: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Finance' },
  environments: [appEnv('staging', '1.4.2'), appEnv('production', '1.4.1')],
  createdAt: '2026-09-01T00:00:00Z',
  templateContractVersion: '1',
  defaultBranch: 'main',
  updatedAt: '2026-09-01T00:00:00Z',
  viewerCanDeploy: true,
  ...overrides,
})

const promotionEnv = (overrides: Record<string, unknown> = {}) => ({
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
    staging: promotionEnv(),
    production: promotionEnv({
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
        summary:
          '## What changed\n\n- The **export** button downloads a CSV again\n- Dates use the `en-GB` format',
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

const deployProgress = (overrides: Record<string, unknown> = {}) => ({
  ticketId: '56565656-5656-4565-8565-565656565656',
  environment: 'staging',
  phase: 'uploaded',
  reached: 'uploaded',
  inProgress: true,
  version: '1.4.3',
  sha: 'a'.repeat(40),
  ref: 'refs/tags/1.4.3',
  actor: 'octocat',
  runUrl: RUN_URL,
  error: null,
  approvalId: null,
  startedAt: minutesAgo(1),
  updatedAt: minutesAgo(0),
  activatedAt: null,
  finishedAt: null,
  ...overrides,
})

const member = () =>
  makeSession({ tenant: { id: IDS.tenant, name: 'Acme', slug: 'acme', role: 'member' } })

function renderOverview(
  routes: RouteTable,
  { session = makeSession(), route = '/apps/expenses' } = {}
) {
  const fetchMock = stubFetch({
    '/api/apps/expenses': appDetail(),
    [`/api/apps/${APP_ID}/pipeline`]: (_init: RequestInit | undefined, url: URL) =>
      pipelineNone(url.searchParams.get('kind') === 'create' ? 'create' : 'teardown'),
    [`/api/apps/${APP_ID}/sessions`]: { items: [] },
    [`/api/apps/${APP_ID}/deploys`]: { items: [] },
    '/api/approvals': { items: [] },
    [LATEST]: { items: [] },
    [PROMOTION]: view(),
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

const shipButton = () => screen.findByRole('button', { name: 'Ship v1.4.2 live' })
const row = (name: 'staging' | 'production') => screen.getByTestId(`env-${name}`)

describe('the flow', () => {
  it('offers Ship as the hero when staging runs a newer, healthy release — with what it ships', async () => {
    renderOverview({})
    const ship = await shipButton()
    expect(ship).toHaveClass('btn-flame')
    // Opening the app names which one: the header's (first) and the Live row's both say Live.
    const [headerOpen] = screen.getAllByRole('link', { name: 'Open Live' })
    expect(headerOpen).toHaveTextContent('Open Live')
    expect(headerOpen).toHaveAttribute('href', 'https://expenses.apps.test')
    // One hero per view: Build it steps down while Ship is on offer.
    expect(screen.getByRole('button', { name: 'Build it' })).not.toHaveClass('btn-flame')
    expect(within(row('staging')).getByText('v1.4.2')).toBeInTheDocument()
    expect(within(row('production')).getByText('v1.4.1')).toBeInTheDocument()
    expect(screen.getByText('2 changes not live')).toBeInTheDocument()
    const ships = screen.getByRole('list', { name: 'What Ship puts live' })
    // The session's own words lead; the stored summary is one plain line; never a SHA.
    expect(within(ships).getByText(/Make the export button work again/)).toBeInTheDocument()
    expect(within(ships).getByText(/The export button downloads/)).toHaveTextContent(
      'The export button downloads a CSV again Dates use the en-GB format'
    )
    expect(within(ships).getByText(/Add a receipts column/)).toBeInTheDocument()
    expect(within(ships).getByRole('link', { name: '#41' })).toHaveAttribute(
      'href',
      'https://github.com/acme/expenses/pull/41'
    )
    expect(ships).not.toHaveTextContent('cccc')
    // The header says what Live runs.
    expect(screen.getByText('v1.4.1 live')).toBeInTheDocument()
  })

  it('ships through the existing route, then names who the request waits on', async () => {
    let shipped = false
    const fetchMock = renderOverview({
      [PROMOTION]: () =>
        shipped
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
        shipped = true
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
    fireEvent.click(await shipButton())
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Ship v1.4.2 live?')).toBeInTheDocument()
    expect(within(dialog).getByRole('list', { name: 'What it ships' })).toBeInTheDocument()
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Month end needs the export fix' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request approval' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, PROMOTE)).toEqual({ reason: 'Month end needs the export fix' })
    )
    // The page stays, and the Live row moves on to the request.
    const live = await screen.findByTestId('env-production')
    expect(await within(live).findByText(/Waiting for approval from Bob Byrne/)).toBeInTheDocument()
  })

  it.each([
    [
      'staging runs a build that is not the release',
      view({ staging: promotionEnv({ version: 'main-64a36e6', releaseId: null }) }),
      'Staging runs main-64a36e6, not v1.4.2.',
    ],
    [
      'staging is unhealthy',
      view({ staging: promotionEnv({ healthStatus: 'down' }) }),
      'Staging is unhealthy.',
    ],
  ])('offers no Ship when %s, and says why', async (_label, body, reason) => {
    renderOverview({ [PROMOTION]: body })
    expect(await screen.findByText(reason)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Ship v/ })).not.toBeInTheDocument()
  })

  it('offers nothing once Live runs the candidate', async () => {
    renderOverview({
      [PROMOTION]: view(
        { production: promotionEnv({ url: 'https://expenses.apps.test' }) },
        { status: 'production_active' }
      ),
    })
    await screen.findByTestId('env-production')
    expect(screen.queryByRole('button', { name: /Ship v/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/not live/)).not.toBeInTheDocument()
  })

  it('is read-only for somebody who may not ship, saying who can', async () => {
    renderOverview(
      { '/api/apps/expenses': appDetail({ viewerCanDeploy: false }) },
      { session: member() }
    )
    expect(
      await screen.findByText(
        /v1\.4\.2 is ready to ship\. The Finance team and organisation admins can ship it live\./
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Ship v/ })).not.toBeInTheDocument()
  })
})

describe('the in-flight line', () => {
  const run = (overrides: Record<string, unknown> = {}) => ({
    status: 'in_progress',
    conclusion: null,
    url: RUN_URL,
    currentJob: 'ci / Gate',
    failedJob: null,
    ...overrides,
  })

  it('says GitHub is checking a tagged release on the Staging row, with its run', async () => {
    renderOverview({
      [PROMOTION]: view({ candidateRun: run() }, { status: 'tagged', createdAt: minutesAgo(3) }),
    })
    const staging = await screen.findByTestId('env-staging')
    expect(await within(staging).findByText(/GitHub is checking it/)).toBeInTheDocument()
    expect(within(staging).getByRole('link', { name: /View run/ })).toHaveAttribute('href', RUN_URL)
    expect(screen.queryByRole('heading', { name: 'Needs you' })).not.toBeInTheDocument()
  })

  it('follows a staging deploy as it runs: the version, the phase and the run', async () => {
    renderOverview({ [LATEST]: { items: [deployProgress()] } })
    const staging = await screen.findByTestId('env-staging')
    const line = await within(staging).findByText(/uploaded/)
    expect(line.closest('[role="status"]')).toHaveTextContent(/→ v1\.4\.3 · uploaded · started/)
    expect(within(staging).getByRole('link', { name: /View run/ })).toHaveAttribute('href', RUN_URL)
  })

  it('names the approvers on the Live row while a shipped release waits, with the link to share', async () => {
    renderOverview({
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
    const live = await screen.findByTestId('env-production')
    expect(
      await within(live).findByText(/Waiting for approval from Bob Byrne and dana@x\.test/)
    ).toBeInTheDocument()
    expect(within(live).getByRole('link', { name: 'See the request' })).toHaveAttribute(
      'href',
      `/approvals/${APPROVAL_ID}`
    )
    expect(within(live).getByRole('button', { name: /Copy link/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Ship v/ })).not.toBeInTheDocument()
    // It waits on somebody else: nothing here needs THIS reader.
    expect(screen.queryByRole('heading', { name: 'Needs you' })).not.toBeInTheDocument()
  })

  it('shows the Live deploy under way once approved', async () => {
    renderOverview({ [PROMOTION]: view({}, { status: 'promoting', approvalId: APPROVAL_ID }) })
    const live = await screen.findByTestId('env-production')
    expect(await within(live).findByText(/· starting/)).toBeInTheDocument()
  })
})

describe('Needs you', () => {
  it('lists a failed release with the job that failed, its run and its details', async () => {
    renderOverview({
      [PROMOTION]: view(
        {
          candidateRun: {
            status: 'completed',
            conclusion: 'failure',
            url: RUN_URL,
            currentJob: null,
            failedJob: 'ci / Gate',
          },
        },
        { status: 'failed', error: 'staging: the deploy run failed', createdAt: minutesAgo(9) }
      ),
    })
    const band = (await screen.findByRole('heading', { name: 'Needs you' })).closest(
      'section'
    ) as HTMLElement
    const item = within(band).getByText('v1.4.2 did not deploy: ci / Gate failed').closest('li')
    expect(item).toHaveTextContent('staging: the deploy run failed')
    expect(within(item as HTMLElement).getByRole('link', { name: /View run/ })).toHaveAttribute(
      'href',
      RUN_URL
    )
    expect(within(item as HTMLElement).getByRole('link', { name: 'Details' })).toHaveAttribute(
      'href',
      '/apps/expenses/releases/1.4.2'
    )
  })

  it('lists a release that never reached staging', async () => {
    renderOverview({
      [PROMOTION]: view({}, { status: 'tagged', createdAt: minutesAgo(60 * 24 * 3) }),
    })
    expect(await screen.findByText('v1.4.2 never reached staging')).toBeInTheDocument()
  })

  it('lists a failed deploy with why', async () => {
    renderOverview({
      [LATEST]: {
        items: [
          deployProgress({
            phase: 'failed',
            inProgress: false,
            reached: 'uploaded',
            error: 'Refused: KV CACHE=unknown',
          }),
        ],
      },
    })
    const item = (await screen.findByText('Staging deploy of v1.4.3 failed')).closest('li')
    expect(item).toHaveTextContent('Refused: KV CACHE=unknown')
  })

  it('lists a release waiting on THIS reader’s approval', async () => {
    renderOverview({
      [PROMOTION]: view(
        {
          approval: {
            id: APPROVAL_ID,
            status: 'pending',
            approvers: [{ id: IDS.user, name: 'Olive Owner', email: 'owner@example.test' }],
          },
        },
        { status: 'awaiting_approval', approvalId: APPROVAL_ID }
      ),
    })
    const item = (
      await screen.findByText('v1.4.2 is waiting for your approval to go live')
    ).closest('li') as HTMLElement
    expect(within(item).getByRole('link', { name: 'Review and decide' })).toHaveAttribute(
      'href',
      `/approvals/${APPROVAL_ID}`
    )
  })

  it('lists missing config with Request for whoever may ask, read-only under Attention otherwise', async () => {
    renderOverview({ [`/api/apps/${APP_ID}/config`]: appConfigView() })
    const item = (await screen.findByText('Microsoft 365 is not held on Live')).closest(
      'li'
    ) as HTMLElement
    expect(within(item).getByRole('link', { name: 'Request' })).toHaveAttribute(
      'href',
      '/apps/expenses/settings/config'
    )
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeInTheDocument()
    cleanup()

    renderOverview(
      {
        '/api/apps/expenses': appDetail({ viewerCanDeploy: false }),
        [`/api/apps/${APP_ID}/config`]: appConfigView({ canRequest: false }),
      },
      { session: member() }
    )
    expect(await screen.findByText('Microsoft 365 is not held on Live')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Attention' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Request' })).not.toBeInTheDocument()
  })
})

describe('the first build', () => {
  it('takes the Overview over and disables Sessions and Releases until it is live', async () => {
    const fetchMock = renderOverview({
      '/api/apps/expenses': appDetail({
        status: 'provisioning',
        environments: [appEnv('staging', '0.1.0'), appEnv('production', '0.1.0')].map(e => ({
          ...e,
          lastDeployVersion: null,
          lastDeployAt: null,
        })),
      }),
    })
    expect(await screen.findByRole('region', { name: 'Launch progress' })).toBeInTheDocument()
    for (const tab of ['sessions', 'releases']) {
      const el = screen.getByTestId(`tab-${tab}`)
      expect(el).toHaveAttribute('aria-disabled', 'true')
      expect(el).toHaveAttribute('title', 'Available once the first version is live')
      expect(el.tagName).not.toBe('A')
    }
    expect(screen.getByTestId('tab-activity').tagName).toBe('A')
    expect(screen.getByTestId('tab-settings').tagName).toBe('A')
    // No flow, no Build it, and nothing asked of the promotion view while it launches.
    expect(screen.queryByTestId('env-staging')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Build it' })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/promotion'))).toBe(false)
  })
})

describe('a session whose ship is in flight', () => {
  const SESSION_ID = '5e551000-0000-4000-8000-000000000001'
  const SESSIONS = `/api/apps/${APP_ID}/sessions`

  const shipping = (overrides: Record<string, unknown> = {}) => ({
    stage: 'deploying',
    waitingOn: null,
    stalledReason: null,
    approvalId: null,
    prNumber: 12,
    version: '1.4.3',
    since: minutesAgo(1),
    ...overrides,
  })

  // After the merge the row is `shipped` (settled) while the landing still moves.
  const sessionRow = (ship: Record<string, unknown> | null, overrides = {}) => ({
    id: SESSION_ID,
    appId: APP_ID,
    kind: 'session',
    shortId: 'abcdefghijkl',
    title: 'Friendlier home page',
    status: 'shipped',
    createdByUserId: IDS.otherUser,
    branch: 'session/abcdefghijkl',
    turnCount: 3,
    costMicrocents: 0,
    prNumber: 12,
    prUrl: 'https://github.com/acme/expenses/pull/12',
    lastActivityAt: minutesAgo(1),
    createdAt: minutesAgo(40),
    runtime: 'claude_code',
    credentialSource: 'platform',
    model: null,
    shipping: ship,
    ...overrides,
  })

  const mergeApproval = () =>
    approvalRow({
      kind: 'session.merge',
      subjectType: 'session',
      subjectId: SESSION_ID,
      reason: null,
      context: {
        kind: 'session.merge',
        sessionId: SESSION_ID,
        shortId: 'abcdefghijkl',
        title: 'Friendlier home page',
        appSlug: 'expenses',
        prNumber: 12,
        prUrl: 'https://github.com/acme/expenses/pull/12',
        prTitle: 'Make the home page friendlier',
        summary: 'Changes the headline.',
        diffStat: ' 1 file changed',
        headSha: 'b'.repeat(40),
        sessionPath: `/sessions/${SESSION_ID}`,
      },
    })

  const activeRow = async () =>
    (
      await within(
        (
          await screen.findByRole('heading', { name: 'Active sessions' })
        ).closest('section') as HTMLElement
      ).findByRole('link', { name: 'Friendlier home page' })
    ).closest('li') as HTMLElement

  // Issue #22: the chip names the stage, and the line says it in the session page's words with
  // how long it has lasted (and, waiting for main's checks, the limit on that wait).
  it.each([
    [
      shipping({ stage: 'ci', version: null }),
      'Checks running',
      'PR #12 · Waiting for the automatic checks · 1 min',
    ],
    [shipping({ stage: 'merging', version: null }), 'Merging', 'PR #12 · Merging · 1 min'],
    [
      shipping({ stage: 'releasing', version: null }),
      'Releasing',
      'PR #12 · Merged, waiting for main’s checks · 1 min (releases anyway after 30 min)',
    ],
    [
      shipping({ stage: 'releasing', version: null, mainCi: 'success' }),
      'Releasing',
      'PR #12 · Merged, releasing · 1 min',
    ],
    [shipping(), 'Deploying', 'PR #12 · Deploying v1.4.3 to staging · 1 min'],
  ])('lists it under Active sessions with where it stands (%#)', async (ship, chip, words) => {
    renderOverview({ [SESSIONS]: { items: [sessionRow(ship)] } })
    const row = await activeRow()
    expect(row.querySelector('.status-badge')).toHaveTextContent(chip)
    expect(row).not.toHaveTextContent('Shipped')
    expect(within(row).getByTestId('session-shipping')).toHaveTextContent(words)
    expect(within(row).getByRole('link', { name: 'Friendlier home page' })).toHaveAttribute(
      'href',
      `/apps/expenses/sessions/${SESSION_ID}`
    )
    // Moving on Launch, nobody's to act on: no band.
    expect(screen.queryByRole('heading', { name: 'Needs you' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Attention' })).not.toBeInTheDocument()
  })

  it('a review waiting on THIS reader is one Needs-you item, to the request', async () => {
    renderOverview({
      [SESSIONS]: {
        items: [
          sessionRow(
            shipping({ stage: 'approval', waitingOn: 'review', approvalId: APPROVAL_ID }),
            { status: 'shipping' }
          ),
        ],
      },
      '/api/approvals': (_init: RequestInit | undefined, url: URL) =>
        url.searchParams.get('kind') === 'session.merge' && url.searchParams.get('box') === 'mine'
          ? { items: [mergeApproval()] }
          : { items: [] },
    })
    const band = (await screen.findByRole('heading', { name: 'Needs you' })).closest(
      'section'
    ) as HTMLElement
    const item = (
      await within(band).findByText(
        'Friendlier home page is waiting for your review before it merges'
      )
    ).closest('li') as HTMLElement
    expect(within(item).getByRole('link', { name: 'Review and decide' })).toHaveAttribute(
      'href',
      `/approvals/${APPROVAL_ID}`
    )
    // Not listed twice.
    expect(within(band).getAllByRole('listitem')).toHaveLength(1)
    expect(within(await activeRow()).getByTestId('session-shipping')).toHaveTextContent(
      'Waiting for a review'
    )
  })

  it('a review someone else is asked for reads under Attention, to the session', async () => {
    renderOverview({
      [SESSIONS]: {
        items: [
          sessionRow(
            shipping({ stage: 'approval', waitingOn: 'review', approvalId: APPROVAL_ID }),
            { status: 'shipping' }
          ),
        ],
      },
    })
    const band = (await screen.findByRole('heading', { name: 'Attention' })).closest(
      'section'
    ) as HTMLElement
    const item = within(band)
      .getByText('Friendlier home page is waiting for a review before it merges')
      .closest('li') as HTMLElement
    expect(within(item).getByRole('link', { name: 'Open session' })).toHaveAttribute(
      'href',
      `/apps/expenses/sessions/${SESSION_ID}`
    )
  })

  it('a stall before the release needs whoever may move it on, from the session', async () => {
    renderOverview({
      [SESSIONS]: {
        items: [
          sessionRow(
            shipping({
              stage: 'stalled',
              waitingOn: 'retry',
              stalledReason: 'main_ci_failed',
              version: null,
            })
          ),
        ],
      },
    })
    const band = (await screen.findByRole('heading', { name: 'Needs you' })).closest(
      'section'
    ) as HTMLElement
    const item = within(band)
      .getByText('Friendlier home page is merged, but main’s checks failed, so it was not released')
      .closest('li') as HTMLElement
    expect(item).toHaveTextContent('Re-run main’s checks or release anyway from the session.')
    expect(within(item).getByRole('link', { name: 'Open session' })).toHaveAttribute(
      'href',
      `/apps/expenses/sessions/${SESSION_ID}`
    )
    const stalled = await activeRow()
    expect(within(stalled).getByTestId('session-shipping')).toHaveTextContent(
      'Merged, but main’s checks failed'
    )
    expect(stalled.querySelector('.status-badge')).toHaveTextContent('Needs you')
  })
})
