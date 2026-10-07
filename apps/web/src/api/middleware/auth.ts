/**
 * Authentication middleware (D10, D12, D25). Applied PER MOUNT in `index.ts`, never inside a
 * route file. Two credentials:
 *   - `Authorization: Bearer <api key>` → the key's tenant, acting as the key's creator (its
 *     GROUPS too, re-read per request — D29)
 *   - `__Host-session` cookie → `resolveSession` (one LATERAL query), sliding expiry via waitUntil
 * Builds `AuthContext` (`buildAbility({ role, isGlobalAdmin, features })`, the features resolved by
 * `permissions/features.ts` from `[vars]` plus the tenant's rollout rows — D30) and `c.set('auth')`.
 * Errors are envelopes: 401 `unauthorized`; 403 `blocked` / `tenant_suspended`. A valid session
 * with NO tenant passes with `tenantId: null` — `withAuthAndDb` turns that into 403 `no_tenant` /
 * `pending_approval`, while tenant-free routes (`withAuth`) keep working.
 *
 * `globalAdminMiddleware` (`/api/admin/*`): a cookie session with `users.isGlobalAdmin`, tenant-free
 * by design — the only cross-tenant auth path. `platformAdminMiddleware` (`/api/platform/*`): the
 * same resolution, gated on `canAdministerPlatform` — the global flag, or in single mode the
 * organisation's owner/admin. Both also take an ADMIN-scoped API key (`api_keys.scope = 'admin'`,
 * minted only by `GET /auth/cli?scope=admin` for a platform administrator) and re-check its
 * creator against the same gate on every request, so demoting someone disables their admin keys
 * with nothing to revoke. An ordinary (`tenant`) key there is 403 `admin_key_required`.
 */
import { ADMIN_KEY_REQUIRED_CODE, type ApiKeyAccessScope } from '@launch/shared/api-keys'
import { ERROR_CODES } from '@launch/shared/errors'
import { createMiddleware } from 'hono/factory'
import { buildAbility, canAdministerPlatform, resolveFeatures } from '../../permissions'
import { touchApiKeyUsage, validateApiKey } from '../auth/api-keys'
import { readSessionToken } from '../auth/cookies'
import {
  deleteSession,
  resolveSession,
  touchSession,
  touchTenantAccess,
  updateSelectedTenant,
} from '../auth/sessions'
import { listFeatureFlagRows } from '../services/features'
import { listUserGroups } from '../services/groups'
import type { AppContext, AppEnv, AuthContext } from '../types'
import { ForbiddenError, UnauthorizedError } from '../utils/core/errors'
import { deferOrAwait } from './database'

export const API_KEY_SESSION_PREFIX = 'api-key:'

export function isApiKeySession(auth: Pick<AuthContext, 'session'>): boolean {
  return auth.session.id.startsWith(API_KEY_SESSION_PREFIX)
}

/** Fire-and-forget side effect: `waitUntil` when available, awaited inline otherwise; never throws. */
export function fireAndForget(c: AppContext, work: () => Promise<unknown>, what: string): void {
  void deferOrAwait(c, () =>
    work().catch(err => {
      c.get('logger').warn({ err }, `Failed to ${what}`)
    })
  )
}

/**
 * Resolve the cookie session into an `AuthContext`, or null when there is no valid cookie.
 * Throws 403 `blocked` / `tenant_suspended`. Shared by `authMiddleware`, `globalAdminMiddleware`
 * and the public `/auth/*` routes that need to know who is asking (session, select-tenant, cli).
 */
export async function resolveCookieAuth(
  c: AppContext,
  token: string | undefined = readSessionToken(c)
): Promise<AuthContext | null> {
  if (!token) return null
  const db = c.get('db')
  const resolved = await resolveSession(db, token)
  if (!resolved) return null

  const { session, user, membership, accessRequestStatus } = resolved
  if (session.expiresAt.getTime() <= Date.now()) {
    fireAndForget(c, () => deleteSession(db, session.id), 'delete expired session')
    return null
  }
  if (user.blockedAt) throw new ForbiddenError('Account is blocked', ERROR_CODES.blocked)
  if (membership?.tenant.status === 'suspended') {
    throw new ForbiddenError('Organisation is suspended', ERROR_CODES.tenantSuspended)
  }

  fireAndForget(c, () => touchSession(db, session.id), 'touch session')
  if (membership) {
    if (session.selectedTenantId !== membership.tenantId) {
      // The LATERAL join already fell back to another membership; persist the new selection.
      fireAndForget(
        c,
        () => updateSelectedTenant(db, session.id, membership.tenantId),
        'update selected tenant'
      )
    }
    fireAndForget(c, () => touchTenantAccess(db, membership.tenantId), 'touch tenant access')
  }

  const features = resolveFeatures(c.get('config'), resolved.flagRows, {
    tenantId: membership?.tenantId ?? null,
    userId: user.id,
  })

  return {
    user,
    tenantId: membership?.tenantId ?? null,
    tenantUser: membership ? { role: membership.role } : null,
    tenant: membership
      ? { id: membership.tenant.id, name: membership.tenant.name, slug: membership.tenant.slug }
      : null,
    session: { id: session.id },
    ability: buildAbility({
      role: membership?.role ?? null,
      isGlobalAdmin: user.isGlobalAdmin,
      features,
    }),
    isGlobalAdmin: user.isGlobalAdmin,
    features,
    groups: membership?.groups ?? [],
    accessRequestStatus,
  }
}

interface BearerAuth {
  auth: AuthContext
  /** What the key may reach — only `admin` passes the admin/platform middlewares. */
  scope: ApiKeyAccessScope
}

async function resolveBearerAuth(c: AppContext, plaintext: string): Promise<BearerAuth> {
  const db = c.get('db')
  const result = await validateApiKey(db, plaintext)
  if (!result.ok) throw new UnauthorizedError('Invalid API key')
  if (result.user.blockedAt) throw new ForbiddenError('Account is blocked', ERROR_CODES.blocked)
  if (result.tenant.status === 'suspended') {
    throw new ForbiddenError('Organisation is suspended', ERROR_CODES.tenantSuspended)
  }
  fireAndForget(c, () => touchApiKeyUsage(db, result.key.id), 'touch API key usage')
  fireAndForget(c, () => touchTenantAccess(db, result.tenant.id), 'touch tenant access')
  // The cookie path gets both of these out of `resolveSession`'s one query; a Bearer request has no
  // session row to join onto, so it pays two small reads — run together rather than in sequence.
  const [groups, flagRows] = await Promise.all([
    listUserGroups(db, result.tenant.id, result.user.id),
    listFeatureFlagRows(db, result.tenant.id),
  ])
  const features = resolveFeatures(c.get('config'), flagRows, {
    tenantId: result.tenant.id,
    userId: result.user.id,
  })
  const auth: AuthContext = {
    user: result.user,
    tenantId: result.tenant.id,
    tenantUser: { role: result.role },
    tenant: { id: result.tenant.id, name: result.tenant.name, slug: result.tenant.slug },
    session: { id: `${API_KEY_SESSION_PREFIX}${result.key.id}` },
    ability: buildAbility({
      role: result.role,
      isGlobalAdmin: result.user.isGlobalAdmin,
      features,
    }),
    isGlobalAdmin: result.user.isGlobalAdmin,
    features,
    // A tenant key carries its CREATOR's groups, re-read on every request (D29): removing someone
    // from a group narrows their keys on the next call, with nothing to revoke. Feature flags are
    // re-read the same way, so a rollout reaches API-key callers on their next request too.
    groups,
    accessRequestStatus: null,
  }
  return { auth, scope: result.key.scope }
}

function bearerToken(c: AppContext): string | undefined {
  const header = c.req.header('Authorization')
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const bearer = bearerToken(c)
  const auth = bearer ? (await resolveBearerAuth(c, bearer)).auth : await resolveCookieAuth(c)
  if (!auth) throw new UnauthorizedError('Authentication required')
  c.set('auth', auth)
  await next()
})

/**
 * Who is asking on an administrative mount: a Bearer key wins over the cookie (as in
 * `authMiddleware`), and must be admin-scoped. The CALLER then applies its gate to the returned
 * context — whose `isGlobalAdmin` and role were read from the database on THIS request — so an
 * admin key is only ever as strong as its creator is right now.
 */
async function resolveAdminAuth(c: AppContext): Promise<AuthContext | null> {
  const bearer = bearerToken(c)
  if (!bearer) return resolveCookieAuth(c)
  const { auth, scope } = await resolveBearerAuth(c, bearer)
  if (scope !== 'admin') {
    throw new ForbiddenError(
      'This needs an admin API key (launch login --admin); a tenant key cannot reach it',
      ADMIN_KEY_REQUIRED_CODE
    )
  }
  return auth
}

export const globalAdminMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const auth = await resolveAdminAuth(c)
  if (!auth) throw new UnauthorizedError('Authentication required')
  if (!auth.isGlobalAdmin) throw new ForbiddenError('Global admin access required')
  c.set('auth', auth)
  await next()
})

/**
 * `/api/platform/*`: administering the Launch deployment itself — setup credentials, the OIDC
 * issuer's keys, the access-request queue. `canAdministerPlatform` decides: a global admin (with or
 * without a membership, as on `/api/admin/*`), or in `TENANCY_MODE=single` the one organisation's
 * owner or admin. A cookie session or an ADMIN-scoped key, like `globalAdminMiddleware` — a tenant
 * API key never writes a deployment-wide credential. In multi mode this is `globalAdminMiddleware`
 * exactly.
 */
export const platformAdminMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const auth = await resolveAdminAuth(c)
  if (!auth) throw new UnauthorizedError('Authentication required')
  if (!canAdministerPlatform(auth, c.get('config'))) {
    throw new ForbiddenError('Platform administrator access required')
  }
  c.set('auth', auth)
  await next()
})
