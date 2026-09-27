/**
 * `launch analytics …` — the analytics plugin's CLI half (D31, Phase C).
 *
 *   launch analytics pages list      GET  /api/analytics/pages          — the tenant's dashboards
 *   launch analytics check-facts     GET  /api/analytics/facts/status   — exit 1 when any is stale
 *   launch analytics refresh-facts   POST /api/analytics/facts/refresh  — enqueue a rebuild
 *
 * **These two replace `pnpm web db:check-facts` and `pnpm web db:refresh-facts`.** Those were
 * `tsx` scripts under `apps/web/scripts/`, which is not one of the four directories a plugin may
 * own — a plugin has to stay reversible by deleting its own trees — so they became commands over
 * routes that already existed or, for the rebuild, over one that now enqueues a job. The practical
 * differences, stated rather than hidden: both now need a logged-in CLI (or `LAUNCH_API_KEY`)
 * and a running server rather than a bare `DATABASE_URL`, both are scoped to ONE organisation
 * rather than every tenant (the cross-tenant rebuild is the `:15` cron, which has no request
 * behind it), and the rebuild is asynchronous — it returns a job id, and under `wrangler dev` the
 * consumer runs in-process so it completes within moments.
 *
 * `check-facts` keeps the old script's contract exactly: a non-zero exit when a table is stale, so
 * it still works as a health check in a pipeline.
 *
 * The CLI never owns a second copy of the contract: every response is parsed with the same
 * `@launch/shared` schema the server validated with, and it throws `CliError` rather than
 * printing an error or calling `process.exit` — it registers with the host's own `action()`
 * wrapper, so it inherits one context, one error printer and one exit-code mapping (0 · 1 · 2 · 3).
 */
import {
  ANALYTICS_PLUGIN_ID,
  analyticsPageListResponseSchema,
  analyticsRefreshFactsResponseSchema,
  analyticsShared,
  factTableStatusListResponseSchema,
} from '@launch/shared/plugins/analytics/index'
// The CLI plugin API (D31) — one declared entry, rather than four reaches into the kit's internals.
import type { CliPlugin, CommandContext } from '../api'
import { CliError, EXIT_ERROR, formatDate, renderTable, requireClient } from '../api'

export async function runAnalyticsPagesList(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/analytics/pages', {
    schema: analyticsPageListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Name', value: p => p.name },
      { header: 'Slug', value: p => p.slug },
      { header: 'Template', value: p => p.templateKey ?? '—' },
      { header: 'Visibility', value: p => p.visibility },
      { header: 'Updated', value: p => formatDate(p.updatedAt) },
    ])
  )
}

export async function runAnalyticsCheckFacts(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/analytics/facts/status', {
    schema: factTableStatusListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Table', value: f => f.table },
      { header: 'Refreshed', value: f => (f.refreshedAt ? formatDate(f.refreshedAt) : 'never') },
      { header: 'Lag (s)', value: f => String(f.lagSeconds) },
      { header: 'State', value: f => (f.stale ? 'STALE' : 'fresh') },
    ])
  )
  const stale = data.items.filter(f => f.stale)
  // Same contract as the script it replaces: a pipeline reads the exit code, not the table.
  if (stale.length > 0) {
    throw new CliError(
      `${stale.length} fact table(s) stale: ${stale.map(f => f.table).join(', ')}`,
      { exitCode: EXIT_ERROR, hint: 'run `launch analytics refresh-facts`' }
    )
  }
}

export async function runAnalyticsRefreshFacts(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('POST', '/api/analytics/facts/refresh', {
    schema: analyticsRefreshFactsResponseSchema,
  })
  ctx.out.data(raw, () => `Queued ${data.type} (${data.jobId}) at ${data.enqueuedAt}`)
}

export const analyticsCli: CliPlugin<typeof analyticsShared> = {
  shared: analyticsShared,
  register(program, action) {
    const root = program.command(ANALYTICS_PLUGIN_ID).description('dashboards and fact tables')
    const pages = root.command('pages').description('dashboards in the active tenant')
    pages
      .command('list', { isDefault: true })
      .description('list dashboards')
      .action(action(ctx => runAnalyticsPagesList(ctx)))
    root
      .command('check-facts')
      .description('fact-table freshness (exit 1 when any is stale)')
      .action(action(ctx => runAnalyticsCheckFacts(ctx)))
    root
      .command('refresh-facts')
      .description('enqueue a rebuild of this organisation’s fact tables')
      .action(action(ctx => runAnalyticsRefreshFacts(ctx)))
  },
}
