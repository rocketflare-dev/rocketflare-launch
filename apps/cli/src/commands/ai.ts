/**
 * `launch ai status|usage` — which model answers chat and embeddings, and what the organisation
 * has spent (D18).
 *
 * - `status` reads `GET /api/ai/config/readiness` (what `resolveChat` / `resolveEmbeddings` WOULD
 *   pick right now: tenant row, platform key or nothing) and `GET /api/ai/config` (the tenant's
 *   saved providers). The server never sends a credential — only `hasCredential` — so there is
 *   nothing secret to print. `--json` → `{ readiness, configs }`.
 * - `usage [--days N]` reads `GET /api/ai/usage/summary?from&to` for the last N days (default 30):
 *   tokens, calls and estimated cost per provider, model and feature.
 *
 * Both are `read`/`manage AiConfig` on the server (admin+); a member's key exits 3.
 *
 * Settings → AI from a terminal (issue #6), `manage AiConfig` = admin+:
 * - `providers` — `GET /providers`, the catalog the form is built from (needs a key / base URL,
 *   scopes, suggested models).
 * - `set --label --provider --model [--scope] [--base-url] [--default] [--thinking] [--key]` —
 *   `POST /api/ai/config`, an upsert on (scope, label). **The API key never travels in argv**:
 *   `--key` asks for it on a hidden prompt, or reads it from stdin when stdin is not a terminal;
 *   without `--key` a re-save keeps the stored one. `--data` with an `apiKey` is refused.
 * - `rm <id|label>` — `DELETE /:id`, confirmed (the UI's "Remove AI provider" words).
 * - `test <id|label>` or `test --provider --model [--key]` — `POST /test`, "Connected in N ms" or
 *   "Connection failed" (exit 1). It spends a provider call, and the server rate-limits it.
 * - `prompts …` and `models …` live in `ai-prompts.ts`.
 *
 * `cli.ts` calls `registerAiCommands(program, action)` once.
 */
import {
  type AiConfig,
  aiConfigListResponseSchema,
  aiConfigSchema,
  aiProviderSchema,
  aiProvidersResponseSchema,
  aiReadinessSchema,
  aiScopeSchema,
  testAiConfigRequestSchema,
  testAiConfigResponseSchema,
  upsertAiConfigRequestSchema,
} from '@launch/shared/ai/config'
import { aiUsageSummarySchema } from '@launch/shared/ai/usage'
import chalk from 'chalk'
import { type Command, InvalidArgumentError } from 'commander'
import type { ApiClient } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError, EXIT_ERROR } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import {
  type ConfirmOptions,
  confirmAction,
  type InputSeams,
  parseBody,
  positiveInt,
  readDataArg,
  readSecret,
  type SecretSeams,
} from '../utils/input'
import { renderTable } from '../utils/output'
import { registerAiPromptCommands } from './ai-prompts'

/** `costMicrocents` (1/1,000,000 of a cent) → `$0.0123`, or null when unpriced. */
export function formatCost(microcents: number | null | undefined): string | null {
  if (microcents === null || microcents === undefined) return null
  return `$${(microcents / 100_000_000).toFixed(4)}`
}

export async function runAiStatus(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const [readiness, configs] = await Promise.all([
    client.request('GET', '/api/ai/config/readiness', { schema: aiReadinessSchema }),
    client.request('GET', '/api/ai/config', { schema: aiConfigListResponseSchema }),
  ])
  ctx.out.data({ readiness: readiness.raw, configs: configs.raw }, () => {
    const scope = (name: string, r: (typeof readiness.data)['chat']) =>
      `${chalk.bold(`${name}:`.padEnd(12))}${r.ready ? chalk.green('ready') : chalk.red('not ready')}` +
      (r.ready ? ` · ${r.provider ?? '?'} ${r.model ?? ''}`.trimEnd() : '') +
      chalk.dim(
        ` (${r.source === 'tenant' ? 'organisation setting' : r.source === 'platform' ? 'platform default' : 'nothing configured'})`
      )
    const lines = [
      scope('Chat', readiness.data.chat),
      scope('Embeddings', readiness.data.embeddings),
      '',
      chalk.bold('Configured providers'),
      renderTable(configs.data.items, [
        { header: 'Scope', value: c => c.scope },
        { header: 'Label', value: c => c.label },
        { header: 'Provider', value: c => c.provider },
        { header: 'Model', value: c => c.model },
        { header: 'Default', value: c => (c.isDefault ? 'yes' : '') },
        { header: 'Key', value: c => (c.hasCredential ? 'set' : 'none') },
      ]),
    ]
    if (!readiness.data.chat.ready) {
      lines.push(
        '',
        chalk.dim('Chat and agents answer 503 until a provider is set (Settings → AI).')
      )
    }
    return lines.join('\n')
  })
}

export interface AiUsageOptions {
  days?: number
  /** Injectable clock for tests. */
  now?: Date
}

const DAY_MS = 24 * 60 * 60 * 1000

export async function runAiUsage(ctx: CommandContext, options: AiUsageOptions = {}): Promise<void> {
  const days = options.days ?? 30
  const now = options.now ?? new Date()
  const { data, raw } = await requireClient(ctx).request('GET', '/api/ai/usage/summary', {
    schema: aiUsageSummarySchema,
    query: { from: new Date(now.getTime() - days * DAY_MS).toISOString(), to: now.toISOString() },
  })
  ctx.out.data(raw, () => {
    const t = data.totals
    const lines = [
      renderTable(data.rows, [
        { header: 'Provider', value: r => r.provider },
        { header: 'Model', value: r => r.model },
        { header: 'Feature', value: r => r.feature },
        { header: 'Calls', value: r => r.calls },
        { header: 'Input', value: r => r.inputTokens },
        { header: 'Output', value: r => r.outputTokens },
        { header: 'Cache read', value: r => r.cacheReadTokens },
        { header: 'Cost', value: r => formatCost(r.costMicrocents) },
      ]),
      '',
      `${chalk.bold(`Last ${days} day(s):`)} ${t.calls} call(s) · ${t.inputTokens}→${t.outputTokens} tokens` +
        ` · ${formatCost(t.costMicrocents) ?? 'cost unknown'}` +
        (t.unpricedCalls
          ? chalk.dim(` (${t.unpricedCalls} call(s) on unpriced models not counted)`)
          : ''),
    ]
    return lines.join('\n')
  })
}

// ---- providers / set / rm / test (Settings → AI) ---------------------------------------------

const aiConfigPath = (id: string) => `/api/ai/config/${encodeURIComponent(id)}`

export async function runAiProviders(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/ai/config/providers', {
    schema: aiProvidersResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Provider', value: p => p.id },
      { header: 'Name', value: p => p.name },
      { header: 'Scopes', value: p => p.scopes.join(', ') },
      {
        header: 'Needs',
        value: p =>
          [p.needsApiKey ? 'API key' : '', p.needsBaseUrl ? 'base URL' : '']
            .filter(Boolean)
            .join(', ') || 'nothing',
      },
      { header: 'Default model', value: p => p.defaultModel || '—' },
      {
        header: 'Suggested',
        value: p =>
          Object.entries(p.suggestedModels)
            .filter(([, models]) => models.length)
            .map(([scope, models]) => `${scope}: ${models.length}`)
            .join(' · '),
      },
    ])
  )
}

/** A saved config by id, 8-character id prefix, or label (`--scope` narrows a label). */
export async function resolveAiConfig(
  client: ApiClient,
  ref: string,
  scope?: string
): Promise<AiConfig> {
  const { items } = await client.get('/api/ai/config', { schema: aiConfigListResponseSchema })
  const byId = items.filter(c => c.id === ref || (ref.length >= 8 && c.id.startsWith(ref)))
  const matches = byId.length
    ? byId
    : items.filter(c => c.label === ref && (!scope || c.scope === scope))
  if (matches.length === 1 && matches[0]) return matches[0]
  if (matches.length > 1) {
    throw new CliError(`"${ref}" names ${matches.length} providers`, {
      hint: 'Pass --scope chat|embeddings, or the id from `ai status --json`.',
    })
  }
  throw new CliError(`No AI provider "${ref}"`, {
    hint: 'Saved providers: `ai status`.',
  })
}

function configLine(c: AiConfig): string {
  return (
    `"${c.label}" (${c.scope}): ${c.provider} ${c.model}` +
    ` · key ${c.hasCredential ? 'set' : 'none'}` +
    (c.isDefault ? ' · default' : '') +
    (c.thinking.enabled ? ` · thinking ${c.thinking.budgetTokens ?? ''}`.trimEnd() : '')
  )
}

export interface AiSetOptions extends InputSeams, SecretSeams {
  scope?: string
  label?: string
  provider?: string
  model?: string
  baseUrl?: string
  default?: boolean
  /** A token budget, or `off`. */
  thinking?: string
  serviceTier?: string
  /** Ask for the API key (hidden prompt, or stdin when not a terminal). */
  key?: boolean
  data?: string
}

export async function runAiSet(ctx: CommandContext, options: AiSetOptions): Promise<void> {
  const base = options.data ? await readDataArg(options.data, options) : {}
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    throw new CliError('--data must be one JSON object')
  }
  if ('apiKey' in base) {
    throw new CliError('An API key is never accepted in --data', {
      hint: 'Use --key: it asks on a hidden prompt, or reads stdin when piped.',
    })
  }
  const body: Record<string, unknown> = { ...base }
  if (options.scope !== undefined) body.scope = options.scope
  if (options.label !== undefined) body.label = options.label
  if (options.provider !== undefined) body.provider = options.provider
  if (options.model !== undefined) body.model = options.model
  if (options.baseUrl !== undefined) body.baseUrl = options.baseUrl
  if (options.default) body.isDefault = true
  if (options.serviceTier !== undefined) body.serviceTier = options.serviceTier
  if (options.thinking !== undefined) {
    body.thinking =
      options.thinking === 'off'
        ? { enabled: false }
        : { enabled: true, budgetTokens: Number(options.thinking) }
  }
  // Validate everything but the key first, so a typo never costs the user a key prompt.
  parseBody(upsertAiConfigRequestSchema, body, 'AI provider')
  if (options.key) body.apiKey = await readSecret('API key (hidden): ', options)
  const request = parseBody(upsertAiConfigRequestSchema, body, 'AI provider')
  const { data, status, raw } = await requireClient(ctx).request('POST', '/api/ai/config', {
    schema: aiConfigSchema,
    body: request,
  })
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} ${status === 201 ? 'Added' : 'Saved'} ${configLine(data)}`,
      chalk.dim(`Check it answers: \`${ctx.binName} ai test ${data.id.slice(0, 8)}\``),
    ].join('\n')
  )
}

export interface AiRemoveOptions extends ConfirmOptions {
  scope?: string
}

export async function runAiRemove(
  ctx: CommandContext,
  ref: string,
  options: AiRemoveOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const config = await resolveAiConfig(client, ref, options.scope)
  const question = `Remove "${config.label}"? ${
    config.isDefault
      ? 'It is the default — another entry (or the platform default) takes over.'
      : 'Consumers keep using the default.'
  }`
  if (!(await confirmAction(question, options))) {
    ctx.log.info('Nothing removed.')
    return
  }
  await client.request('DELETE', aiConfigPath(config.id))
  ctx.out.data({ deleted: config.id }, () => `${chalk.green('✓')} Removed "${config.label}".`)
}

export interface AiTestOptions extends SecretSeams {
  scope?: string
  provider?: string
  model?: string
  baseUrl?: string
  key?: boolean
}

export async function runAiTest(
  ctx: CommandContext,
  ref: string | undefined,
  options: AiTestOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  let body: unknown
  if (ref) {
    if (options.provider || options.model || options.key) {
      throw new CliError('Test a saved provider OR a candidate (--provider/--model), not both')
    }
    body = { configId: (await resolveAiConfig(client, ref, options.scope)).id }
  } else {
    if (!options.provider || !options.model) {
      throw new CliError('Name a saved provider, or give --provider and --model to test one', {
        hint: `\`${ctx.binName} ai status\` lists the saved ones.`,
      })
    }
    const candidate: Record<string, unknown> = {
      scope: options.scope ?? 'chat',
      provider: options.provider,
      model: options.model,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    }
    parseBody(testAiConfigRequestSchema, candidate, 'test')
    if (options.key) candidate.apiKey = await readSecret('API key (hidden): ', options)
    body = parseBody(testAiConfigRequestSchema, candidate, 'test')
  }
  const { data, raw } = await client.request('POST', '/api/ai/config/test', {
    schema: testAiConfigResponseSchema,
    body,
  })
  ctx.out.data(raw, () =>
    data.ok
      ? `${chalk.green('Connected')} in ${data.latencyMs.toLocaleString()} ms · ${data.model}`
      : `${chalk.red('Connection failed')}${data.error ? ` · ${data.error}` : ''}${
          data.code ? chalk.dim(` (${data.code})`) : ''
        }`
  )
  if (!data.ok) {
    throw new CliError(`${data.provider} ${data.model} did not answer`, { exitCode: EXIT_ERROR })
  }
}

function enumArg(label: string, schema: { options: readonly string[] }) {
  return (value: string) => {
    if (!schema.options.includes(value)) {
      throw new InvalidArgumentError(`${label} must be one of ${schema.options.join(', ')}`)
    }
    return value
  }
}

export function registerAiCommands(program: Command, action: ActionWrapper): void {
  const ai = program
    .command('ai')
    .description('AI providers and spend of the active organisation (admin+)')
  ai.command('status')
    .description('which model answers chat and embeddings, and the configured providers')
    .action(action(ctx => runAiStatus(ctx)))
  ai.command('usage')
    .description('tokens, calls and cost per provider, model and feature')
    .option('--days <n>', 'how many days back (default 30)', positiveInt('--days'))
    .action(action((ctx, cmd) => runAiUsage(ctx, cmd.opts<AiUsageOptions>())))
  ai.command('providers')
    .description('the providers this server knows: what each needs and the models it suggests')
    .action(action(ctx => runAiProviders(ctx)))
  ai.command('set')
    .description('add or update a provider (upsert on scope + label; admin+)')
    .option('--label <label>', 'the name it is saved under (the upsert key)')
    .option('--provider <provider>', aiProviderSchema.options.join(' | '))
    .option('--model <model>', 'model id (`ai providers` suggests some)')
    .option('--scope <scope>', 'chat (default) | embeddings', enumArg('--scope', aiScopeSchema))
    .option('--base-url <url>', 'endpoint, for the *_compatible providers')
    .option('--default', "make it the scope's default")
    .option('--thinking <budget|off>', 'extended-thinking token budget, or off')
    .option('--service-tier <tier>', 'sent verbatim as service_tier; "" clears it')
    .option('--key', 'set or replace the API key: hidden prompt, or stdin when piped')
    .option('--data <json|@file|->', 'the request body as JSON (flags override; never apiKey)')
    .action(action((ctx, cmd) => runAiSet(ctx, cmd.opts<AiSetOptions>())))
  ai.command('rm <id|label>')
    .description('remove a provider (asks first)')
    .option('--scope <scope>', 'chat | embeddings, when a label is in both')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(action((ctx, cmd) => runAiRemove(ctx, cmd.args[0] ?? '', cmd.opts())))
  ai.command('test [id|label]')
    .description('check a saved provider, or a candidate, answers (one real provider call)')
    .option('--scope <scope>', 'chat (default) | embeddings')
    .option('--provider <provider>', 'test a candidate that is not saved')
    .option('--model <model>', "the candidate's model")
    .option('--base-url <url>', "the candidate's endpoint")
    .option('--key', "the candidate's API key: hidden prompt, or stdin when piped")
    .action(action((ctx, cmd) => runAiTest(ctx, cmd.args[0], cmd.opts<AiTestOptions>())))
  registerAiPromptCommands(ai, action)
}
