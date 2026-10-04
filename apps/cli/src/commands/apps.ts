/**
 * `launch apps show|upgrade` (P6 6c, the single-app half of kit upgrades), over `/api/apps/:slug`
 * and `POST /api/apps/:id/upgrade` with `@launch/shared/launch-apps` / `launch-upgrades`.
 *
 * - `show <app>` — one app by slug: status, repository, the kit it is on against the template pin
 *   ("Requires upgrade → X.Y.Z" when it is behind, and the upgrade in flight, if any) and each
 *   environment's address and health. `--json` is the raw detail.
 * - `upgrade <app>` — start the kit upgrade: a coding session that runs `/rf-upgrade` to the pin's
 *   tag and ships it when its first turn ends cleanly. Owners and admins (a 403 exits 3); every
 *   refusal (not behind, one already open, a commit pin, the session limit…) is the server's
 *   sentence, exit 1. Prints the session to follow (`sessions say|ship`) and the upgrade's id.
 *
 * `cli.ts` calls `registerAppsCommands(program, action)` once, as the P4/P5 files do.
 */
import { type AppDetail, appDetailSchema } from '@launch/shared/launch-apps'
import {
  APP_UPGRADE_STATUS_LABELS,
  type KitStatus,
  requiresUpgradeLabel,
  startUpgradeResponseSchema,
} from '@launch/shared/launch-upgrades'
import chalk from 'chalk'
import type { Command } from 'commander'
import type { ApiClient } from '../api'
import { type CommandContext, requireClient } from '../context'
import type { ActionWrapper } from '../plugins/types'
import { renderTable } from '../utils/output'

async function resolveApp(client: ApiClient, app: string) {
  return client.get(`/api/apps/${encodeURIComponent(app)}`, { schema: appDetailSchema })
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

export async function runAppsShow(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await client.request('GET', `/api/apps/${encodeURIComponent(app)}`, {
    schema: appDetailSchema,
  })
  ctx.out.data(raw, () => {
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
          { header: 'Environment', value: e => e.name },
          { header: 'Address', value: e => e.url ?? '—' },
          { header: 'Health', value: e => e.healthStatus },
          { header: 'Version', value: e => e.lastDeployVersion ?? e.healthVersion ?? '—' },
        ])
      )
    }
    return lines.join('\n')
  })
}

export async function runAppsUpgrade(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request(
    'POST',
    `/api/apps/${encodeURIComponent(detail.id)}/upgrade`,
    { schema: startUpgradeResponseSchema, body: {} }
  )
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

export function registerAppsCommands(program: Command, action: ActionWrapper): void {
  const apps = program.command('apps').description('read an app and upgrade its kit')
  apps
    .command('show <app>')
    .description('an app by slug: its kit against the template pin, and its environments')
    .action(action((ctx, cmd) => runAppsShow(ctx, cmd.args[0] ?? '')))
  apps
    .command('upgrade <app>')
    .description(
      'upgrade the app’s kit to the template pin in a coding session that ships it (owners and admins)'
    )
    .action(action((ctx, cmd) => runAppsUpgrade(ctx, cmd.args[0] ?? '')))
}
