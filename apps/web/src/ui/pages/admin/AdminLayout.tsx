/**
 * `/admin/*` (D10, D25): the operator's cross-tenant area, gated by `RequireGuard
 * guard="globalAdmin"` on the route (server: `globalAdminMiddleware`) in every tenancy mode —
 * organisations (in single mode collapsed to the one tenant, see TenantList), users, feature flags
 * and live coding sessions. Setup, Identity and Access requests are not here: they administer the
 * deployment, which a single-mode owner/admin may do too, so they live under `/settings/platform`
 * (`canAdministerPlatform`); the header links there, and the old `/admin/*` paths redirect.
 */
import { WrenchScrewdriverIcon } from '@heroicons/react/24/outline'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { PageHeader } from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { PLATFORM_SETTINGS_PATH } from '@/ui/lib/platform-paths'

export default function AdminLayout() {
  const { tenancyMode } = useAuth()

  const tabs = [
    { to: '/admin/tenants', label: tenancyMode === 'single' ? 'Organisation' : 'Organisations' },
    { to: '/admin/users', label: 'Users' },
    { to: '/admin/feature-flags', label: 'Feature flags' },
    // Launch P3: live coding sessions and the drain before a session-image deploy.
    { to: '/admin/sessions', label: 'Sessions' },
  ]

  return (
    <div>
      <PageHeader
        title="Admin"
        description="Across every organisation on this deployment."
        actions={
          <Link to={PLATFORM_SETTINGS_PATH} className="btn btn-ghost btn-sm gap-1.5">
            <WrenchScrewdriverIcon className="w-4 h-4" />
            Setup & access requests
          </Link>
        }
      />
      <div
        role="tablist"
        className="tabs tabs-border border-b border-[color:var(--border-default)] mb-6"
      >
        {tabs.map(tab => (
          <NavLink
            key={tab.to}
            to={tab.to}
            role="tab"
            className={({ isActive }) => `tab gap-2 ${isActive ? 'tab-active font-semibold' : ''}`}
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
      <Outlet />
    </div>
  )
}
