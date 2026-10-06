import { useAuth } from '@/ui/hooks/useAuth'
import { RoleBadge } from './RoleBadge'

/**
 * Sidebar footer: which org (and as what) the reader is acting in. A global admin's membership
 * role says little about what they may do (they hold `manage all` whatever it is), so they read
 * "Global admin", with the organisation role in the tooltip.
 */
export function TenantFooter() {
  const { tenant, isGlobalAdmin } = useAuth()
  if (!tenant) return null
  return (
    <div className="flex items-center justify-between gap-2 px-1 py-1 text-xs">
      <span className="truncate text-secondary" title={tenant.name}>
        {tenant.name}
      </span>
      {isGlobalAdmin ? (
        <span
          className="badge badge-sm badge-info shrink-0 whitespace-nowrap"
          title={`Organisation role: ${tenant.role}`}
        >
          Global admin
        </span>
      ) : (
        <RoleBadge role={tenant.role} className="shrink-0" />
      )}
    </div>
  )
}
