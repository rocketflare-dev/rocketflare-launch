/**
 * The analytics plugin's two host hooks (D31): what a NEW organisation gets, and what the demo
 * seed adds. Both are post-commit, idempotent and best-effort, exactly like the kit's own — a
 * plugin hook must never be able to break somebody's sign-up.
 *
 * Note what `HookCtx` does NOT carry: a logger, an `env`, a way to enqueue or nudge. A hook runs at
 * somebody else's transaction boundary and has no business doing any of that — if it needs to, it
 * is not a hook. `SeedCtx`'s `demoId` arrives already namespaced with this plugin's id.
 */
import { and, eq, ne } from 'drizzle-orm'
import { activityEvents, groups, tenants } from '@/db/schema/kit'
import type { HookCtx, SeedCtx } from '@/plugins/api'
import { analyticsPageGroups } from '../db/schema/analytics-page-groups'
import { analyticsPages } from '../db/schema/analytics-pages'
import { ensureDefaultDashboards } from '../services/dashboard-templates'
import { refreshAllFactTables } from '../services/fact-tables'

/**
 * Seed a new organisation's template dashboards (D19). The lazy repair path is what makes a
 * swallowed failure here survivable: `GET /api/analytics/pages` calls `ensureDefaultDashboards`
 * on every read, idempotently through `(tenant_id, slug)`, so a tenant with no pages gets them on
 * first view — and so does one created before a template existed.
 *
 * `features` is the set this deployment ships (D30). It matters here more than anywhere: this is a
 * gate that CREATES rows, so a template belonging to a dark feature must not be copied into a new
 * organisation at all. A flag mid-rollout resolves false here — the tenant it would be bucketed on
 * does not exist yet — and its page arrives on that tenant's first `GET /api/analytics/pages`
 * instead, through the same lazy path.
 */
export async function onTenantCreated({ db, tenantId, userId, features }: HookCtx): Promise<void> {
  await ensureDefaultDashboards(db, tenantId, userId, features)
}

/**
 * The demo workspace's analytics (`pnpm seed --demo`). Fixed ids through `demoId` and
 * `onConflictDoNothing`, so re-running adds nothing.
 *
 * It reads the kit's demo rows rather than being handed them: the Finance group by NAME, the
 * sibling organisations as "every other tenant". A hook is given `{ tenantId, ownerId }` and has
 * to find the rest itself, which is the right way round — the host cannot carry every plugin's
 * dependencies in one context object, and a query that finds nothing simply seeds less.
 */
export async function seedDemo(ctx: SeedCtx): Promise<void> {
  const { db, tenantId, ownerId, demoId, log } = ctx

  await ensureDefaultDashboards(db, tenantId, ownerId)
  const siblings = await db.select({ id: tenants.id }).from(tenants).where(ne(tenants.id, tenantId))
  for (const sibling of siblings) await ensureDefaultDashboards(db, sibling.id, null)

  const [overview] = await db
    .select()
    .from(analyticsPages)
    .where(and(eq(analyticsPages.tenantId, tenantId), eq(analyticsPages.slug, 'tenant-overview')))
    .limit(1)

  // A user-created page restricted to Finance. Template pages stay tenant-wide on purpose — they
  // are seeded for every tenant and resetting one must never change who can see it.
  const [finance] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.tenantId, tenantId), eq(groups.name, 'Finance')))
    .limit(1)

  const financePageId = demoId('page:finance')
  if (finance) {
    await db
      .insert(analyticsPages)
      .values({
        id: financePageId,
        tenantId,
        slug: 'finance-review',
        name: 'Finance review',
        description: 'Restricted to the Finance department.',
        templateKey: null,
        config: (overview?.config ?? { layoutMode: 'rows', rows: [], portlets: [] }) as never,
        sortOrder: 200,
        createdByUserId: ownerId,
        visibility: 'groups',
      })
      .onConflictDoNothing()
    await db
      .insert(analyticsPageGroups)
      .values({ tenantId, pageId: financePageId, groupId: finance.id })
      .onConflictDoNothing()
  }

  // One activity row, so the demo's Activity page and the `ActivityEvents` cube have a dashboard
  // event in them — it is the kit's own row, which moved here with the rest of analytics.
  if (overview) {
    await db
      .insert(activityEvents)
      .values({
        id: demoId('activity:dashboard-created'),
        tenantId,
        userId: ownerId,
        type: 'dashboard.created',
        subjectType: 'Dashboard',
        subjectId: overview.id,
        metadata: { name: overview.name },
        createdAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000 - 4 * 60 * 60 * 1000),
      })
      .onConflictDoNothing()
  }

  // Last, so the rebuild sees every activity row the kit's demo block wrote, and this one.
  const refreshed = await refreshAllFactTables(db)
  const rows = refreshed.results.reduce((n, r) => n + r.rows, 0)
  log(
    `dashboards for ${siblings.length + 1} organisation(s)${finance ? ' + 1 restricted page' : ''}; ` +
      `${rows} fact row(s) across ${refreshed.results.length} table(s)`
  )
}
