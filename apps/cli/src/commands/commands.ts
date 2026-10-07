/**
 * `launch commands [--json]` (issue #6) — every command this CLI has, with its arguments, options
 * and description, walked from the commander `program` at run time so it cannot drift from what
 * `cli.ts` and the plugins register. The `--json` tree is what an agent reads to learn the CLI in
 * one call.
 *
 * `cli.ts` calls `registerCommandsCommand(program, action)` once; the walk happens when the command
 * runs, so commands registered after it (the plugins) are listed too.
 */
import chalk from 'chalk'
import type { Command } from 'commander'
import type { CommandContext } from '../context'
import type { ActionWrapper } from '../plugins/types'

export interface CommandOption {
  flags: string
  description: string
  default?: unknown
  required?: boolean
}

export interface CommandArgument {
  name: string
  required: boolean
  variadic: boolean
  description?: string
}

export interface CommandNode {
  /** The full command path, e.g. `sessions logs`. */
  path: string
  description: string
  arguments: CommandArgument[]
  options: CommandOption[]
  /** Other names the command answers to (`ls` ⇄ `list`); omitted when there are none. */
  aliases?: string[]
  commands: CommandNode[]
}

/** The interchangeable verbs: a group that registered one also answers to the other. */
const VERB_ALIASES: Record<string, string> = { ls: 'list', list: 'ls' }

/**
 * Give every `ls` the alias `list` and every `list` the alias `ls` (issue #6), across the kit's
 * commands and the plugins', unless a sibling already owns that name. `cli.ts` calls it once,
 * after everything is registered.
 */
export function aliasListVerbs(cmd: Command): void {
  for (const child of cmd.commands) {
    const other = VERB_ALIASES[child.name()]
    const taken = cmd.commands.some(c => c.name() === other || c.aliases().includes(other ?? ''))
    if (other && !taken) child.alias(other)
    aliasListVerbs(child)
  }
}

function optionsOf(cmd: Command): CommandOption[] {
  return cmd.options
    .filter(o => !o.hidden)
    .map(o => ({
      flags: o.flags,
      description: o.description,
      ...(o.defaultValue !== undefined ? { default: o.defaultValue } : {}),
      ...(o.mandatory ? { required: true } : {}),
    }))
}

/** The tree under `cmd`; the root (`parentPath` undefined) has an empty path. */
export function commandTree(cmd: Command, parentPath?: string): CommandNode {
  const path = parentPath === undefined ? '' : `${parentPath} ${cmd.name()}`.trim()
  return {
    path,
    description: cmd.description(),
    arguments: cmd.registeredArguments.map(a => ({
      name: a.name(),
      required: a.required,
      variadic: a.variadic,
      ...(a.description ? { description: a.description } : {}),
    })),
    options: optionsOf(cmd),
    ...(cmd.aliases().length ? { aliases: cmd.aliases() } : {}),
    commands: cmd.commands.filter(c => c.name() !== 'help').map(c => commandTree(c, path)),
  }
}

function usage(node: CommandNode): string {
  const args = node.arguments.map(a => {
    const name = `${a.name}${a.variadic ? '...' : ''}`
    return a.required ? `<${name}>` : `[${name}]`
  })
  return [node.path, ...args].join(' ')
}

function render(node: CommandNode, bin: string, lines: string[]): void {
  if (node.path) {
    const leaf = node.commands.length === 0
    const also = node.aliases?.length ? chalk.dim(` (also: ${node.aliases.join(', ')})`) : ''
    lines.push(
      `${chalk.bold(`${bin} ${usage(node)}`)}${also}${node.description ? `  ${chalk.dim(node.description)}` : ''}`
    )
    if (leaf || node.options.length)
      for (const o of node.options) {
        const def =
          o.default !== undefined && o.default !== false
            ? ` (default ${JSON.stringify(o.default)})`
            : ''
        lines.push(
          `    ${o.flags}${o.required ? ' (required)' : ''}  ${chalk.dim(`${o.description}${def}`)}`
        )
      }
  }
  for (const child of node.commands) render(child, bin, lines)
}

export async function runCommands(ctx: CommandContext, program: Command): Promise<void> {
  const tree = commandTree(program)
  ctx.out.data(tree, () => {
    const lines: string[] = []
    if (tree.options.length) {
      lines.push(chalk.bold('Global options'))
      for (const o of tree.options) lines.push(`    ${o.flags}  ${chalk.dim(o.description)}`)
      lines.push('')
    }
    render(tree, ctx.binName, lines)
    return lines.join('\n')
  })
}

export function registerCommandsCommand(program: Command, action: ActionWrapper): void {
  program
    .command('commands')
    .description('list every command with its arguments and options (--json: the whole tree)')
    .action(action(ctx => runCommands(ctx, program)))
}
