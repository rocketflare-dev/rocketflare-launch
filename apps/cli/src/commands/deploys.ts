/**
 * `launch deploys ls|latest|production|approve|reject <app>` (issue #6) — an app's deploys, over
 * `GET /api/apps/:id/deploys` (`deployTicketListResponseSchema`) and `/deploys/latest`
 * (`appDeployProgressResponseSchema`). `<app>` is a slug (`GET /api/apps/:slug`); `--json` prints
 * the parsed body.
 *
 * - `ls <app>` — every deploy ticket, newest first: environment, status, version, commit, who
 *   started it, when it went live (a `finished` ticket that never activated never served a
 *   request), the run and the error.
 * - `latest <app>` — each environment's newest deploy as the app page's stepper reads it
 *   (dispatched → building → uploaded → migrating → activating → live, or failed / awaiting
 *   approval), after the server has polled the GitHub run of one in progress.
 *
 * - `production <app> [--yes]` — "Deploy main to Live": asks the app's approvers to deploy the
 *   default branch as it is (owners and admins; asks first). Shipping a tested release is
 *   `releases promote`.
 * - `approve|reject <app> <ticket> [--reason]` — decide a production run waiting in GitHub (the
 *   ticket id or an 8-character prefix from `ls`); whoever its approval's policy names decides.
 */

import { approvalPath } from '@launch/shared/launch-approvals'
import { appDeployProgressResponseSchema, appDetailSchema } from '@launch/shared/launch-apps'
import {
  deployDecisionSchema,
  deployTicketListResponseSchema,
  deployTicketSchema,
  PRODUCTION_INTENT_TTL_MS,
  productionDeployResponseSchema,
} from '@launch/shared/launch-pipeline'
import chalk from 'chalk'
import type { Command } from 'commander'
import type { ApiClient } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { type ConfirmOptions, confirmAction, parseBody } from '../utils/input'
import { formatDate, renderTable } from '../utils/output'
import { deployLine, duration, ENVIRONMENT_LABELS, v } from './app-words'

const appPath = (id: string) => `/api/apps/${encodeURIComponent(id)}`

async function resolveApp(client: ApiClient, app: string) {
  if (!app.trim()) throw new CliError('Give an app slug')
  return client.get(appPath(app.trim()), { schema: appDetailSchema })
}

const runUrl = (repository: string | null, runId: string | null) =>
  repository && runId ? `https://github.com/${repository}/actions/runs/${runId}` : null

export async function runDeploysList(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('GET', `${appPath(detail.id)}/deploys`, {
    schema: deployTicketListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'When', value: t => formatDate(t.createdAt) },
      { header: 'Environment', value: t => ENVIRONMENT_LABELS[t.environment] },
      { header: 'Purpose', value: t => t.purpose },
      { header: 'Status', value: t => t.status },
      { header: 'Version', value: t => (t.version ? v(t.version) : null) },
      { header: 'Commit', value: t => t.sha?.slice(0, 7) },
      { header: 'By', value: t => t.actor },
      { header: 'Live at', value: t => formatDate(t.activatedAt) },
      { header: 'Run', value: t => runUrl(t.repository, t.runId) },
      {
        header: 'Error',
        value: t => t.error ?? (t.refused?.length ? `refused: ${t.refused.join(', ')}` : null),
      },
    ])
  )
}

export async function runDeploysLatest(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('GET', `${appPath(detail.id)}/deploys/latest`, {
    schema: appDeployProgressResponseSchema,
  })
  ctx.out.data(raw, () => {
    if (data.items.length === 0) return `${detail.slug} has not deployed yet.`
    const lines: string[] = []
    for (const d of data.items) {
      const reached =
        d.phase === 'failed' && d.reached
          ? ` (stopped after ${d.reached})`
          : d.phase === 'failed'
            ? ' (before it was dispatched)'
            : ''
      const took = duration(
        d.startedAt,
        d.finishedAt ?? d.activatedAt ?? (d.inProgress ? new Date() : null)
      )
      const meta = [
        d.actor ? `by ${d.actor}` : null,
        `started ${formatDate(d.startedAt)}`,
        took ? (d.inProgress ? `${took} so far` : `took ${took}`) : null,
      ].filter(Boolean)
      lines.push(`${chalk.bold(deployLine(d))}${reached}`, chalk.dim(`  ${meta.join(' · ')}`))
      if (d.error) lines.push(chalk.red(`  ${d.error}`))
      if (d.runUrl) lines.push(chalk.dim(`  ${d.runUrl}`))
      if (d.approvalId && d.phase === 'awaiting_approval')
        lines.push(chalk.dim(`  Approval: ${ctx.binName} approvals show ${d.approvalId}`))
    }
    return lines.join('\n')
  })
}

// ---- deploying to Live and deciding a run ------------------------------------------------

export async function runDeploysProduction(
  ctx: CommandContext,
  app: string,
  options: ConfirmOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const branch = detail.defaultBranch ?? 'the default branch'
  ctx.log.warn(
    `Launch asks this app’s approvers to deploy ${branch} to Live as it is. Once someone other than you approves, it starts the repository’s deploy workflow, which runs the full gate first — nothing changes if that fails.`
  )
  ctx.log.hint(
    `To ship a tested version instead: ${ctx.binName} releases promote ${detail.slug} <version>`
  )
  const go = await confirmAction(
    `Deploy ${branch} to Live?`,
    options,
    `Refusing to request a Live deploy of ${detail.slug} without confirmation`
  )
  if (!go) {
    ctx.log.info('Nothing was requested.')
    return
  }
  const { data, raw } = await client.request('POST', `${appPath(detail.id)}/deploys/production`, {
    schema: productionDeployResponseSchema,
  })
  ctx.out.data(raw, () => {
    if (data.approvalId && !data.ticket) {
      const url = `${ctx.config.serverUrl.replace(/\/+$/, '')}${approvalPath(data.approvalId)}`
      return [
        `${chalk.green('✓')} Live deploy requested — waiting for approval.`,
        chalk.dim(`  ${ctx.binName} approvals show ${data.approvalId}`),
        chalk.dim(`  ${url}`),
      ].join('\n')
    }
    return `${chalk.green('✓')} Live deploy started — approved for ${Math.round(PRODUCTION_INTENT_TTL_MS / 60_000)} minutes.`
  })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A ticket by id, or by a prefix of at least 8 characters among the app's tickets. */
async function resolveTicketId(client: ApiClient, appId: string, ref: string): Promise<string> {
  const wanted = ref.trim().toLowerCase()
  if (UUID.test(wanted)) return wanted
  if (wanted.length < 8) throw new CliError('Give the deploy ticket’s id or its first 8 characters')
  const { items } = await client.get(`${appPath(appId)}/deploys`, {
    schema: deployTicketListResponseSchema,
  })
  const matches = items.filter(t => t.id.startsWith(wanted))
  if (matches.length === 1) return (matches[0] as { id: string }).id
  throw new CliError(
    matches.length ? `“${ref}” matches ${matches.length} deploys` : `No deploy “${ref}”`,
    { hint: 'List them with `launch deploys ls <app>`.' }
  )
}

export async function runDeploysDecide(
  ctx: CommandContext,
  app: string,
  ticket: string,
  decision: 'approve' | 'reject',
  options: { reason?: string } = {}
): Promise<void> {
  const body = parseBody(deployDecisionSchema, { decision, reason: options.reason })
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const ticketId = await resolveTicketId(client, detail.id, ticket)
  const { data, raw } = await client.request(
    'POST',
    `${appPath(detail.id)}/deploys/${encodeURIComponent(ticketId)}/decide`,
    { schema: deployTicketSchema, body }
  )
  ctx.out.data(raw, () =>
    decision === 'approve'
      ? `${chalk.green('✓')} Approved the ${ENVIRONMENT_LABELS[data.environment]} deploy${data.version ? ` of ${v(data.version)}` : ''} · ${data.status}.`
      : `${chalk.green('✓')} Rejected it: the job stops and nothing is deployed.`
  )
}

export function registerDeploysCommands(program: Command, action: ActionWrapper): void {
  const deploys = program.command('deploys').description('an app’s deploys to Staging and Live')
  deploys
    .command('ls <app>')
    .description('every deploy of an app, newest first')
    .action(action((ctx, cmd) => runDeploysList(ctx, cmd.args[0] ?? '')))
  deploys
    .command('latest <app>')
    .description('each environment’s newest deploy, step by step')
    .action(action((ctx, cmd) => runDeploysLatest(ctx, cmd.args[0] ?? '')))
  deploys
    .command('production <app>')
    .description('ask the approvers to deploy the default branch to Live as it is (asks first)')
    .option('-y, --yes', 'do not ask')
    .action(action((ctx, cmd) => runDeploysProduction(ctx, cmd.args[0] ?? '', cmd.opts())))
  for (const decision of ['approve', 'reject'] as const) {
    deploys
      .command(`${decision} <app> <ticket>`)
      .description(
        decision === 'approve'
          ? 'approve a production run waiting in GitHub'
          : 'reject a production run waiting in GitHub: the job stops, nothing is deployed'
      )
      .option('--reason <text>', 'why')
      .action(
        action((ctx, cmd) =>
          runDeploysDecide(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', decision, cmd.opts())
        )
      )
  }
}
