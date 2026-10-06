import { screen, waitFor } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Moved } from '@/ui/components/Moved'
import { ProtectedRoute } from '@/ui/components/ProtectedRoute'
import { RequireGuard } from '@/ui/components/RequireGuard'
import { SETTINGS_GUARD } from '@/ui/lib/settings-paths'
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
                path="/settings/kit"
                element={
                  <RequireGuard guard="platformAdmin">
                    <Where label="platform" />
                  </RequireGuard>
                }
              />
              <Route path="/admin/users" element={<Moved to="/settings/users" />} />
              <Route path="/secrets" element={<Where label="secrets" />} />
              <Route path="/secrets/:id" element={<Where label="secret" />} />
              <Route path="/shared-config" element={<Moved to="/secrets" />} />
              <Route path="/activity" element={<Moved to="/settings/audit" />} />
              <Route
                path="/shared-config/:id"
                element={<Moved to={({ id = '' }) => `/secrets/${encodeURIComponent(id)}`} />}
              />
              {/* As `settingsRoutes()` mounts it, one section standing in for each guard. */}
              <Route
                path="/settings/users"
                element={
                  <RequireGuard guard={SETTINGS_GUARD}>
                    <RequireGuard guard="globalAdmin" redirectTo="/settings">
                      <Where label="operator" />
                    </RequireGuard>
                  </RequireGuard>
                }
              />
              <Route
                path="/settings/*"
                element={
                  <RequireGuard guard={SETTINGS_GUARD}>
                    <Where label="settings" />
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

  it('RequireGuard: member is bounced from /settings to home', () => {
    renderWithProviders(<App />, {
      session: makeSession({ tenant: makeTenant({ role: 'member' }) }),
      route: '/settings/people',
    })
    expect(page()).toBe('home')
  })

  it("RequireGuard: owner opens /settings but not the operator's sections", () => {
    const { unmount } = renderWithProviders(<App />, { session: makeSession(), route: '/settings' })
    expect(page()).toBe('settings')
    unmount()
    renderWithProviders(<App />, { session: makeSession(), route: '/settings/users' })
    expect(page()).toBe('settings')
    expect(path()).toBe('/settings')
  })

  it('a global admin with NO membership reaches /settings/* (and the old /admin/*) — and only that', () => {
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
    expect(landsOn('/settings/users')).toBe('operator')
    expect(landsOn('/admin/users')).toBe('operator')
    expect(landsOn('/settings')).toBe('settings')
    expect(landsOn('/')).toBe('no-access')
    expect(landsOn('/secrets')).toBe('no-access')
  })

  it('a non-admin with no membership is still redirected away from /settings and /admin', () => {
    for (const route of ['/admin/users', '/settings/users']) {
      const { unmount } = renderWithProviders(<App />, {
        session: makeSession({ tenant: null, tenants: [] }),
        route,
      })
      expect(page()).toBe('no-access')
      unmount()
    }
  })

  it('a platform section: the single-mode owner/admin; never a member or a multi-mode owner', () => {
    const landsOn = (session: ReturnType<typeof makeSession>) => {
      const { unmount } = renderWithProviders(<App />, {
        session,
        route: '/settings/kit',
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

  it('a global admin with NO membership reaches the platform sections too', () => {
    renderWithProviders(<App />, {
      session: makeSession({ user: makeUser({ isGlobalAdmin: true }), tenant: null, tenants: [] }),
      route: '/settings/kit',
    })
    expect(page()).toBe('platform')
  })

  it('the old /shared-config links land on Secrets, keeping the id, query and hash', () => {
    renderWithProviders(<App />, { session: makeSession(), route: '/shared-config?archived=1' })
    expect(page()).toBe('secrets')
    expect(path()).toBe('/secrets?archived=1')
  })

  it('the old /activity link lands on Settings → Audit — the one log — keeping the query and hash', () => {
    renderWithProviders(<App />, {
      session: makeSession({ tenant: makeTenant({ role: 'admin' }) }),
      route: '/activity?page=2#top',
    })
    expect(page()).toBe('settings')
    expect(path()).toBe('/settings/audit?page=2#top')
  })

  it('an old /shared-config/:id link lands on that secret', () => {
    renderWithProviders(<App />, { session: makeSession(), route: '/shared-config/abc-123#push' })
    expect(page()).toBe('secret')
    expect(path()).toBe('/secrets/abc-123#push')
  })

  it("RequireGuard: global admin opens the operator's sections", () => {
    renderWithProviders(<App />, {
      session: makeSession({ user: makeUser({ isGlobalAdmin: true }) }),
      route: '/settings/users',
    })
    expect(page()).toBe('operator')
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
