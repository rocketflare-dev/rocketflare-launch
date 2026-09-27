/**
 * Who may READ a dashboard (D29, D31) — this plugin's entry in the kit's visibility registry.
 *
 * `analytics_pages.visibility` is the DECISION and `analytics_page_groups` holds only the grants,
 * which is the whole design: deleting the last group a dashboard was shared with leaves it
 * `groups` with an EMPTY grant list, so it narrows to its creator and to admins rather than
 * publishing to the organisation. Inferring "restricted" from "has grant rows" makes that same
 * delete a silent publish.
 *
 * `predicate` is ANDed with the tenant predicate and NEVER replaces it, and it returns `undefined`
 * for an admin-level scope (`bypass`), so owner, admin, support and global admins are not narrowed.
 * A page the reader may not see answers the same 404 as one that does not exist.
 *
 * `sharedWithMyGroups` comes from `@/plugins/api`, which re-exports the LEAF half of the kit's
 * access module for exactly this import: a visibility resource needs the SQL at module scope, and
 * the composing module reads the plugin barrel.
 */
import { and, count, eq, inArray, type SQL, sql } from 'drizzle-orm'
import { groups, groupTypes } from '@/db/schema/kit'
import type { AccessScope, VisibilityResource } from '@/plugins/api'
import { sharedWithMyGroups } from '@/plugins/api'
import { analyticsPageGroups } from './db/schema/analytics-page-groups'
import { analyticsPages } from './db/schema/analytics-pages'

/** The registry key. `<id>:<thing>`, so two plugins can never claim one kind. */
export const ANALYTICS_PAGE_VISIBILITY = 'analytics:page'

export function visibleAnalyticsPages(scope: AccessScope): SQL | undefined {
  if (scope.bypass) return undefined
  const owned = scope.userId ? sql`${analyticsPages.createdByUserId} = ${scope.userId}` : sql`false`
  const shared = sharedWithMyGroups(
    scope,
    'analytics_page_groups',
    'page_id',
    sql`${analyticsPages.id}`
  )
  return sql`(${analyticsPages.visibility} = 'tenant' or ${owned} or ${shared})`
}

export const analyticsPageVisibility: VisibilityResource = {
  key: ANALYTICS_PAGE_VISIBILITY,
  noun: 'dashboard',
  usageKey: 'dashboards',
  predicate: visibleAnalyticsPages,
  setGroups: async (tx, tenantId, resourceId, input, groupIds) => {
    await tx
      .update(analyticsPages)
      .set({ visibility: input.visibility })
      .where(and(eq(analyticsPages.id, resourceId), eq(analyticsPages.tenantId, tenantId)))
    await tx
      .delete(analyticsPageGroups)
      .where(
        and(eq(analyticsPageGroups.tenantId, tenantId), eq(analyticsPageGroups.pageId, resourceId))
      )
    if (groupIds.length > 0) {
      await tx
        .insert(analyticsPageGroups)
        .values(groupIds.map(groupId => ({ tenantId, pageId: resourceId, groupId })))
        .onConflictDoNothing()
    }
  },
  grantRows: (db, tenantId, resourceIds) =>
    db
      .select({
        resourceId: analyticsPageGroups.pageId,
        id: groups.id,
        name: groups.name,
        typeName: groupTypes.name,
      })
      .from(analyticsPageGroups)
      .innerJoin(groups, eq(groups.id, analyticsPageGroups.groupId))
      .innerJoin(groupTypes, eq(groupTypes.id, groups.groupTypeId))
      .where(
        and(
          eq(analyticsPageGroups.tenantId, tenantId),
          inArray(analyticsPageGroups.pageId, resourceIds)
        )
      ),
  countGrants: async (db, tenantId, groupIds) => {
    const [row] = await db
      .select({ n: count() })
      .from(analyticsPageGroups)
      .where(
        and(
          eq(analyticsPageGroups.tenantId, tenantId),
          inArray(analyticsPageGroups.groupId, groupIds)
        )
      )
    return row?.n ?? 0
  },
}
