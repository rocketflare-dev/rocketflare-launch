/**
 * The cube security context (D19, D31) — the ONLY bridge between the request and cube SQL.
 *
 * **It is built in the ROUTE and passed down, and that is the migration's one real shape change.**
 * `createCubeApp` calls `extractSecurityContext` per query, from inside drizzle-cube, where no Hono
 * context exists — so the old spelling (`c.get('auth')` in a library callback) was reaching for a
 * request that had already gone. `RequestCtx` is deliberately not widened to work outside a
 * handler; `ctx.detached()` is the kit's answer, and this file consumes it.
 *
 * Every cube's `sql()` then scopes its base query with `tenantIdOf(ctx)`. The route is mounted
 * behind the kit's auth middleware, so a missing tenant here is a wiring bug, not an expected
 * path — it throws.
 */
import type { QueryContext, SecurityContext } from 'drizzle-cube/server'
import { inArray, type SQL, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { DetachedCtx } from '@/plugins/api'

export interface AnalyticsSecurityContext extends SecurityContext {
  tenantId: string
  userId: string
  /** Membership role; `null` never reaches a cube (no tenant → 403 before the cube app runs). */
  role: string | null
  /** D29 — every group this person is in, by id. What `groupFilter` matches on. */
  groupIds: string[]
  /** The same groups by TYPE name (`{ Department: ['Finance'] }`) — for readability, not matching. */
  groups: Record<string, string[]>
  /** Ids by type name — what `groupFilter` narrows on, because a rename must not move rows. */
  groupIdsByType: Record<string, string[]>
  /** Admin-level readers are not narrowed by `groupFilter`. */
  isAdmin: boolean
}

export class AnalyticsAuthError extends Error {
  constructor(message = 'Authentication required for analytics access') {
    super(message)
    this.name = 'AnalyticsAuthError'
  }
}

/**
 * One of the reader's groups, with the name of the TYPE it belongs to — structurally the kit's
 * `GroupRef`, named here because it is what the pure builder below takes.
 */
export interface GroupTypeRef {
  id: string
  name: string
  typeName: string
}

/** What the context carries about who is asking — the half of `DetachedCtx` a cube may read. */
export type CubeReader = Pick<DetachedCtx, 'tenantId' | 'userId' | 'role' | 'isAdmin'>

/**
 * Build the security context from a detached context and the reader's resolved groups. Pure, so
 * the shape is unit-tested without a database or a request.
 */
export function analyticsSecurityContext(
  reader: CubeReader,
  memberships: readonly GroupTypeRef[] = []
): AnalyticsSecurityContext {
  if (!reader.tenantId) throw new AnalyticsAuthError()
  const groupNames: Record<string, string[]> = {}
  const groupIdsByType: Record<string, string[]> = {}
  for (const group of memberships) {
    groupNames[group.typeName] = [...(groupNames[group.typeName] ?? []), group.name]
    groupIdsByType[group.typeName] = [...(groupIdsByType[group.typeName] ?? []), group.id]
  }
  return {
    tenantId: reader.tenantId,
    userId: reader.userId,
    role: reader.role,
    groupIds: memberships.map(g => g.id),
    groups: groupNames,
    groupIdsByType,
    isAdmin: reader.isAdmin,
  }
}

/**
 * The whole bridge, for the route: a detached context in, a security context out. **Pure, and no
 * longer a query.**
 *
 * `groupFilter` narrows by group TYPE, so the names have to come from somewhere, and `AccessScope`
 * carries ids alone. This used to resolve them with one query per cube request; kit 0.7.0 puts them
 * on the context as `ctx.groups`, already resolved in the session's own LATERAL query, so there is
 * nothing left to read. An admin-level reader is never narrowed by `groupFilter` at all, so their
 * memberships are not even mapped.
 */
export function buildSecurityContext(ctx: DetachedCtx): AnalyticsSecurityContext {
  return analyticsSecurityContext(ctx, ctx.isAdmin ? [] : ctx.groups)
}

/**
 * Narrow a cube's rows to the reader's groups of one TYPE (D29) — the pattern an app uses when its
 * own fact table carries a group dimension. No kit cube uses it, because no kit table has one.
 *
 *   sql: ctx => ({
 *     from: orders,
 *     where: and(eq(orders.tenantId, tenantIdOf(ctx)), groupFilter(ctx, 'Department', orders.departmentGroupId)),
 *   })
 *
 * Three behaviours, and the third is the important one:
 *   - admin-level reader → `undefined`, i.e. no narrowing at all;
 *   - reader with groups of that type → `column in (...their ids)`;
 *   - reader with NO group of that type → **`false`**, so they see nothing rather than everything.
 *
 * That last case is why this matches on IDS: matching on group NAMES means renaming a group
 * silently changes which rows a person sees, with nothing to catch it. Names are in the context
 * for labels and debugging.
 */
export function groupFilter(
  ctx: QueryContext,
  typeName: string,
  column: AnyPgColumn
): SQL | undefined {
  const security = ctx.securityContext as Partial<AnalyticsSecurityContext>
  if (security.isAdmin) return undefined
  const ids = security.groupIdsByType?.[typeName] ?? []
  if (ids.length === 0) return sql`false`
  return inArray(column, ids)
}

/**
 * The tenant every cube filters by. Cubes call this instead of reading `securityContext.tenantId`
 * directly so a context without a tenant fails loudly instead of compiling `tenant_id = NULL`
 * (which would match nothing — safe, but silent).
 */
export function tenantIdOf(ctx: QueryContext): string {
  const tenantId = ctx.securityContext.tenantId
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new AnalyticsAuthError('Cube query without a tenant in the security context')
  }
  return tenantId
}
