/**
 * The ONE place nav visibility and route access are decided (D10). SideNav items and
 * `RequireGuard` share the type and the hook, so a link never points at a page its reader may
 * not open. Cosmetic — the server enforces on every request.
 */
import { type Actions, canAdministerPlatform, type Subjects } from '@launch/shared/permissions'
import { useCallback } from 'react'
import { useAbility } from '@/ui/components/permissions/AbilityContext'
import { useAuth } from './useAuth'

/**
 * Coarse role flags for routing (`AdminRoute` / `GlobalAdminRoute` semantics), a CASL
 * `{ action, subject }` pair for per-page checks, a feature flag, a list meaning AND, or `{ anyOf }`
 * meaning OR. Strings, not the typed unions, so apps can add subjects without touching the shell;
 * the pair is cast when it reaches the ability.
 */
export type NavGuard =
  | 'admin'
  | 'globalAdmin'
  /**
   * Administering the deployment (Settings → Connections, Coding agents, Kit, access requests):
   * `canAdministerPlatform` from
   * `@launch/shared/permissions`, the SAME function the server's `platformAdminMiddleware` calls —
   * a global admin (membership or not), or in single mode the organisation's owner/admin.
   */
  | 'platformAdmin'
  | { action: string; subject: string }
  /**
   * A feature flag (D30): satisfied by `session.features`, NEVER by the ability. A global admin
   * holds `manage all`, which in CASL covers `access` on every `Feature:` subject, so an ability
   * check would show them a surface the deployment does not ship — and the server, which reads the
   * same array, would 404 the routes underneath it. See `src/permissions/features.ts`.
   */
  | { feature: string }
  /**
   * Every guard must pass (AND). This is how a surface behind a feature flag is expressed —
   * `[{ feature: 'reports' }, { action: 'read', subject: 'Report' }]` — so the flag and the
   * permission stay two separate, readable facts instead of one conflated subject. An empty list is
   * allowed, matching `undefined`.
   */
  | readonly NavGuard[]
  /**
   * At least one guard must pass (OR). For a door into several sections with different guards —
   * Settings is `{ anyOf: ['admin', 'platformAdmin'] }`: in multi mode an organisation's owner
   * (`admin`, not `platformAdmin`) and a global admin with no membership (`platformAdmin`, not
   * `admin`) both have sections to open there, and neither guard covers both.
   */
  | { anyOf: readonly NavGuard[] }

const ADMIN_ROLES = new Set(['owner', 'admin', 'support'])

/** `Array.isArray` widens a `readonly T[]` to `any[]` rather than narrowing the union, so this. */
export const isGuardList = (guard: NavGuard): guard is readonly NavGuard[] => Array.isArray(guard)

export function useNavGuard(): (guard: NavGuard | undefined) => boolean {
  const { tenant, isGlobalAdmin, session, tenancyMode } = useAuth()
  const ability = useAbility()
  const role = tenant?.role ?? null

  const hasTenant = tenant !== null
  const features = session?.features ?? []

  return useCallback(
    function check(guard: NavGuard | undefined): boolean {
      if (guard === undefined) return true
      if (isGuardList(guard)) return guard.every(check)
      if (typeof guard === 'object' && 'anyOf' in guard) return guard.anyOf.some(check)
      // Before the tenant check: a feature that is off is off for everyone, membership or not.
      if (typeof guard === 'object' && 'feature' in guard) return features.includes(guard.feature)
      if (guard === 'globalAdmin') return isGlobalAdmin
      if (guard === 'platformAdmin')
        return canAdministerPlatform({ isGlobalAdmin, role, tenancyMode })
      // Without an organisation only the global admin's areas are openable — a global admin's
      // `manage all` would otherwise light up every tenant page, each bouncing to `noTenantRoute`
      if (!hasTenant) return false
      // `support` is a global admin visiting this org; global admins hold `manage all` server-side
      if (guard === 'admin') return isGlobalAdmin || (role !== null && ADMIN_ROLES.has(role))
      return ability.can(guard.action as Actions, guard.subject as Subjects)
    },
    [ability, features, hasTenant, isGlobalAdmin, role, tenancyMode]
  )
}
