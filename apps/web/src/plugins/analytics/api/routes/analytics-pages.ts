/**
 * `/api/analytics` (D19, D31): dashboard pages, templates and fact-table status.
 *   GET    /pages            every member; ensures the tenant's template pages exist, then lists
 *                            only the ones this reader may SEE (D29 — template pages are
 *                            tenant-wide, so nothing changes until somebody restricts a page)
 *   POST   /pages            manage Dashboard (admin+) — user-created page, slug from the name
 *   GET    /pages/:id        every member
 *   PATCH  /pages/:id        manage Dashboard — name / description / config / order / isDefault
 *   DELETE /pages/:id        manage Dashboard — user-created pages only (template pages would be
 *                            re-created by the next list, so deleting one is refused: 403 `template_page`)
 *   POST   /pages/:id/reset  manage Dashboard — template pages back to their template
 *   GET    /templates        every member — `{ key, name, description }[]`
 *   POST   /templates/recreate  manage Dashboard — create missing + reset existing template pages
 *   PUT    /pages/:id/visibility  manage Dashboard — tenant-wide or a set of groups
 *   GET    /facts/status     admin+ — fact-table freshness
 *   POST   /facts/refresh    admin+ — enqueue a rebuild of THIS organisation's fact tables, 202
 *
 * A plugin route is a kit route in every respect — `createRouter()`, `validate()` with a contract
 * from this plugin's own shared entry, an authorisation check, a tenant predicate on every query,
 * typed errors rather than hand-rolled JSON. What differs is only where it is REGISTERED
 * (`ServerPlugin.mounts`) and how it reaches the kit: through `requestCtx(c)` rather than through
 * nine imports of kit internals.
 *
 * **`ctx` carries an explicit `: RequestCtx` annotation on purpose.** The error helpers return
 * `never` and throw, so `if (!row) ctx.notFound(...)` leaves `row` non-null on the next line — but
 * TypeScript applies never-return narrowing only when the call target is explicitly annotated.
 * `const ctx = requestCtx(c)` is inferred, and the guard would still throw while the compiler went
 * on believing the row may be undefined.
 *
 * Group membership grants READ only: editing a dashboard stays `manage Dashboard` (admin+), exactly
 * as before Groups existed. The cube data behind a page is served by `/cubejs-api` with its own
 * `read Analytics` guard.
 */

import { type SetVisibilityRequest, setVisibilityRequestSchema } from '@launch/shared/groups'
import {
  ANALYTICS_DASHBOARDS_ENTITY,
  ANALYTICS_REFRESH_FACTS_JOB,
  type CreateAnalyticsPageRequest,
  createAnalyticsPageRequestSchema,
  DASHBOARD_SUBJECT,
  type UpdateAnalyticsPageRequest,
  updateAnalyticsPageRequestSchema,
} from '@launch/shared/plugins/analytics/index'
import type { DashboardConfig } from 'drizzle-cube/client'
import { and, asc, eq } from 'drizzle-orm'
import type { RequestCtx } from '@/plugins/api'
import { createRouter, recordActivity, requestCtx, validate } from '@/plugins/api'
import { listTemplates } from '../../dashboards'
import { analyticsPages } from '../../db/schema'
import {
  ensureDefaultDashboards,
  recreateTemplates,
  resetToTemplate,
  toAnalyticsPageDto,
  uniquePageSlug,
} from '../../services/dashboard-templates'
import { checkFactTableFreshness } from '../../services/fact-tables'
import { ANALYTICS_PAGE_VISIBILITY, visibleAnalyticsPages } from '../../visibility'

/** What a user-created page starts as: an empty rows-mode dashboard the editor can fill. */
const EMPTY_DASHBOARD: DashboardConfig = { layoutMode: 'rows', rows: [], portlets: [] }

/** Admin-level, and said once so the two fact routes cannot drift apart. */
function guardFactTables(ctx: RequestCtx, action: string): void {
  if (!ctx.isAdmin) ctx.forbidden(`Only admins can ${action}`)
}
export const analyticsPagesRouter = createRouter()

analyticsPagesRouter.get('/pages', async c => {
  const ctx: RequestCtx = requestCtx(c)
  await ensureDefaultDashboards(ctx.db, ctx.tenantId, ctx.userId, ctx.features)
  const rows = await ctx.db
    .select()
    .from(analyticsPages)
    .where(and(eq(analyticsPages.tenantId, ctx.tenantId), visibleAnalyticsPages(ctx.scope)))
    .orderBy(asc(analyticsPages.sortOrder), asc(analyticsPages.name))
  const grants = await ctx.visibility.grantsFor(
    ANALYTICS_PAGE_VISIBILITY,
    rows.map(r => r.id)
  )
  return c.json({ items: rows.map(row => toAnalyticsPageDto(row, grants.get(row.id) ?? [])) })
})

analyticsPagesRouter.post('/pages', validate('json', createAnalyticsPageRequestSchema), async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('manage', DASHBOARD_SUBJECT)
  const body = ctx.valid<CreateAnalyticsPageRequest>('json')
  const [row] = await ctx.db
    .insert(analyticsPages)
    .values({
      tenantId: ctx.tenantId,
      slug: await uniquePageSlug(ctx.db, ctx.tenantId, body.name),
      name: body.name,
      description: body.description ?? null,
      templateKey: null,
      config: (body.config as unknown as DashboardConfig | undefined) ?? EMPTY_DASHBOARD,
      sortOrder: body.order ?? 100,
      createdByUserId: ctx.userId,
    })
    .returning()
  if (!row) throw new Error('analytics page insert returned no row')
  ctx.defer(() =>
    recordActivity(ctx.db, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      type: 'dashboard.created',
      subjectType: 'Dashboard',
      subjectId: row.id,
      metadata: { name: row.name },
    })
  )
  return c.json(toAnalyticsPageDto(row), 201)
})

analyticsPagesRouter.get('/pages/:id', async c => {
  const ctx: RequestCtx = requestCtx(c)
  const id = ctx.uuid('id')
  // `select()`, not the relational query builder: it renames the table it selects from, and the
  // visibility predicate is raw SQL naming `analytics_pages`.
  const [row] = await ctx.db
    .select()
    .from(analyticsPages)
    .where(
      and(
        eq(analyticsPages.id, id),
        eq(analyticsPages.tenantId, ctx.tenantId),
        visibleAnalyticsPages(ctx.scope)
      )
    )
    .limit(1)
  // A dashboard this reader may not see is the SAME 404 as one that does not exist.
  if (!row) ctx.notFound('Dashboard not found')
  return c.json(
    toAnalyticsPageDto(
      row,
      (await ctx.visibility.grantsFor(ANALYTICS_PAGE_VISIBILITY, [id])).get(id) ?? []
    )
  )
})

/**
 * Who may read this dashboard. `manage Dashboard` (admin+), like every other write here — group
 * membership grants READ only, so a member who can see a page still cannot re-share it.
 */
analyticsPagesRouter.put(
  '/pages/:id/visibility',
  validate('json', setVisibilityRequestSchema),
  async c => {
    const ctx: RequestCtx = requestCtx(c)
    ctx.guard('manage', DASHBOARD_SUBJECT)
    const id = ctx.uuid('id')
    const [row] = await ctx.db
      .select({ id: analyticsPages.id })
      .from(analyticsPages)
      .where(and(eq(analyticsPages.id, id), eq(analyticsPages.tenantId, ctx.tenantId)))
      .limit(1)
    if (!row) ctx.notFound('Dashboard not found')
    // The kit's own helpers, through the registry entry this plugin declared: `resolve` refuses a
    // group outside this tenant and, for a plain member, one they are not in (403
    // `group_not_yours`); `set` writes the column and replaces the grants in one transaction.
    const requested = await ctx.visibility.resolve(ctx.valid<SetVisibilityRequest>('json'))
    await ctx.visibility.set(ANALYTICS_PAGE_VISIBILITY, id, requested)
    ctx.defer(() =>
      recordActivity(ctx.db, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        type: 'dashboard.visibility_changed',
        subjectType: 'Dashboard',
        subjectId: id,
        metadata: { visibility: requested.visibility, groupIds: requested.groupIds },
      })
    )
    // The entity string IS this plugin's query-key family root, so everyone in the tenant
    // re-queries and the socket wiring costs no hook-side code (D8).
    ctx.nudge(ANALYTICS_DASHBOARDS_ENTITY, id)
    const [updated] = await ctx.db
      .select()
      .from(analyticsPages)
      .where(and(eq(analyticsPages.id, id), eq(analyticsPages.tenantId, ctx.tenantId)))
      .limit(1)
    if (!updated) ctx.notFound('Dashboard not found')
    return c.json(
      toAnalyticsPageDto(
        updated,
        (await ctx.visibility.grantsFor(ANALYTICS_PAGE_VISIBILITY, [id])).get(id) ?? []
      )
    )
  }
)

analyticsPagesRouter.patch(
  '/pages/:id',
  validate('json', updateAnalyticsPageRequestSchema),
  async c => {
    const ctx: RequestCtx = requestCtx(c)
    ctx.guard('manage', DASHBOARD_SUBJECT)
    const id = ctx.uuid('id')
    const patch = ctx.valid<UpdateAnalyticsPageRequest>('json')
    const [row] = await ctx.db
      .update(analyticsPages)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.config !== undefined && { config: patch.config as unknown as DashboardConfig }),
        ...(patch.order !== undefined && { sortOrder: patch.order }),
        ...(patch.isDefault !== undefined && { isDefault: patch.isDefault }),
      })
      .where(and(eq(analyticsPages.id, id), eq(analyticsPages.tenantId, ctx.tenantId)))
      .returning()
    if (!row) ctx.notFound('Dashboard not found')
    ctx.defer(() =>
      recordActivity(ctx.db, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        type: 'dashboard.updated',
        subjectType: 'Dashboard',
        subjectId: row.id,
        metadata: { fields: Object.keys(patch) },
      })
    )
    return c.json(toAnalyticsPageDto(row))
  }
)

analyticsPagesRouter.delete('/pages/:id', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('manage', DASHBOARD_SUBJECT)
  const id = ctx.uuid('id')
  const [row] = await ctx.db
    .select({
      id: analyticsPages.id,
      name: analyticsPages.name,
      templateKey: analyticsPages.templateKey,
    })
    .from(analyticsPages)
    .where(and(eq(analyticsPages.id, id), eq(analyticsPages.tenantId, ctx.tenantId)))
    .limit(1)
  if (!row) ctx.notFound('Dashboard not found')
  if (row.templateKey) {
    ctx.forbidden('Template dashboards cannot be deleted — reset them instead', 'template_page')
  }
  await ctx.db.delete(analyticsPages).where(eq(analyticsPages.id, id))
  ctx.defer(() =>
    recordActivity(ctx.db, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      type: 'dashboard.deleted',
      subjectType: 'Dashboard',
      subjectId: id,
      metadata: { name: row.name },
    })
  )
  return c.body(null, 204)
})

analyticsPagesRouter.post('/pages/:id/reset', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('manage', DASHBOARD_SUBJECT)
  const row = await resetToTemplate(ctx, ctx.uuid('id'))
  ctx.defer(() =>
    recordActivity(ctx.db, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      type: 'dashboard.reset',
      subjectType: 'Dashboard',
      subjectId: row.id,
      metadata: { templateKey: row.templateKey },
    })
  )
  return c.json(toAnalyticsPageDto(row))
})

analyticsPagesRouter.get('/templates', c => {
  const ctx: RequestCtx = requestCtx(c)
  return c.json({
    items: listTemplates(ctx.features).map(t => ({
      key: t.key,
      name: t.name,
      description: t.description,
    })),
  })
})

analyticsPagesRouter.post('/templates/recreate', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('manage', DASHBOARD_SUBJECT)
  return c.json(await recreateTemplates(ctx.db, ctx.tenantId, ctx.userId, ctx.features))
})

analyticsPagesRouter.get('/facts/status', async c => {
  const ctx: RequestCtx = requestCtx(c)
  guardFactTables(ctx, 'read fact-table status')
  return c.json({ items: await checkFactTableFreshness(ctx.db) })
})

/**
 * Rebuild this organisation's fact tables now, out of band (D31). It ENQUEUES — a route never runs
 * long work, and a rebuild is a full DELETE+INSERT per table per tenant. The `:15` cron is still
 * the normal path; this is what `pnpm web db:refresh-facts` used to be before analytics left the
 * kit and took its scripts with it, and what `launch analytics refresh-facts` calls.
 *
 * Admin-level, and scoped to the CALLER's tenant by the context rather than by anything in the
 * body: the cross-tenant rebuild has no request behind it and lives in the cron.
 */
analyticsPagesRouter.post('/facts/refresh', async c => {
  const ctx: RequestCtx = requestCtx(c)
  guardFactTables(ctx, 'rebuild fact tables')
  const job = await ctx.enqueue({
    type: ANALYTICS_REFRESH_FACTS_JOB,
    payload: { tenantId: ctx.tenantId },
  })
  return c.json({ jobId: job.id, type: job.type, enqueuedAt: job.enqueuedAt }, 202)
})
