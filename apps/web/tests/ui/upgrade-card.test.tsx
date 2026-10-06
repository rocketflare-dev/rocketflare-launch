/**
 * Kit upgrades on the app page and in the catalogue (P6 6c):
 *
 * - the catalogue says "Requires upgrade → 0.16.1" in plain text beside the kit version, and says
 *   nothing for an app that is current;
 * - the Overview's Kit section appears only while the app is behind or an upgrade is open: the
 *   version it is on, the release notes, and Upgrade for an owner or admin — which posts
 *   `/upgrade` and opens the session; a refusal is a toast; a member reads who can;
 * - an open upgrade says where it stands, its PR and its session, and why it needs the owner.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared'
import AppPage from '@/ui/pages/apps/AppPage'
import {
  lastEndedUpgrade,
  openUpgradeSentence,
  showUpgradeCard,
} from '@/ui/pages/apps/app/UpgradeCard'
import CataloguePage from '@/ui/pages/apps/CataloguePage'
import {
  errorResponse,
  IDS,
  makeSession,
  type RouteTable,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useToastStore.setState({ toasts: [] })
})

const APP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const UPGRADE_ID = '99999999-9999-4999-8999-999999999999'
const SESSION_ID = '88888888-8888-4888-8888-888888888888'
const NOTES = 'https://github.com/rocketflare-dev/rocketflare/blob/0.16.1/docs/upgrades/0.16.1.md'

const kit = (overrides: Record<string, unknown> = {}) => ({
  current: '0.16.0',
  target: '0.16.1',
  behind: true,
  openUpgrade: null,
  notesUrl: NOTES,
  ...overrides,
})

const upgrade = (overrides: Record<string, unknown> = {}) => ({
  id: UPGRADE_ID,
  appId: APP_ID,
  targetKind: 'kit',
  pluginId: null,
  fromVersion: '0.16.0',
  toVersion: '0.16.1',
  status: 'running',
  sessionId: SESSION_ID,
  prNumber: null,
  prUrl: null,
  error: null,
  requestedByUserId: IDS.user,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...overrides,
})

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: APP_ID,
  slug: 'expenses',
  displayName: 'Expense Tracker',
  description: null,
  status: 'live',
  source: 'created',
  template: 'rocketflare',
  templateVersion: '0.16.0',
  repoOwner: 'acme',
  repoName: 'expenses',
  ownerGroup: null,
  environments: [],
  createdAt: '2026-09-01T00:00:00Z',
  kit: kit(),
  ...overrides,
})

const detail = (overrides: Record<string, unknown> = {}) => ({
  ...summary(),
  templateContractVersion: '1',
  defaultBranch: 'main',
  updatedAt: '2026-09-01T00:00:00Z',
  viewerCanDeploy: true,
  ...overrides,
})

const member = () =>
  makeSession({ tenant: { id: IDS.tenant, name: 'Acme', slug: 'acme', role: 'member' } })

function renderOverview(routes: RouteTable = {}, session = makeSession()) {
  const fetchMock = stubFetch({
    '/api/apps/expenses': detail(),
    [`/api/apps/${APP_ID}/pipeline`]: (_init: RequestInit | undefined, url: URL) => ({
      appId: APP_ID,
      runId: null,
      kind: url.searchParams.get('kind') === 'create' ? 'create' : 'teardown',
      status: 'none',
      steps: [],
      canRescaffold: false,
      templateTag: null,
      rescaffoldChecksDatabase: false,
    }),
    [`/api/apps/${APP_ID}/sessions`]: { items: [] },
    [`/api/apps/${APP_ID}/deploys`]: { items: [] },
    [`/api/apps/${APP_ID}/deploys/latest`]: { items: [] },
    [`/api/apps/${APP_ID}/upgrades`]: { items: [] },
    [`/api/sessions/${SESSION_ID}`]: errorResponse(404, 'not here'),
    ...routes,
  })
  renderWithProviders(
    <Routes>
      <Route path="/apps/:slug/*" element={<AppPage />} />
    </Routes>,
    { session, route: '/apps/expenses' }
  )
  return fetchMock
}

const kitSection = () => screen.findByRole('region', { name: 'Kit' })

describe('the catalogue', () => {
  it('says Requires upgrade → the pin, in plain text, only for an app behind it', async () => {
    stubFetch({
      '/api/apps': {
        appsDomain: null,
        items: [
          summary(),
          summary({
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            slug: 'current',
            displayName: 'Current App',
            templateVersion: '0.16.1',
            kit: kit({ current: '0.16.1', behind: false }),
          }),
        ],
      },
    })
    renderWithProviders(<CataloguePage />, { session: makeSession() })
    const labels = await screen.findAllByText('Requires upgrade → 0.16.1')
    expect(labels.length).toBeGreaterThan(0)
    // Plain text: no badge styling on it.
    for (const label of labels) expect(label.className).not.toMatch(/badge/)
    expect(screen.getAllByText(/Requires upgrade/)).toHaveLength(labels.length)
  })
})

describe('the Overview’s Kit section', () => {
  it('shows the version, the notes and Upgrade; Upgrade posts and opens the session', async () => {
    let posted = false
    renderOverview({
      [`POST /api/apps/${APP_ID}/upgrade`]: () => {
        posted = true
        return { upgradeId: UPGRADE_ID, sessionId: SESSION_ID, upgrade: upgrade() }
      },
    })
    const section = await kitSection()
    expect(within(section).getByText(/Requires upgrade → 0\.16\.1/)).toBeInTheDocument()
    expect(within(section).getByText('0.16.0')).toBeInTheDocument()
    expect(within(section).getByRole('link', { name: /Release notes/ })).toHaveAttribute(
      'href',
      NOTES
    )
    const button = within(section).getByRole('button', { name: 'Upgrade' })
    expect(button).not.toHaveClass('btn-flame')
    fireEvent.click(button)
    await waitFor(() => expect(posted).toBe(true))
  })

  it('a refusal is a toast with the server’s sentence', async () => {
    renderOverview({
      [`POST /api/apps/${APP_ID}/upgrade`]: errorResponse(
        409,
        'This app already has 3 active sessions. End one first.',
        'session_limit'
      ),
    })
    fireEvent.click(within(await kitSection()).getByRole('button', { name: 'Upgrade' }))
    await waitFor(() =>
      expect(
        useToastStore
          .getState()
          .toasts.map(t => t.message)
          .join(' ')
      ).toMatch(/as many sessions running/)
    )
  })

  it('a member reads who can upgrade, with no button', async () => {
    renderOverview({ '/api/apps/expenses': detail({ viewerCanDeploy: false }) }, member())
    const section = await kitSection()
    expect(within(section).queryByRole('button', { name: 'Upgrade' })).toBeNull()
    expect(within(section).getByText(/owners and admins can upgrade/)).toBeInTheDocument()
  })

  it('an open upgrade says where it stands, with its PR and session; nothing to click twice', async () => {
    renderOverview({
      '/api/apps/expenses': detail({
        kit: kit({
          openUpgrade: upgrade({
            status: 'pr_open',
            prNumber: 12,
            prUrl: 'https://github.com/acme/expenses/pull/12',
          }),
        }),
      }),
    })
    const section = await kitSection()
    expect(within(section).getByText(/in a pull request/)).toBeInTheDocument()
    expect(within(section).getByRole('link', { name: /Pull request #12/ })).toHaveAttribute(
      'href',
      'https://github.com/acme/expenses/pull/12'
    )
    expect(within(section).getByRole('link', { name: /Open the session/ })).toHaveAttribute(
      'href',
      `/apps/expenses/sessions/${SESSION_ID}`
    )
    expect(within(section).queryByRole('button', { name: 'Upgrade' })).toBeNull()
  })

  it('follows the upgrade’s landing once Launch has merged it (issue #22)', async () => {
    const sessionRow = (stage: string) => ({
      id: SESSION_ID,
      appId: APP_ID,
      kind: 'upgrade',
      shortId: 'abcdefghijkl',
      title: 'Upgrade the kit to 0.16.1',
      status: 'shipped',
      createdByUserId: IDS.user,
      branch: 'session/abcdefghijkl',
      turnCount: 1,
      costMicrocents: 0,
      prNumber: 12,
      prUrl: 'https://github.com/acme/expenses/pull/12',
      lastActivityAt: '2026-10-01T00:00:00Z',
      createdAt: '2026-10-01T00:00:00Z',
      shipping: {
        stage,
        waitingOn: null,
        stalledReason: null,
        approvalId: null,
        prNumber: 12,
        version: null,
        since: '2026-10-01T00:00:00Z',
      },
    })
    renderOverview({
      '/api/apps/expenses': detail({
        kit: kit({
          openUpgrade: upgrade({
            status: 'pr_open',
            prNumber: 12,
            prUrl: 'https://github.com/acme/expenses/pull/12',
          }),
        }),
      }),
      [`/api/apps/${APP_ID}/sessions`]: { items: [sessionRow('releasing')] },
    })
    const section = await kitSection()
    await waitFor(() =>
      expect(within(section).getByTestId('upgrade-sentence')).toHaveTextContent(
        'The upgrade to 0.16.1 is merged, releasing to staging.'
      )
    )
    expect(within(section).queryByText(/Merge it and release/)).toBeNull()
  })

  it('is absent for an app on the pinned kit', async () => {
    renderOverview({
      '/api/apps/expenses': detail({ kit: kit({ current: '0.16.1', behind: false }) }),
    })
    await screen.findByText('Where it runs')
    expect(screen.queryByRole('region', { name: 'Kit' })).toBeNull()
  })
})

describe('the pure parts', () => {
  it('decides when to show, what an open upgrade says and the last ended attempt', () => {
    expect(showUpgradeCard(null)).toBe(false)
    expect(showUpgradeCard(kit({ behind: false }) as never)).toBe(false)
    expect(showUpgradeCard(kit() as never)).toBe(true)
    expect(openUpgradeSentence(upgrade({ status: 'needs_attention' }) as never)).toMatch(
      /needs its owner/
    )
    // Issue #22: the landing's words while the upgrade ships, and the new version once recorded.
    const pr = upgrade({ status: 'pr_open' }) as never
    expect(openUpgradeSentence(pr)).toMatch(/Merge it and release/)
    expect(
      openUpgradeSentence(pr, { stage: 'ci', stalledReason: null, version: null, mainCi: null })
    ).toBe(
      'The upgrade to 0.16.1 is shipping: waiting for the automatic checks. Launch merges it when that’s done.'
    )
    expect(
      openUpgradeSentence(pr, {
        stage: 'deploying',
        stalledReason: null,
        version: '1.2.0',
        mainCi: 'success',
      })
    ).toBe('The upgrade to 0.16.1 is merged and released, deploying to staging.')
    expect(openUpgradeSentence(pr, null, '0.16.1')).toBe('The app is on 0.16.1.')
    expect(lastEndedUpgrade([upgrade({ status: 'cancelled' })] as never)?.status).toBe('cancelled')
    expect(lastEndedUpgrade([upgrade({ status: 'released' })] as never)).toBeNull()
  })
})
