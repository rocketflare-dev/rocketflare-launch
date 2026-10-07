/**
 * `launch apps …` that CHANGE an app (issue #6) — the app page's and the catalogue's buttons, over
 * `/api/apps` with the same `@launch/shared` contracts the routes validate with. Every body is
 * checked before it is sent (exit 1 listing the issues); a refusal is the server's sentence (exit
 * 1); a 403 exits 3; `--json` prints the parsed body.
 *
 * - `create <name> [--slug] [--description] [--team] [--no-deploy-staging] [--data] [--follow]` —
 *   "Create app": the slug is suggested from the name as the dialog does; below the `app.create`
 *   role the answer is an approval to wait on. `--follow` polls the launch run step by step to
 *   its end (exit 1 when it fails).
 * - `import <owner/name> [--ref] [--team]` — "Import app" (admins).
 * - `set <app> [--name] [--description] [--team] [--data]` — `PATCH /:id` (admins).
 * - `ship-settings <app> [--ship staging|pr] [--review none|app_owners|groups] [--review-team …]`
 *   — where a session's Ship ends and who reviews it (owners and admins); no flag prints it.
 * - `branch-protection <app> [--apply]` — how GitHub protects the default branch; `--apply` sets
 *   Launch's ruleset (admins).
 * - `teardown <app> [--delete-repo] [--yes] [--follow]` — "Archive app": says what it deletes and
 *   refuses without `--yes` or a confirmed prompt.
 * - `sign-in show|register|rotate-secret|redirect-uris <app>` — the app's OIDC client. The secret
 *   is printed ONCE, by `register` and `rotate-secret` (Launch keeps only a hash), never logged.
 * - `thumbnail get <app> --out <file>` / `thumbnail refresh <app>`.
 *
 * `apps.ts` calls `registerAppsManageCommands(apps, action)` from its own registration.
 */

import { approvalPath } from '@launch/shared/launch-approvals'
import {
  type AppBranchProtection,
  type AppDetail,
  type AppOidcClient,
  type AppOidcClientSecretResponse,
  appBranchProtectionSchema,
  appDetailSchema,
  appOidcClientResponseSchema,
  appOidcClientSecretResponseSchema,
  appThumbnailRefreshResponseSchema,
  importAppRequestSchema,
  putAppShipSettingsRequestSchema,
  SESSION_SHIP_MODES,
  SHIP_REVIEW_MODES,
  updateAppRedirectUrisRequestSchema,
  updateAppRequestSchema,
} from '@launch/shared/launch-apps'
import {
  createAppRequestSchema,
  createAppResponseSchema,
  type PipelineKind,
  type PipelineView,
  pipelineViewSchema,
  teardownRequestSchema,
  teardownResponseSchema,
} from '@launch/shared/launch-pipeline'
import chalk from 'chalk'
import type { Command } from 'commander'
import type { ApiClient } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import {
  asObject,
  type ConfirmOptions,
  confirmAction,
  downloadToFile,
  listOption,
  oneOf,
  parseBody,
  readDataArg,
} from '../utils/input'
import { formatDate } from '../utils/output'
import { ENVIRONMENT_LABELS } from './app-words'
import { pipelineStepLines } from './apps'

const appPath = (id: string) => `/api/apps/${encodeURIComponent(id)}`
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function resolveApp(client: ApiClient, app: string): Promise<AppDetail> {
  if (!app.trim()) throw new CliError('Give an app slug')
  return client.get(appPath(app.trim()), { schema: appDetailSchema })
}

const webUrl = (ctx: CommandContext, path: string) =>
  `${ctx.config.serverUrl.replace(/\/+$/, '')}${path}`

/** `--data` merged under the flags (a flag wins). */
async function baseBody(data: string | undefined, readStdin?: () => Promise<string>) {
  return data === undefined ? {} : asObject(await readDataArg(data, { readStdin }))
}

const defined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/** `none` / blank → null (clear it), otherwise the value. */
const orNull = (value: string | undefined) =>
  value === undefined ? undefined : value.trim() === '' || value === 'none' ? null : value

// ---- following a pipeline run --------------------------------------------------------------

export interface FollowOptions {
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  now?: () => number
}

/**
 * Poll `GET /:id/pipeline?kind=` until the run `runId` ends, printing each step as its status
 * changes. Exit 1 when it fails (its error, and the retry command) or the wait runs out.
 */
export async function followPipeline(
  ctx: CommandContext,
  client: ApiClient,
  app: { id: string; slug: string },
  kind: PipelineKind,
  runId: string,
  options: FollowOptions = {}
): Promise<PipelineView> {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeoutMs ?? 60 * 60_000)
  const seen = new Map<string, string>()
  let view: PipelineView | null = null
  while (true) {
    view = await client.get(`${appPath(app.id)}/pipeline`, {
      schema: pipelineViewSchema,
      query: { kind },
    })
    // The page's query may still hold an older run for a moment: wait for ours.
    if (view.runId === runId) {
      for (const step of view.steps) {
        if (step.status === 'pending' || seen.get(step.step) === step.status) continue
        seen.set(step.step, step.status)
        ctx.out.text(pipelineStepLines(step).join('\n'))
      }
      if (view.status === 'succeeded') return view
      if (view.status === 'failed') {
        const failed = view.steps.find(s => s.status === 'failed')
        const flag = kind === 'create' ? '' : ' --kind teardown'
        throw new CliError(
          `The ${kind === 'create' ? 'launch' : 'teardown'} of ${app.slug} failed${failed ? ` at “${failed.label}”` : ''}${failed?.error ? `: ${failed.error}` : ''}`,
          {
            hint: `Retry from the failed step: ${ctx.binName} apps pipeline retry ${app.slug}${flag}`,
          }
        )
      }
    }
    if (now() >= deadline) {
      throw new CliError(`${app.slug}'s ${kind} run is still going`, {
        hint: `It carries on. Follow it: ${ctx.binName} apps pipeline ${app.slug}${kind === 'create' ? '' : ' --kind teardown'}`,
      })
    }
    await sleep(options.pollMs ?? 3000)
  }
}

// ---- create / import -----------------------------------------------------------------------

/** A slug suggested from the display name, as the create dialog suggests it. Pure. */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

export interface AppsCreateOptions extends FollowOptions {
  slug?: string
  description?: string
  team?: string
  deployStaging?: boolean
  data?: string
  follow?: boolean
  readStdin?: () => Promise<string>
}

export async function runAppsCreate(
  ctx: CommandContext,
  name: string | undefined,
  options: AppsCreateOptions = {}
): Promise<void> {
  const base = await baseBody(options.data, options.readStdin)
  const displayName = name?.trim() || (base.displayName as string | undefined)
  const merged: Record<string, unknown> = {
    ...base,
    ...defined({
      displayName,
      slug: options.slug ?? base.slug ?? (displayName ? slugFromName(displayName) : undefined),
      description: options.description,
      ownerGroupId: options.team,
    }),
  }
  if (options.deployStaging === false)
    merged.options = { ...asObject(base.options ?? {}, 'options'), deployStaging: false }
  const body = parseBody(createAppRequestSchema, merged)

  const client = requireClient(ctx)
  const { data, raw } = await client.request('POST', '/api/apps', {
    schema: createAppResponseSchema,
    body,
  })
  const { app, approvalId, runId } = data
  const waiting = Boolean(approvalId)
  if (!options.follow || waiting) {
    ctx.out.data(raw, () =>
      waiting
        ? [
            `${chalk.green('✓')} Asked to create ${app.displayName} — an administrator has to approve it.`,
            chalk.dim(`  The request: ${ctx.binName} approvals show ${approvalId}`),
            chalk.dim(`  ${webUrl(ctx, approvalPath(approvalId as string))}`),
          ].join('\n')
        : [
            `${chalk.green('✓')} Launching ${app.displayName} (${app.slug}).`,
            chalk.dim(`  Follow it: ${ctx.binName} apps pipeline ${app.slug}`),
          ].join('\n')
    )
    return
  }
  ctx.out.text(`Launching ${app.displayName} (${app.slug})…`)
  const pipeline = await followPipeline(ctx, client, app, 'create', runId, options)
  ctx.out.data({ ...asObject(raw, 'response'), pipeline }, () =>
    [
      `${chalk.green('✓')} ${app.displayName} is launched.`,
      chalk.dim(`  ${ctx.binName} apps show ${app.slug}`),
    ].join('\n')
  )
}

export async function runAppsImport(
  ctx: CommandContext,
  repo: string,
  options: { ref?: string; team?: string } = {}
): Promise<void> {
  const body = parseBody(
    importAppRequestSchema,
    defined({ repo, ref: options.ref, ownerGroupId: options.team })
  )
  const client = requireClient(ctx)
  const { data, raw } = await client.request('POST', '/api/apps/import', {
    schema: appDetailSchema,
    body,
  })
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Imported ${data.displayName} (${data.slug}) from ${body.repo}.`,
      chalk.dim(`  ${ctx.binName} apps show ${data.slug}`),
    ].join('\n')
  )
}

// ---- set / ship settings / branch protection -----------------------------------------------

export async function runAppsSet(
  ctx: CommandContext,
  app: string,
  options: {
    name?: string
    description?: string
    team?: string
    data?: string
    readStdin?: () => Promise<string>
  } = {}
): Promise<void> {
  const base = await baseBody(options.data, options.readStdin)
  const body = parseBody(updateAppRequestSchema, {
    ...base,
    ...defined({
      displayName: options.name,
      description: orNull(options.description),
      ownerGroupId: orNull(options.team),
    }),
  })
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('PATCH', `${appPath(detail.id)}`, {
    schema: appDetailSchema,
    body,
  })
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Saved ${data.displayName} (${data.slug}).`,
      `  Description  ${data.description ?? '—'}`,
      `  Team         ${data.ownerGroup?.name ?? 'No team yet'}`,
    ].join('\n')
  )
}

const SHIP_WORDS = {
  staging: 'Ship merges, releases and deploys to Staging',
  pr: 'Ship opens a pull request and leaves it for a person',
} as const
const REVIEW_WORDS = {
  none: 'no review',
  app_owners: 'the app’s owners review the merge',
  groups: 'named teams review the merge',
} as const

function shipSettingsLines(detail: AppDetail): string[] {
  const s = detail.shipSettings
  const teams = s.review.mode === 'groups' ? ` (${s.review.groupIds.join(', ')})` : ''
  const policy = detail.shipReviewSetBy === 'policy' ? ' — set by an approval policy' : ''
  return [
    `  Ship    ${s.sessionShip} · ${SHIP_WORDS[s.sessionShip]}`,
    `  Review  ${s.review.mode} · ${REVIEW_WORDS[s.review.mode]}${teams}${policy}`,
  ]
}

export async function runAppsShipSettings(
  ctx: CommandContext,
  app: string,
  options: {
    ship?: (typeof SESSION_SHIP_MODES)[number]
    review?: (typeof SHIP_REVIEW_MODES)[number]
    reviewTeam?: string[]
    data?: string
    readStdin?: () => Promise<string>
  } = {}
): Promise<void> {
  const client = requireClient(ctx)
  const changing =
    options.ship !== undefined ||
    options.review !== undefined ||
    options.reviewTeam !== undefined ||
    options.data !== undefined
  if (!changing) {
    const detail = await resolveApp(client, app)
    ctx.out.data(
      {
        shipSettings: detail.shipSettings,
        shipReviewSetBy: detail.shipReviewSetBy,
      },
      () => [`${chalk.bold(detail.slug)} ship settings`, ...shipSettingsLines(detail)].join('\n')
    )
    return
  }
  const base = await baseBody(options.data, options.readStdin)
  const detail = await resolveApp(client, app)
  // The stored settings are the base, as the card sends them: an admin policy's review goes back
  // unchanged (changing it is the server's 409 `ship_review_set_by_policy`).
  const stored = detail.shipSettings
  const review = { ...stored.review, ...asObject(base.review ?? {}, 'review') }
  if (options.review) review.mode = options.review
  if (options.reviewTeam) review.groupIds = options.reviewTeam
  if (review.mode !== 'groups' && !options.reviewTeam && !base.review) review.groupIds = []
  const body = parseBody(putAppShipSettingsRequestSchema, {
    ...stored,
    ...base,
    ...defined({ sessionShip: options.ship }),
    review,
  })
  const { data, raw } = await client.request('PUT', `${appPath(detail.id)}/ship-settings`, {
    schema: appDetailSchema,
    body,
  })
  ctx.out.data(raw, () =>
    [`${chalk.green('✓')} Saved ${data.slug}'s ship settings.`, ...shipSettingsLines(data)].join(
      '\n'
    )
  )
}

/** The branch protection in lines, as the card says it. Pure. */
export function branchProtectionLines(bp: AppBranchProtection): string[] {
  const words: Record<AppBranchProtection['state'], string> = {
    ok: 'Protected: Launch’s ruleset requires the Gate check and Launch may bypass it',
    none: 'Nothing protects the default branch',
    blocks: 'A rule would stop Launch’s release from landing',
    unavailable: 'This repository’s plan has no rulesets',
    unknown: 'GitHub could not be asked',
  }
  const lines = [`  State           ${bp.state} · ${words[bp.state]}`]
  lines.push(`  Required checks ${bp.requiredChecks.length ? bp.requiredChecks.join(', ') : '—'}`)
  lines.push(`  Launch bypasses ${bp.appCanBypass ? 'yes' : 'no'}`)
  if (bp.rulesetId) lines.push(`  Ruleset         #${bp.rulesetId}`)
  if (bp.gateVariable)
    lines.push(
      `  Gate variable   ${bp.gateVariable.state}${bp.gateVariable.value ? ` (${bp.gateVariable.value})` : ''}`
    )
  if (bp.detail) lines.push(chalk.yellow(`  ${bp.detail}`))
  if (bp.gateVariable?.detail) lines.push(chalk.yellow(`  ${bp.gateVariable.detail}`))
  return lines
}

export async function runAppsBranchProtection(
  ctx: CommandContext,
  app: string,
  options: { apply?: boolean } = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = options.apply
    ? await client.request('POST', `${appPath(detail.id)}/branch-protection`, {
        schema: appBranchProtectionSchema,
      })
    : await client.request('GET', `${appPath(detail.id)}/branch-protection`, {
        schema: appBranchProtectionSchema,
      })
  ctx.out.data(raw, () => {
    const head = options.apply
      ? `${chalk.green('✓')} Applied Launch’s ruleset to ${detail.slug}.`
      : `${chalk.bold(detail.slug)} · ${detail.defaultBranch ?? 'default branch'}`
    const lines = [head, ...branchProtectionLines(data)]
    if (!options.apply && data.state !== 'ok')
      lines.push(
        chalk.dim(
          `  Apply Launch’s ruleset: ${ctx.binName} apps branch-protection ${detail.slug} --apply`
        )
      )
    return lines.join('\n')
  })
}

// ---- teardown ------------------------------------------------------------------------------

/** What an archive deletes — the teardown dialog's list. */
export const TEARDOWN_DELETES = [
  'The staging and production Workers and their routes',
  'The database — every row, on both branches',
  'File buckets, queues and KV namespaces',
  'The email sending keys',
]

export interface AppsTeardownOptions extends FollowOptions, ConfirmOptions {
  deleteRepo?: boolean
  follow?: boolean
}

export async function runAppsTeardown(
  ctx: CommandContext,
  app: string,
  options: AppsTeardownOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const body = parseBody(teardownRequestSchema, {
    confirmSlug: detail.slug,
    deleteRepo: Boolean(options.deleteRepo),
  })
  const repo = detail.repoOwner && detail.repoName ? `${detail.repoOwner}/${detail.repoName}` : null
  ctx.log.warn(
    `Archiving ${detail.displayName} deletes what Launch created for it, and cannot be undone:`
  )
  for (const item of TEARDOWN_DELETES) ctx.log.hint(`- ${item}`)
  if (repo)
    ctx.log.hint(
      `- The repository ${repo} is ${options.deleteRepo ? 'DELETED' : 'archived (read-only)'}`
    )
  ctx.log.hint('Its sign-in client is disabled; the app stays in the catalogue as archived.')
  const go = await confirmAction(
    `Archive ${detail.slug}?`,
    options,
    `Refusing to archive ${detail.slug} without confirmation`
  )
  if (!go) {
    ctx.log.info('Nothing was archived.')
    return
  }
  const { data, raw } = await client.request('POST', `${appPath(detail.id)}/teardown`, {
    schema: teardownResponseSchema,
    body,
  })
  if (!options.follow) {
    ctx.out.data(raw, () =>
      [
        `${chalk.green('✓')} Archiving ${detail.displayName}.`,
        chalk.dim(`  Follow it: ${ctx.binName} apps pipeline ${detail.slug} --kind teardown`),
      ].join('\n')
    )
    return
  }
  ctx.out.text(`Archiving ${detail.displayName}…`)
  const pipeline = await followPipeline(ctx, client, detail, 'teardown', data.runId, options)
  ctx.out.data(
    { ...asObject(raw, 'response'), pipeline },
    () => `${chalk.green('✓')} ${detail.displayName} is archived.`
  )
}

// ---- sign-in (the app's OIDC client) -------------------------------------------------------

function clientLines(client: AppOidcClient): string[] {
  const secret = client.secretRotatedAt
    ? `rotated ${formatDate(client.secretRotatedAt)}`
    : `set ${formatDate(client.createdAt)}`
  const list = (uris: string[]) => (uris.length ? uris.join('\n                 ') : '—')
  return [
    `  Client id      ${client.clientId}`,
    `  Secret         ${client.secretHint}… · ${secret}`,
    `  Redirect URIs  ${list(client.redirectUris)}`,
    `  Post-logout    ${list(client.postLogoutRedirectUris)}`,
    `  Who may sign in ${client.accessPolicy === 'restricted' ? 'restricted' : 'whole company'}`,
    ...(client.disabledAt ? [chalk.yellow(`  Disabled ${formatDate(client.disabledAt)}`)] : []),
  ]
}

export async function runAppsSignInShow(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('GET', `${appPath(detail.id)}/oidc-client`, {
    schema: appOidcClientResponseSchema,
  })
  ctx.out.data(raw, () =>
    data.client
      ? [`${chalk.bold(detail.slug)} · sign-in through Launch`, ...clientLines(data.client)].join(
          '\n'
        )
      : [
          `${detail.slug} has no sign-in client yet.`,
          chalk.dim(`  Register one: ${ctx.binName} apps sign-in register ${detail.slug}`),
        ].join('\n')
  )
}

/** The one place a client secret is printed: stdout, once; the warning on stderr. */
function printSecret(ctx: CommandContext, raw: unknown, data: AppOidcClientSecretResponse) {
  ctx.log.warn('The client secret is shown ONCE — Launch keeps only a hash. Store it now.')
  ctx.out.data(raw, () =>
    [
      `  Issuer         ${data.issuer}`,
      `  Client id      ${data.clientId}`,
      `  Client secret  ${data.clientSecret}`,
      '',
      data.snippet,
    ].join('\n')
  )
}

export async function runAppsSignInRegister(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('POST', `${appPath(detail.id)}/oidc-client`, {
    schema: appOidcClientSecretResponseSchema,
  })
  ctx.log.success(`Registered ${detail.slug}'s sign-in client.`)
  printSecret(ctx, raw, data)
}

export async function runAppsSignInRotate(
  ctx: CommandContext,
  app: string,
  options: ConfirmOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  ctx.log.warn(
    'The current secret stops working immediately. The app cannot sign anyone in until you set the new one on both environments.'
  )
  const go = await confirmAction(
    `Rotate ${detail.slug}'s client secret?`,
    options,
    `Refusing to rotate ${detail.slug}'s secret without confirmation`
  )
  if (!go) {
    ctx.log.info('Nothing was rotated.')
    return
  }
  const { data, raw } = await client.request(
    'POST',
    `${appPath(detail.id)}/oidc-client/rotate-secret`,
    { schema: appOidcClientSecretResponseSchema }
  )
  ctx.log.success(`Rotated ${detail.slug}'s client secret.`)
  printSecret(ctx, raw, data)
}

export async function runAppsSignInRedirectUris(
  ctx: CommandContext,
  app: string,
  options: {
    redirect?: string[]
    logout?: string[]
    data?: string
    readStdin?: () => Promise<string>
  } = {}
): Promise<void> {
  const base = await baseBody(options.data, options.readStdin)
  const body = parseBody(updateAppRedirectUrisRequestSchema, {
    ...base,
    ...defined({ redirectUris: options.redirect, postLogoutRedirectUris: options.logout }),
  })
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request(
    'PATCH',
    `${appPath(detail.id)}/oidc-client/redirect-uris`,
    { schema: appOidcClientResponseSchema, body }
  )
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Saved ${detail.slug}'s redirect URIs.`,
      ...(data.client ? clientLines(data.client) : []),
    ].join('\n')
  )
}

// ---- thumbnail -----------------------------------------------------------------------------

export async function runAppsThumbnailGet(
  ctx: CommandContext,
  app: string,
  options: { out: string; force?: boolean }
): Promise<void> {
  if (!options.out) throw new CliError('--out <file> is required')
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const download = await client.download(`${appPath(detail.id)}/thumbnail`)
  const bytes = await downloadToFile(download, options.out, options.force)
  ctx.out.data(
    { path: options.out, bytes, contentType: download.contentType },
    () =>
      `${chalk.green('✓')} Saved ${bytes} bytes${download.contentType ? ` (${download.contentType})` : ''} to ${options.out}`
  )
}

export async function runAppsThumbnailRefresh(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await client.request('POST', `${appPath(detail.id)}/thumbnail/refresh`, {
    schema: appThumbnailRefreshResponseSchema,
  })
  ctx.out.data(raw, () =>
    data.queued.length
      ? `${chalk.green('✓')} Queued a new picture of ${data.queued.map(e => ENVIRONMENT_LABELS[e]).join(' and ')}. It replaces the old one when it lands.`
      : `${detail.slug} has no environment with an address to capture.`
  )
}

// ---- registration --------------------------------------------------------------------------

const shipOption = oneOf('--ship', SESSION_SHIP_MODES)
const reviewOption = oneOf('--review', SHIP_REVIEW_MODES)

export function registerAppsManageCommands(apps: Command, action: ActionWrapper): void {
  apps
    .command('create [name]')
    .description('create an app: scaffold, provision and (by default) deploy Staging')
    .option('--slug <slug>', 'the app’s slug (default: from the name) — it names its hostnames')
    .option('--description <text>', 'what the app is for')
    .option('--team <groupId>', 'the owner team (a group id — `launch groups list`)')
    .option('--no-deploy-staging', 'do not deploy Staging as part of the launch')
    .option('--data <json|@file|->', 'the request body as JSON (flags win)')
    .option('--follow', 'follow the launch step by step until it ends')
    .action(action((ctx, cmd) => runAppsCreate(ctx, cmd.args[0], cmd.opts())))
  apps
    .command('import <repo>')
    .description('import an existing app from its repository, owner/name (admins)')
    .option('--ref <ref>', 'a branch, tag or commit (default: the default branch)')
    .option('--team <groupId>', 'the owner team (a group id)')
    .action(action((ctx, cmd) => runAppsImport(ctx, cmd.args[0] ?? '', cmd.opts())))
  apps
    .command('set <app>')
    .description('change an app’s name, description or owner team (admins)')
    .option('--name <name>', 'the display name')
    .option('--description <text>', 'the description ("" clears it)')
    .option('--team <groupId|none>', 'the owner team ("none" clears it)')
    .option('--data <json|@file|->', 'the request body as JSON (flags win)')
    .action(action((ctx, cmd) => runAppsSet(ctx, cmd.args[0] ?? '', cmd.opts())))
  apps
    .command('ship-settings <app>')
    .description('where a session’s Ship ends and who reviews the merge (no flag: show them)')
    .option('--ship <mode>', 'staging | pr', shipOption)
    .option('--review <mode>', 'none | app_owners | groups', reviewOption)
    .option('--review-team <groupId,…>', 'the teams that review (with --review groups)', listOption)
    .option('--data <json|@file|->', 'the settings as JSON (flags win)')
    .action(action((ctx, cmd) => runAppsShipSettings(ctx, cmd.args[0] ?? '', cmd.opts())))
  apps
    .command('branch-protection <app>')
    .description('how GitHub protects the default branch; --apply sets Launch’s ruleset (admins)')
    .option('--apply', 'apply Launch’s ruleset and the gate variable')
    .action(action((ctx, cmd) => runAppsBranchProtection(ctx, cmd.args[0] ?? '', cmd.opts())))
  apps
    .command('teardown <app>')
    .description('archive an app: delete its Workers, database and storage (admins; asks first)')
    .option('--delete-repo', 'delete the GitHub repository instead of archiving it')
    .option('-y, --yes', 'do not ask')
    .option('--follow', 'follow the teardown step by step until it ends')
    .action(action((ctx, cmd) => runAppsTeardown(ctx, cmd.args[0] ?? '', cmd.opts())))

  const signIn = apps
    .command('sign-in')
    .description('the app’s sign-in through Launch (its OIDC client)')
  signIn
    .command('show <app>')
    .description('the client: id, secret hint, redirect URIs')
    .action(action((ctx, cmd) => runAppsSignInShow(ctx, cmd.args[0] ?? '')))
  signIn
    .command('register <app>')
    .description('register a client; prints its secret ONCE (admins)')
    .action(action((ctx, cmd) => runAppsSignInRegister(ctx, cmd.args[0] ?? '')))
  signIn
    .command('rotate-secret <app>')
    .description('a new secret; the old one stops working at once (admins; asks first)')
    .option('-y, --yes', 'do not ask')
    .action(action((ctx, cmd) => runAppsSignInRotate(ctx, cmd.args[0] ?? '', cmd.opts())))
  signIn
    .command('redirect-uris <app>')
    .description('replace the redirect URIs (admins)')
    .option('--redirect <uri,…>', 'redirect URIs (repeatable)', listOption)
    .option('--logout <uri,…>', 'post-logout redirect URIs (repeatable)', listOption)
    .option('--data <json|@file|->', 'the request body as JSON (flags win)')
    .action(action((ctx, cmd) => runAppsSignInRedirectUris(ctx, cmd.args[0] ?? '', cmd.opts())))

  const thumbnail = apps.command('thumbnail').description('the app’s picture in the catalogue')
  thumbnail
    .command('get <app>')
    .description('download the picture (Live’s, else Staging’s)')
    .requiredOption('--out <file>', 'where to save it')
    .option('--force', 'replace the file if it exists')
    .action(action((ctx, cmd) => runAppsThumbnailGet(ctx, cmd.args[0] ?? '', cmd.opts())))
  thumbnail
    .command('refresh <app>')
    .description('capture a new picture of every environment (admins; once a minute)')
    .action(action((ctx, cmd) => runAppsThumbnailRefresh(ctx, cmd.args[0] ?? '')))
}
