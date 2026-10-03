/**
 * `/settings/platform/*`: administering the Launch DEPLOYMENT — the setup wizard, the coding agents
 * sessions run, Launch as the company's OIDC issuer, and the sign-up review queue. Gated by `RequireGuard
 * guard="platformAdmin"` on the route (`canAdministerPlatform`; server: `platformAdminMiddleware`
 * on `/api/platform/*`): a global admin, or in single mode the organisation's owner/admin — there
 * the one organisation IS the company running Launch, so its admins own the platform too.
 *
 * Real paths rather than `/settings?tab=` because a global admin with no membership must still
 * open them (`ProtectedRoute`'s `isAdminPath`; the tabbed `/settings` needs an organisation), and
 * because the Create-app modal deep-links a step anchor (`/settings/platform/setup#setup-public_url`).
 */
import { NavLink, Outlet } from 'react-router-dom'
import { PageHeader } from '@/ui/components/shared'
import { useAdminAccessRequests } from '@/ui/hooks/useAdminAccessRequests'
import { useAuth } from '@/ui/hooks/useAuth'
import { useNavGuard } from '@/ui/hooks/useNavGuard'
import {
  PLATFORM_ACCESS_REQUESTS_PATH,
  PLATFORM_CODING_AGENTS_PATH,
  PLATFORM_IDENTITY_PATH,
  PLATFORM_SETUP_PATH,
} from '@/ui/lib/platform-paths'

export default function PlatformLayout() {
  const { tenancyMode } = useAuth()
  const canAccess = useNavGuard()
  const { data } = useAdminAccessRequests({ status: 'pending', pageSize: 1 })
  const pendingCount = data?.pagination.total ?? 0

  const tabs = [
    // Launch: the platform credentials and settings (spec/03) and the issuer's keys (spec/05).
    { to: PLATFORM_SETUP_PATH, label: 'Setup' },
    // Sessions §18.22: which coding agents run, their models, who pays, and Launch's keys for them.
    { to: PLATFORM_CODING_AGENTS_PATH, label: 'Coding agents' },
    { to: PLATFORM_IDENTITY_PATH, label: 'Identity' },
    { to: PLATFORM_ACCESS_REQUESTS_PATH, label: 'Access requests', badge: pendingCount },
  ]

  return (
    <div>
      <PageHeader
        title="Platform"
        description={
          tenancyMode === 'single'
            ? 'Launch itself: its credentials and domain, its sign-in keys, and who is waiting to join.'
            : 'This deployment of Launch: credentials and domain, sign-in keys, access requests.'
        }
        // A global admin with no membership cannot open `/settings` — no crumb pointing there.
        breadcrumbs={
          canAccess('admin') ? [{ label: 'Settings', to: '/settings' }, { label: 'Platform' }] : []
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
            {tab.badge !== undefined && tab.badge > 0 && (
              <span className="badge badge-sm badge-warning tabular-nums">{tab.badge}</span>
            )}
          </NavLink>
        ))}
      </div>
      <Outlet />
    </div>
  )
}
