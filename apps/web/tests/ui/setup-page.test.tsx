/**
 * Admin → Setup (spec/03): the stepper renders every step with the server's status, a set
 * credential is write-only ("Set — hidden" + Replace, never an input holding a value), Replace
 * opens an EMPTY field and PUTs only what was typed, and a bad settings value is refused with the
 * server's own schema message before any request.
 */
import type { SetupCredential, SetupOverview } from '@launch/shared/launch-setup'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Setup from '@/ui/pages/admin/Setup'
import {
  makeSession,
  makeUser,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const unset = (kind: SetupCredential['kind']): SetupCredential => ({
  kind,
  set: false,
  setAt: null,
  setByUserId: null,
  setByEmail: null,
  rotatedAt: null,
  metadata: {},
  lastCheckStatus: null,
  lastCheck: null,
  lastCheckedAt: null,
})

const overview: SetupOverview = {
  steps: [
    { id: 'domain', status: 'ok' },
    { id: 'cloudflare', status: 'warning' },
    { id: 'neon', status: 'todo' },
    { id: 'resend', status: 'failed' },
    { id: 'github', status: 'todo' },
    { id: 'identity', status: 'ok' },
  ],
  settings: {
    apps_domain: 'company-apps.test',
    cloudflare_account_id: '0123456789abcdef0123456789abcdef',
    neon_org_id: null,
    neon_region_id: null,
    notifications_domain: null,
    github_org: null,
  },
  effectiveNotificationsDomain: 'notifications.company-apps.test',
  credentials: [
    {
      ...unset('cloudflare_api_token'),
      set: true,
      setAt: new Date('2026-09-01T00:00:00Z'),
      setByUserId: '11111111-1111-4111-8111-111111111111',
      setByEmail: 'ada@example.test',
      metadata: { accountId: '0123456789abcdef0123456789abcdef' },
      lastCheckStatus: 'warning',
      lastCheck: [
        { id: 'zone.account', label: 'Apps zone in this account', status: 'ok' },
        {
          id: 'token.write',
          label: 'Write permissions',
          status: 'warning',
          detail: 'Write scope unverified',
        },
      ],
      lastCheckedAt: new Date('2026-09-01T00:00:00Z'),
    },
    unset('neon_org_api_key'),
    {
      ...unset('resend_api_key'),
      set: true,
      setAt: new Date('2026-09-01T00:00:00Z'),
      lastCheckStatus: 'failed',
      lastCheck: [
        {
          id: 'domain.verified',
          label: 'Notifications domain verified',
          status: 'failed',
          detail: 'notifications.company-apps.test is not a Resend domain yet.',
        },
      ],
    },
    unset('github_app'),
  ],
  identity: {
    providers: ['google'],
    oidc: null,
    oidcOnly: false,
    checks: [{ id: 'providers', label: 'Single sign-on configured', status: 'ok' }],
  },
}

const checkResponse = {
  credential: overview.credentials[0],
  status: 'warning',
  checks: overview.credentials[0]?.lastCheck ?? [],
}

function render() {
  const fetchMock = stubFetch({
    '/api/admin/setup': overview,
    'PUT /api/admin/setup/credentials/cloudflare_api_token': checkResponse,
    'PUT /api/admin/setup/settings': overview,
  })
  renderWithProviders(<Setup />, {
    session: makeSession({ user: makeUser({ isGlobalAdmin: true }) }),
  })
  return fetchMock
}

describe('Admin → Setup', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renders the stepper and each step with its status', async () => {
    render()
    const nav = await screen.findByRole('navigation', { name: 'Setup steps' })
    for (const title of ['Domain & zone', 'Cloudflare', 'Neon', 'Resend', 'GitHub App']) {
      expect(within(nav).getByText(title)).toBeInTheDocument()
    }
    const resend = screen.getByRole('region', { name: /Resend/ })
    expect(resend.querySelector('header [data-status]')?.getAttribute('data-status')).toBe('failed')
    expect(within(resend).getByText(/is not a Resend domain yet/)).toBeInTheDocument()
    const cloudflare = screen.getByRole('region', { name: /2\.\s*Cloudflare/ })
    expect(within(cloudflare).getByText('Write permissions')).toBeInTheDocument()
    expect(within(cloudflare).getByText(/by ada@example.test/)).toBeInTheDocument()
  })

  it('shows a set secret as hidden, and Replace opens an empty field that PUTs what was typed', async () => {
    const fetchMock = render()
    const cloudflare = await screen.findByRole('region', { name: /2\.\s*Cloudflare/ })
    expect(within(cloudflare).getByText(/Set — hidden/)).toBeInTheDocument()
    expect(cloudflare.querySelector('input[type="password"]')).toBeNull()

    fireEvent.click(within(cloudflare).getByRole('button', { name: 'Replace' }))
    const input = within(cloudflare).getByLabelText('API token') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'new-cloudflare-token-0123456789' } })
    fireEvent.click(within(cloudflare).getByRole('button', { name: 'Save and check' }))

    await waitFor(() =>
      expect(
        requestBody(fetchMock, 'PUT /api/admin/setup/credentials/cloudflare_api_token')
      ).toEqual({ apiToken: 'new-cloudflare-token-0123456789' })
    )
    // Settings did not change, so they were not sent.
    expect(requestBody(fetchMock, 'PUT /api/admin/setup/settings')).toBeUndefined()
  })

  it("refuses a bad setting with the server's own message, before any request", async () => {
    const fetchMock = render()
    const github = await screen.findByRole('region', { name: /GitHub App/ })
    fireEvent.change(within(github).getByLabelText('Organization'), {
      target: { value: 'not a valid org!' },
    })
    fireEvent.click(within(github).getByRole('button', { name: 'Save and check' }))
    expect(await within(github).findByText('A GitHub organization login')).toBeInTheDocument()
    expect(requestBody(fetchMock, 'PUT /api/admin/setup/settings')).toBeUndefined()
  })
})
