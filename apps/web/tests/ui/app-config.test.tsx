/**
 * An app's shared config (Launch P5, spec/09, plan §4 5f): the Config page, the Config card on the
 * app page, the Request flow, and the session ship panel's needs line. What they are arranged to
 * get right:
 *
 * - each matched resource shows its state per environment (held with the version, requested with
 *   the request's link, missing with Request), and keys nothing matches carry "ask an admin";
 * - Request opens with only the missing environments selected (a held one cannot be asked again),
 *   validates with the route's own schema, posts one body, and renders a refusal as a sentence;
 * - Re-scan posts the scan and shows its answer; Revoke is confirmed;
 * - a reader who may not request sees states but no buttons;
 * - ship's `ship.config_needs` row becomes one line with a link to the Config page.
 */
import { sessionSchema } from '@launch/shared/launch-sessions'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared'
import { appConfigPollInterval, grantOwesPush } from '@/ui/hooks/useAppConfig'
import AppConfigPage from '@/ui/pages/apps/AppConfigPage'
import { ConfigCard } from '@/ui/pages/apps/components/ConfigCard'
import {
  declaredByPlugin,
  envGrantState,
  missingEnvironments,
  needsSummary,
} from '@/ui/pages/apps/components/configModel'
import {
  configNeedsSentence,
  ShipPanel,
  shipConfigNeeds,
} from '@/ui/pages/sessions/components/ShipPanel'
import {
  APP_ID,
  appConfigView,
  appGrant,
  GRANT_APPROVAL_ID,
  GRANT_ID,
  GRANT_PROD_ID,
  RESOURCE_ID,
} from './helpers/grants'
import {
  errorResponse,
  IDS,
  makeSession,
  type RouteTable,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'
import { sessionEvent, sessionRow } from './helpers/sessions'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useToastStore.setState({ toasts: [] })
})

const appDetail = {
  id: APP_ID,
  slug: 'expenses',
  displayName: 'Expenses',
  description: null,
  status: 'live',
  source: 'imported',
  template: 'rocketflare',
  templateVersion: '0.15.0',
  repoOwner: 'acme',
  repoName: 'expenses',
  ownerGroup: null,
  environments: [],
  createdAt: '2026-09-27T00:00:00Z',
  templateContractVersion: null,
  defaultBranch: 'main',
  updatedAt: '2026-09-27T00:00:00Z',
  viewerCanDeploy: true,
}

const CONFIG = `/api/apps/${APP_ID}/config`

function renderConfigPage(routes: RouteTable, session = makeSession()) {
  const fetchMock = stubFetch({ '/api/apps/expenses': appDetail, ...routes })
  renderWithProviders(
    <Routes>
      <Route path="/apps/:slug/config" element={<AppConfigPage />} />
    </Routes>,
    { session, route: '/apps/expenses/config' }
  )
  return fetchMock
}

describe('AppConfigPage', () => {
  it('shows each environment’s state, the declared keys by plugin, and the unmatched hint', async () => {
    renderConfigPage({ [CONFIG]: appConfigView() })
    const list = await screen.findByRole('list', { name: 'Shared config' })
    const staging = within(list).getByText('staging').closest('[data-env]') as HTMLElement
    expect(within(staging).getByText('Held · v3')).toBeInTheDocument()
    const production = within(list).getByText('production').closest('[data-env]') as HTMLElement
    expect(within(production).getByText('Missing')).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'Request' })).toBeInTheDocument()

    expect(screen.getByRole('heading', { name: 'm365-connector' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'The kit (optional)' })).toBeInTheDocument()
    const stripe = screen.getByText('STRIPE_KEY').closest('tr') as HTMLElement
    expect(within(stripe).getByText(/ask an admin to add it/)).toBeInTheDocument()
    expect(screen.getByText(/Scanned/)).toHaveTextContent('main @ abcdef1')
  })

  it('requests the missing environment only, with the route’s schema, then says who decides', async () => {
    const fetchMock = renderConfigPage({
      [CONFIG]: appConfigView(),
      [`POST /api/apps/${APP_ID}/grants`]: () =>
        new Response(
          JSON.stringify({
            grants: [
              {
                id: GRANT_PROD_ID,
                environment: 'production',
                approvalId: GRANT_APPROVAL_ID,
                status: 'requested',
              },
            ],
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } }
        ),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Request' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('checkbox', { name: /Staging/i })).toBeDisabled()
    expect(within(dialog).getByRole('checkbox', { name: /Production/i })).toBeChecked()
    // No reason → the schema refuses before any request.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }))
    expect(await within(dialog).findByText(/at least 1 character/i)).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText(/Why the app needs it/), {
      target: { value: 'The M365 connector reads mail' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `POST /api/apps/${APP_ID}/grants`)).toEqual({
        resourceId: RESOURCE_ID,
        environments: ['production'],
        reason: 'The M365 connector reads mail',
      })
    )
    await waitFor(() =>
      expect(useToastStore.getState().toasts[0]?.message).toBe(
        'Asked for Microsoft 365 in production. Its owner team decides.'
      )
    )
  })

  it('renders a refusal as a sentence in the modal, not a toast', async () => {
    renderConfigPage({
      [CONFIG]: appConfigView(),
      [`POST /api/apps/${APP_ID}/grants`]: () => errorResponse(409, 'No values', 'values_not_set'),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Request' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/Why the app needs it/), {
      target: { value: 'x' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }))
    expect(
      await within(dialog).findByText(/has no values in that environment yet/)
    ).toBeInTheDocument()
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('links a requested environment to its approval, and revokes an active grant', async () => {
    const requested = appGrant({
      id: GRANT_PROD_ID,
      environment: 'production',
      status: 'requested',
      approvalId: GRANT_APPROVAL_ID,
      pushedVersion: null,
      pushedAt: null,
    })
    const view = appConfigView({
      matched: [
        {
          ...appConfigView().matched[0],
          grants: { staging: appGrant(), production: requested },
        },
      ],
      grants: [requested, appGrant()],
    })
    const fetchMock = renderConfigPage({
      [CONFIG]: view,
      [`DELETE /api/apps/${APP_ID}/grants/${GRANT_ID}`]: {
        grant: appGrant({ status: 'revoking' }),
        pushId: null,
      },
    })
    const list = await screen.findByRole('list', { name: 'Shared config' })
    expect(within(list).getByRole('link', { name: 'View request' })).toHaveAttribute(
      'href',
      `/approvals/${GRANT_APPROVAL_ID}`
    )
    expect(within(list).queryByRole('button', { name: 'Request' })).not.toBeInTheDocument()

    const row = document.querySelector(`[data-grant="${GRANT_ID}"]`) as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }))
    await waitFor(() =>
      expect(requestBody(fetchMock, `DELETE /api/apps/${APP_ID}/grants/${GRANT_ID}`)).toEqual({})
    )
  })

  it('a reader who may not request sees the states and no buttons', async () => {
    renderConfigPage(
      { [CONFIG]: appConfigView({ canRequest: false }) },
      makeSession({ tenant: { id: IDS.tenant, name: 'Acme', slug: 'acme', role: 'member' } })
    )
    await screen.findByRole('list', { name: 'Shared config' })
    expect(screen.queryByRole('button', { name: 'Request' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Re-scan/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument()
  })
})

describe('ConfigCard', () => {
  it('re-scans and shows the new answer', async () => {
    const fetchMock = stubFetch({
      [CONFIG]: appConfigView({ scan: null, declared: [], matched: [], unmatched: [], grants: [] }),
      [`POST ${CONFIG}/scan`]: appConfigView(),
    })
    renderWithProviders(<ConfigCard appId={APP_ID} appSlug="expenses" appName="Expenses" />, {
      session: makeSession(),
    })
    expect(await screen.findByText('Not scanned yet.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Re-scan/ }))
    expect(await screen.findByRole('link', { name: 'Microsoft 365' })).toBeInTheDocument()
    expect(screen.getByText(/2 declared keys match/)).toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => String(input).endsWith('/config/scan') && init?.method === 'POST'
      )
    ).toBe(true)
  })
})

describe('config model', () => {
  it('words each environment and what a Request pre-selects', () => {
    expect(envGrantState(null)).toBe('missing')
    expect(envGrantState({ status: 'active', pushedVersion: null, pushError: null })).toBe(
      'pushing'
    )
    expect(envGrantState({ status: 'active', pushedVersion: 2, pushError: 'x' })).toBe(
      'push_failed'
    )
    expect(envGrantState({ status: 'rejected', pushedVersion: null, pushError: null })).toBe(
      'missing'
    )
    const match = appConfigView().matched[0] as never
    expect(missingEnvironments(match)).toEqual(['production'])
    expect(needsSummary({ matched: [match] as never })).toBe(
      'Microsoft 365 is not held in production'
    )
  })

  it('groups declared keys by plugin, the kit last', () => {
    const groups = declaredByPlugin(appConfigView() as never)
    expect(groups.map(g => g.pluginId)).toEqual(['m365-connector', 'payments', 'kit'])
    expect(groups[0]?.keys[0]?.resource?.id).toBe(RESOURCE_ID)
    expect(groups[1]?.keys[0]?.resource).toBeNull()
  })

  it('polls only while a push is landing on a grant', () => {
    expect(grantOwesPush({ status: 'active', pushedVersion: null, pushError: null })).toBe(true)
    expect(grantOwesPush({ status: 'requested', pushedVersion: null, pushError: null })).toBe(false)
    expect(appConfigPollInterval({ grants: [] })).toBe(false)
  })
})

describe('ShipPanel — the shared config a PR needs', () => {
  const needs = {
    needs: [
      {
        resourceId: RESOURCE_ID,
        slug: 'm365',
        displayName: 'Microsoft 365',
        keys: ['M365_TENANT_ID', 'M365_CLIENT_SECRET'],
      },
    ],
    unmatched: [],
    sha: 'b'.repeat(40),
  }

  it('reads the latest ship.config_needs row, and nothing when none is needed', () => {
    const events = [
      sessionEvent(3, 'ship.config_needs', { needs: [], unmatched: [] }),
      sessionEvent(7, 'ship.config_needs', needs),
    ]
    const parsed = events.map(e => ({ ...e, at: new Date(e.at) }))
    expect(shipConfigNeeds(parsed as never)?.needs[0]?.slug).toBe('m365')
    expect(shipConfigNeeds([parsed[0]] as never)).toBeNull()
    expect(configNeedsSentence(needs.needs)).toBe(
      'Microsoft 365 (M365_TENANT_ID, M365_CLIENT_SECRET)'
    )
  })

  it('says the PR needs it and links to the app’s Config page', async () => {
    stubFetch({})
    const session = sessionSchema.parse(sessionRow({ status: 'shipping' }))
    render(
      <MemoryRouter>
        {/* The PR read is disabled without a PR number: a bare client is enough. */}
        <ShipPanelHarness>
          <ShipPanel session={session} gates={[]} configNeeds={needs} appSlug="expenses" />
        </ShipPanelHarness>
      </MemoryRouter>
    )
    const line = screen.getByTestId('config-needs')
    expect(line).toHaveTextContent('Microsoft 365 (M365_TENANT_ID, M365_CLIENT_SECRET)')
    expect(within(line).getByRole('link', { name: 'Request it' })).toHaveAttribute(
      'href',
      '/apps/expenses/config'
    )
  })
})

function ShipPanelHarness({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}
