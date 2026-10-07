/**
 * The Setup page's buttons from a terminal (issue #6), over `/api/platform/setup/*` (platform
 * administrators; an admin key — `launch login --admin`). `launch platform setup` (platform.ts)
 * reads the overview; these change it:
 *
 * - `platform settings set [--apps-domain …] [--clear k,…] [--data]` — PUT `/settings`, any
 *   subset; `null` (`--clear`) unsets one.
 * - `platform credentials set <kind>` — PUT `/credentials/:kind`: the secret comes from a HIDDEN
 *   prompt or stdin (`github_app`: `--app-id` and `--private-key-file <path|->`; or a whole JSON
 *   body with `--data @file|-`), never argv, and is never printed — the response is presence and
 *   probes. Validated with the kind's own schema first. `credentials check <kind>` re-runs the
 *   probes; `credentials remove <kind>` (asks first) deletes it. A failed check prints the probes
 *   and exits 1.
 * - `platform public-url check` — probe `APP_URL` from the internet now; failed → exit 1.
 * - `platform kit tags [--repo]`, `kit pin --tag|--commit|--latest [--repo]`, `kit check` (Follow
 *   latest's Check now; 409 unless following), `kit reset` (asks first; back to the code default).
 * - `platform agents set` — coding agents: `--runtime <id>` with `--enable|--disable`, `--model`
 *   (`default` clears it) and `--credential-mode`, the rest of that runtime's entry kept from the
 *   current overview; or `--data` for the whole `{ runtimes }` body.
 * - `platform sandbox set <local|remote>` — where NEW sessions' containers run.
 *
 * Every write is validated with the route's shared schema before any request (exit 1 listing the
 * issues); every refusal is the server's sentence (409/404/422 → exit 1).
 */
import {
  AGENT_RUNTIMES,
  type AgentRuntimeId,
  SESSION_CREDENTIAL_MODES,
} from '@launch/shared/launch-agents'
import {
  type CredentialCheck,
  type CredentialKind,
  credentialKindSchema,
  credentialPayloadSchemas,
  kitTagsResponseSchema,
  publicUrlCheckResponseSchema,
  SETUP_SETTING_KEYS,
  type SetupOverview,
  sessionAgentsUpdateSchema,
  sessionSandboxUpdateSchema,
  setupCheckResponseSchema,
  setupOverviewSchema,
  setupRemoveResponseSchema,
  setupSettingsUpdateSchema,
  templatePinRequestSchema,
} from '@launch/shared/launch-setup'
import chalk from 'chalk'
import type { Command } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import {
  asObject,
  type ConfirmOptions,
  confirmAction,
  type InputSeams,
  parseBody,
  readDataArg,
  readSecret,
  readTextArg,
  type SecretSeams,
} from '../utils/input'
import { formatDate, renderTable } from '../utils/output'
import { withAdminKey } from './admin-key'

const setupCredentialPath = (kind: string) => `/api/platform/setup/credentials/${kind}`

/** `owner/name@tag` (or the short commit), with Follow latest and the default called out. */
export function kitLine(status: SetupOverview['templatePin']): string {
  const { pin } = status
  const at = pin.tag ?? pin.commit.slice(0, 7)
  const follow = pin.follow === 'latest' ? ', following the latest release' : ''
  return `${pin.repo}@${at}${follow}${status.isDefault ? ' (default)' : ''}`
}

function checksTable(checks: readonly CredentialCheck[]): string {
  if (checks.length === 0) return chalk.dim('No probes ran.')
  return renderTable(checks, [
    { header: 'Probe', value: c => c.label },
    {
      header: 'Result',
      value: c =>
        c.status === 'ok'
          ? chalk.green('ok')
          : c.status === 'warning'
            ? chalk.yellow('warning')
            : chalk.red('failed'),
    },
    { header: 'Detail', value: c => c.detail ?? '' },
  ])
}

/** After printing: a failed check is exit 1, so a script notices. */
function failIfFailed(what: string, status: string): void {
  if (status === 'failed') {
    throw new CliError(`${what}: the check failed`, { hint: 'The probes above say why.' })
  }
}

// ---- settings ------------------------------------------------------------------------------

/** `--apps-domain` → `apps_domain`, one flag per setup setting. */
const SETTING_FLAGS = Object.fromEntries(
  SETUP_SETTING_KEYS.map(key => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), key])
) as Record<string, (typeof SETUP_SETTING_KEYS)[number]>

export interface PlatformSettingsOptions extends InputSeams {
  data?: string
  clear?: string
  appsDomain?: string
  cloudflareAccountId?: string
  neonOrgId?: string
  neonRegionId?: string
  notificationsDomain?: string
  githubOrg?: string
}

export async function runPlatformSettingsSet(
  ctx: CommandContext,
  options: PlatformSettingsOptions = {}
): Promise<void> {
  const body = options.data ? { ...asObject(await readDataArg(options.data, options)) } : {}
  for (const [flag, key] of Object.entries(SETTING_FLAGS)) {
    const value = options[flag as keyof PlatformSettingsOptions]
    if (typeof value === 'string') body[key] = value
  }
  for (const key of (options.clear ?? '').split(',').map(s => s.trim())) {
    if (key) body[key] = null
  }
  const update = parseBody(setupSettingsUpdateSchema, body, 'settings')
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('PUT', '/api/platform/setup/settings', {
      schema: setupOverviewSchema,
      body: update,
    })
  )
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Saved ${Object.keys(update).join(', ')}`,
      renderTable(Object.entries(data.settings), [
        { header: 'Setting', value: ([k]) => k },
        { header: 'Value', value: ([, v]) => v ?? chalk.dim('not set') },
      ]),
    ].join('\n')
  )
}

// ---- credentials ---------------------------------------------------------------------------

/** The one secret field of each single-value kind. */
const SECRET_FIELD: Partial<Record<CredentialKind, string>> = {
  cloudflare_api_token: 'apiToken',
  neon_org_api_key: 'apiKey',
  resend_api_key: 'apiKey',
  anthropic_api_key: 'apiKey',
  openai_api_key: 'apiKey',
}

function credentialKind(value: string): CredentialKind {
  const parsed = credentialKindSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new CliError(`Unknown credential "${value}"`, {
    hint: `One of: ${credentialKindSchema.options.join(', ')}`,
  })
}

export interface PlatformCredentialSetOptions extends InputSeams, SecretSeams {
  /** A whole JSON body from a file or stdin — never inline: a secret never goes on argv. */
  data?: string
  appId?: string
  privateKeyFile?: string
}

/** The kind's sealed JSON, from a hidden prompt, stdin, or a file — never from argv. */
async function credentialPayload(
  kind: CredentialKind,
  options: PlatformCredentialSetOptions
): Promise<unknown> {
  if (options.data !== undefined) {
    if (options.data !== '-' && !options.data.startsWith('@')) {
      throw new CliError('A credential never goes on the command line', {
        hint: 'Pass --data @file.json or --data - (stdin).',
      })
    }
    return readDataArg(options.data, options)
  }
  if (kind === 'github_app') {
    if (!options.appId || !options.privateKeyFile) {
      throw new CliError('github_app needs --app-id and --private-key-file <path|->')
    }
    return {
      appId: options.appId,
      privateKey: await readTextArg(options.privateKeyFile, {
        ...options,
        label: '--private-key-file',
      }),
    }
  }
  const field = SECRET_FIELD[kind] as string
  return { [field]: await readSecret(`${kind} (hidden): `, options) }
}

function credentialResult(
  ctx: CommandContext,
  verb: string,
  data: { credential: { kind: string }; status: string; checks: CredentialCheck[] },
  raw: unknown
) {
  ctx.out.data(raw, () =>
    [
      `${data.status === 'failed' ? chalk.red('✗') : chalk.green('✓')} ${data.credential.kind} ${verb} — check ${data.status}`,
      checksTable(data.checks),
    ].join('\n')
  )
  failIfFailed(data.credential.kind, data.status)
}

export async function runPlatformCredentialSet(
  ctx: CommandContext,
  kindArg: string,
  options: PlatformCredentialSetOptions = {}
): Promise<void> {
  const kind = credentialKind(kindArg)
  const payload = parseBody(
    credentialPayloadSchemas[kind] as unknown as Parameters<typeof parseBody>[0],
    await credentialPayload(kind, options),
    kind
  )
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('PUT', setupCredentialPath(kind), {
      schema: setupCheckResponseSchema,
      body: payload,
    })
  )
  credentialResult(ctx, 'saved', data, raw)
}

export async function runPlatformCredentialCheck(
  ctx: CommandContext,
  kindArg: string
): Promise<void> {
  const kind = credentialKind(kindArg)
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('POST', `${setupCredentialPath(kind)}/check`, {
      schema: setupCheckResponseSchema,
    })
  )
  credentialResult(ctx, 'checked', data, raw)
}

export async function runPlatformCredentialRemove(
  ctx: CommandContext,
  kindArg: string,
  options: ConfirmOptions = {}
): Promise<void> {
  const kind = credentialKind(kindArg)
  if (!(await confirmAction(`Remove the ${kind} credential? Whatever uses it stops.`, options))) {
    ctx.log.info('Nothing changed.')
    return
  }
  const client = requireClient(ctx)
  const { raw } = await withAdminKey(ctx, () =>
    client.request('DELETE', setupCredentialPath(kind), { schema: setupRemoveResponseSchema })
  )
  ctx.out.data(raw, () => `${chalk.green('✓')} ${kind} removed`)
}

// ---- public URL ----------------------------------------------------------------------------

export async function runPlatformPublicUrlCheck(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('POST', '/api/platform/setup/public-url/check', {
      schema: publicUrlCheckResponseSchema,
    })
  )
  ctx.out.data(raw, () =>
    [
      `Public URL ${data.url} — ${data.status} (${formatDate(data.checkedAt)})`,
      checksTable(data.checks),
    ].join('\n')
  )
  failIfFailed('Public URL', data.status)
}

// ---- kit pin -------------------------------------------------------------------------------

export async function runPlatformKitTags(
  ctx: CommandContext,
  options: { repo?: string } = {}
): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('GET', '/api/platform/setup/template-pin/tags', {
      schema: kitTagsResponseSchema,
      query: { repo: options.repo },
    })
  )
  ctx.out.data(raw, () =>
    [
      `${data.repo} — Follow latest would pick ${data.latest ?? chalk.dim('nothing (no release)')}`,
      renderTable(data.tags, [
        { header: 'Tag', value: t => t.name },
        { header: 'Commit', value: t => t.commit.slice(0, 7) },
      ]),
    ].join('\n')
  )
}

function printKit(ctx: CommandContext, verb: string, data: SetupOverview, raw: unknown) {
  const check = data.templatePin.latestCheck
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} ${verb}: new apps use ${kitLine(data.templatePin)}`,
      ...(check?.error ? [chalk.yellow(`Last lookup failed: ${check.error}`)] : []),
    ].join('\n')
  )
}

export interface PlatformKitPinOptions {
  tag?: string
  commit?: string
  latest?: boolean
  repo?: string
}

export async function runPlatformKitPin(
  ctx: CommandContext,
  options: PlatformKitPinOptions = {}
): Promise<void> {
  const chosen = [options.tag !== undefined, options.commit !== undefined, Boolean(options.latest)]
  if (chosen.filter(Boolean).length !== 1) {
    throw new CliError('Pass exactly one of --tag <tag>, --commit <sha|branch> or --latest')
  }
  const body = parseBody(
    templatePinRequestSchema,
    options.latest
      ? { kind: 'latest', repo: options.repo }
      : options.tag !== undefined
        ? { kind: 'tag', tag: options.tag, repo: options.repo }
        : { kind: 'commit', ref: options.commit, repo: options.repo },
    'kit pin'
  )
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('PUT', '/api/platform/setup/template-pin', { schema: setupOverviewSchema, body })
  )
  printKit(ctx, 'Pinned', data, raw)
}

export async function runPlatformKitCheck(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('POST', '/api/platform/setup/template-pin/check', {
      schema: setupOverviewSchema,
    })
  )
  printKit(ctx, 'Checked', data, raw)
}

export async function runPlatformKitReset(
  ctx: CommandContext,
  options: ConfirmOptions = {}
): Promise<void> {
  if (
    !(await confirmAction(
      "Reset the kit pin to Launch's default? New apps are cut from the default kit; existing apps are not changed.",
      options
    ))
  ) {
    ctx.log.info('Nothing changed.')
    return
  }
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('DELETE', '/api/platform/setup/template-pin', { schema: setupOverviewSchema })
  )
  printKit(ctx, 'Reset', data, raw)
}

// ---- coding agents and the sandbox ---------------------------------------------------------

export interface PlatformAgentsOptions extends InputSeams {
  data?: string
  runtime?: string
  enable?: boolean
  disable?: boolean
  model?: string
  credentialMode?: string
}

export async function runPlatformAgentsSet(
  ctx: CommandContext,
  options: PlatformAgentsOptions = {}
): Promise<void> {
  const body = options.data ? { ...asObject(await readDataArg(options.data, options)) } : {}
  const client = requireClient(ctx)
  if (options.runtime !== undefined) {
    if (!(AGENT_RUNTIMES as readonly string[]).includes(options.runtime)) {
      throw new CliError(`Unknown agent "${options.runtime}"`, {
        hint: `One of: ${AGENT_RUNTIMES.join(', ')}`,
      })
    }
    if (options.enable && options.disable)
      throw new CliError('Pass --enable or --disable, not both')
    if (
      options.credentialMode !== undefined &&
      !(SESSION_CREDENTIAL_MODES as readonly string[]).includes(options.credentialMode)
    ) {
      throw new CliError(`--credential-mode must be one of ${SESSION_CREDENTIAL_MODES.join(', ')}`)
    }
    // Each runtime's entry is whole: start from what is set now.
    const { data: overview } = await withAdminKey(ctx, () =>
      client.request('GET', '/api/platform/setup', { schema: setupOverviewSchema })
    )
    const current = overview.sessionAgents.runtimes.find(r => r.runtime === options.runtime)
    const runtimes = { ...asObject(body.runtimes ?? {}, 'runtimes') }
    runtimes[options.runtime as AgentRuntimeId] = {
      enabled: options.enable ? true : options.disable ? false : (current?.enabled ?? false),
      model:
        options.model === undefined
          ? (current?.model ?? null)
          : options.model === 'default'
            ? null
            : options.model,
      credentialMode: options.credentialMode ?? current?.credentialMode ?? 'platform',
    }
    body.runtimes = runtimes
  }
  if (body.runtimes === undefined) {
    throw new CliError('Nothing to change', {
      hint: 'Pass --runtime <id> with --enable/--disable/--model/--credential-mode, or --data.',
    })
  }
  const update = parseBody(sessionAgentsUpdateSchema, body, 'coding agents')
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('PUT', '/api/platform/setup/session-agents', {
      schema: setupOverviewSchema,
      body: update,
    })
  )
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Saved — new sessions use these; running ones keep theirs.`,
      renderTable(data.sessionAgents.runtimes, [
        { header: 'Agent', value: r => r.label },
        { header: 'Enabled', value: r => (r.enabled ? 'yes' : 'no') },
        { header: 'Model', value: r => r.model ?? chalk.dim("agent's choice") },
        { header: 'Who pays', value: r => r.credentialMode },
      ]),
    ].join('\n')
  )
}

export async function runPlatformSandboxSet(ctx: CommandContext, host: string): Promise<void> {
  const body = parseBody(sessionSandboxUpdateSchema, { host }, 'sandbox')
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('PUT', '/api/platform/setup/session-sandbox', {
      schema: setupOverviewSchema,
      body,
    })
  )
  ctx.out.data(
    raw,
    () =>
      `${chalk.green('✓')} New sessions' containers run ${data.sessionSandbox.host}; running sessions keep the host they started on.`
  )
}

// ---- registration --------------------------------------------------------------------------

export function registerPlatformSetupCommands(platform: Command, action: ActionWrapper): void {
  const settings = platform.command('settings').description('the setup settings (not secrets)')
  const set = settings
    .command('set')
    .description('change any of the setup settings')
    .option('--apps-domain <domain>', 'the apps domain')
    .option('--cloudflare-account-id <id>', 'the Cloudflare account id')
    .option('--neon-org-id <id>', 'the Neon organization id')
    .option('--neon-region-id <id>', 'the Neon region, e.g. aws-us-east-2')
    .option('--notifications-domain <domain>', 'the notifications domain')
    .option('--github-org <login>', 'the GitHub organization')
    .option('--clear <keys>', 'comma-separated settings to unset')
    .option('--data <json|@file|->', 'the PUT body: inline JSON, @file or - for stdin')
  set.action(action((ctx, cmd) => runPlatformSettingsSet(ctx, cmd.opts<PlatformSettingsOptions>())))

  const credentials = platform
    .command('credentials')
    .description('platform credentials: set, check, remove (values are never shown)')
  credentials
    .command('set <kind>')
    .description('store a credential (hidden prompt or stdin) and check it')
    .option('--app-id <id>', 'github_app: the numeric app id')
    .option('--private-key-file <path>', 'github_app: the PEM file, or - for stdin')
    .option('--data <@file|->', 'the whole JSON body from a file or stdin (never inline)')
    .action(
      action((ctx, cmd) =>
        runPlatformCredentialSet(
          ctx,
          cmd.args[0] as string,
          cmd.opts<PlatformCredentialSetOptions>()
        )
      )
    )
  credentials
    .command('check <kind>')
    .description('re-run the probes for a stored credential')
    .action(action((ctx, cmd) => runPlatformCredentialCheck(ctx, cmd.args[0] as string)))
  credentials
    .command('remove <kind>')
    .description('delete a stored credential')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(
      action((ctx, cmd) =>
        runPlatformCredentialRemove(ctx, cmd.args[0] as string, cmd.opts<ConfirmOptions>())
      )
    )

  platform
    .command('public-url')
    .description("Launch's public URL")
    .command('check')
    .description('probe APP_URL from the internet now')
    .action(action(ctx => runPlatformPublicUrlCheck(ctx)))

  const kit = platform.command('kit').description('the kit new apps are cut from')
  kit
    .command('tags')
    .description("the kit repo's tags, newest release first")
    .option('--repo <owner/name>', 'another kit repo')
    .action(action((ctx, cmd) => runPlatformKitTags(ctx, cmd.opts<{ repo?: string }>())))
  kit
    .command('pin')
    .description('pin a release tag, a commit or branch, or follow the latest release')
    .option('--tag <tag>', 'a release tag')
    .option('--commit <ref>', 'a commit SHA or a branch name')
    .option('--latest', 'follow the newest release')
    .option('--repo <owner/name>', 'another kit repo')
    .action(action((ctx, cmd) => runPlatformKitPin(ctx, cmd.opts<PlatformKitPinOptions>())))
  kit
    .command('check')
    .description('Follow latest: move to the newest release now if there is one')
    .action(action(ctx => runPlatformKitCheck(ctx)))
  kit
    .command('reset')
    .description("back to Launch's default kit")
    .option('-y, --yes', 'do not ask for confirmation')
    .action(action((ctx, cmd) => runPlatformKitReset(ctx, cmd.opts<ConfirmOptions>())))

  platform
    .command('agents')
    .description('the coding agents sessions may run')
    .command('set')
    .description('change one agent (the rest of its settings kept) or send the whole body')
    .option('--runtime <id>', `the agent: ${AGENT_RUNTIMES.join(' or ')}`)
    .option('--enable', 'allow it')
    .option('--disable', 'stop offering it')
    .option('--model <model>', 'pin a model, or "default" to let the agent choose')
    .option('--credential-mode <mode>', `who pays: ${SESSION_CREDENTIAL_MODES.join(', ')}`)
    .option('--data <json|@file|->', 'the PUT body: inline JSON, @file or - for stdin')
    .action(action((ctx, cmd) => runPlatformAgentsSet(ctx, cmd.opts<PlatformAgentsOptions>())))

  platform
    .command('sandbox')
    .description("where new sessions' containers run")
    .command('set <host>')
    .description('local (this Worker) or remote (development only)')
    .action(action((ctx, cmd) => runPlatformSandboxSet(ctx, cmd.args[0] as string)))
}
