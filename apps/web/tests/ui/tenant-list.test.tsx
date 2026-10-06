/**
 * Settings → Organisations (the Operator group, multi mode) and the sidebar's footer.
 *
 * The list used to read "No organisations match" on a single-mode deployment with one: the
 * route answers 404 `tenancy_mode_single` there, the query errored, and an errored list looked
 * exactly like an empty search. Single mode no longer lists it at all (the redirects send its old
 * address to General — `settings-layout.test.tsx`), and a load that fails says so.
 */
import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TenantFooter } from '@/ui/components/TenantFooter'
import TenantList from '@/ui/pages/admin/TenantList'
import {
  errorResponse,
  IDS,
  makeSession,
  makeTenant,
  makeUser,
  paged,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

afterEach(() => vi.unstubAllGlobals())

const globalAdmin = () =>
  makeSession({ user: makeUser({ isGlobalAdmin: true }), tenant: makeTenant({ role: 'member' }) })

const acme = {
  id: IDS.tenant,
  name: 'Acme',
  slug: 'acme',
  status: 'active',
  memberCount: 3,
  seedDataCreated: true,
  lastAccessedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
}

describe('Settings → Organisations', () => {
  it('lists each organisation, linking to its page under Settings', async () => {
    stubFetch({ '/api/admin/tenants': paged([acme]) })
    renderWithProviders(<TenantList />, { session: globalAdmin() })
    expect(await screen.findByText('Acme')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open/ })).toHaveAttribute(
      'href',
      `/settings/organisations/${IDS.tenant}`
    )
  })

  it('says a failed load failed — never "No organisations match"', async () => {
    stubFetch({
      '/api/admin/tenants': errorResponse(404, 'Not found', 'tenancy_mode_single'),
    })
    renderWithProviders(<TenantList />, { session: globalAdmin() })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The organisations could not be loaded.'
    )
    expect(screen.queryByText('No organisations match')).toBeNull()
  })

  it('still says "No organisations match" for a search that matches none', async () => {
    stubFetch({ '/api/admin/tenants': paged([]) })
    renderWithProviders(<TenantList />, { session: globalAdmin() })
    expect(await screen.findByText('No organisations match')).toBeInTheDocument()
  })
})

describe('the sidebar footer', () => {
  it('names a global admin as one, whatever their membership role', () => {
    renderWithProviders(<TenantFooter />, { session: globalAdmin() })
    const badge = screen.getByText('Global admin')
    expect(badge).toHaveAttribute('title', 'Organisation role: member')
    expect(screen.queryByText('member')).toBeNull()
  })

  it("shows everyone else's organisation role", () => {
    renderWithProviders(<TenantFooter />, {
      session: makeSession({ tenant: makeTenant({ role: 'admin' }) }),
    })
    expect(screen.getByText('admin')).toBeInTheDocument()
  })
})
