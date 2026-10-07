/**
 * The group writes (issue #6) — see `groups.ts` for the whole command. Every write is admin+
 * (`manage Group`); `mine` is any member's own groups.
 *
 * A group, a type and a person are each named by id, id prefix or name (email for a person).
 * Deleting or taking someone out narrows what people can READ, so each says who, then asks:
 *
 * - `rm <group>`: "Its N members (…) lose what it lets them see." Then `DELETE`; a 409
 *   `group_in_use` is the page's sentence ("still controls access to 3 documents and 1
 *   dashboard…") and exits 1 unless `--force`, which asks again and re-sends with `?force=1`.
 * - `types rm <type>`: its groups and how many people are in them; the same 409 / `--force`.
 * - `remove <group> <user>`: that person stops seeing what the group was given.
 */
import {
  addGroupMembersRequestSchema,
  createGroupRequestSchema,
  createGroupTypeRequestSchema,
  type Group,
  type GroupType,
  groupDetailSchema,
  groupListResponseSchema,
  groupSchema,
  groupTypeListResponseSchema,
  groupTypeSchema,
  myGroupsSchema,
  updateGroupRequestSchema,
  updateGroupTypeRequestSchema,
} from '@launch/shared/groups'
import type { Member } from '@launch/shared/tenants'
import chalk from 'chalk'
import type { Command } from 'commander'
import { CliApiError } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { type ConfirmOptions, confirmConsequence, parseBody } from '../utils/input'
import { formatDate, renderTable } from '../utils/output'
import { findMember } from './members'
import { listWords, pickOne } from './org-common'

const groupPath = (id: string) => `/api/groups/${encodeURIComponent(id)}`
const groupTypePath = (id: string) => `/api/groups/types/${encodeURIComponent(id)}`

const groupLabel = (g: Pick<Group, 'name' | 'typeName'>) => `“${g.name}” (${g.typeName})`

export async function findGroup(ctx: CommandContext, ref: string): Promise<Group> {
  const list = await requireClient(ctx).get('/api/groups', { schema: groupListResponseSchema })
  return pickOne(list.items, ref, {
    noun: 'group',
    listHint: `${ctx.binName} groups list`,
    names: g => [g.name],
  })
}

export async function findGroupType(ctx: CommandContext, ref: string): Promise<GroupType> {
  const list = await requireClient(ctx).get('/api/groups/types', {
    schema: groupTypeListResponseSchema,
  })
  return pickOne(list.items, ref, {
    noun: 'group type',
    listHint: `${ctx.binName} groups types ls`,
    names: t => [t.name],
  })
}

/** `3 documents and 1 dashboard` from the 409's `details` — the page's words, zeroes included. */
export function describeInUse(details: unknown): string | null {
  if (!details || typeof details !== 'object') return null
  const parts = Object.entries(details as Record<string, unknown>)
    .filter((e): e is [string, number] => typeof e[1] === 'number')
    .map(([key, n]) => `${n} ${n === 1 ? key.replace(/s$/, '') : key}`)
  return parts.length ? parts.join(' and ') : null
}

function inUseOf(error: unknown): string | null {
  if (!(error instanceof CliApiError) || error.status !== 409 || error.code !== 'group_in_use')
    return null
  const details = (error.body as { details?: unknown } | undefined)?.details
  return describeInUse(details) ?? 'documents or dashboards'
}

/**
 * DELETE, and on 409 `group_in_use`: refuse (exit 1) without `--force`; with it, say what forcing
 * does, ask, and re-send with `?force=1`. Returns false when the person said no.
 */
async function deleteRefusingInUse(
  ctx: CommandContext,
  send: (force: boolean) => Promise<unknown>,
  what: 'group' | 'type',
  options: GroupsRemoveOptions
): Promise<boolean> {
  try {
    await send(false)
    return true
  } catch (error) {
    const held = inUseOf(error)
    if (!held) throw error
    const sentence = `This ${what} still controls access to ${held}. Deleting it leaves them visible to their owner and to administrators only — never to everyone.`
    if (!options.force)
      throw new CliError(sentence, { hint: 'Re-run with --force to delete it anyway.' })
    if (!(await confirmConsequence(ctx, options, 'Delete it anyway?', sentence))) return false
    await send(true)
    return true
  }
}

// ---- groups ----------------------------------------------------------------------------------

export async function runGroupsMine(ctx: CommandContext) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/groups/mine', {
    schema: myGroupsSchema,
  })
  ctx.out.data(raw, () =>
    data.items.length === 0
      ? 'You are in no groups.'
      : renderTable(data.items, [
          { header: 'Type', value: g => g.typeName },
          { header: 'Group', value: g => g.name },
          { header: 'Id', value: g => g.id },
        ])
  )
}

export async function runGroupsCreate(
  ctx: CommandContext,
  name: string,
  options: { type: string; description?: string }
) {
  const type = await findGroupType(ctx, options.type)
  const body = parseBody(createGroupRequestSchema, {
    groupTypeId: type.id,
    name,
    ...(options.description !== undefined ? { description: options.description } : {}),
  })
  const { data, raw } = await requireClient(ctx).request('POST', '/api/groups', {
    schema: groupSchema,
    body,
  })
  ctx.out.data(raw, () => `${chalk.green('✓')} Created ${groupLabel(data)} — id ${data.id}`)
}

export async function runGroupsSet(
  ctx: CommandContext,
  ref: string,
  options: { name?: string; description?: string }
) {
  const group = await findGroup(ctx, ref)
  const body = parseBody(updateGroupRequestSchema, {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.description !== undefined
      ? { description: options.description === '' ? null : options.description }
      : {}),
  })
  const { data, raw } = await requireClient(ctx).request('PATCH', groupPath(group.id), {
    schema: groupSchema,
    body,
  })
  ctx.out.data(raw, () => `${chalk.green('✓')} Saved ${groupLabel(data)}.`)
}

export interface GroupsRemoveOptions extends ConfirmOptions {
  /** Delete even while it still controls access to content (the page's "Delete anyway"). */
  force?: boolean
}

export async function runGroupsRemove(
  ctx: CommandContext,
  ref: string,
  options: GroupsRemoveOptions = {}
) {
  const group = await findGroup(ctx, ref)
  const client = requireClient(ctx)
  const detail = await client.get(groupPath(group.id), { schema: groupDetailSchema })
  const people = detail.members.map(m => m.email)
  const consequence =
    people.length === 0
      ? 'It has no members; its grants on documents and dashboards go with it.'
      : `Its ${people.length} member${people.length === 1 ? '' : 's'} (${listWords(people)}) lose what it lets them see; its memberships go with it.`
  if (!(await confirmConsequence(ctx, options, `Delete group ${groupLabel(group)}?`, consequence)))
    return
  const done = await deleteRefusingInUse(
    ctx,
    force =>
      client.request('DELETE', `/api/groups/${group.id}`, {
        query: { force: force ? '1' : undefined },
      }),
    'group',
    options
  )
  if (!done) return
  ctx.out.data({ deleted: group.id }, () => `${chalk.green('✓')} Deleted ${groupLabel(group)}.`)
}

export async function runGroupsAdd(ctx: CommandContext, ref: string, userRefs: string[]) {
  const group = await findGroup(ctx, ref)
  const users: Member[] = []
  for (const u of userRefs) users.push(await findMember(ctx, u))
  const body = parseBody(addGroupMembersRequestSchema, {
    userIds: [...new Set(users.map(u => u.userId))],
  })
  const { data, raw } = await requireClient(ctx).request(
    'POST',
    `/api/groups/${group.id}/members`,
    { schema: groupDetailSchema, body }
  )
  ctx.out.data(
    raw,
    () =>
      `${chalk.green('✓')} Added ${listWords(users.map(u => u.email))} to ${groupLabel(data)} — ${data.members.length} member(s) now.`
  )
}

export async function runGroupsRemoveMember(
  ctx: CommandContext,
  ref: string,
  userRef: string,
  options: ConfirmOptions = {}
) {
  const group = await findGroup(ctx, ref)
  const user = await findMember(ctx, userRef)
  if (
    !(await confirmConsequence(
      ctx,
      options,
      `Take ${user.email} out of ${groupLabel(group)}?`,
      'They stop seeing what the group was given (documents and dashboards shared with it).'
    ))
  )
    return
  await requireClient(ctx).request('DELETE', `/api/groups/${group.id}/members/${user.userId}`)
  ctx.out.data(
    { group: group.id, removed: user.userId },
    () => `${chalk.green('✓')} ${user.email} is no longer in ${groupLabel(group)}.`
  )
}

// ---- group types -----------------------------------------------------------------------------

export async function runGroupTypesList(ctx: CommandContext) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/groups/types', {
    schema: groupTypeListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Type', value: t => t.name },
      { header: 'Groups', value: t => String(t.groupCount) },
      { header: 'Description', value: t => t.description },
      { header: 'Created', value: t => formatDate(t.createdAt) },
      { header: 'Id', value: t => t.id },
    ])
  )
}

export async function runGroupTypesCreate(
  ctx: CommandContext,
  name: string,
  options: { description?: string } = {}
) {
  const body = parseBody(createGroupTypeRequestSchema, {
    name,
    ...(options.description !== undefined ? { description: options.description } : {}),
  })
  const { data, raw } = await requireClient(ctx).request('POST', '/api/groups/types', {
    schema: groupTypeSchema,
    body,
  })
  ctx.out.data(raw, () => `${chalk.green('✓')} Created type “${data.name}” — id ${data.id}`)
}

export async function runGroupTypesSet(
  ctx: CommandContext,
  ref: string,
  options: { name?: string; description?: string }
) {
  const type = await findGroupType(ctx, ref)
  const body = parseBody(updateGroupTypeRequestSchema, {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.description !== undefined
      ? { description: options.description === '' ? null : options.description }
      : {}),
  })
  const { data, raw } = await requireClient(ctx).request('PATCH', groupTypePath(type.id), {
    schema: groupTypeSchema,
    body,
  })
  ctx.out.data(raw, () => `${chalk.green('✓')} Saved type “${data.name}”.`)
}

export async function runGroupTypesRemove(
  ctx: CommandContext,
  ref: string,
  options: GroupsRemoveOptions = {}
) {
  const type = await findGroupType(ctx, ref)
  const client = requireClient(ctx)
  const groups = await client.get('/api/groups', {
    schema: groupListResponseSchema,
    query: { typeId: type.id },
  })
  const people = groups.items.reduce((n, g) => n + g.memberCount, 0)
  const consequence =
    groups.items.length === 0
      ? 'It has no groups.'
      : `Its ${groups.items.length} group(s) (${listWords(groups.items.map(g => g.name))}) and their memberships go with it — ${people} membership(s), whose people lose what those groups let them see.`
  if (!(await confirmConsequence(ctx, options, `Delete group type “${type.name}”?`, consequence)))
    return
  const done = await deleteRefusingInUse(
    ctx,
    force =>
      client.request('DELETE', `/api/groups/types/${type.id}`, {
        query: { force: force ? '1' : undefined },
      }),
    'type',
    options
  )
  if (!done) return
  ctx.out.data({ deleted: type.id }, () => `${chalk.green('✓')} Deleted type “${type.name}”.`)
}

// ---- registration (onto the `groups` command `cli.ts` creates) -------------------------------

export function registerGroupsWriteCommands(groups: Command, action: ActionWrapper): void {
  groups
    .command('mine')
    .description('the groups you are in (any member)')
    .action(action(ctx => runGroupsMine(ctx)))
  groups
    .command('create <name>')
    .description('create a group under a type')
    .requiredOption('--type <type>', 'the group type (id or name)')
    .option('--description <text>', 'what the group is for')
    .action(action((ctx, cmd) => runGroupsCreate(ctx, cmd.args[0] ?? '', cmd.opts())))
  groups
    .command('set <group>')
    .description('rename a group or change its description ("" clears it)')
    .option('--name <name>', 'new name')
    .option('--description <text>', 'new description')
    .action(action((ctx, cmd) => runGroupsSet(ctx, cmd.args[0] ?? '', cmd.opts())))
  groups
    .command('rm <group>')
    .description('delete a group — its members lose what it lets them see')
    .option('--force', 'delete even while it controls access to documents or dashboards')
    .option('-y, --yes', 'do not ask first')
    .action(action((ctx, cmd) => runGroupsRemove(ctx, cmd.args[0] ?? '', cmd.opts())))
  groups
    .command('add <group> <users...>')
    .description('add members to a group (user ids or emails)')
    .action(
      action((ctx, cmd) => runGroupsAdd(ctx, cmd.args[0] ?? '', (cmd.args as string[]).slice(1)))
    )
  groups
    .command('remove <group> <user>')
    .description('take one person out of a group')
    .option('-y, --yes', 'do not ask first')
    .action(
      action((ctx, cmd) =>
        runGroupsRemoveMember(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', cmd.opts())
      )
    )

  const types = groups.command('types').description('group types — Department, Region, Client…')
  types.command('ls').description('list group types').action(action(runGroupTypesList))
  types
    .command('create <name>')
    .description('create a group type')
    .option('--description <text>', 'what the type means')
    .action(action((ctx, cmd) => runGroupTypesCreate(ctx, cmd.args[0] ?? '', cmd.opts())))
  types
    .command('set <type>')
    .description('rename a type or change its description ("" clears it)')
    .option('--name <name>', 'new name')
    .option('--description <text>', 'new description')
    .action(action((ctx, cmd) => runGroupTypesSet(ctx, cmd.args[0] ?? '', cmd.opts())))
  types
    .command('rm <type>')
    .description('delete a type with its groups — their members lose what they let them see')
    .option('--force', 'delete even while its groups control access to content')
    .option('-y, --yes', 'do not ask first')
    .action(action((ctx, cmd) => runGroupTypesRemove(ctx, cmd.args[0] ?? '', cmd.opts())))
}
