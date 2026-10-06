/**
 * The shell's routes for Settings: the one `/settings/*` layout behind `SETTINGS_GUARD`, and a
 * redirect from every address Settings, Setup and Admin used to have. Bookmarks, links in older
 * notifications and emails, and the docs of older releases point at these, so they stay forever.
 * The old `/settings?tab=` links are `/settings` itself, which `SettingsLayout` resolves.
 *
 * A function returning `<Route>`s rather than a component, because React Router only reads
 * `<Route>` elements that are direct children of `<Routes>` — the same shape as `pluginRoutes`.
 */
import { lazy } from 'react'
import { Navigate, Route, useLocation } from 'react-router-dom'
import { Moved } from '@/ui/components/Moved'
import { RequireGuard } from '@/ui/components/RequireGuard'
import {
  legacySetupPath,
  organisationPath,
  SETTINGS_GUARD,
  SETTINGS_PATHS,
  userPath,
} from '@/ui/lib/settings-paths'

const SettingsLayout = lazy(() => import('@/ui/pages/settings/SettingsLayout'))

/** The old setup wizard: a step anchor (`#setup-public_url`) opens that connection's own page. */
function MovedSetup() {
  const { hash } = useLocation()
  return <Navigate to={legacySetupPath(hash)} replace />
}

/** Old address → where it lives now. Query and hash are kept (`Moved`). */
export const MOVED_SETTINGS_ROUTES: { path: string; to: Parameters<typeof Moved>[0]['to'] }[] = [
  { path: '/audit', to: SETTINGS_PATHS.audit },
  // Audit is the one log: the kit's activity events are appended to it too.
  { path: '/activity', to: SETTINGS_PATHS.audit },
  { path: '/settings/platform/kit', to: SETTINGS_PATHS.kit },
  { path: '/settings/platform/coding-agents', to: SETTINGS_PATHS.codingAgents },
  { path: '/settings/platform/identity', to: SETTINGS_PATHS.signIn },
  { path: '/settings/platform/access-requests', to: SETTINGS_PATHS.accessRequests },
  { path: '/admin', to: SETTINGS_PATHS.users },
  { path: '/admin/identity', to: SETTINGS_PATHS.signIn },
  { path: '/admin/access-requests', to: SETTINGS_PATHS.accessRequests },
  // In single mode there is no list: `/settings/organisations` itself goes on to General.
  { path: '/admin/tenants', to: SETTINGS_PATHS.organisations },
  { path: '/admin/tenants/:id', to: ({ id = '' }) => organisationPath(id) },
  { path: '/admin/users', to: SETTINGS_PATHS.users },
  { path: '/admin/users/:id', to: ({ id = '' }) => userPath(id) },
  { path: '/admin/feature-flags', to: SETTINGS_PATHS.featureFlags },
  { path: '/admin/sessions', to: SETTINGS_PATHS.sessions },
]

/** The setup wizard's three addresses, each to a Connections page by its `#setup-<step>` anchor. */
export const MOVED_SETUP_PATHS = ['/settings/platform', '/settings/platform/setup', '/admin/setup']

export function settingsRoutes() {
  return [
    <Route
      key="/settings/*"
      path="/settings/*"
      element={
        <RequireGuard guard={SETTINGS_GUARD}>
          <SettingsLayout />
        </RequireGuard>
      }
    />,
    ...MOVED_SETTINGS_ROUTES.map(({ path, to }) => (
      <Route key={path} path={path} element={<Moved to={to} />} />
    )),
    ...MOVED_SETUP_PATHS.map(path => <Route key={path} path={path} element={<MovedSetup />} />),
  ]
}
