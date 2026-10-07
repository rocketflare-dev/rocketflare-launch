/**
 * `launch ai prompts …` and `launch ai models …` — Settings → Prompts and Settings → Agent models
 * from a terminal (issue #6). Reading is every member's (the prompt shapes what answers them);
 * writing is `manage Prompt` / `manage AiConfig`, admin+ (a member's key exits 3).
 *
 * - `prompts ls` / `show <key> [--default]` — `GET /api/ai/prompts[/:key]`: the registry entry, the
 *   organisation's override (if any) and the effective text, variables NOT interpolated.
 * - `prompts set <key> --file <path|->` — `PUT /:key`. The new text comes from a file or stdin
 *   (a prompt is too long for argv), is validated with `updatePromptRequestSchema`, and the command
 *   prints a line diff of effective-before → after (`--dry-run` prints it and sends nothing).
 * - `prompts reset <key>` — `DELETE /:key`, confirmed with the page's "Reset to default" words.
 * - `models ls` — `GET /api/ai/agent-models`: each prompt key, its assignment and what
 *   `resolveChat` would pick for it right now.
 * - `models set <promptKey> [--config <id|label>] [--model <m>]` — `PUT /:promptKey`; `models
 *   reset <promptKey>` — `DELETE`, back to the organisation default (idempotent, not asked).
 */
import {
  type AgentModelEntry,
  agentModelAssignmentSchema,
  agentModelsListResponseSchema,
  upsertAgentModelRequestSchema,
} from '@launch/shared/ai/agent-models'
import {
  promptListResponseSchema,
  promptWithResolvedSchema,
  updatePromptRequestSchema,
} from '@launch/shared/ai/prompts'
import chalk from 'chalk'
import type { Command } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import {
  type ConfirmOptions,
  confirmAction,
  confirmConsequence,
  type InputSeams,
  parseBody,
  readTextArg,
} from '../utils/input'
import { formatDate, renderTable } from '../utils/output'
import { resolveAiConfig } from './ai'

const promptPath = (key: string) => `/api/ai/prompts/${encodeURIComponent(key)}`
const agentModelPath = (key: string) => `/api/ai/agent-models/${encodeURIComponent(key)}`

// ---- prompts ---------------------------------------------------------------------------------

export async function runPromptsList(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/ai/prompts', {
    schema: promptListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Key', value: p => p.definition.key },
      { header: 'Title', value: p => p.definition.title },
      { header: 'Override', value: p => (p.isOverridden ? 'yes' : '') },
      {
        header: 'Updated',
        value: p => (p.override ? formatDate(p.override.updatedAt) : null),
      },
      { header: 'Chars', value: p => p.effectiveText.length },
      { header: 'Variables', value: p => p.definition.variables.join(', ') },
    ])
  )
}

export interface PromptShowOptions {
  /** Print the built-in text rather than the effective one. */
  default?: boolean
}

export async function runPromptShow(
  ctx: CommandContext,
  key: string,
  options: PromptShowOptions = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', promptPath(key), {
    schema: promptWithResolvedSchema,
  })
  ctx.out.data(raw, () => {
    const d = data.definition
    const lines = [
      `${chalk.bold(d.title)}  ${chalk.dim(d.key)}`,
      chalk.dim(d.description),
      chalk.dim(
        `variables: ${d.variables.map(v => `{{${v}}}`).join(' ') || 'none'} · ` +
          (data.override
            ? `overridden ${formatDate(data.override.updatedAt)}`
            : 'the built-in default')
      ),
      '',
      options.default ? d.defaultText : data.effectiveText,
    ]
    return lines.join('\n')
  })
}

/**
 * A line diff (longest common subsequence) as `- ` / `+ ` lines with a little context, capped. Pure.
 * Prompts are at most 20 000 characters, so the quadratic table stays small.
 */
export function lineDiff(before: string, after: string, maxLines = 60): string[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  // lcs[i * w + j] = length of the longest common subsequence of a[i..] and b[j..].
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  const at = (i: number, j: number) => lcs[i * w + j] ?? 0
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const ops: Array<[' ' | '-' | '+', string]> = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push([' ', a[i] ?? ''])
      i++
      j++
    } else if (i < n && (j >= m || at(i + 1, j) >= at(i, j + 1))) {
      ops.push(['-', a[i] ?? ''])
      i++
    } else {
      ops.push(['+', b[j] ?? ''])
      j++
    }
  }
  // Keep changed lines and one line of context around each run of changes.
  const keep = ops.map(
    (op, k) => op[0] !== ' ' || ops[k - 1]?.[0] !== ' ' || ops[k + 1]?.[0] !== ' '
  )
  const out: string[] = []
  let gap = false
  ops.forEach(([sign, text], k) => {
    if (!keep[k] || (sign === ' ' && ops.every(o => o[0] === ' '))) {
      gap = true
      return
    }
    if (gap && out.length) out.push(chalk.dim('  …'))
    gap = false
    out.push(
      sign === '-' ? chalk.red(`- ${text}`) : sign === '+' ? chalk.green(`+ ${text}`) : `  ${text}`
    )
  })
  if (out.length > maxLines) {
    return [...out.slice(0, maxLines), chalk.dim(`  … ${out.length - maxLines} more line(s)`)]
  }
  return out
}

function diffSummary(before: string, after: string): string {
  const a = before.split('\n').length
  const b = after.split('\n').length
  return `${a} → ${b} line(s), ${before.length} → ${after.length} chars`
}

export interface PromptSetOptions extends InputSeams {
  file?: string
  dryRun?: boolean
}

export async function runPromptSet(
  ctx: CommandContext,
  key: string,
  options: PromptSetOptions
): Promise<void> {
  if (!options.file) {
    throw new CliError('Give the new text with --file <path>, or --file - to read stdin')
  }
  const body = parseBody(
    updatePromptRequestSchema,
    { text: await readTextArg(options.file, options) },
    'prompt'
  )
  const client = requireClient(ctx)
  const current = await client.get(promptPath(key), { schema: promptWithResolvedSchema })
  const before = current.effectiveText
  const unknownVars = [...body.text.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)]
    .map(m => m[1] as string)
    .filter(v => !current.definition.variables.includes(v))
  if (unknownVars.length) {
    ctx.log.warn(
      `Not a variable of this prompt, left as written: ${[...new Set(unknownVars)].map(v => `{{${v}}}`).join(' ')}`
    )
  }
  const diff = lineDiff(before, body.text)
  if (options.dryRun) {
    ctx.out.data({ key, before, after: body.text, changed: before !== body.text }, () =>
      [
        chalk.bold(`${current.definition.title} — not saved (--dry-run)`),
        chalk.dim(diffSummary(before, body.text)),
        ...(diff.length ? diff : [chalk.dim('No change.')]),
      ].join('\n')
    )
    return
  }
  const { raw } = await client.request('PUT', promptPath(key), {
    schema: promptWithResolvedSchema,
    body,
  })
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Saved the override of "${current.definition.title}" (${diffSummary(before, body.text)})`,
      ...diff,
    ].join('\n')
  )
}

export async function runPromptReset(
  ctx: CommandContext,
  key: string,
  options: ConfirmOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const current = await client.get(promptPath(key), { schema: promptWithResolvedSchema })
  if (!current.isOverridden) {
    ctx.out.data(current, () => `"${current.definition.title}" already uses the built-in prompt.`)
    return
  }
  const question = `Discard this organisation's override of "${current.definition.title}" and use the built-in prompt again?`
  if (!(await confirmAction(question, options))) {
    ctx.log.info('Nothing reset.')
    return
  }
  const { raw } = await client.request('DELETE', promptPath(key), {
    schema: promptWithResolvedSchema,
  })
  ctx.out.data(
    raw,
    () => `${chalk.green('✓')} "${current.definition.title}" uses the built-in prompt again.`
  )
}

// ---- agent models ----------------------------------------------------------------------------

function effectiveLine(e: AgentModelEntry['effective']): string {
  if (e.source === 'none') return chalk.red('nothing (503)')
  const where =
    e.source === 'assignment'
      ? 'assigned'
      : e.source === 'tenant'
        ? 'organisation default'
        : 'platform default'
  return `${e.provider ?? '?'} ${e.model ?? ''} ${chalk.dim(`(${where})`)}`
}

export async function runAgentModelsList(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/ai/agent-models', {
    schema: agentModelsListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Prompt', value: e => e.promptKey },
      { header: 'Title', value: e => e.title },
      { header: 'Answers with', value: e => effectiveLine(e.effective) },
      {
        header: 'Assignment',
        value: e =>
          e.assignment
            ? [
                e.assignment.aiConfigId ? `config ${e.assignment.aiConfigId.slice(0, 8)}` : '',
                e.assignment.model ?? '',
              ]
                .filter(Boolean)
                .join(' · ')
            : null,
      },
    ])
  )
}

export interface AgentModelSetOptions {
  /** A chat config id, 8-char prefix or label. */
  config?: string
  model?: string
}

export async function runAgentModelSet(
  ctx: CommandContext,
  promptKey: string,
  options: AgentModelSetOptions
): Promise<void> {
  const client = requireClient(ctx)
  if (options.config === undefined && options.model === undefined) {
    throw new CliError('Give --config, --model, or both', {
      hint: `\`${ctx.binName} ai models reset ${promptKey}\` goes back to the default.`,
    })
  }
  const draft: Record<string, unknown> = {}
  if (options.model !== undefined) draft.model = options.model
  if (options.config !== undefined) {
    draft.aiConfigId = (await resolveAiConfig(client, options.config, 'chat')).id
  }
  const body = parseBody(upsertAgentModelRequestSchema, draft, 'assignment')
  const { data, raw } = await client.request('PUT', agentModelPath(promptKey), {
    schema: agentModelAssignmentSchema,
    body,
  })
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} ${data.promptKey} now answers with ` +
        [
          data.aiConfigId ? `config ${data.aiConfigId.slice(0, 8)}` : 'the default config',
          data.model ? `model ${data.model}` : "the config's own model",
        ].join(', '),
      chalk.dim(`\`${ctx.binName} ai models ls\` shows what each agent resolves to.`),
    ].join('\n')
  )
}

export async function runAgentModelReset(
  ctx: CommandContext,
  promptKey: string,
  options: ConfirmOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  if (
    !(await confirmConsequence(
      ctx,
      options,
      `Remove ${promptKey}'s model assignment and use the organisation default?`
    ))
  )
    return
  await client.request('DELETE', agentModelPath(promptKey))
  ctx.out.data(
    { promptKey, reverted: true },
    () => `${chalk.green('✓')} ${promptKey} uses the organisation default again.`
  )
}

// ---- registration ----------------------------------------------------------------------------

export function registerAiPromptCommands(ai: Command, action: ActionWrapper): void {
  const prompts = ai.command('prompts').description("the organisation's prompt overrides")
  prompts
    .command('ls')
    .description('every prompt, whether it is overridden, and its variables')
    .action(action(ctx => runPromptsList(ctx)))
  prompts
    .command('show <key>')
    .description('print the prompt that runs (variables not filled in)')
    .option('--default', 'print the built-in text instead')
    .action(action((ctx, cmd) => runPromptShow(ctx, cmd.args[0] ?? '', cmd.opts())))
  prompts
    .command('set <key>')
    .description('override a prompt with the text of a file (admin+); prints the change')
    .option('--file <path|->', 'the new text: a file, or - for stdin')
    .option('--dry-run', 'print the change and save nothing')
    .action(action((ctx, cmd) => runPromptSet(ctx, cmd.args[0] ?? '', cmd.opts())))
  prompts
    .command('reset <key>')
    .description('discard the override and use the built-in prompt again (asks first)')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(action((ctx, cmd) => runPromptReset(ctx, cmd.args[0] ?? '', cmd.opts())))

  const models = ai.command('models').description('which model each agent and chat answers with')
  models
    .command('ls')
    .description('each prompt key, its assignment and what it resolves to right now')
    .action(action(ctx => runAgentModelsList(ctx)))
  models
    .command('set <promptKey>')
    .description('pin a chat provider and/or a model for one agent (admin+)')
    .option('--config <id|label>', 'a saved chat provider (`ai status`)')
    .option('--model <model>', 'a model id served by that provider')
    .action(action((ctx, cmd) => runAgentModelSet(ctx, cmd.args[0] ?? '', cmd.opts())))
  models
    .command('reset <promptKey>')
    .description('back to the organisation default (asks first)')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(action((ctx, cmd) => runAgentModelReset(ctx, cmd.args[0] ?? '', cmd.opts())))
}
