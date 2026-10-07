/**
 * `launch shared ls|show|set|rotate|pushes` — shared config from the terminal (Launch P5, plan §4
 * 5f), over `/api/shared-resources` and `@launch/shared/launch-grants`.
 *
 * - `ls` — every resource: owner team, items, and per environment "v3 · 2 apps" or "not set".
 * - `show <slug>` — one resource: items, each environment's version line, the var values and the
 *   holders (both for the owner team and admins only — the server decides), running pushes.
 * - `set <slug> --env <env> [--wait]` — write a new version. Values come from a HIDDEN TTY prompt
 *   (one per item; Enter keeps what is set) or, when stdin is not a terminal, from stdin as
 *   `KEY=value` lines or one JSON object — **never argv**, where they would land in the shell
 *   history and `ps`. Nothing ever prints a value back. When apps hold the environment the server
 *   starts a rotation push; `--wait` follows it.
 * - `rotate <slug> --env <env>` — `set`, then follow the push it starts (the same as `set --wait`,
 *   named for what the owner team is doing).
 * - `pushes <slug> [--env] [--wait]` — the push history (owners and admins); `--wait` follows the
 *   running one to the end and exits 1 when it partly or wholly failed, naming the apps.
 * - `retry <slug> <push> [--wait]` (issue #6) — retry the apps a push failed on.
 * - `create|edit|archive` (issue #6) — the resource itself, in `shared-manage.ts`.
 *
 * Following POLLS the push (`GET …/pushes/:id`) — `api.ts` stays the one fetch site — with an
 * injectable `sleep` / `pollMs`, the sessions and releases pattern. With `--json` a follow prints
 * ONE document at the end.
 *
 * Slice 5f owns this file. `cli.ts` calls `registerSharedCommands(program, action)` once, after the
 * kit's own commands, so this file adds its `program.command(...)` entries and never edits
 * `cli.ts` (the plugin `register` shape, `plugins/types.ts`).
 */
import { APP_ENVIRONMENT_NAMES, type AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  type GrantPush,
  type GrantPushStatus,
  grantPushListResponseSchema,
  grantPushSchema,
  isActiveGrantPush,
  putSharedResourceValuesResponseSchema,
  putSharedResourceValuesSchema,
  type SharedResource,
  type SharedResourceDetail,
  type SharedResourceEnvironment,
  sharedResourceDetailSchema,
  sharedResourceListResponseSchema,
  sharedResourcePath,
} from '@launch/shared/launch-grants'
import chalk from 'chalk'
import { type Command, InvalidArgumentError } from 'commander'
import type { ApiClient } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { promptHiddenOnTerminal, readAllStdin } from '../utils/input'
import { formatDate, renderTable } from '../utils/output'
import { registerSharedManageCommands } from './shared-manage'

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const base = '/api/shared-resources'
const resourceApiPath = (id: string) => `/api/shared-resources/${encodeURIComponent(id)}`

/** The web page for a resource. */
export function sharedResourceUrl(ctx: CommandContext, id: string): string {
  return `${ctx.config.serverUrl.replace(/\/+$/, '')}${sharedResourcePath(id)}`
}

/** A resource by id, or by slug looked up in the list every member may read. */
export async function resolveResource(
  client: ApiClient,
  ref: string
): Promise<SharedResourceDetail> {
  const wanted = ref.trim()
  if (!wanted) throw new CliError('Give a secret’s slug')
  let id = wanted
  if (!UUID.test(wanted)) {
    // The live list first; an archived resource is still addressable (`show` explains it).
    let match: SharedResource | undefined
    for (const archived of [undefined, 'true']) {
      const list = await client.get(base, {
        schema: sharedResourceListResponseSchema,
        query: { archived },
      })
      match = list.items.find(r => r.slug === wanted)
      if (match) break
    }
    if (!match) {
      throw new CliError(`No secret "${wanted}"`, {
        hint: 'List them with `launch shared ls`.',
      })
    }
    id = match.id
  }
  return client.get(resourceApiPath(id), { schema: sharedResourceDetailSchema })
}

// ---- words ---------------------------------------------------------------------------------

function envOf(resource: Pick<SharedResource, 'environments'>, env: AppEnvironmentName) {
  return resource.environments.find(e => e.environment === env) ?? null
}

/** "v3 · 2 apps" / "not set". */
function envCell(env: SharedResourceEnvironment | null): string {
  if (!env || env.version === null) return 'not set'
  const apps = `${env.holderCount} app${env.holderCount === 1 ? '' : 's'}`
  const due = env.rotationDue.length ? ' · rotation due' : ''
  return `v${env.version} · ${apps}${due}`
}

/** "set — version 3, rotated 2026-09-28 10:00 by Carol" — the most anyone sees of a value. */
export function valueLine(env: SharedResourceEnvironment | null): string {
  if (!env || env.version === null) return 'not set'
  const when = env.setAt ? `${env.version === 1 ? 'set' : 'rotated'} ${formatDate(env.setAt)}` : ''
  const who = env.setBy ? ` by ${env.setBy.name ?? env.setBy.email}` : ''
  return `set — version ${env.version}${when ? `, ${when}` : ''}${who}`
}

const PUSH_WORDS: Record<GrantPushStatus, string> = {
  queued: 'queued',
  running: 'pushing',
  succeeded: 'done',
  partial: 'partly failed',
  failed: 'failed',
}

function pushLine(push: Pick<GrantPush, 'succeeded' | 'failed' | 'total'>): string {
  const failed = push.failed ? `, ${push.failed} failed` : ''
  return `${push.succeeded} of ${push.total} app${push.total === 1 ? '' : 's'} updated${failed}`
}

// ---- values input --------------------------------------------------------------------------

/**
 * Parse values piped on stdin: one JSON object (`{"KEY": "value"}`) or `KEY=value` lines
 * (`export ` and matching quotes stripped, blank and `#` lines skipped). Only the resource's keys
 * are accepted, and a blank value is dropped (it keeps what is set). Pure; never echoes a value.
 */
export function parseValuesInput(text: string, keys: readonly string[]): Record<string, string> {
  const known = new Set(keys)
  const trimmed = text.trim()
  let entries: [string, string][]
  if (trimmed.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new CliError('The values on stdin are not valid JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new CliError('The JSON on stdin must be one object of KEY: "value"')
    entries = Object.entries(parsed as Record<string, unknown>).map(([k, v]) => {
      if (typeof v !== 'string') throw new CliError(`The value of ${k} must be a string`)
      return [k, v]
    })
  } else {
    entries = []
    for (const [i, raw] of trimmed.split(/\r?\n/).entries()) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const body = line.startsWith('export ') ? line.slice('export '.length) : line
      const eq = body.indexOf('=')
      if (eq <= 0) throw new CliError(`Line ${i + 1} of stdin is not KEY=value`)
      let value = body.slice(eq + 1)
      const quoted = /^(['"])(.*)\1$/s.exec(value)
      if (quoted) value = quoted[2] ?? ''
      entries.push([body.slice(0, eq).trim(), value])
    }
  }
  const values: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (!known.has(key)) {
      throw new CliError(`${key} is not one of this resource's items`, {
        hint: `Its keys: ${keys.join(', ')}`,
      })
    }
    if (value !== '') values[key] = value
  }
  return values
}

// ---- following a push ----------------------------------------------------------------------

export interface FollowOptions {
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  now?: () => number
}

async function followPush(
  ctx: CommandContext,
  client: ApiClient,
  resourceId: string,
  pushId: string,
  options: FollowOptions
): Promise<GrantPush> {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? 2000
  const deadline = now() + (options.timeoutMs ?? 30 * 60_000)
  let lastLine = ''
  let push: GrantPush | null = null
  while (now() < deadline) {
    push = await client.get(`${resourceApiPath(resourceId)}/pushes/${encodeURIComponent(pushId)}`, {
      schema: grantPushSchema,
    })
    const line = pushLine(push)
    if (!ctx.json && line !== lastLine) {
      ctx.log.info(`${PUSH_WORDS[push.status]}: ${line}`)
      lastLine = line
    }
    if (!isActiveGrantPush(push.status)) return push
    await sleep(pollMs)
  }
  throw new CliError('Timed out waiting for the push', {
    hint: push ? `It is still ${PUSH_WORDS[push.status]}.` : undefined,
  })
}

/** Print a settled push's outcome; exit 1 (throw) when some app did not get it. */
function reportPush(ctx: CommandContext, push: GrantPush): void {
  const failed = push.targets.filter(t => t.status === 'failed')
  if (push.status === 'succeeded') {
    if (!ctx.json) ctx.out.text(`${chalk.green('✓')} Pushed: ${pushLine(push)}.`)
    return
  }
  if (!ctx.json) {
    for (const target of failed)
      ctx.out.text(chalk.red(`  ✗ ${target.app.slug}${target.error ? ` — ${target.error}` : ''}`))
  }
  throw new CliError(`The push ${PUSH_WORDS[push.status]}: ${pushLine(push)}`, {
    hint: `Retry the failed apps from ${sharedResourceUrl(ctx, push.resourceId)}`,
  })
}

// ---- commands ------------------------------------------------------------------------------

export async function runSharedList(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await client.request('GET', base, {
    schema: sharedResourceListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Slug', value: r => r.slug },
      { header: 'Name', value: r => r.displayName },
      { header: 'Owner team', value: r => r.ownerGroup.name },
      { header: 'Items', value: r => r.items.map(i => i.key).join(', ') },
      ...APP_ENVIRONMENT_NAMES.map(env => ({
        header: env[0]?.toUpperCase() + env.slice(1),
        value: (r: SharedResource) => envCell(envOf(r, env)),
      })),
    ])
  )
}

export async function runSharedShow(ctx: CommandContext, ref: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveResource(client, ref)
  ctx.out.data(detail, () => {
    const lines = [
      `${chalk.bold(detail.displayName)} (${detail.slug})${detail.archivedAt ? chalk.dim(' — archived') : ''}`,
      `Owner team: ${detail.ownerGroup.name}`,
    ]
    if (detail.description) lines.push(detail.description)
    lines.push('', 'Items:')
    for (const item of detail.items) {
      const rotate = item.rotationDays ? chalk.dim(` · rotate every ${item.rotationDays} days`) : ''
      lines.push(
        `  ${item.key}  ${chalk.dim(item.kind)}${item.description ? `  ${item.description}` : ''}${rotate}`
      )
    }
    for (const name of APP_ENVIRONMENT_NAMES) {
      const env = envOf(detail, name)
      lines.push('', `${chalk.bold(name)}: ${valueLine(env)}`)
      if (!env) continue
      lines.push(`  ${env.holderCount} app${env.holderCount === 1 ? '' : 's'} hold it`)
      if (env.rotationDue.length)
        lines.push(chalk.yellow(`  rotation due: ${env.rotationDue.join(', ')}`))
      for (const [key, value] of Object.entries(env.vars ?? {})) lines.push(`  ${key}=${value}`)
      const running = detail.activePushes.find(p => p.environment === name)
      if (running) lines.push(chalk.cyan(`  pushing: ${pushLine(running)}`))
    }
    if (detail.holders) {
      lines.push('', 'Holders:')
      lines.push(
        renderTable(detail.holders, [
          { header: 'App', value: h => h.app.slug },
          { header: 'Env', value: h => h.environment },
          { header: 'Status', value: h => h.status },
          { header: 'Holds', value: h => (h.pushedVersion ? `v${h.pushedVersion}` : null) },
          { header: 'Lapses', value: h => (h.expiresAt ? formatDate(h.expiresAt) : 'never') },
          { header: 'Grant', value: h => h.grantId },
        ])
      )
    }
    lines.push('', chalk.dim(sharedResourceUrl(ctx, detail.id)))
    return lines.join('\n')
  })
}

export interface SharedSetOptions extends FollowOptions {
  env: AppEnvironmentName
  wait?: boolean
  /** Whether stdin is a terminal (default `process.stdin.isTTY`). */
  isTTY?: boolean
  /** Injected for tests: the whole of stdin. */
  readStdin?: () => Promise<string>
  /** Injected for tests: ask for one value without echo. */
  promptHidden?: (question: string) => Promise<string>
}

async function readValues(
  ctx: CommandContext,
  detail: SharedResourceDetail,
  options: SharedSetOptions
): Promise<Record<string, string>> {
  const keys = detail.items.map(item => item.key)
  const tty = options.isTTY ?? Boolean(process.stdin.isTTY)
  if (!tty) return parseValuesInput(await (options.readStdin ?? readAllStdin)(), keys)
  const ask =
    options.promptHidden ?? (q => promptHiddenOnTerminal(q, 'Cancelled — nothing was set'))
  const set = new Set(envOf(detail, options.env)?.keysSet ?? [])
  ctx.log.info(
    `Values for ${detail.displayName} in ${options.env}. Nothing you type is shown; Enter on a set key keeps it.`
  )
  const values: Record<string, string> = {}
  for (const item of detail.items) {
    const note = set.has(item.key) ? 'set — Enter keeps it' : 'not set'
    const value = await ask(`${item.key} (${item.kind}, ${note}): `)
    if (value !== '') values[item.key] = value
  }
  return values
}

export async function runSharedSet(
  ctx: CommandContext,
  ref: string,
  options: SharedSetOptions
): Promise<void> {
  if (!(APP_ENVIRONMENT_NAMES as readonly string[]).includes(options.env))
    throw new CliError(`--env must be one of ${APP_ENVIRONMENT_NAMES.join(', ')}`)
  const client = requireClient(ctx)
  const detail = await resolveResource(client, ref)
  const values = await readValues(ctx, detail, options)
  if (Object.keys(values).length === 0)
    throw new CliError('No values given — nothing was set', {
      hint: 'Type at least one value, or pipe KEY=value lines on stdin.',
    })
  const body = putSharedResourceValuesSchema.safeParse({ values })
  if (!body.success)
    throw new CliError(`Invalid values: ${body.error.issues[0]?.message ?? 'check them'}`)

  const { data, raw } = await client.request(
    'PUT',
    `${resourceApiPath(detail.id)}/values/${options.env}`,
    { schema: putSharedResourceValuesResponseSchema, body: body.data }
  )
  const holders = envOf(detail, options.env)?.holderCount ?? 0
  if (!options.wait || !data.pushId) {
    ctx.out.data(raw, () => {
      const lines = [
        `${chalk.green('✓')} Version ${data.version} of ${detail.displayName} set for ${options.env} (${Object.keys(values).join(', ')}).`,
      ]
      if (data.pushId)
        lines.push(
          `  Pushing it to ${holders || 'the'} app${holders === 1 ? '' : 's'} that hold it.`,
          chalk.dim(
            `  Follow it: ${ctx.binName} shared pushes ${detail.slug} --env ${options.env} --wait`
          )
        )
      else lines.push(chalk.dim('  No app holds it here yet; nothing was pushed.'))
      return lines.join('\n')
    })
    return
  }

  if (!ctx.json)
    ctx.out.text(
      `${chalk.green('✓')} Version ${data.version} set for ${options.env}. Pushing it to the apps that hold it…`
    )
  const push = await followPush(ctx, client, detail.id, data.pushId, options)
  if (ctx.json) ctx.out.data({ values: raw, push }, () => '')
  reportPush(ctx, push)
}

export interface SharedPushesOptions extends FollowOptions {
  env?: AppEnvironmentName
  wait?: boolean
}

export async function runSharedPushes(
  ctx: CommandContext,
  ref: string,
  options: SharedPushesOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveResource(client, ref)
  const { data, raw } = await client.request('GET', `${resourceApiPath(detail.id)}/pushes`, {
    schema: grantPushListResponseSchema,
    query: { environment: options.env },
  })
  if (!options.wait) {
    ctx.out.data(raw, () =>
      renderTable(data.items, [
        { header: 'When', value: p => formatDate(p.createdAt) },
        { header: 'Env', value: p => p.environment },
        { header: 'Reason', value: p => p.reason },
        { header: 'Version', value: p => (p.version ? `v${p.version}` : null) },
        { header: 'Status', value: p => PUSH_WORDS[p.status] },
        { header: 'Progress', value: p => pushLine(p) },
        { header: 'Id', value: p => p.id },
      ])
    )
    return
  }
  const running = data.items.find(p => isActiveGrantPush(p.status))
  const target = running ?? data.items[0]
  if (!target) throw new CliError('Nothing has been pushed yet')
  const push = running
    ? await followPush(ctx, client, detail.id, running.id, options)
    : await client.get(`${resourceApiPath(detail.id)}/pushes/${encodeURIComponent(target.id)}`, {
        schema: grantPushSchema,
      })
  if (ctx.json) ctx.out.data(push, () => '')
  reportPush(ctx, push)
}

/**
 * `shared retry <slug> <push> [--wait]` (issue #6): retry the apps a push failed on — the
 * resource page's Retry. `<push>` is a push id or its first 8 characters (from `shared pushes`).
 * Owners and admins; a push with nothing to retry is the server's 409 sentence (exit 1).
 */
export async function runSharedRetry(
  ctx: CommandContext,
  ref: string,
  pushRef: string,
  options: FollowOptions & { wait?: boolean } = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveResource(client, ref)
  const wanted = pushRef.trim()
  if (wanted.length < 8) throw new CliError('Give a push id or its first 8 characters')
  let pushId = wanted
  if (!UUID.test(wanted)) {
    const list = await client.get(`${resourceApiPath(detail.id)}/pushes`, {
      schema: grantPushListResponseSchema,
      query: { limit: 100 },
    })
    const matches = list.items.filter(p => p.id.startsWith(wanted))
    if (matches.length > 1)
      throw new CliError(`"${wanted}" matches more than one push; give more of the id`)
    if (!matches[0])
      throw new CliError(`No push "${wanted}" on ${detail.slug}`, {
        hint: `List them with \`${ctx.binName} shared pushes ${detail.slug}\`.`,
      })
    pushId = matches[0].id
  }
  const { data, raw } = await client.request(
    'POST',
    `${resourceApiPath(detail.id)}/pushes/${encodeURIComponent(pushId)}/retry`,
    { schema: grantPushSchema }
  )
  if (!options.wait) {
    ctx.out.data(raw, () =>
      [
        `${chalk.green('✓')} Retrying the ${data.environment} push of ${detail.slug}: ${pushLine(data)}.`,
        chalk.dim(
          `  Follow it: ${ctx.binName} shared pushes ${detail.slug} --env ${data.environment} --wait`
        ),
      ].join('\n')
    )
    return
  }
  const push = await followPush(ctx, client, detail.id, data.id, options)
  if (ctx.json) ctx.out.data(push, () => '')
  reportPush(ctx, push)
}

// ---- registration --------------------------------------------------------------------------

function envOption(value: string): AppEnvironmentName {
  if (!(APP_ENVIRONMENT_NAMES as readonly string[]).includes(value))
    throw new InvalidArgumentError(`--env must be one of ${APP_ENVIRONMENT_NAMES.join(', ')}`)
  return value as AppEnvironmentName
}

export function registerSharedCommands(program: Command, action: ActionWrapper): void {
  const shared = program
    .command('shared')
    .description('secrets (shared config): credentials many apps use, owned by a team')
  shared
    .command('ls')
    .description('list the organisation’s secrets')
    .action(action(ctx => runSharedList(ctx)))
  shared
    .command('show <slug>')
    .description('one secret: items, versions per environment and (owners) its holders')
    .action(action((ctx, cmd) => runSharedShow(ctx, cmd.args[0] ?? '')))
  shared
    .command('set <slug>')
    .description('set values for one environment (hidden prompt, or KEY=value lines on stdin)')
    .requiredOption('--env <env>', 'staging | production', envOption)
    .option('--wait', 'follow the push to the apps that hold it')
    .action(action((ctx, cmd) => runSharedSet(ctx, cmd.args[0] ?? '', cmd.opts())))
  shared
    .command('rotate <slug>')
    .description('set new values and wait until every app that holds them has them')
    .requiredOption('--env <env>', 'staging | production', envOption)
    .action(
      action((ctx, cmd) => runSharedSet(ctx, cmd.args[0] ?? '', { ...cmd.opts(), wait: true }))
    )
  shared
    .command('pushes <slug>')
    .description('the push history (owners and admins); --wait follows the running one')
    .option('--env <env>', 'staging | production', envOption)
    .option('--wait', 'wait for the running push to finish')
    .action(action((ctx, cmd) => runSharedPushes(ctx, cmd.args[0] ?? '', cmd.opts())))
  shared
    .command('retry <slug> <push>')
    .description('retry the apps a push failed on (push id or 8-char prefix; owners and admins)')
    .option('--wait', 'follow the push to its end')
    .action(
      action((ctx, cmd) => runSharedRetry(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', cmd.opts()))
    )
  // Issue #6: create, edit and archive (`shared-manage.ts`).
  registerSharedManageCommands(shared, action)
}
