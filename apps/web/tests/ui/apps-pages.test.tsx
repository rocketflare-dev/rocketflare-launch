/**
 * The registry pages (spec/06): the catalogue's empty state and cards (health dots with their
 * labels, the fleet summary, search), the Import modal's validation and its in-modal refusal, and
 * the detail page's OIDC card showing the client secret ONCE.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AppDetailPage from '@/ui/pages/apps/AppDetailPage'
import CataloguePage from '@/ui/pages/apps/CataloguePage'
import {
  errorResponse,
  IDS,
  makeSession,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const APP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const STAGING_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PRODUCTION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const checked = new Date(Date.now() - 3 * 60 * 1000).toISOString()

const env = (id: string, name: 'staging' | 'production', healthStatus: string) => ({
  id,
  name,
  url: `https://expenses${name === 'staging' ? '-staging' : ''}.apps.test`,
  healthStatus,
  healthCheckedAt: checked,
  healthChangedAt: checked,
  healthVersion: '1.4.0',
  healthLatencyMs: 84,
  healthError: healthStatus === 'up' ? null : 'ready: HTTP 503',
})

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: APP_ID,
  slug: 'expenses',
  displayName: 'Expense Tracker',
  description: null,
  status: 'live',
  source: 'imported',
  template: 'rocketflare',
  templateVersion: '0.15.0',
  repoOwner: 'acme',
  repoName: 'expenses',
  ownerGroup: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Finance' },
  environments: [env(STAGING_ID, 'staging', 'degraded'), env(PRODUCTION_ID, 'production', 'up')],
  createdAt: '2026-09-01T00:00:00Z',
  ...overrides,
})

const detail = () => ({
  ...summary(),
  templateContractVersion: '1',
  defaultBranch: 'main',
  environments: summary().environments.map(e => ({
    ...e,
    workerName: e.name === 'staging' ? 'expenses-staging' : 'expenses',
    resources: { queues: [{ binding: 'JOBS_QUEUE', queue: 'expenses-jobs' }] },
    lastDeployVersion: null,
    lastDeployAt: null,
    lastDeployBy: null,
  })),
  updatedAt: '2026-09-01T00:00:00Z',
})

const member = () =>
  makeSession({ tenant: { id: IDS.tenant, name: 'Acme', slug: 'acme', role: 'member' } })

afterEach(() => vi.unstubAllGlobals())

describe('CataloguePage', () => {
  it('greets an empty catalogue with Create (the flame) and Import for an admin, and neither for a member', async () => {
    stubFetch({ '/api/apps': { items: [] } })
    const { unmount } = renderWithProviders(<CataloguePage />, { session: makeSession() })
    expect(await screen.findByText('Launch your first app')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Create app/ })).toHaveClass('btn-flame')
    expect(screen.getByRole('button', { name: /Import app/ })).not.toHaveClass('btn-flame')
    unmount()

    stubFetch({ '/api/apps': { items: [] } })
    renderWithProviders(<CataloguePage />, { session: member() })
    expect(await screen.findByText('No apps in the catalogue yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Import app/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Create app/ })).not.toBeInTheDocument()
  })

  it('shows each app with team, kit and a labelled dot per environment, and the fleet summary', async () => {
    stubFetch({
      '/api/apps': {
        items: [
          summary(),
          summary({
            id: '99999999-9999-4999-8999-999999999999',
            slug: 'atlas',
            displayName: 'Atlas',
            ownerGroup: null,
            environments: [env(PRODUCTION_ID, 'production', 'unknown')],
          }),
        ],
      },
    })
    renderWithProviders(<CataloguePage />, { session: member() })
    const card = (await screen.findByText('Expense Tracker')).closest('a') as HTMLElement
    expect(card).toHaveAttribute('href', '/apps/expenses')
    expect(within(card).getByText('Finance')).toBeInTheDocument()
    expect(within(card).getByText('kit 0.15.0')).toBeInTheDocument()
    expect(within(card).getByRole('img', { name: 'Degraded' })).toBeInTheDocument()
    expect(within(card).getByRole('img', { name: 'Up' })).toBeInTheDocument()
    expect(within(card).getAllByText(/3 minutes ago/)).toHaveLength(2)
    expect(screen.getByText('No team')).toBeInTheDocument()

    const needAttention = screen.getByText('Need attention').nextElementSibling
    expect(needAttention).toHaveTextContent('1')
    expect(screen.getByText('Production up').nextElementSibling).toHaveTextContent('1/2')

    fireEvent.change(screen.getByLabelText('Find an app'), { target: { value: 'finance' } })
    await waitFor(() => expect(screen.queryByText('Atlas')).not.toBeInTheDocument())
    expect(screen.getByText('Expense Tracker')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Table' }))
    expect(await screen.findByRole('table')).toBeInTheDocument()
  })

  it('validates the repo with the shared schema, then renders a refusal inside the modal', async () => {
    const fetchMock = stubFetch({
      '/api/apps': { items: [] },
      'POST /api/apps/import': errorResponse(
        422,
        'acme/nope@main has no .rocketflare.json or launch.plugins.json — is it a Rocketflare app?',
        'manifest_missing'
      ),
    })
    renderWithProviders(<CataloguePage />, { session: makeSession() })
    fireEvent.click(await screen.findByRole('button', { name: /Import app/ }))
    const form = document.getElementById('import-app-form') as HTMLFormElement

    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'not a repo' } })
    fireEvent.submit(form)
    expect(await screen.findByText('Use the form owner/name')).toBeInTheDocument()
    expect(requestBody(fetchMock, 'POST /api/apps/import')).toBeUndefined()

    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'acme/nope' } })
    fireEvent.submit(form)
    expect(await screen.findByText(/has no \.rocketflare\.json/)).toBeInTheDocument()
    expect(screen.getByText(/carry \.rocketflare\.json at the repo root/)).toBeInTheDocument()
    expect(requestBody(fetchMock, 'POST /api/apps/import')).toEqual({ repo: 'acme/nope' })
  })
})

describe('AppDetailPage', () => {
  function renderDetail(session = makeSession(), routes: Record<string, unknown> = {}) {
    const fetchMock = stubFetch({
      '/api/apps/expenses': detail(),
      [`/api/apps/${APP_ID}/health`]: { since: '2026-09-26T00:00:00Z', items: [] },
      [`/api/apps/${APP_ID}/operations`]: { items: [] },
      [`/api/apps/${APP_ID}/oidc-client`]: { client: null },
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

  it('shows environments, resources and the link to who can sign in', async () => {
    renderDetail(member())
    expect(await screen.findByRole('heading', { name: 'Expense Tracker' })).toBeInTheDocument()
    expect(screen.getByText('expenses-staging.apps.test')).toBeInTheDocument()
    expect(screen.getAllByText('JOBS_QUEUE')).toHaveLength(2)
    expect(screen.getByRole('link', { name: /Who can sign in/ })).toHaveAttribute(
      'href',
      '/apps/expenses/access'
    )
    // A member sees no admin actions.
    expect(screen.queryByRole('button', { name: /Check now/ })).not.toBeInTheDocument()
    expect(await screen.findByText(/Not registered yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Register OIDC client/ })).not.toBeInTheDocument()
  })

  it('registers the OIDC client and shows the secret once, with the config snippet', async () => {
    const client = {
      id: '12121212-1212-4212-8212-121212121212',
      clientId: 'lc_abc',
      secretHint: 'WXYZ',
      secretRotatedAt: null,
      redirectUris: ['https://expenses.apps.test/auth/oidc/callback'],
      postLogoutRedirectUris: ['https://expenses.apps.test/login?signedOut=1'],
      accessPolicy: 'company',
      disabledAt: null,
      createdAt: '2026-09-27T00:00:00Z',
    }
    let registered = false
    renderDetail(makeSession(), {
      [`/api/apps/${APP_ID}/oidc-client`]: () => ({ client: registered ? client : null }),
      [`POST /api/apps/${APP_ID}/oidc-client`]: () => {
        registered = true
        return new Response(
          JSON.stringify({
            client,
            clientId: 'lc_abc',
            clientSecret: 'super-secret-shown-once-WXYZ',
            issuer: 'https://launch.example.com',
            snippet: 'OIDC_ISSUER = "https://launch.example.com"\nAUTH_OIDC_ONLY = "true"',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: /Register OIDC client/ }))
    const secret = await screen.findByLabelText('Client secret')
    expect(secret).toHaveValue('super-secret-shown-once-WXYZ')
    expect(screen.getByText(/only time it is shown/)).toBeInTheDocument()
    expect(screen.getByText(/AUTH_OIDC_ONLY = "true"/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'I have stored the secret' }))
    await waitFor(() => expect(screen.queryByLabelText('Client secret')).not.toBeInTheDocument())
    expect(await screen.findByText('lc_abc')).toBeInTheDocument()
    expect(screen.getByText(/••••••••WXYZ/)).toBeInTheDocument()
    expect(screen.queryByText(/super-secret-shown-once/)).not.toBeInTheDocument()
  })
})
