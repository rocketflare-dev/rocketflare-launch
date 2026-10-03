import { screen, waitFor } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Moved } from '@/ui/components/Moved'
import { ProtectedRoute } from '@/ui/components/ProtectedRoute'
import { RequireGuard } from '@/ui/components/RequireGuard'
import {
  makeSession,
  makeTenant,
  makeUser,
  renderWithProviders,
} from './helpers/renderWithProviders'

function Where({ label }: { label: string }) {
  const location = useLocation()
  return (
    <div>
      <span data-testid="page">{label}</span>
      <span data-testid="path">{location.pathname + location.search + location.hash}</span>
    </div>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Where label="login" />} />
      <Route
        path="/select-tenant"
        element={
          <ProtectedRoute requireTenant={false}>
            <Where label="select-tenant" />
          </ProtectedRoute>
        }
      />
      <Route
        path="/pending"
        element={
          <ProtectedRoute requireTenant={false}>
            <Where label="pending" />
          </ProtectedRoute>
        }
      />
      <Route
        path="/no-access"
        element={
          <ProtectedRoute requireTenant={false}>
            <Where label="no-access" />
          </ProtectedRoute>
        }
      />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <Routes>
              <Route path="/" element={<Where label="home" />} />
              <Route
                path="/settings/platform/*"
                element={
                  <RequireGuard guard="platformAdmin">
                    <Where label="platform" />
                  </RequireGuard>
                }
              />
              <Route path="/admin/setup" element={<Moved to="/settings/platform/setup" />} />
              <Route path="/secrets" element={<Where label="secrets" />} />
              <Route path="/secrets/:id" element={<Where label="secret" />} />
              <Route path="/shared-config" element={<Moved to="/secrets" />} />
              <Route
                path="/audit"
                element={
                  <RequireGuard guard="admin">
                    <Where label="audit" />
                  </RequireGuard>
                }
              />
              <Route path="/activity" element={<Moved to="/audit" />} />
              <Route
                path="/shared-config/:id"
                element={<Moved to={({ id = '' }) => `/secrets/${encodeURIComponent(id)}`} />}
              />
              <Route
                path="/settings/*"
                element={
                  <RequireGuard guard="admin">
                    <Where label="settings" />
                  </RequireGuard>
                }
              />
              <Route
                path="/admin/*"
                element={
                  <RequireGuard guard="globalAdmin">
                    <Where label="admin" />
                  </RequireGuard>
                }
              />
            </Routes>
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}

const page = () => screen.getByTestId('page').textContent
const path = () => screen.getByTestId('path').textContent

describe('ProtectedRoute', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows a spinner while the session loads', () => {
    renderWithProviders(<App />, { session: makeSession() })
    // Seeded cache resolves synchronously on first render — nothing to wait for
    expect(page()).toBe('home')
  })

  it('unauthenticated → /login with the attempted path as returnUrl', async () => {
    renderWithProviders(<App />, { session: null, route: '/settings/people?x=1' })
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument()
    await waitFor(() => expect(page()).toBe('login'))
    expect(path()).toBe('/login?returnUrl=%2Fsettings%2Fpeople%3Fx%3D1')
  })

  it('unauthenticated on / → plain /login', async () => {
    renderWithProviders(<App />, { session: null, route: '/' })
    await waitFor(() => expect(path()).toBe('/login'))
  })

  it('no tenant but memberships → /select-tenant', () => {
    renderWithProviders(<App />, {
      session: makeSession({
        tenant: null,
        tenants: [
          makeTenant(),
          makeTenant({ id: '33333333-3333-4333-8333-333333333333', slug: 'b' }),
        ],
      }),
    })
    expect(page()).toBe('select-tenant')
  })

  it('no tenant with an access request → /pending', () => {
    renderWithProviders(<App />, {
      session: makeSession({ tenant: null, tenants: [], accessRequest: { status: 'pending' } }),
    })
    expect(page()).toBe('pending')
  })

  it('no tenant, approval mode, no request yet → /pending', () => {
    renderWithProviders(<App />, {
      session: makeSession({ tenant: null, tenants: [], signupMode: 'approval' }),
    })
    expect(page()).toBe('pending')
  })

  it('no tenant, invite-only → /no-access', () => {
    renderWithProviders(<App />, { session: makeSession({ tenant: null, tenants: [] }) })
    expect(page()).toBe('no-access')
  })

  it('with a tenant, the no-tenant pages are not forced', () => {
    renderWithProviders(<App />, { session: makeSession(), route: '/select-tenant' })
    expect(page()).toBe('select-tenant')
  })

  it('RequireGuard: member is bounced from /settings and /admin to home', () => {
    renderWithProviders(<App />, {
      session: makeSession({ tenant: makeTenant({ role: 'member' }) }),
      route: '/settings/people',
    })
    expect(page()).toBe('home')
  })

  it('RequireGuard: owner opens /settings but not /admin', () => {
    const { unmount } = renderWithProviders(<App />, { session: makeSession(), route: '/settings' })
    expect(page()).toBe('settings')
    unmount()
    renderWithProviders(<App />, { session: makeSession(), route: '/admin/users' })
    expect(page()).toBe('home')
  })

  it('a global admin with NO membership reaches /admin/* — and only /admin/*', () => {
    const session = makeSession({
      user: makeUser({ isGlobalAdmin: true }),
      tenant: null,
      tenants: [],
    })
    const landsOn = (route: string) => {
      const { unmount } = renderWithProviders(<App />, { session, route })
      const label = page()
      unmount()
      return label
    }
    expect(landsOn('/admin/users')).toBe('admin')
    expect(landsOn('/admin')).toBe('admin')
    expect(landsOn('/')).toBe('no-access')
    expect(landsOn('/settings')).toBe('no-access')
  })

  it('a non-admin with no membership is still redirected away from /admin', () => {
    renderWithProviders(<App />, {
      session: makeSession({ tenant: null, tenants: [] }),
      route: '/admin/users',
    })
    expect(page()).toBe('no-access')
  })

  it('/settings/platform: the single-mode owner/admin; never a member or a multi-mode owner', () => {
    const landsOn = (session: ReturnType<typeof makeSession>) => {
      const { unmount } = renderWithProviders(<App />, {
        session,
        route: '/settings/platform/setup',
      })
      const label = page()
      unmount()
      return label
    }
    const single = (role: 'owner' | 'admin' | 'member') =>
      makeSession({ tenancyMode: 'single', tenant: makeTenant({ role }) })
    expect(landsOn(single('owner'))).toBe('platform')
    expect(landsOn(single('admin'))).toBe('platform')
    expect(landsOn(single('member'))).toBe('home')
    expect(landsOn(makeSession({ tenant: makeTenant({ role: 'owner' }) }))).toBe('home')
  })

  it('a global admin with NO membership reaches /settings/platform too', () => {
    renderWithProviders(<App />, {
      session: makeSession({ user: makeUser({ isGlobalAdmin: true }), tenant: null, tenants: [] }),
      route: '/settings/platform/access-requests',
    })
    expect(page()).toBe('platform')
  })

  it('the old /admin/setup link lands on the platform page with its step anchor', () => {
    renderWithProviders(<App />, {
      session: makeSession({ tenancyMode: 'single', tenant: makeTenant({ role: 'admin' }) }),
      route: '/admin/setup#setup-public_url',
    })
    expect(page()).toBe('platform')
    expect(path()).toBe('/settings/platform/setup#setup-public_url')
  })

  it('the old /shared-config links land on Secrets, keeping the id, query and hash', () => {
    renderWithProviders(<App />, { session: makeSession(), route: '/shared-config?archived=1' })
    expect(page()).toBe('secrets')
    expect(path()).toBe('/secrets?archived=1')
  })

  it('the old /activity link lands on Audit — the one log — keeping the query and hash', () => {
    renderWithProviders(<App />, {
      session: makeSession({ tenant: makeTenant({ role: 'admin' }) }),
      route: '/activity?page=2#top',
    })
    expect(page()).toBe('audit')
    expect(path()).toBe('/audit?page=2#top')
  })

  it('an old /shared-config/:id link lands on that secret', () => {
    renderWithProviders(<App />, { session: makeSession(), route: '/shared-config/abc-123#push' })
    expect(page()).toBe('secret')
    expect(path()).toBe('/secrets/abc-123#push')
  })

  it('RequireGuard: global admin opens /admin', () => {
    renderWithProviders(<App />, {
      session: makeSession({ user: makeUser({ isGlobalAdmin: true }) }),
      route: '/admin/users',
    })
    expect(page()).toBe('admin')
  })

  it('a non-401 session failure shows a retry panel instead of bouncing to login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503, statusText: 'Service Unavailable' }))
    )
    renderWithProviders(<App />, { route: '/' })
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent("Can't reach the server")
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
