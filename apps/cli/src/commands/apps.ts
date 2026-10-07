/**
 * `launch apps …` — one app from the terminal: what it is, what Launch is doing to it, and its kit.
 * Over `/api/apps` with `@launch/shared/launch-apps` / `launch-pipeline` / `launch-upgrades` /
 * `launch-promotion`. Every `<app>` is a slug, resolved through `GET /api/apps/:slug`; every
 * command prints the parsed body with `--json`.
 *
 * - `ls` — the catalogue: status, each environment's health and version, the latest deploy, the kit.
 * - `show <app>` — status, repository, `kitLine` (the kit against the template pin, "Requires
 *   upgrade → X.Y.Z" when behind, the upgrade in flight), each environment's address, health and
 *   version, and (issue #6) the newest release with where Staging → Live stands
 *   (`GET /:id/promotion`, read best-effort: its failure never fails `show`; `--json` adds it as
 *   `promotion`, null when it could not be read).
 * - `health <app> [--hours n]` — the health history: per environment, the share of checks that
 *   were up and every change of state. `health-check <app>` probes every environment now (admins).
 * - `operations <app>` — every pipeline step Launch ran on the app, newest first.
 * - `pipeline <app> [--kind create|teardown]` — the latest launch (or teardown) run step by step:
 *   status, timing, error and the GitHub run to follow. `pipeline retry|cancel <app>` and
 *   `rescaffold <app>` (admins) are the app page's buttons; a refusal is the server's sentence.
 * - `upgrades <app>` — the kit upgrade history. `upgrade <app>` starts one (owners and admins): a
 *   coding session that runs `/rf-upgrade` to the pin's tag and ships it when its first turn ends
 *   cleanly; it deliberately suggests no `sessions say`.
 * - `config-scan <app>` — re-read the app's declared config and match it against the shared
 *   secrets (owners and admins); prints what `grants needs` prints.
 *
 * `cli.ts` calls `registerAppsCommands(program, action)` once, as the P4/P5 files do.
 */
import {
  type AppCatalogueItem,
  type AppDetail,
  type AppEnvironmentName,
  type AppHealthCheck,
  appDetailSchema,
  appHealthCheckRunResponseSchema,
  appHealthResponseSchema,
  appListResponseSchema,
  appOperationListResponseSchema,
} from '@launch/shared/launch-apps'
import { appConfigSchema } from '@launch/shared/launch-grants'
import {
  APP_LAUNCH_STEPS,
  APP_TEARDOWN_STEPS,
  cancelPipelineResponseSchema,
  PIPELINE_KINDS,
  type PipelineKind,
  type PipelineStep,
  pipelineViewSchema,
  rescaffoldPipelineResponseSchema,
  retryPipelineResponseSchema,
} from '@launch/shared/launch-pipeline'
import { type AppPromotion, appPromotionSchema } from '@launch/shared/launch-promotion'
import {
  APP_UPGRADE_STATUS_LABELS,
  appUpgradeListResponseSchema,
  type KitStatus,
  requiresUpgradeLabel,
  startUpgradeResponseSchema,
} from '@launch/shared/launch-upgrades'
import chalk from 'chalk'
import { type Command, InvalidArgumentError } from 'commander'
import type { ApiClient } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { type ConfirmOptions, confirmConsequence } from '../utils/input'
import { formatDate, renderTable } from '../utils/output'
import { deployLine, duration, ENVIRONMENT_LABELS, HEALTH_LABELS, healthLine, v } from './app-words'
import { registerAppsManageCommands } from './apps-manage'
import { needsLines } from './grants'
import { promotionLines, STATUS_WORDS } from './releases'

const appPath = (id: string) => `/api/apps/${encodeURIComponent(id)}`

async function resolveApp(client: ApiClient, app: string) {
  if (!app.trim()) throw new CliError('Give an app slug')
  return client.get(appPath(app.trim()), { schema: appDetailSchema })
}

/** The kit in one line: the version, and what the pin asks of it. Pure. */
export function kitLine(detail: Pick<AppDetail, 'templateVersion' | 'kit'>): string {
  const kit: KitStatus | null = detail.kit
  const on = detail.templateVersion ? `kit ${detail.templateVersion}` : 'kit unknown'
  if (!kit) return on
  const open = kit.openUpgrade
  if (open) {
    const pr = open.prUrl ? ` (${open.prUrl})` : ''
    return `${on} · upgrade to ${open.toVersion}: ${APP_UPGRADE_STATUS_LABELS[open.status].toLowerCase()}${pr}`
  }
  const label = requiresUpgradeLabel(kit)
  if (label) return `${on} · ${label}`
  return kit.target ? `${on} · current (pin ${kit.target})` : on
}

// ---- ls ------------------------------------------------------------------------------------

function envCell(item: AppCatalogueItem, name: AppEnvironmentName): string | null {
  const env = item.environments.find(e => e.name === name)
  return env ? healthLine({ ...env, healthLatencyMs: null }) : null
}

export async function runAppsList(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await client.request('GET', '/api/apps', { schema: appListResponseSchema })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'App', value: a => a.slug },
      { header: 'Name', value: a => a.displayName },
      { header: 'Status', value: a => a.status },
      { header: 'Staging', value: a => envCell(a, 'staging') },
      { header: 'Live', value: a => envCell(a, 'production') },
      { header: 'Latest deploy', value: a => (a.latestDeploy ? deployLine(a.latestDeploy) : null) },
      {
        header: 'Kit',
        value: a =>
          a.kit?.behind ? `${a.templateVersion ?? '?'} → ${a.kit.target}` : a.templateVersion,
      },
    ])
  )
}

// ---- show ----------------------------------------------------------------------------------

/** The promotion view, or null — a failure here never fails `show`. */
async function readPromotion(client: ApiClient, appId: string): Promise<AppPromotion | null> {
  try {
    return await client.get(`${appPath(appId)}/promotion`, { schema: appPromotionSchema })
  } catch {
    return null
  }
}

export async function runAppsShow(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  if (!app.trim()) throw new CliError('Give an app slug')
  const { data, raw } = await client.request('GET', appPath(app.trim()), {
    schema: appDetailSchema,
  })
  const promotion = await readPromotion(client, data.id)
  const rawObject = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  ctx.out.data({ ...rawObject, promotion }, () => {
    const repo = data.repoOwner && data.repoName ? `${data.repoOwner}/${data.repoName}` : '—'
    const lines = [
      `${chalk.bold(data.displayName)} ${chalk.dim(`(${data.slug})`)} · ${data.status}`,
      `  Repository  ${repo}`,
      `  Template    ${kitLine(data)}`,
    ]
    if (data.kit?.behind && !data.kit.openUpgrade && data.viewerCanDeploy) {
      lines.push(chalk.dim(`  Upgrade it: ${ctx.binName} apps upgrade ${data.slug}`))
    }
    if (data.environments.length > 0) {
      lines.push(
        '',
        renderTable(data.environments, [
          { header: 'Environment', value: e => ENVIRONMENT_LABELS[e.name] },
          { header: 'Address', value: e => e.url ?? '—' },
          { header: 'Health', value: e => healthLine(e) },
          { header: 'Checked', value: e => formatDate(e.healthCheckedAt) },
          { header: 'Version', value: e => e.lastDeployVersion ?? e.healthVersion ?? '—' },
          { header: 'Deployed', value: e => formatDate(e.lastDeployAt) },
        ])
      )
      for (const e of data.environments) {
        if (e.healthError && (e.healthStatus === 'down' || e.healthStatus === 'degraded'))
          lines.push(chalk.yellow(`  ${ENVIRONMENT_LABELS[e.name]}: ${e.healthError}`))
      }
    }
    if (promotion) {
      const c = promotion.candidate
      lines.push(
        '',
        c
          ? `Latest release ${chalk.bold(v(c.version))} · ${STATUS_WORDS[c.status]} · ${formatDate(c.createdAt)}`
          : 'No release yet',
        ...promotionLines(promotion)
      )
    }
    if (data.status === 'provisioning' || data.status === 'failed' || data.status === 'requested')
      lines.push(chalk.dim(`  The launch, step by step: ${ctx.binName} apps pipeline ${data.slug}`))
    return lines.join('\n')
  })
}

// ---- health --------------------------------------------------------------------------------

/** Each environment's checks reduced to the moments its state changed (oldest first). Pure. */
export function healthChanges(items: readonly AppHealthCheck[]): AppHealthCheck[] {
  const last = new Map<string, string>()
  const out: AppHealthCheck[] = []
  for (const check of items) {
    if (last.get(check.environmentId) !== check.status) out.push(check)
    last.set(check.environmentId, check.status)
  }
  return out
}

export async function runAppsHealth(
  ctx: CommandContext,
  app: string,
  options: { hours?: number } = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('GET', `${appPath(detail.id)}/health`, {
    schema: appHealthResponseSchema,
    query: { hours: options.hours },
  })
  ctx.out.data(raw, () => {
    const lines = [chalk.dim(`Since ${formatDate(data.since)}`)]
    for (const env of detail.environments) {
      const label = ENVIRONMENT_LABELS[env.name].padEnd(9)
      const checks = data.items.filter(c => c.environmentId === env.id)
      const latest = checks.at(-1)
      if (!latest) {
        lines.push(`${label}no checks`)
        continue
      }
      const up = checks.filter(c => c.status === 'up').length
      const share = Math.round((up / checks.length) * 100)
      lines.push(
        `${label}${share}% up over ${checks.length} checks · now ${HEALTH_LABELS[latest.status]}`
      )
    }
    const changes = healthChanges(data.items)
    if (changes.length > 0)
      lines.push(
        '',
        renderTable(changes, [
          { header: 'When', value: c => formatDate(c.checkedAt) },
          { header: 'Environment', value: c => ENVIRONMENT_LABELS[c.environmentName] },
          { header: 'Health', value: c => HEALTH_LABELS[c.status] },
          { header: 'HTTP', value: c => c.httpStatus },
          { header: 'Ready', value: c => c.readyStatus },
          { header: 'Version', value: c => c.version },
          { header: 'Error', value: c => c.error },
        ])
      )
    return lines.join('\n')
  })
}

export async function runAppsHealthCheck(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('POST', `${appPath(detail.id)}/health-check`, {
    schema: appHealthCheckRunResponseSchema,
  })
  ctx.out.data(raw, () => {
    const lines = [
      renderTable(data.environments, [
        { header: 'Environment', value: e => ENVIRONMENT_LABELS[e.name] },
        { header: 'Address', value: e => e.url },
        { header: 'Health', value: e => healthLine(e) },
      ]),
    ]
    for (const e of data.environments)
      if (e.healthError && (e.healthStatus === 'down' || e.healthStatus === 'degraded'))
        lines.push(chalk.yellow(`  ${ENVIRONMENT_LABELS[e.name]}: ${e.healthError}`))
    return lines.join('\n')
  })
}

// ---- operations and the pipeline -----------------------------------------------------------

const STEP_LABELS = new Map<string, string>(
  [...APP_LAUNCH_STEPS, ...APP_TEARDOWN_STEPS].map(s => [s.step, s.label])
)

/** A step key in words ("scaffold.wait" → "Scaffold from the template"). Pure. */
export function stepLabel(step: string): string {
  return STEP_LABELS.get(step.split('#')[0] ?? step) ?? step
}

export async function runAppsOperations(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('GET', `${appPath(detail.id)}/operations`, {
    schema: appOperationListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'When', value: o => formatDate(o.startedAt ?? o.createdAt) },
      { header: 'Run', value: o => `${o.kind} ${o.runId.slice(0, 8)}` },
      { header: 'Step', value: o => stepLabel(o.step) },
      { header: 'Status', value: o => o.status },
      { header: 'Try', value: o => o.attempt },
      { header: 'Took', value: o => duration(o.startedAt, o.finishedAt) },
      { header: 'Error', value: o => o.error },
    ])
  )
}

const STEP_GLYPHS: Record<PipelineStep['status'], string> = {
  succeeded: '✓',
  failed: '✗',
  running: '…',
  pending: '·',
  skipped: '-',
}

/** One pipeline row: glyph, label, try, timing; its error and run link under it. Pure. */
export function pipelineStepLines(step: PipelineStep, now: Date = new Date()): string[] {
  const running = step.status === 'running'
  const took = running ? duration(step.startedAt, now) : duration(step.startedAt, step.finishedAt)
  const meta = [
    step.attempt > 1 ? `try ${step.attempt}` : null,
    took ? (running ? `${took} so far` : took) : null,
  ].filter(Boolean)
  const glyph = STEP_GLYPHS[step.status]
  const tinted =
    step.status === 'succeeded'
      ? chalk.green(glyph)
      : step.status === 'failed'
        ? chalk.red(glyph)
        : running
          ? chalk.cyan(glyph)
          : chalk.dim(glyph)
  const lines = [`${tinted} ${step.label}${meta.length ? chalk.dim(` · ${meta.join(' · ')}`) : ''}`]
  if (step.error) lines.push(chalk.red(`    ${step.error}`))
  if (step.url && step.status !== 'succeeded') lines.push(chalk.dim(`    ${step.url}`))
  return lines
}

function kindOption(value: string): PipelineKind {
  if (!(PIPELINE_KINDS as readonly string[]).includes(value))
    throw new InvalidArgumentError(`--kind must be one of ${PIPELINE_KINDS.join(', ')}`)
  return value as PipelineKind
}

const RUN_WORDS: Record<PipelineKind, string> = { create: 'launch', teardown: 'teardown' }

export async function runAppsPipeline(
  ctx: CommandContext,
  app: string,
  options: { kind?: PipelineKind } = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('GET', `${appPath(detail.id)}/pipeline`, {
    schema: pipelineViewSchema,
    query: { kind: options.kind },
  })
  ctx.out.data(raw, () => {
    const words = RUN_WORDS[data.kind]
    if (data.status === 'none' || !data.runId) return `${detail.slug} has no ${words} run.`
    const lines = [
      `${chalk.bold(detail.slug)} · ${words} run ${data.runId.slice(0, 8)} · ${data.status}`,
      ...data.steps.flatMap(s => pipelineStepLines(s)),
    ]
    const kind = data.kind === 'create' ? '' : ' --kind teardown'
    if (data.status === 'failed')
      lines.push(
        '',
        chalk.dim(
          `  Retry from the failed step: ${ctx.binName} apps pipeline retry ${detail.slug}${kind}`
        )
      )
    if (data.status === 'running' && data.kind === 'create')
      lines.push(
        '',
        chalk.dim(`  Stuck? Stop it: ${ctx.binName} apps pipeline cancel ${detail.slug}`)
      )
    if (data.canRescaffold) {
      const check = data.rescaffoldChecksDatabase
        ? ' (Launch first checks no migration ran on its database)'
        : ''
      lines.push(
        chalk.dim(
          `  Or scaffold it again from kit ${data.templateTag ?? 'the pin'}${check}: ${ctx.binName} apps rescaffold ${detail.slug}`
        )
      )
    }
    return lines.join('\n')
  })
}

export async function runAppsPipelineRetry(
  ctx: CommandContext,
  app: string,
  options: { kind?: PipelineKind } = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const kind = options.kind ?? 'create'
  const { raw } = await client.request('POST', `${appPath(detail.id)}/pipeline/retry`, {
    schema: retryPipelineResponseSchema,
    body: { kind },
  })
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Retrying ${detail.slug}'s ${RUN_WORDS[kind]} from its failed step.`,
      chalk.dim(
        `  Follow it: ${ctx.binName} apps pipeline ${detail.slug}${kind === 'create' ? '' : ' --kind teardown'}`
      ),
    ].join('\n')
  )
}

export async function runAppsPipelineCancel(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('POST', `${appPath(detail.id)}/pipeline/cancel`, {
    schema: cancelPipelineResponseSchema,
  })
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Stopped ${detail.slug}'s launch at “${stepLabel(data.step)}”.`,
      chalk.dim(`  Retry it: ${ctx.binName} apps pipeline retry ${detail.slug}`),
    ].join('\n')
  )
}

export async function runAppsRescaffold(
  ctx: CommandContext,
  app: string,
  options: ConfirmOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const go = await confirmConsequence(
    ctx,
    options,
    `Re-scaffold ${detail.slug} from the current kit pin?`,
    'The code on main is replaced by a fresh scaffold of the kit, and Launch writes its configuration onto it again. Anything committed since the scaffold is overwritten (its history is kept). The database, storage, Workers, sign-in client and secrets are kept.'
  )
  if (!go) return
  const { data, raw } = await client.request('POST', `${appPath(detail.id)}/pipeline/rescaffold`, {
    schema: rescaffoldPipelineResponseSchema,
  })
  ctx.out.data(raw, () => {
    const was = data.previousTemplateTag ? ` (was ${data.previousTemplateTag})` : ''
    return [
      `${chalk.green('✓')} Scaffolding ${detail.slug} again from kit ${data.templateTag}${was}.`,
      chalk.dim(`  Follow it: ${ctx.binName} apps pipeline ${detail.slug}`),
    ].join('\n')
  })
}

// ---- upgrades ------------------------------------------------------------------------------

export async function runAppsUpgrades(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('GET', `${appPath(detail.id)}/upgrades`, {
    schema: appUpgradeListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'When', value: u => formatDate(u.createdAt) },
      { header: 'Kit', value: u => `${u.fromVersion ?? '?'} → ${u.toVersion}` },
      { header: 'Status', value: u => APP_UPGRADE_STATUS_LABELS[u.status] },
      { header: 'PR', value: u => u.prUrl },
      { header: 'Session', value: u => u.sessionId },
      { header: 'Why', value: u => u.error },
    ])
  )
}

export async function runAppsUpgrade(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('POST', `${appPath(detail.id)}/upgrade`, {
    schema: startUpgradeResponseSchema,
    body: {},
  })
  ctx.out.data(raw, () => {
    const { upgrade } = data
    const from = upgrade.fromVersion ? `${upgrade.fromVersion} → ` : ''
    return [
      `${chalk.green('✓')} Upgrading ${detail.slug}'s kit ${from}${upgrade.toVersion} in session ${data.sessionId}.`,
      chalk.dim(
        '  Launch ships it when the upgrade ends cleanly; otherwise the session waits for you.'
      ),
      chalk.dim(
        `  Watch it: ${ctx.config.serverUrl.replace(/\/+$/, '')}/apps/${detail.slug}/sessions/${data.sessionId}`
      ),
      chalk.dim(`  Upgrade ${data.upgradeId}`),
    ].join('\n')
  })
}

// ---- config scan ---------------------------------------------------------------------------

export async function runAppsConfigScan(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('POST', `${appPath(detail.id)}/config/scan`, {
    schema: appConfigSchema,
  })
  ctx.out.data(raw, () => needsLines(ctx, detail.slug, data).join('\n'))
}

// ---- registration --------------------------------------------------------------------------

function hoursOption(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 168)
    throw new InvalidArgumentError('--hours must be a whole number from 1 to 168')
  return n
}

export function registerAppsCommands(program: Command, action: ActionWrapper): void {
  const apps = program
    .command('apps')
    .description('an app: create, read and change it — environments, health, pipeline, kit')
  apps
    .command('ls')
    .description('every app: status, each environment’s health and the latest deploy')
    .action(action(ctx => runAppsList(ctx)))
  apps
    .command('show <app>')
    .description('an app by slug: its kit, its environments and the newest release')
    .action(action((ctx, cmd) => runAppsShow(ctx, cmd.args[0] ?? '')))
  apps
    .command('health <app>')
    .description('the health history: how often each environment was up, and every change')
    .option('--hours <n>', 'how far back (1–168, default 24)', hoursOption)
    .action(action((ctx, cmd) => runAppsHealth(ctx, cmd.args[0] ?? '', cmd.opts())))
  apps
    .command('health-check <app>')
    .description('probe every environment now (admins)')
    .action(action((ctx, cmd) => runAppsHealthCheck(ctx, cmd.args[0] ?? '')))
  apps
    .command('operations <app>')
    .description('every step Launch ran on the app, newest first')
    .action(action((ctx, cmd) => runAppsOperations(ctx, cmd.args[0] ?? '')))
  // `pipeline <app>` reads; `pipeline retry|cancel <app>` act (commander dispatches a first
  // operand that names a sub-command to it, and runs this action otherwise).
  const pipeline = apps
    .command('pipeline')
    .usage('<app> [--kind create|teardown] | retry <app> | cancel <app>')
    .description('the latest launch (or teardown) run, step by step')
    .argument('<app>')
    .option('--kind <kind>', 'create | teardown (default create)', kindOption)
    .action(action((ctx, cmd) => runAppsPipeline(ctx, cmd.args[0] ?? '', cmd.opts())))
  pipeline
    .command('retry <app>')
    .description('retry a failed run from its failed step (admins)')
    .option('--kind <kind>', 'create | teardown (default create)', kindOption)
    .action(action((ctx, cmd) => runAppsPipelineRetry(ctx, cmd.args[0] ?? '', cmd.opts())))
  pipeline
    .command('cancel <app>')
    .description('stop a launch that is still running, so it can be retried (admins)')
    .action(action((ctx, cmd) => runAppsPipelineCancel(ctx, cmd.args[0] ?? '')))
  apps
    .command('rescaffold <app>')
    .description('scaffold an app that never deployed again from the current kit pin (admins)')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(action((ctx, cmd) => runAppsRescaffold(ctx, cmd.args[0] ?? '', cmd.opts())))
  apps
    .command('upgrades <app>')
    .description('the app’s kit upgrades, newest first')
    .action(action((ctx, cmd) => runAppsUpgrades(ctx, cmd.args[0] ?? '')))
  apps
    .command('upgrade <app>')
    .description(
      'upgrade the app’s kit to the template pin in a coding session that ships it (owners and admins)'
    )
    .action(action((ctx, cmd) => runAppsUpgrade(ctx, cmd.args[0] ?? '')))
  apps
    .command('config-scan <app>')
    .description('re-read the config the app declares and match it to secrets (owners and admins)')
    .action(action((ctx, cmd) => runAppsConfigScan(ctx, cmd.args[0] ?? '')))
  // Issue #6: the commands that change an app (create, import, set, teardown, sign-in…).
  registerAppsManageCommands(apps, action)
}
