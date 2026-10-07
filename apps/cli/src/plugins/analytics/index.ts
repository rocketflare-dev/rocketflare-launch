/**
 * `launch analytics …` — the analytics plugin's CLI half (D31, Phase C).
 *
 *   launch analytics pages list      GET  /api/analytics/pages          — the tenant's dashboards
 *   launch analytics check-facts     GET  /api/analytics/facts/status   — exit 1 when any is stale
 *   launch analytics refresh-facts   POST /api/analytics/facts/refresh  — enqueue a rebuild
 *
 * Dashboards from a terminal (issue #6), `manage Dashboard` = admin+ for every write:
 *
 *   pages show <id|slug>            GET    /api/analytics/pages/:id   (`--json` = the config too)
 *   pages create --name [--data]    POST   /api/analytics/pages       (config from `--data`)
 *   pages update <id|slug> …        PATCH  /api/analytics/pages/:id   (name, description, order,
 *                                                                     default; config via --data)
 *   pages visibility <id|slug>      PUT    /pages/:id/visibility      (--tenant | --groups ids)
 *   pages reset <id|slug>           POST   /pages/:id/reset           (asks; template pages only)
 *   pages rm <id|slug>              DELETE /pages/:id                 (asks; a template is 403)
 *   templates list                  GET    /api/analytics/templates
 *   templates recreate              POST   /templates/recreate        (asks)
 *
 * Querying the cubes is `/cubejs-api` — drizzle-cube's own contract, used through its client or
 * `curl`.
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
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import {
  ANALYTICS_PLUGIN_ID,
  type AnalyticsPage,
  analyticsPageListResponseSchema,
  analyticsPageSchema,
  analyticsRefreshFactsResponseSchema,
  analyticsShared,
  createAnalyticsPageRequestSchema,
  dashboardTemplateListResponseSchema,
  factTableStatusListResponseSchema,
  recreateTemplatesResponseSchema,
  setDashboardVisibilityRequestSchema,
  updateAnalyticsPageRequestSchema,
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

// ---- dashboards: show / create / visibility / reset / rm / templates (issue #6) ---------------

const pagePath = (id: string) => `/api/analytics/pages/${encodeURIComponent(id)}`
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A dashboard by id, or by slug through the list (the page's own URL uses the slug). */
async function resolvePage(ctx: CommandContext, ref: string): Promise<AnalyticsPage> {
  const client = requireClient(ctx)
  if (UUID_RE.test(ref)) return client.get(pagePath(ref), { schema: analyticsPageSchema })
  const { items } = await client.get('/api/analytics/pages', {
    schema: analyticsPageListResponseSchema,
  })
  const page = items.find(p => p.slug === ref)
  if (!page) {
    throw new CliError(`No dashboard "${ref}"`, {
      hint: 'Dashboards: `launch analytics pages list`.',
    })
  }
  return page
}

function accessLabel(p: AnalyticsPage): string {
  if (p.visibility === 'tenant') return 'everyone'
  return p.groups.length ? p.groups.map(g => g.name).join(', ') : 'only its creator and admins'
}

function invalid(
  what: string,
  error: { issues: { path: (string | number)[]; message: string }[] }
): CliError {
  const lines = error.issues.map(i => `  ${i.path.join('.') || '(body)'}: ${i.message}`)
  return new CliError(`Invalid ${what}:\n${lines.join('\n')}`, { exitCode: EXIT_ERROR })
}

/** Injectable seams for tests. */
export interface AnalyticsSeams {
  confirm?: (question: string) => Promise<boolean>
  readStdin?: () => Promise<string>
  readFile?: (path: string) => Promise<string>
}

async function confirmed(question: string, options: AnalyticsSeams & { yes?: boolean }) {
  if (options.yes) return true
  const ask =
    options.confirm ??
    (process.stdin.isTTY
      ? async (q: string) => {
          const rl = createInterface({ input: process.stdin, output: process.stderr })
          try {
            return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim())
          } finally {
            rl.close()
          }
        }
      : undefined)
  if (!ask) throw new CliError('Refusing without confirmation', { hint: 'Re-run with --yes.' })
  return ask(question)
}

async function readJsonArg(value: string, seams: AnalyticsSeams): Promise<unknown> {
  let text = value
  if (value === '-') {
    text = seams.readStdin
      ? await seams.readStdin()
      : await (async () => {
          const chunks: Buffer[] = []
          for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
          return Buffer.concat(chunks).toString('utf8')
        })()
  } else if (value.startsWith('@')) {
    text = await (seams.readFile ?? (p => readFile(p, 'utf8')))(value.slice(1))
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CliError(`--data is not JSON: ${(error as Error).message}`, {
      hint: 'Pass inline JSON, @file.json, or - for stdin.',
    })
  }
}

export async function runAnalyticsPageShow(ctx: CommandContext, ref: string): Promise<void> {
  const page = await resolvePage(ctx, ref)
  ctx.out.data(page, () => {
    const portlets = page.config.portlets
    return [
      `${page.name}  (${page.slug})`,
      page.description ?? '',
      `id ${page.id} · ${page.templateKey ? `template ${page.templateKey}` : 'user-created'}` +
        `${page.isDefault ? ' · default' : ''} · visible to ${accessLabel(page)} · updated ${formatDate(page.updatedAt)}`,
      '',
      renderTable(portlets, [
        { header: 'Portlet', value: p => String(p.title ?? p.id ?? '') },
        { header: 'Chart', value: p => String(p.chartType ?? '') },
      ]),
    ]
      .filter((line, i) => i !== 1 || line)
      .join('\n')
  })
}

export interface AnalyticsPageCreateOptions extends AnalyticsSeams {
  name?: string
  description?: string
  data?: string
}

export async function runAnalyticsPageCreate(
  ctx: CommandContext,
  options: AnalyticsPageCreateOptions
): Promise<void> {
  const base = options.data !== undefined ? await readJsonArg(options.data, options) : {}
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    throw new CliError('--data must be one JSON object (name, description, config, order)')
  }
  const draft: Record<string, unknown> = { ...base }
  if (options.name !== undefined) draft.name = options.name
  if (options.description !== undefined) draft.description = options.description
  const parsed = createAnalyticsPageRequestSchema.safeParse(draft)
  if (!parsed.success) throw invalid('dashboard', parsed.error)
  const { data, raw } = await requireClient(ctx).request('POST', '/api/analytics/pages', {
    schema: analyticsPageSchema,
    body: parsed.data,
  })
  ctx.out.data(raw, () => `Created "${data.name}" (${data.slug}, ${data.id})`)
}

export interface AnalyticsPageUpdateOptions extends AnalyticsSeams {
  name?: string
  description?: string
  order?: string
  default?: boolean
  data?: string
}

export async function runAnalyticsPageUpdate(
  ctx: CommandContext,
  ref: string,
  options: AnalyticsPageUpdateOptions
): Promise<void> {
  const base = options.data !== undefined ? await readJsonArg(options.data, options) : {}
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    throw new CliError(
      '--data must be one JSON object (name, description, config, order, isDefault)'
    )
  }
  const draft: Record<string, unknown> = { ...base }
  if (options.name !== undefined) draft.name = options.name
  if (options.description !== undefined) {
    draft.description = options.description === '' ? null : options.description
  }
  if (options.order !== undefined) draft.order = Number(options.order)
  if (options.default !== undefined) draft.isDefault = options.default
  const parsed = updateAnalyticsPageRequestSchema.safeParse(draft)
  if (!parsed.success) throw invalid('change', parsed.error)
  const page = await resolvePage(ctx, ref)
  const { data, raw } = await requireClient(ctx).request('PATCH', pagePath(page.id), {
    schema: analyticsPageSchema,
    body: parsed.data,
  })
  ctx.out.data(raw, () => `Updated "${data.name}" (${Object.keys(parsed.data).join(', ')})`)
}

export interface AnalyticsPageVisibilityOptions {
  tenant?: boolean
  groups?: string
}

export async function runAnalyticsPageVisibility(
  ctx: CommandContext,
  ref: string,
  options: AnalyticsPageVisibilityOptions
): Promise<void> {
  if (Boolean(options.tenant) === (options.groups !== undefined)) {
    throw new CliError('Give exactly one of --tenant or --groups <id,…>')
  }
  const groupIds = (options.groups ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const parsed = setDashboardVisibilityRequestSchema.safeParse(
    options.tenant ? { visibility: 'tenant' } : { visibility: 'groups', groupIds }
  )
  if (!parsed.success) throw invalid('visibility', parsed.error)
  const page = await resolvePage(ctx, ref)
  const { data, raw } = await requireClient(ctx).request('PUT', `${pagePath(page.id)}/visibility`, {
    schema: analyticsPageSchema,
    body: parsed.data,
  })
  ctx.out.data(raw, () => `"${data.name}" is visible to ${accessLabel(data)}.`)
}

export async function runAnalyticsPageReset(
  ctx: CommandContext,
  ref: string,
  options: AnalyticsSeams & { yes?: boolean } = {}
): Promise<void> {
  const page = await resolvePage(ctx, ref)
  if (!page.templateKey) {
    throw new CliError(`"${page.name}" was not made from a template, so it has nothing to reset to`)
  }
  const question = `"${page.name}" goes back to its template layout. Portlets added or changed on this dashboard are lost.`
  if (!(await confirmed(question, options))) {
    ctx.out.text('Nothing reset.')
    return
  }
  const { data, raw } = await requireClient(ctx).request('POST', `${pagePath(page.id)}/reset`, {
    schema: analyticsPageSchema,
  })
  ctx.out.data(raw, () => `Reset "${data.name}" to its template.`)
}

export async function runAnalyticsPageRemove(
  ctx: CommandContext,
  ref: string,
  options: AnalyticsSeams & { yes?: boolean } = {}
): Promise<void> {
  const page = await resolvePage(ctx, ref)
  if (page.templateKey) {
    throw new CliError('Template dashboards cannot be deleted — reset them instead', {
      hint: `launch analytics pages reset ${page.slug}`,
    })
  }
  if (!(await confirmed(`Delete "${page.name}"? This cannot be undone.`, options))) {
    ctx.out.text('Nothing deleted.')
    return
  }
  await requireClient(ctx).request('DELETE', pagePath(page.id))
  ctx.out.data({ deleted: page.id }, () => `Deleted "${page.name}".`)
}

export async function runAnalyticsTemplatesList(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/analytics/templates', {
    schema: dashboardTemplateListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Key', value: t => t.key },
      { header: 'Name', value: t => t.name },
      { header: 'Description', value: t => t.description },
    ])
  )
}

export async function runAnalyticsTemplatesRecreate(
  ctx: CommandContext,
  options: AnalyticsSeams & { yes?: boolean } = {}
): Promise<void> {
  const question =
    'Missing template dashboards are created and existing ones are reset to their template. Edits made to template dashboards are lost; user-created dashboards are untouched.'
  if (!(await confirmed(`${question} Recreate?`, options))) {
    ctx.out.text('Nothing changed.')
    return
  }
  const { data, raw } = await requireClient(ctx).request(
    'POST',
    '/api/analytics/templates/recreate',
    { schema: recreateTemplatesResponseSchema }
  )
  ctx.out.data(raw, () => `Created ${data.created} and reset ${data.reset} template dashboard(s).`)
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
    pages
      .command('show <id|slug>')
      .description('one dashboard: who sees it and its portlets (--json: the config)')
      .action(action((ctx, cmd) => runAnalyticsPageShow(ctx, cmd.args[0] ?? '')))
    pages
      .command('create')
      .description('create a dashboard (admin+); --data carries a config')
      .option('--name <name>', 'its name')
      .option('--description <text>', 'a description')
      .option('--data <json|@file|->', 'the body as JSON: name, description, config, order')
      .action(action((ctx, cmd) => runAnalyticsPageCreate(ctx, cmd.opts())))
    pages
      .command('update <id|slug>')
      .description('change a dashboard (admin+); --data carries a config')
      .option('--name <name>', 'its name')
      .option('--description <text>', 'a description ("" clears it)')
      .option('--order <n>', 'its position in the list')
      .option('--default', 'make it the default dashboard')
      .option('--no-default', 'stop it being the default')
      .option(
        '--data <json|@file|->',
        'the change as JSON: name, description, config, order, isDefault'
      )
      .action(action((ctx, cmd) => runAnalyticsPageUpdate(ctx, cmd.args[0] ?? '', cmd.opts())))
    pages
      .command('visibility <id|slug>')
      .description('who may open a dashboard: everyone, or only some groups')
      .option('--tenant', 'everyone in the organisation')
      .option('--groups <ids>', 'only these group ids (comma-separated)')
      .action(action((ctx, cmd) => runAnalyticsPageVisibility(ctx, cmd.args[0] ?? '', cmd.opts())))
    pages
      .command('reset <id|slug>')
      .description('put a template dashboard back to its template (asks first)')
      .option('-y, --yes', 'do not ask for confirmation')
      .action(action((ctx, cmd) => runAnalyticsPageReset(ctx, cmd.args[0] ?? '', cmd.opts())))
    pages
      .command('rm <id|slug>')
      .description('delete a dashboard you created (asks first)')
      .option('-y, --yes', 'do not ask for confirmation')
      .action(action((ctx, cmd) => runAnalyticsPageRemove(ctx, cmd.args[0] ?? '', cmd.opts())))
    const templates = root.command('templates').description('the template dashboards')
    templates
      .command('list', { isDefault: true })
      .description('the templates every organisation gets')
      .action(action(ctx => runAnalyticsTemplatesList(ctx)))
    templates
      .command('recreate')
      .description('create missing template dashboards and reset the others (asks first)')
      .option('-y, --yes', 'do not ask for confirmation')
      .action(action((ctx, cmd) => runAnalyticsTemplatesRecreate(ctx, cmd.opts())))
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
