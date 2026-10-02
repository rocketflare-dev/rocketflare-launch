/**
 * App thumbnails in the UI: `AppThumbnail` shows the screenshot when the app has one and the
 * app's initial on `bg-base-200` when it has none or the image fails — in a box of fixed size
 * either way, lazy-loaded from Launch's own route; the catalogue, Home and the app header use it;
 * Settings → General offers "Refresh thumbnail" to whoever may manage the app and words a 429.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AppPage from '@/ui/pages/apps/AppPage'
import CataloguePage from '@/ui/pages/apps/CataloguePage'
import { AppThumbnail, appInitial } from '@/ui/pages/apps/components/AppThumbnail'
import { AppsSection } from '@/ui/pages/home/AppsSection'
import {
  errorResponse,
  IDS,
  makeSession,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

const APP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CAPTURED = '2026-10-01T12:00:00.000Z'
const THUMB_URL = `/api/apps/${APP_ID}/thumbnail?v=${Date.parse(CAPTURED)}`

const env = (id: string, name: 'staging' | 'production') => ({
  id,
  name,
  url: `https://expenses${name === 'staging' ? '-staging' : ''}.apps.test`,
  healthStatus: 'up',
  healthCheckedAt: CAPTURED,
  healthChangedAt: CAPTURED,
  healthVersion: '1.4.0',
  healthLatencyMs: 84,
  healthError: null,
})

const thumbnail = { url: THUMB_URL, capturedAt: CAPTURED, env: 'production', version: '1.4.0' }
/** The same, as the parsed schema hands it to a component. */
const parsed = { ...thumbnail, capturedAt: new Date(CAPTURED), env: 'production' as const }

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
  ownerGroup: null,
  environments: [
    env('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'staging'),
    env('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'production'),
  ],
  createdAt: '2026-09-01T00:00:00Z',
  thumbnail,
  ...overrides,
})

const detail = (overrides: Record<string, unknown> = {}) => {
  const base = summary(overrides)
  return {
    ...base,
    templateContractVersion: '1',
    defaultBranch: 'main',
    environments: (base.environments as ReturnType<typeof env>[]).map(e => ({
      ...e,
      workerName: e.name === 'staging' ? 'expenses-staging' : 'expenses',
      resources: {},
      lastDeployVersion: '1.4.0',
      lastDeployAt: null,
      lastDeployBy: null,
    })),
    updatedAt: '2026-09-01T00:00:00Z',
    viewerCanDeploy: true,
  }
}

const member = () =>
  makeSession({ tenant: { id: IDS.tenant, name: 'Acme', slug: 'acme', role: 'member' } })

afterEach(() => vi.unstubAllGlobals())

describe('AppThumbnail', () => {
  it('shows the screenshot, lazy, from Launch’s route — or the initial when there is none', () => {
    const { container } = render(
      <AppThumbnail app={{ displayName: 'Expense Tracker', thumbnail: parsed }} size="sm" />
    )
    const img = container.querySelector('img') as HTMLImageElement
    expect(img).toHaveAttribute('src', THUMB_URL)
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(img).toHaveAttribute('alt', '')
    const box = screen.getByTestId('app-thumbnail')
    // A fixed box with the capture's ratio: nothing moves when the image arrives.
    expect(box.className).toMatch(/\bw-16\b/)
    expect(box.className).toContain('aspect-[16/10]')
    expect(box).toHaveAttribute('title', expect.stringMatching(/^Live v1\.4\.0, captured /))
    expect(screen.queryByTestId('app-thumbnail-placeholder')).not.toBeInTheDocument()
    cleanup()

    render(<AppThumbnail app={{ displayName: 'expense tracker', thumbnail: null }} size="sm" />)
    expect(screen.getByTestId('app-thumbnail-placeholder')).toHaveTextContent('E')
    expect(screen.getByTestId('app-thumbnail').className).toContain('bg-base-200')
    expect(screen.getByTestId('app-thumbnail').querySelector('img')).toBeNull()
  })

  it('falls back to the initial when the picture fails to load', () => {
    const { container } = render(
      <AppThumbnail app={{ displayName: 'Atlas', thumbnail: parsed }} size="md" />
    )
    fireEvent.error(container.querySelector('img') as HTMLImageElement)
    expect(screen.getByTestId('app-thumbnail-placeholder')).toHaveTextContent('A')
  })

  it('takes the first letter or digit of the name', () => {
    expect(appInitial('expenses')).toBe('E')
    expect(appInitial('  42 things')).toBe('4')
    expect(appInitial('—')).toBe('?')
  })
})

describe('where thumbnails appear', () => {
  it('the catalogue card and table row and Home lead with it', async () => {
    stubFetch({
      '/api/apps': {
        appsDomain: null,
        items: [
          summary(),
          summary({
            id: '99999999-9999-4999-8999-999999999999',
            slug: 'atlas',
            displayName: 'Atlas',
            thumbnail: null,
          }),
        ],
      },
    })
    const { unmount } = renderWithProviders(<CataloguePage />, { session: member() })
    const card = (await screen.findByText('Expense Tracker')).closest('a') as HTMLElement
    expect(within(card).getByTestId('app-thumbnail').querySelector('img')).toHaveAttribute(
      'src',
      THUMB_URL
    )
    const atlas = screen.getByText('Atlas').closest('a') as HTMLElement
    expect(within(atlas).getByTestId('app-thumbnail-placeholder')).toHaveTextContent('A')
    unmount()

    renderWithProviders(<AppsSection />, { session: member() })
    const rows = await screen.findAllByTestId('home-app-row')
    expect(rows).toHaveLength(2)
    const expenses = rows.find(r => within(r).queryByText('Expense Tracker')) as HTMLElement
    expect(within(expenses).getByTestId('app-thumbnail').querySelector('img')).toHaveAttribute(
      'src',
      THUMB_URL
    )
  })
})

describe('the app page', () => {
  function renderApp(session = makeSession(), routes: Record<string, unknown> = {}, over = {}) {
    const fetchMock = stubFetch({
      '/api/apps/expenses': detail(over),
      [`/api/apps/${APP_ID}/health`]: { since: CAPTURED, items: [] },
      [`/api/apps/${APP_ID}/operations`]: { items: [] },
      [`/api/apps/${APP_ID}/oidc-client`]: { client: null },
      ...routes,
    })
    renderWithProviders(
      <Routes>
        <Route path="/apps/:slug/*" element={<AppPage />} />
      </Routes>,
      { session, route: '/apps/expenses/settings/general' }
    )
    return fetchMock
  }

  it('puts the thumbnail in the header and says what it shows under Settings → General', async () => {
    renderApp(member())
    expect(await screen.findByRole('heading', { name: 'Thumbnail' })).toBeInTheDocument()
    const thumbs = screen.getAllByTestId('app-thumbnail')
    // The header's and the section's.
    expect(thumbs).toHaveLength(2)
    expect(screen.getByText(/A screenshot of Live at/)).toBeInTheDocument()
    // A member may not refresh it.
    expect(screen.queryByRole('button', { name: 'Refresh thumbnail' })).not.toBeInTheDocument()
  })

  it('lets an admin refresh it, and words the once-a-minute refusal', async () => {
    let calls = 0
    const fetchMock = renderApp(makeSession(), {
      [`POST /api/apps/${APP_ID}/thumbnail/refresh`]: () => {
        calls += 1
        return calls === 1
          ? new Response(JSON.stringify({ queued: ['staging', 'production'] }), {
              status: 202,
              headers: { 'Content-Type': 'application/json' },
            })
          : errorResponse(429, 'The thumbnail was refreshed less than a minute ago', 'rate_limited')
      },
    })
    const button = await screen.findByRole('button', { name: 'Refresh thumbnail' })
    fireEvent.click(button)
    expect(await screen.findByText(/Capture queued/)).toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith(`/api/apps/${APP_ID}/thumbnail/refresh`) && init?.method === 'POST'
      )
    ).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh thumbnail' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/less than a minute ago/)
  })

  it('offers no refresh for an app with no address, and shows the initial without a picture', async () => {
    renderApp(
      makeSession(),
      {},
      {
        thumbnail: null,
        environments: [{ ...env('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'production'), url: null }],
      }
    )
    expect(await screen.findByText('No screenshot yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Refresh thumbnail' })).not.toBeInTheDocument()
    expect(screen.getAllByTestId('app-thumbnail-placeholder').length).toBeGreaterThan(0)
  })
})
