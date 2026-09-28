/**
 * Server side of `canAdministerPlatform` (`@launch/shared/permissions`): who may administer the
 * Launch deployment — the setup wizard, the OIDC issuer's keys, the access-request queue. A global
 * admin always; in `TENANCY_MODE=single` also the one organisation's owner or admin. Multi mode is
 * `isGlobalAdmin` alone, exactly as before. `platformAdminMiddleware` (`/api/platform/*`) is the
 * route-side caller; the UI's `platformAdmin` nav guard calls the shared function directly.
 */
import { canAdministerPlatform as decide } from '@launch/shared/permissions'
import type { MembershipRole } from '@launch/shared/tenants'

/** The slice of `AuthContext` the decision reads — a literal is enough in a test. */
export interface PlatformAdminView {
  isGlobalAdmin: boolean
  tenantUser: { role: MembershipRole } | null
}

export function canAdministerPlatform(
  auth: PlatformAdminView,
  config: { TENANCY_MODE: 'multi' | 'single' }
): boolean {
  return decide({
    isGlobalAdmin: auth.isGlobalAdmin === true,
    role: auth.tenantUser?.role ?? null,
    tenancyMode: config.TENANCY_MODE,
  })
}
