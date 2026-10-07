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
 * - `retry <app> <release>` (app page P2) — the stage-aware Retry: whatever stage the release is
 *   stuck at (`failedStage`), Launch does the one thing that unsticks it — re-runs the failed
 *   GitHub run's jobs, re-pushes a lost tag, re-checks health or asks for approval again — and
 *   says which. A release with nothing failing exits 1 (`release_not_retryable`).
 * - `cancel <app> <release>` — cancel the release's deploy run in flight on GitHub; the release
 *   is marked failed so `retry` re-runs it later.
 * - `rollback <app> <release>` (app page P3) — put an earlier release that was live before back on
 *   production, through the same approval as `promote` (the repo's own deploy workflow at its tag).
 *   409 `release_not_rollbackable` for a release that is not earlier than production's, or was
 *   never live. `ls` also says how far the default branch is ahead of the latest release tag
 *   (`GET …/releases/compare`; `--json` carries it as `mainAhead`).
 *
 * - `show <app> <release>`, `chain <app> <release>`, `promotion <app>` (issue #6) — one release,
 *   its audit chain, and where Staging → Live stands (`promotionSentence`, the app page's words).
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
  type AppPromotion,
  appPromotionSchema,
  candidateRunFailed,
  compareReleaseVersions,
} from '@launch/shared/launch-promotion'
import {
  cancelReleaseResponseSchema,
  parseReleaseVersion,
  promoteReleaseResponseSchema,
  RELEASE_BUMPS,
  RELEASE_RETRY_LABELS,
  RELEASE_STAGE_LABELS,
  RELEASE_STAGING_TIMEOUT_MINUTES,
  type Release,
  type ReleaseBump,
  type ReleaseCompare,
  type ReleaseStatus,
  type RetryReleaseResponse,
  releaseChainSchema,
  releaseCompareSchema,
  releaseListResponseSchema,
  releaseSchema,
  retryReleaseResponseSchema,
  rollbackReleaseResponseSchema,
} from '@launch/shared/launch-releases'
import chalk from 'chalk'
import { type Command, InvalidArgumentError } from 'commander'
import type { ApiClient } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { type ConfirmOptions, confirmConsequence } from '../utils/input'
import { formatDate, renderTable } from '../utils/output'
import { ENVIRONMENT_LABELS, healthLine, v } from './app-words'
import { approvalUrl } from './approvals'

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const releasesPath = (appId: string) => `/api/apps/${encodeURIComponent(appId)}/releases`
const releasePath = (appId: string, releaseId: string) =>
  `/api/apps/${encodeURIComponent(appId)}/releases/${encodeURIComponent(releaseId)}`

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
export const STATUS_WORDS: Record<ReleaseStatus, string> = {
  tagged: 'tagged',
  staging: 'deploying to staging',
  staging_active: 'live on staging',
  awaiting_approval: 'waiting for approval',
  promoting: 'deploying to production',
  production_active: 'live in production',
  rejected: 'rejected',
  failed: 'failed',
  rolled_back: 'rolled back',
}

/** The main-ahead line under the list (app page P3), or null when there is nothing to say. Pure. */
export function mainAheadSentence(compare: ReleaseCompare | null): string | null {
  if (!compare || compare.aheadBy === null || !compare.base) return null
  if (compare.aheadBy === 0) return `${compare.branch} has nothing new since ${compare.base}`
  const n = compare.aheadBy
  return `${compare.branch} is ${n} commit${n === 1 ? '' : 's'} ahead of ${compare.base}`
}

/** The main-ahead compare, or null — a failure here never fails the listing. */
async function readCompare(client: ApiClient, appId: string): Promise<ReleaseCompare | null> {
  try {
    return await client.get(`${releasesPath(appId)}/compare`, { schema: releaseCompareSchema })
  } catch {
    return null
  }
}

export async function runReleasesList(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('GET', releasesPath(detail.id), {
    schema: releaseListResponseSchema,
  })
  const compare = await readCompare(client, detail.id)
  const ahead = mainAheadSentence(compare)
  const rawObject = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  ctx.out.data({ ...rawObject, mainAhead: compare }, () => {
    const table = renderTable(data.items, [
      { header: 'Version', value: r => r.version },
      {
        header: 'Status',
        value: r =>
          r.failedStage
            ? `${STATUS_WORDS[r.status]} (${RELEASE_STAGE_LABELS[r.failedStage].toLowerCase()})`
            : r.rolledBackFrom && r.status === 'production_active'
              ? `${STATUS_WORDS[r.status]} (rolled back from ${r.rolledBackFrom})`
              : STATUS_WORDS[r.status],
      },
      { header: 'PRs', value: r => r.prs.length },
      { header: 'Commit', value: r => r.sha.slice(0, 7) },
      { header: 'Created', value: r => formatDate(r.createdAt) },
      { header: 'Id', value: r => r.id },
    ])
    if (!ahead) return table
    const next =
      compare?.aheadBy && detail.viewerCanDeploy
        ? chalk.dim(`  Release it: ${ctx.binName} releases create ${detail.slug}`)
        : null
    return [table, '', ahead, ...(next ? [next] : [])].join('\n')
  })
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

/** What a retry did, in one line. Pure. */
export function retrySentence(data: RetryReleaseResponse): string {
  const label = RELEASE_RETRY_LABELS[data.stage]
  switch (data.action) {
    case 'rerun':
      return `${label}: re-running the failed jobs on GitHub${data.attempt ? ` (attempt ${data.attempt})` : ''}`
    case 'retag':
      return `${label}: pushed the tag ${data.release.tag} again; staging deploys it next`
    case 'health_check':
      return `${label}: ${data.stage === 'production_health' ? 'production' : 'staging'} is ${data.health ?? 'not answering'}`
    case 'approval':
      return `${label}: asked for the production approval again`
  }
}

export async function runReleasesRetry(
  ctx: CommandContext,
  app: string,
  ref: string,
  options: { reason?: string } = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const release = await resolveRelease(client, detail.id, ref)
  if (!release.failedStage) {
    throw new CliError(
      `Release ${release.version} is ${STATUS_WORDS[release.status]}; nothing about it is failing`
    )
  }
  const reason = options.reason?.trim()
  const { data, raw } = await client.request(
    'POST',
    `${releasePath(detail.id, release.id)}/retry`,
    {
      schema: retryReleaseResponseSchema,
      // The stage this command saw: a release that moved on meanwhile is refused, not re-tried.
      body: { stage: release.failedStage, ...(reason ? { reason } : {}) },
    }
  )
  ctx.out.data(raw, () => {
    const lines = [`${chalk.green('✓')} ${retrySentence(data)}`]
    if (data.runUrl) lines.push(chalk.dim(`  ${data.runUrl}`))
    if (data.approvalId)
      lines.push(`  Another owner or admin approves it here: ${approvalUrl(ctx, data.approvalId)}`)
    return lines.join('\n')
  })
}

export async function runReleasesCancel(
  ctx: CommandContext,
  app: string,
  ref: string,
  options: ConfirmOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const release = await resolveRelease(client, detail.id, ref)
  const go = await confirmConsequence(
    ctx,
    options,
    `Cancel v${release.version}?`,
    'Launch cancels the deploy run on GitHub and marks the release failed. Nothing that already went live is undone; Retry runs it again later.'
  )
  if (!go) return
  const { data, raw } = await client.request(
    'POST',
    `${releasePath(detail.id, release.id)}/cancel`,
    { schema: cancelReleaseResponseSchema }
  )
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Cancelled the deploy run of ${chalk.bold(data.release.version)} on GitHub.`,
      chalk.dim(`  ${data.runUrl ?? ''}`),
      chalk.dim(
        `  Run it again: ${ctx.binName} releases retry ${detail.slug} ${data.release.version}`
      ),
    ].join('\n')
  )
}

/**
 * `releases rollback <app> <version>` (app page P3): put an EARLIER release that was live before
 * back on production. Opens the same `deploy.production` approval Ship does; once granted, Launch
 * runs the repo's own deploy workflow at that tag. Migrations and secrets do not revert.
 */
export async function runReleasesRollback(
  ctx: CommandContext,
  app: string,
  ref: string,
  options: { reason?: string } & ConfirmOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const release = await resolveRelease(client, detail.id, ref)
  const go = await confirmConsequence(
    ctx,
    options,
    `Roll Live back to v${release.version}?`,
    `Once the app’s approvers agree, Launch runs the repository’s own deploy workflow at the ${release.tag ?? `v${release.version}`} tag. Migrations and secrets don’t revert: database changes made since v${release.version} stay, and it runs with today’s config and secrets.`
  )
  if (!go) return
  const reason = options.reason?.trim()
  const { data, raw } = await client.request(
    'POST',
    `${releasePath(detail.id, release.id)}/rollback`,
    { schema: rollbackReleaseResponseSchema, body: reason ? { reason } : {} }
  )
  ctx.out.data(raw, () => {
    const lines =
      data.approvalStatus === 'approved'
        ? [
            `${chalk.green('✓')} Rolling production back from ${data.from} to ${chalk.bold(data.release.version)}: the deploy workflow runs at ${data.release.tag}.`,
          ]
        : [
            `${chalk.green('✓')} Asked to roll production back from ${data.from} to ${chalk.bold(data.release.version)}.`,
            `  Another owner or admin approves it here: ${approvalUrl(ctx, data.approvalId)}`,
          ]
    lines.push(chalk.dim('  Migrations and secrets do not revert with the code.'))
    return lines.join('\n')
  })
}

// ---- show, chain, promotion (issue #6) -----------------------------------------------------

/** A release in a few lines: status, commit, tag, PRs, error. Pure. */
export function releaseLines(release: Release): string[] {
  const status = release.failedStage
    ? `${STATUS_WORDS[release.status]} (${RELEASE_STAGE_LABELS[release.failedStage].toLowerCase()})`
    : release.rolledBackFrom && release.status === 'production_active'
      ? `${STATUS_WORDS[release.status]} (rolled back from ${release.rolledBackFrom})`
      : STATUS_WORDS[release.status]
  const lines = [
    `${chalk.bold(v(release.version))} · ${status}`,
    `  Tag       ${release.tag} at ${release.sha.slice(0, 7)}${release.previousTag ? ` (after ${release.previousTag})` : ''}`,
    `  Created   ${formatDate(release.createdAt)}`,
  ]
  if (release.approvalId) lines.push(`  Approval  ${release.approvalId}`)
  if (release.error) lines.push(chalk.red(`  ${release.error}`))
  lines.push(`  ${release.prs.length} pull request${release.prs.length === 1 ? '' : 's'}`)
  for (const pr of release.prs) lines.push(chalk.dim(`    #${pr.number} ${pr.title}`))
  return lines
}

export async function runReleasesShow(ctx: CommandContext, app: string, ref: string) {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const release = await resolveRelease(client, detail.id, ref)
  const { data, raw } = await client.request('GET', releasePath(detail.id, release.id), {
    schema: releaseSchema,
  })
  ctx.out.data(raw, () => {
    const lines = releaseLines(data)
    if (data.failedStage && detail.viewerCanDeploy)
      lines.push(
        chalk.dim(
          `  ${RELEASE_RETRY_LABELS[data.failedStage]}: ${ctx.binName} releases retry ${detail.slug} ${data.version}`
        )
      )
    lines.push(
      chalk.dim(`  How it got here: ${ctx.binName} releases chain ${detail.slug} ${data.version}`)
    )
    return lines.join('\n')
  })
}

export async function runReleasesChain(ctx: CommandContext, app: string, ref: string) {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const release = await resolveRelease(client, detail.id, ref)
  const { data, raw } = await client.request('GET', `${releasePath(detail.id, release.id)}/chain`, {
    schema: releaseChainSchema,
  })
  ctx.out.data(raw, () =>
    [
      `${chalk.bold(v(data.release.version))} · ${STATUS_WORDS[data.release.status]}`,
      '',
      renderTable(data.events, [
        { header: 'When', value: e => formatDate(e.at) },
        { header: 'What', value: e => e.action },
        { header: 'Who', value: e => e.actorEmail ?? e.actorType },
        { header: 'Approval', value: e => e.approvalId?.slice(0, 8) ?? null },
      ]),
    ].join('\n')
  )
}

/** "Ana", "Ana and Ben", "Ana, Ben and 3 others". */
function people(list: readonly { name: string | null; email: string }[], shown = 3): string {
  const names = list.map(p => p.name?.trim() || p.email)
  if (names.length <= 1) return names[0] ?? ''
  if (names.length <= shown) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  const rest = names.length - shown
  return `${names.slice(0, shown).join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`
}

/**
 * Where Staging → Live stands, worded as the app page's strip words it (`promotionModel.ts`):
 * "Ready to promote v1.4.2 to Live", "v1.4.2 is waiting for approval from Ana", "Deploying v1.4.2
 * to staging…", "v1.4.2 did not deploy: ci / Gate failed", "Live already runs v1.4.2". Pure.
 */
export function promotionSentence(view: AppPromotion, now: Date = new Date()): string {
  const release = view.candidate
  if (!release) return 'Nothing on staging yet'
  const ver = v(release.version)
  const run = view.candidateRun ?? null
  const didNotDeploy = () =>
    run && candidateRunFailed(run) && run.failedJob
      ? `${ver} did not deploy: ${run.failedJob} failed`
      : `${ver} did not deploy`
  switch (release.status) {
    case 'tagged':
    case 'staging': {
      if (run && candidateRunFailed(run)) return didNotDeploy()
      const inFlight = run && run.status !== 'completed'
      const stuck =
        now.getTime() - release.createdAt.getTime() >= RELEASE_STAGING_TIMEOUT_MINUTES * 60_000
      const job = run?.currentJob ? ` (running: ${run.currentJob})` : ''
      if (release.status === 'staging' && (inFlight || !stuck))
        return `Deploying ${ver} to staging…${job}`
      if (inFlight)
        return `${ver} is tagged — GitHub is checking it before it deploys to staging${job}`
      return stuck ? `${ver} never reached staging` : 'Staging is still deploying'
    }
    case 'awaiting_approval': {
      const who = view.approval?.approvers.length ? ` from ${people(view.approval.approvers)}` : ''
      return `${ver} is waiting for approval${who}`
    }
    case 'promoting':
      return `Deploying ${ver} to Live…`
    case 'production_active':
      return `${ver} is Live`
    case 'rolled_back':
      return `${ver} was rolled back; release a fix to ship again`
    case 'failed':
      return didNotDeploy()
    case 'staging_active':
    case 'rejected': {
      const production = view.production?.version ?? null
      if (production && compareReleaseVersions(production, release.version) >= 0)
        return `Live already runs ${v(production)}`
      const staging = view.staging
      if (!staging?.version) return 'Nothing on staging yet'
      if (staging.version !== release.version)
        return `Staging runs ${v(staging.version)}, not ${ver}`
      if (staging.healthStatus === 'unknown')
        return 'Staging has not been checked since it was deployed'
      if (staging.healthStatus !== 'up') return 'Staging is unhealthy'
      return `Ready to promote ${ver} to Live${release.status === 'rejected' ? ' (asked before, rejected)' : ''}`
    }
  }
}

/** The strip in lines: each environment, the candidate's state, the changes, a pending rollback. */
export function promotionLines(view: AppPromotion, now: Date = new Date()): string[] {
  const lines: string[] = []
  for (const [name, env] of [
    ['staging', view.staging],
    ['production', view.production],
  ] as const) {
    if (!env) continue
    const version = env.version ? v(env.version) : 'nothing deployed'
    const back = env.rolledBackFrom ? ` (rolled back from ${v(env.rolledBackFrom)})` : ''
    const health = healthLine({
      healthStatus: env.healthStatus,
      healthVersion: null,
      healthLatencyMs: null,
      healthError: null,
    })
    const when = env.deployedAt ? ` · since ${formatDate(env.deployedAt)}` : ''
    lines.push(`  ${ENVIRONMENT_LABELS[name].padEnd(8)}${version}${back} · ${health}${when}`)
  }
  lines.push(`  ${promotionSentence(view, now)}`)
  if (view.candidateRun?.url) lines.push(chalk.dim(`    ${view.candidateRun.url}`))
  if (view.rollback) {
    const who = view.rollback.approval.approvers.length
      ? ` from ${people(view.rollback.approval.approvers)}`
      : ''
    lines.push(
      `  Rollback to ${v(view.rollback.version)}${view.rollback.from ? ` (from ${v(view.rollback.from)})` : ''} is waiting for approval${who}`
    )
  }
  if (view.changes.length > 0) {
    const n = view.changes.length
    lines.push(
      `  ${n}${view.changesTruncated ? '+' : ''} ${n === 1 && !view.changesTruncated ? 'change' : 'changes'} not live:`
    )
    for (const c of view.changes)
      lines.push(chalk.dim(`    ${v(c.version)} #${c.number} ${c.sessionTitle ?? c.title}`))
  }
  return lines
}

export async function runReleasesPromotion(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request(
    'GET',
    `/api/apps/${encodeURIComponent(detail.id)}/promotion`,
    { schema: appPromotionSchema }
  )
  ctx.out.data(raw, () => {
    const lines = [
      `${chalk.bold(detail.displayName)} ${chalk.dim(`(${detail.slug})`)}`,
      ...promotionLines(data),
    ]
    const sentence = promotionSentence(data)
    if (data.candidate && sentence.startsWith('Ready to promote') && detail.viewerCanDeploy)
      lines.push(
        chalk.dim(
          `  Promote it: ${ctx.binName} releases promote ${detail.slug} ${data.candidate.version}`
        )
      )
    if (data.approval?.status === 'pending')
      lines.push(chalk.dim(`  ${approvalUrl(ctx, data.approval.id)}`))
    return lines.join('\n')
  })
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
    .command('show <app> <release>')
    .description('one release (id or version): status, tag, pull requests, where it is stuck')
    .action(action((ctx, cmd) => runReleasesShow(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '')))
  releases
    .command('chain <app> <release>')
    .description(
      'how a release (id or version) got where it is: PR → tag → staging → approval → Live'
    )
    .action(action((ctx, cmd) => runReleasesChain(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '')))
  releases
    .command('promotion <app>')
    .description(
      'Staging → Live: what each runs, the newest release and whether it can be promoted'
    )
    .action(action((ctx, cmd) => runReleasesPromotion(ctx, cmd.args[0] ?? '')))
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
  releases
    .command('retry <app> <release>')
    .description('retry whatever a release (id or version) is stuck at (owners and admins)')
    .option('--reason <text>', 'why — shown on a re-requested approval')
    .action(
      action((ctx, cmd) => runReleasesRetry(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', cmd.opts()))
    )
  releases
    .command('rollback <app> <release>')
    .description('roll production back to an earlier release (id or version) (owners and admins)')
    .option('--reason <text>', 'why — shown to the approvers')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(
      action((ctx, cmd) =>
        runReleasesRollback(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', cmd.opts())
      )
    )
  releases
    .command('cancel <app> <release>')
    .description(
      'cancel a release’s deploy run in flight on GitHub (owners and admins; asks first)'
    )
    .option('-y, --yes', 'do not ask for confirmation')
    .action(
      action((ctx, cmd) => runReleasesCancel(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', cmd.opts()))
    )
}
