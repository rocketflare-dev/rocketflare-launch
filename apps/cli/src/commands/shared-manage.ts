/**
 * `launch shared create|edit|archive` (issue #6) — the secrets' own lifecycle, over
 * `POST /api/shared-resources`, `PATCH /:id` and `DELETE /:id` with `createSharedResourceSchema` /
 * `patchSharedResourceSchema`. Bodies are checked before they are sent (exit 1 listing the
 * issues); `--data <json|@file|->` carries what flags do not (`policies`, item descriptions and
 * rotation days); a flag wins over `--data`. No VALUE is ever part of these: values are `shared
 * set`'s, from a hidden prompt or stdin.
 *
 * - `create <slug> --name --team --item KEY[:var|secret] [--description]` (admins).
 * - `edit <slug> [--name] [--description] [--item …] [--team]` — owners edit name, description and
 *   items (`--item` REPLACES the list); only admins the team and the policies (403).
 * - `archive <slug> [--yes]` — `DELETE`: archived, refused while an app holds it (409); asks first.
 *
 * `shared.ts` calls `registerSharedManageCommands(shared, action)` from its own registration.
 */
import {
  createSharedResourceSchema,
  patchSharedResourceSchema,
  SHARED_RESOURCE_ITEM_KINDS,
  type SharedResourceDetail,
  type SharedResourceItem,
  sharedResourceDetailSchema,
} from '@launch/shared/launch-grants'
import chalk from 'chalk'
import { type Command, InvalidArgumentError } from 'commander'
import { type CommandContext, requireClient } from '../context'
import type { ActionWrapper } from '../plugins/types'
import {
  asObject,
  type ConfirmOptions,
  confirmAction,
  parseBody,
  readDataArg,
} from '../utils/input'
import { resolveResource, sharedResourceUrl } from './shared'

const resourceApiPath = (id: string) => `/api/shared-resources/${encodeURIComponent(id)}`

const defined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/** `KEY` / `KEY:secret` / `KEY:var`, comma-separated and repeatable → items (secret by default). */
export function itemOption(value: string, previous: Partial<SharedResourceItem>[] = []) {
  const items = value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(part => {
      const [key, kind = 'secret'] = part.split(':')
      if (!(SHARED_RESOURCE_ITEM_KINDS as readonly string[]).includes(kind))
        throw new InvalidArgumentError(`--item ${part}: the kind is var or secret`)
      return { key, kind } as Partial<SharedResourceItem>
    })
  return [...previous, ...items]
}

interface WriteOptions {
  name?: string
  description?: string
  team?: string
  item?: Partial<SharedResourceItem>[]
  data?: string
  readStdin?: () => Promise<string>
}

async function bodyFrom(options: WriteOptions, clearDescription: boolean) {
  const base =
    options.data === undefined
      ? {}
      : asObject(await readDataArg(options.data, { readStdin: options.readStdin }))
  const description =
    options.description === undefined
      ? undefined
      : options.description.trim() === '' && clearDescription
        ? null
        : options.description
  return {
    ...base,
    ...defined({
      displayName: options.name,
      description,
      ownerGroupId: options.team,
      items: options.item,
    }),
  }
}

function savedLines(ctx: CommandContext, verb: string, d: SharedResourceDetail): string {
  return [
    `${chalk.green('✓')} ${verb} ${d.displayName} (${d.slug}) · ${d.items.length} item${d.items.length === 1 ? '' : 's'}: ${d.items.map(i => `${i.key}${i.kind === 'var' ? ' (var)' : ''}`).join(', ')}`,
    chalk.dim(`  Set its values: ${ctx.binName} shared set ${d.slug} --env staging`),
    chalk.dim(`  ${sharedResourceUrl(ctx, d.id)}`),
  ].join('\n')
}

export async function runSharedCreate(
  ctx: CommandContext,
  slug: string,
  options: WriteOptions = {}
): Promise<void> {
  const body = parseBody(createSharedResourceSchema, {
    ...(await bodyFrom(options, false)),
    ...defined({ slug: slug || undefined }),
  })
  const client = requireClient(ctx)
  const { data, raw } = await client.request('POST', '/api/shared-resources', {
    schema: sharedResourceDetailSchema,
    body,
  })
  ctx.out.data(raw, () => savedLines(ctx, 'Created', data))
}

export async function runSharedEdit(
  ctx: CommandContext,
  ref: string,
  options: WriteOptions = {}
): Promise<void> {
  const body = parseBody(patchSharedResourceSchema, await bodyFrom(options, true))
  const client = requireClient(ctx)
  const resource = await resolveResource(client, ref)
  const { data, raw } = await client.request('PATCH', resourceApiPath(resource.id), {
    schema: sharedResourceDetailSchema,
    body,
  })
  ctx.out.data(raw, () => savedLines(ctx, 'Saved', data))
}

export async function runSharedArchive(
  ctx: CommandContext,
  ref: string,
  options: ConfirmOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const resource = await resolveResource(client, ref)
  ctx.log.warn(
    `Archiving ${resource.displayName} removes it from the list; its versions are kept. Launch refuses while an app still holds it.`
  )
  const go = await confirmAction(
    `Archive ${resource.slug}?`,
    options,
    `Refusing to archive ${resource.slug} without confirmation`
  )
  if (!go) {
    ctx.log.info('Nothing was archived.')
    return
  }
  await client.request('DELETE', resourceApiPath(resource.id))
  ctx.out.data(
    { id: resource.id, slug: resource.slug, archived: true },
    () => `${chalk.green('✓')} Archived ${resource.displayName} (${resource.slug}).`
  )
}

export function registerSharedManageCommands(shared: Command, action: ActionWrapper): void {
  shared
    .command('create <slug>')
    .description('a new secret: its items and owner team, no values yet (admins)')
    .option('--name <name>', 'the display name')
    .option('--team <groupId>', 'the owner team (a group id — `launch groups list`)')
    .option('--item <KEY[:var|secret],…>', 'an item (repeatable; secret by default)', itemOption)
    .option('--description <text>', 'what it is for')
    .option('--data <json|@file|->', 'the request body as JSON (flags win; policies go here)')
    .action(action((ctx, cmd) => runSharedCreate(ctx, cmd.args[0] ?? '', cmd.opts())))
  shared
    .command('edit <slug>')
    .description('change the name, description or items (owners); the team and policies (admins)')
    .option('--name <name>', 'the display name')
    .option('--description <text>', 'what it is for ("" clears it)')
    .option('--item <KEY[:var|secret],…>', 'the items — replaces the list (repeatable)', itemOption)
    .option('--team <groupId>', 'the owner team (admins)')
    .option('--data <json|@file|->', 'the request body as JSON (flags win; policies go here)')
    .action(action((ctx, cmd) => runSharedEdit(ctx, cmd.args[0] ?? '', cmd.opts())))
  shared
    .command('archive <slug>')
    .description('archive a secret nobody holds (admins; asks first)')
    .option('-y, --yes', 'do not ask')
    .action(action((ctx, cmd) => runSharedArchive(ctx, cmd.args[0] ?? '', cmd.opts())))
}
