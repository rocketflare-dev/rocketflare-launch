/**
 * `launch releases ls|create|promote [--wait]` — cut an app's release and promote it to production
 * (Launch P4, plan §1.8 / §4f, D26), over `/api/apps/:id/releases` and
 * `@launch/shared/launch-releases`.
 *
 * - `ls <app>` — the app's releases, newest first.
 * - `create <app> [--bump patch|minor|major]` — Launch bumps the root `package.json`, tags `X.Y.Z`
 *   (which starts staging) and records the PRs in it. Owners and admins; a 403 exits 3.
 * - `promote <app> <release> [--reason] [--wait]` — `<release>` is a release id or its version.
 *   Opens the `deploy.production` approval and prints the page an approver decides it on — the
 *   CLI never approves its own promote (the engine would refuse: the promoter is excluded).
 *   `--wait` polls the approval until it is decided, then the release until production is live
 *   (`production_active`), and exits 1 on anything else. Polling, not SSE, with an injectable
 *   `sleep`/`pollMs` — the sessions pattern.
 *
 * Slice 4f owns this file. `cli.ts` calls `registerReleasesCommands(program, action)` once, after
 * the kit's own commands, so this file adds its `program.command(...)` entries and never edits
 * `cli.ts` (the plugin `register` shape, `plugins/types.ts`).
 */

import {
  type ApprovalDetail,
  approvalDetailSchema,
  TERMINAL_APPROVAL_STATUSES,
} from '@launch/shared/launch-approvals'
import { appDetailSchema } from '@launch/shared/launch-apps'
import {
  parseReleaseVersion,
  promoteReleaseResponseSchema,
  RELEASE_BUMPS,
  type Release,
  type ReleaseBump,
  type ReleaseStatus,
  releaseListResponseSchema,
  releaseSchema,
} from '@launch/shared/launch-releases'
import chalk from 'chalk'
import { type Command, InvalidArgumentError } from 'commander'
import type { ApiClient } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { formatDate, renderTable } from '../utils/output'
import { approvalUrl } from './approvals'

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const releasesPath = (appId: string) => `/api/apps/${encodeURIComponent(appId)}/releases`
const releasePath = (appId: string, releaseId: string) =>
  `${releasesPath(appId)}/${encodeURIComponent(releaseId)}`

async function resolveApp(client: ApiClient, app: string) {
  return client.get(`/api/apps/${encodeURIComponent(app)}`, { schema: appDetailSchema })
}

/** A release id, or its version (`1.2.3`) looked up in the app's list. */
async function resolveRelease(client: ApiClient, appId: string, ref: string): Promise<Release> {
  const wanted = ref.trim()
  if (!wanted) throw new CliError('Give a release id or version')
  if (parseReleaseVersion(wanted)) {
    const list = await client.get(releasesPath(appId), { schema: releaseListResponseSchema })
    const match = list.items.find(r => r.version === wanted || r.tag === wanted)
    if (!match) throw new CliError(`No release ${wanted} on this app`)
    return match
  }
  return client.get(releasePath(appId, wanted), { schema: releaseSchema })
}

/** A release's status in words. */
const STATUS_WORDS: Record<ReleaseStatus, string> = {
  tagged: 'tagged',
  staging: 'deploying to staging',
  staging_active: 'live on staging',
  awaiting_approval: 'waiting for approval',
  promoting: 'deploying to production',
  production_active: 'live in production',
  rejected: 'rejected',
  failed: 'failed',
}

export async function runReleasesList(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('GET', releasesPath(detail.id), {
    schema: releaseListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Version', value: r => r.version },
      { header: 'Status', value: r => STATUS_WORDS[r.status] },
      { header: 'PRs', value: r => r.prs.length },
      { header: 'Commit', value: r => r.sha.slice(0, 7) },
      { header: 'Created', value: r => formatDate(r.createdAt) },
      { header: 'Id', value: r => r.id },
    ])
  )
}

export async function runReleasesCreate(
  ctx: CommandContext,
  app: string,
  options: { bump?: ReleaseBump } = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('POST', releasesPath(detail.id), {
    schema: releaseSchema,
    body: { bump: options.bump ?? 'patch' },
  })
  ctx.out.data(raw, () => {
    const lines = [
      `${chalk.green('✓')} Tagged ${chalk.bold(data.tag)} on ${detail.slug} (${data.prs.length} PR${data.prs.length === 1 ? '' : 's'} since ${data.previousTag ?? 'the start'}). Staging deploys it next.`,
    ]
    for (const pr of data.prs) lines.push(chalk.dim(`  #${pr.number} ${pr.title}`))
    lines.push(
      chalk.dim(`  Next: ${ctx.binName} releases promote ${detail.slug} ${data.version} --wait`)
    )
    return lines.join('\n')
  })
}

export interface ReleasesPromoteOptions {
  reason?: string
  wait?: boolean
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Give up after this long. Default 24 h — the approval's own default expiry. */
  timeoutMs?: number
  now?: () => number
}

const RELEASE_SETTLED: readonly ReleaseStatus[] = ['production_active', 'rejected', 'failed']

export async function runReleasesPromote(
  ctx: CommandContext,
  app: string,
  ref: string,
  options: ReleasesPromoteOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const release = await resolveRelease(client, detail.id, ref)
  const reason = options.reason?.trim()
  const { data, raw } = await client.request(
    'POST',
    `${releasePath(detail.id, release.id)}/promote`,
    { schema: promoteReleaseResponseSchema, body: reason ? { reason } : {} }
  )
  const url = approvalUrl(ctx, data.approvalId)
  if (!options.wait) {
    ctx.out.data(raw, () =>
      [
        `${chalk.green('✓')} Asked to deploy ${chalk.bold(data.release.version)} of ${detail.slug} to production.`,
        `  Another owner or admin approves it here: ${url}`,
        chalk.dim(`  Follow it: ${ctx.binName} approvals show ${data.approvalId}`),
      ].join('\n')
    )
    return
  }

  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? 5000
  const deadline = now() + (options.timeoutMs ?? 24 * 60 * 60_000)
  if (!ctx.json) {
    ctx.out.text(
      `${chalk.green('✓')} Asked to deploy ${chalk.bold(data.release.version)} to production. Waiting for approval…`
    )
    ctx.out.text(chalk.dim(`  ${url}`))
  }

  // 1. The approval, until somebody decides it (or it expires / is cancelled).
  let approval: ApprovalDetail | null = null
  while (now() < deadline) {
    approval = await client.get(`/api/approvals/${encodeURIComponent(data.approvalId)}`, {
      schema: approvalDetailSchema,
    })
    if ((TERMINAL_APPROVAL_STATUSES as readonly string[]).includes(approval.status)) break
    await sleep(pollMs)
  }
  if (!approval || approval.status === 'pending')
    throw new CliError('Timed out waiting for the approval', { hint: url })
  if (approval.status !== 'approved') {
    if (ctx.json) ctx.out.data({ release: data.release, approval }, () => '')
    const by = approval.decisions.find(d => d.decision === 'reject')
    throw new CliError(`The production deploy was ${approval.status}`, {
      hint: by?.comment ? `${by.userName ?? by.userEmail}: ${by.comment}` : url,
    })
  }
  if (!ctx.json) ctx.out.text(`${chalk.green('✓')} Approved. Deploying to production…`)

  // 2. The release, until production is live (or the deploy failed).
  let current = data.release
  while (now() < deadline) {
    current = await client.get(releasePath(detail.id, release.id), { schema: releaseSchema })
    if (RELEASE_SETTLED.includes(current.status)) break
    await sleep(pollMs)
  }
  if (ctx.json) ctx.out.data({ release: current, approval }, () => '')
  if (current.status !== 'production_active') {
    throw new CliError(
      RELEASE_SETTLED.includes(current.status)
        ? `The release is ${STATUS_WORDS[current.status]}`
        : 'Timed out waiting for the production deploy',
      current.error ? { hint: current.error } : {}
    )
  }
  if (!ctx.json) ctx.out.text(chalk.green(`✓ ${current.version} is live in production`))
}

// ---- registration --------------------------------------------------------------------------

function bumpOption(value: string): ReleaseBump {
  if (!(RELEASE_BUMPS as readonly string[]).includes(value))
    throw new InvalidArgumentError(`--bump must be one of ${RELEASE_BUMPS.join(', ')}`)
  return value as ReleaseBump
}

export function registerReleasesCommands(program: Command, action: ActionWrapper): void {
  const releases = program
    .command('releases')
    .description('tag a release of an app and promote it to production')
  releases
    .command('ls <app>')
    .description('list an app’s releases (by slug)')
    .action(action((ctx, cmd) => runReleasesList(ctx, cmd.args[0] ?? '')))
  releases
    .command('create <app>')
    .description('bump the version, tag it and deploy it to staging (owners and admins)')
    .option('--bump <part>', 'patch | minor | major (default patch)', bumpOption)
    .action(action((ctx, cmd) => runReleasesCreate(ctx, cmd.args[0] ?? '', cmd.opts())))
  releases
    .command('promote <app> <release>')
    .description('ask for approval to deploy a release (id or version) to production')
    .option('--reason <text>', 'why — shown to the approvers')
    .option('--wait', 'wait for the approval and the production deploy')
    .action(
      action((ctx, cmd) =>
        runReleasesPromote(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', cmd.opts())
      )
    )
}
