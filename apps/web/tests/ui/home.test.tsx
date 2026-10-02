/**
 * Home: the overview. The approvals waiting on the reader (rows linking to each request, or one
 * quiet line when there are none), the apps — one row each with Live's version and health, Staging's
 * version and an attention word — "New app" only for whoever may create one, and no request per app.
 */
import { HEALTH_NOT_DEPLOYED_ERROR } from '@launch/shared/launch-apps'
import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Home from '@/ui/pages/Home'
import { APPROVAL_ID, approvalRow } from './helpers/approvals'
import {
  makeSession,
  makeTenant,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

afterEach(() => vi.unstubAllGlobals())

const checked = new Date(Date.now() - 3 * 60_000).toISOString()

const env = (name: 'staging' | 'production', overrides: Record<string, unknown> = {}) => ({
  id:
    name === 'staging'
      ? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      : 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  name,
  url: null,
  healthStatus: 'up',
  healthCheckedAt: checked,
  healthChangedAt: checked,
  healthVersion: name === 'staging' ? '1.5.0' : '1.4.2',
  healthLatencyMs: 80,
  healthError: null,
  ...overrides,
})

const catalogueApp = (overrides: Record<string, unknown> = {}) => ({
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  slug: 'expenses',
  displayName: 'Expenses',
  description: null,
  status: 'live',
  source: 'created',
  template: 'rocketflare',
  templateVersion: '0.15.0',
  repoOwner: 'acme',
  repoName: 'expenses',
  ownerGroup: null,
  environments: [env('staging'), env('production')],
  createdAt: '2026-09-01T00:00:00Z',
  latestDeploy: null,
  ...overrides,
})

const BILLING = catalogueApp({
  id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
  slug: 'billing',
  displayName: 'Billing',
  environments: [
    env('staging'),
    env('production', { healthStatus: 'unknown', healthError: HEALTH_NOT_DEPLOYED_ERROR }),
  ],
})

function stub({ approvals = [] as unknown[], apps = [catalogueApp(), BILLING] } = {}) {
  return stubFetch({
    '/api/approvals': { items: approvals },
    '/api/approvals/count': { count: approvals.length },
    '/api/apps': { items: apps, appsDomain: 'apps.test' },
  })
}

const member = () => makeSession({ tenant: makeTenant({ role: 'member' }) })

describe('Home — approvals waiting on you', () => {
  it('lists each request with its app, who asked and when, linking to the request', async () => {
    const fetchMock = stub({ approvals: [approvalRow()] })
    renderWithProviders(<Home />, { session: makeSession() })
    const list = await screen.findByRole('list', { name: 'Approvals waiting on you' })
    const link = within(list).getByRole('link', { name: 'Deploy Expenses 1.3.0 to production' })
    expect(link).toHaveAttribute('href', `/approvals/${APPROVAL_ID}`)
    expect(within(list).getByText(/Bob Builder asked/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'All approvals →' })).toHaveAttribute(
      'href',
      '/approvals'
    )
    // The inbox's "Waiting on me" box — the same set the nav badge counts.
    const call = fetchMock.mock.calls.find(
      ([u]) => new URL(String(u), 'http://x').pathname === '/api/approvals'
    )
    expect(String(call?.[0])).toContain('box=mine')
  })

  it('is one quiet line when nothing is waiting', async () => {
    stub()
    renderWithProviders(<Home />, { session: makeSession() })
    expect(await screen.findByText(/Nothing waiting on you\./)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Approvals waiting on you' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Waiting on you' })).not.toBeInTheDocument()
  })
})

describe('Home — apps', () => {
  it('shows one row per app: Live version and health, Staging version, and what needs a look', async () => {
    const fetchMock = stub()
    renderWithProviders(<Home />, { session: makeSession() })
    const table = await screen.findByRole('table', { name: 'Apps' })
    const rows = within(table).getAllByTestId('home-app-row')
    expect(rows).toHaveLength(2)
    // "not live yet" is quiet, so it does not jump the queue: by name.
    const [billing, expenses] = rows as [HTMLElement, HTMLElement]
    expect(within(billing).getByRole('link', { name: 'Billing' })).toHaveAttribute(
      'href',
      '/apps/billing'
    )
    expect(within(billing).getByText('not live yet')).toBeInTheDocument()
    expect(within(expenses).getByRole('link', { name: 'Expenses' })).toHaveAttribute(
      'href',
      '/apps/expenses'
    )
    expect(within(expenses).getByText('v1.4.2')).toBeInTheDocument()
    expect(within(expenses).getByText('v1.5.0')).toBeInTheDocument()
    expect(within(expenses).getByRole('img', { name: 'Up' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'All apps →' })).toHaveAttribute('href', '/apps')
    // The catalogue alone: no request per app.
    const paths = fetchMock.mock.calls.map(([u]) => new URL(String(u), 'http://x').pathname)
    expect(paths.filter(p => p.startsWith('/api/apps/'))).toEqual([])
  })

  it('puts a failed deploy first and says so', async () => {
    stub({
      apps: [
        catalogueApp(),
        catalogueApp({
          id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
          slug: 'payroll',
          displayName: 'Payroll',
          latestDeploy: {
            ticketId: '11111111-1111-4111-8111-111111111111',
            environment: 'production',
            phase: 'failed',
            reached: 'uploaded',
            inProgress: false,
            version: '2.0.0',
            sha: null,
            ref: null,
            actor: null,
            runUrl: null,
            error: 'binding check failed',
            approvalId: null,
            startedAt: checked,
            updatedAt: checked,
            activatedAt: null,
            finishedAt: checked,
          },
        }),
      ],
    })
    renderWithProviders(<Home />, { session: makeSession() })
    const rows = within(await screen.findByRole('table', { name: 'Apps' })).getAllByTestId(
      'home-app-row'
    )
    expect(within(rows[0] as HTMLElement).getByText('Live deploy failed')).toBeInTheDocument()
  })

  it('offers New app to an admin, beside All apps', async () => {
    stub()
    renderWithProviders(<Home />, { session: makeSession() })
    expect(await screen.findByRole('button', { name: /New app/ })).toBeInTheDocument()
  })

  it('a member reads the overview without the create action', async () => {
    stub({ approvals: [approvalRow()] })
    renderWithProviders(<Home />, { session: member() })
    expect(await screen.findByRole('table', { name: 'Apps' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /New app/ })).not.toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Approvals waiting on you' })).toBeInTheDocument()
  })

  it('never links the hidden kit-ai surfaces', async () => {
    stub()
    renderWithProviders(<Home />, { session: makeSession() })
    await screen.findByRole('table', { name: 'Apps' })
    for (const href of ['/chat', '/agents', '/documents', '/search']) {
      expect(document.querySelector(`a[href^="${href}"]`)).toBeNull()
    }
  })
})
