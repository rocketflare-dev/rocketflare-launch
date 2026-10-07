/**
 * Home: the overview. The approvals waiting on the reader (a "Waiting on you" section with a count
 * and rows linking to each request, or one compact quiet line when there are none), the apps — a
 * grid of large cards, each one link to the app, with its screenshot or initial, Live's version and
 * health, Staging's version and an attention word — "New app" only for whoever may create one, and
 * no request per app. A platform admin also sees "Finish setting up Launch" while a connection is
 * unfinished.
 */
import { HEALTH_NOT_DEPLOYED_ERROR } from '@launch/shared/launch-apps'
import type { SetupOverview } from '@launch/shared/launch-setup'
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Home from '@/ui/pages/Home'
import { APPROVAL_ID, approvalRow } from './helpers/approvals'
import {
  makeSession,
  makeTenant,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'
import { setupComplete, setupOverview } from './helpers/setup'

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
    expect(screen.getByRole('heading', { level: 2, name: 'Waiting on you' })).toBeInTheDocument()
    expect(screen.getByTestId('home-approvals-count')).toHaveTextContent('1')
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

  it('is one compact quiet line when nothing is waiting, with the inbox one link away', async () => {
    stub()
    renderWithProviders(<Home />, { session: makeSession() })
    const none = await screen.findByTestId('home-approvals-none')
    expect(none).toHaveTextContent('Nothing waiting on you.')
    expect(within(none).getByRole('link', { name: 'All approvals →' })).toHaveAttribute(
      'href',
      '/approvals'
    )
    expect(screen.queryByRole('list', { name: 'Approvals waiting on you' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Waiting on you' })).not.toBeInTheDocument()
  })
})

describe('Home — apps', () => {
  const cards = async () => {
    const grid = await screen.findByRole('list', { name: 'Apps' })
    return within(grid).getAllByTestId('home-app-card')
  }

  it('shows one card per app, each one link to the app with its versions and what needs a look', async () => {
    const fetchMock = stub()
    renderWithProviders(<Home />, { session: makeSession() })
    const all = await cards()
    expect(all).toHaveLength(2)
    expect(screen.getByRole('heading', { level: 2, name: 'Apps' })).toBeInTheDocument()
    expect(screen.getByTestId('home-apps-count')).toHaveTextContent('2')
    // "not live yet" is quiet, so it does not jump the queue: by name.
    const [billing, expenses] = all as [HTMLElement, HTMLElement]
    // The whole card is the link, named by the app alone.
    expect(billing.tagName).toBe('A')
    expect(screen.getByRole('link', { name: 'Billing' })).toBe(billing)
    expect(billing).toHaveAttribute('href', '/apps/billing')
    expect(within(billing).getByText('not live yet')).toHaveClass('text-muted')
    expect(screen.getByRole('link', { name: 'Expenses' })).toBe(expenses)
    expect(expenses).toHaveAttribute('href', '/apps/expenses')
    expect(expenses).toHaveAccessibleDescription(/Live.*v1\.4\.2.*Staging.*v1\.5\.0/)
    expect(within(expenses).getByText('v1.4.2')).toHaveClass('font-mono', 'tabular-nums')
    expect(within(expenses).getByText('v1.5.0')).toBeInTheDocument()
    expect(within(expenses).getByRole('img', { name: 'Up' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'All apps →' })).toHaveAttribute('href', '/apps')
    // The catalogue alone: no request per app.
    const paths = fetchMock.mock.calls.map(([u]) => new URL(String(u), 'http://x').pathname)
    expect(paths.filter(p => p.startsWith('/api/apps/'))).toEqual([])
  })

  it('leads each card with the screenshot filling its width, or a large initial without one', async () => {
    const url = '/api/apps/cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnail?v=1'
    stub({
      apps: [
        catalogueApp({
          thumbnail: { url, capturedAt: checked, env: 'production', version: '1.4.2' },
        }),
        BILLING,
      ],
    })
    renderWithProviders(<Home />, { session: makeSession() })
    const [billing, expenses] = (await cards()) as [HTMLElement, HTMLElement]
    const shot = within(expenses).getByTestId('app-thumbnail')
    expect(shot.className).toMatch(/\bw-full\b/)
    expect(shot.className).toContain('aspect-[16/10]')
    expect(shot.querySelector('img')).toHaveAttribute('src', url)
    const initial = within(billing).getByTestId('app-thumbnail-placeholder')
    expect(initial).toHaveTextContent('B')
    expect(within(billing).getByTestId('app-thumbnail').className).toMatch(/\btext-6xl\b/)
    expect(within(billing).getByTestId('app-thumbnail').className).toContain('bg-base-200')
  })

  it('puts a failed deploy first and says so, in the error colour', async () => {
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
    const [first] = (await cards()) as [HTMLElement]
    expect(first).toHaveAttribute('href', '/apps/payroll')
    expect(within(first).getByText('Live deploy failed')).toHaveClass('text-error')
  })

  it('caps the grid at eight cards and names the total on All apps', async () => {
    const apps = Array.from({ length: 10 }, (_, i) =>
      catalogueApp({
        id: `cccccccc-cccc-4ccc-8ccc-cccccccccc${String(i).padStart(2, '0')}`,
        slug: `app-${i}`,
        displayName: `App ${String.fromCharCode(65 + i)}`,
      })
    )
    stub({ apps })
    renderWithProviders(<Home />, { session: makeSession() })
    expect(await cards()).toHaveLength(8)
    expect(screen.getByTestId('home-apps-count')).toHaveTextContent('10')
    expect(screen.getByRole('link', { name: 'All 10 apps →' })).toHaveAttribute('href', '/apps')
  })

  it('offers New app to an admin, beside All apps', async () => {
    stub()
    renderWithProviders(<Home />, { session: makeSession() })
    expect(await screen.findByRole('button', { name: /New app/ })).toBeInTheDocument()
  })

  it('a member reads the overview without the create action', async () => {
    stub({ approvals: [approvalRow()] })
    renderWithProviders(<Home />, { session: member() })
    expect(await cards()).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /New app/ })).not.toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Approvals waiting on you' })).toBeInTheDocument()
  })

  it('never links the hidden kit-ai surfaces', async () => {
    stub()
    renderWithProviders(<Home />, { session: makeSession() })
    await cards()
    for (const href of ['/chat', '/agents', '/documents', '/search']) {
      expect(document.querySelector(`a[href^="${href}"]`)).toBeNull()
    }
  })
})

describe('Home — finish setting up Launch', () => {
  const withSetup = (overview: SetupOverview) =>
    stubFetch({
      '/api/approvals': { items: [] },
      '/api/approvals/count': { count: 0 },
      '/api/apps': { items: [], appsDomain: null },
      '/api/platform/setup': overview,
    })
  const singleOwner = () => makeSession({ tenancyMode: 'single' })

  it('lists every connection with its state in words, linking to its page, while one is unfinished', async () => {
    withSetup(setupOverview)
    renderWithProviders(<Home />, { session: singleOwner() })
    // domain ok, cloudflare warning (working), identity ok → 3 of 7.
    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: 'Finish setting up Launch — 3 of 7 working',
      })
    ).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Platform' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map(row => within(row).getByRole('link').textContent)).toEqual([
      'Domain',
      'Cloudflare',
      'Neon',
      'GitHub',
      'Email',
      'Sign-in',
      'Public URL',
    ])
    expect(within(list).getByRole('link', { name: 'Public URL' })).toHaveAttribute(
      'href',
      '/settings/public-url'
    )
    expect(within(list).getByRole('link', { name: 'Email' })).toHaveAttribute(
      'href',
      '/settings/email'
    )
    // The state in words, at the end of the row.
    expect(rows[4]?.lastElementChild).toHaveTextContent('Failed')
    expect(rows[2]?.lastElementChild).toHaveTextContent('Not set')
    expect(rows[1]?.lastElementChild).toHaveTextContent('Needs a look')
    // What is wrong, in the failing probe's own words, under the name.
    expect(rows[4]).toHaveTextContent('notifications.company-apps.test is not a Resend domain yet.')
  })

  it('is gone once every connection works', async () => {
    const fetchMock = withSetup(setupComplete)
    renderWithProviders(<Home />, { session: singleOwner() })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/platform/setup'))
      ).toBe(true)
    )
    await screen.findByTestId('home-approvals-none')
    expect(screen.queryByRole('heading', { name: /Finish setting up Launch/ })).toBeNull()
  })

  it('is never shown to — or fetched for — somebody who does not administer the platform', async () => {
    // Multi mode: an organisation owner is not a platform admin.
    const fetchMock = withSetup(setupOverview)
    renderWithProviders(<Home />, { session: makeSession() })
    await screen.findByTestId('home-approvals-none')
    expect(screen.queryByRole('heading', { name: /Finish setting up Launch/ })).toBeNull()
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('/api/platform/setup'))
    ).toBe(false)
  })
})
