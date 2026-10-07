/**
 * `launch notifications ls|count|read` — the signed-in user's own inbox (`/api/notifications`, D8).
 * The server scopes every query to `(tenant, user)`, so `read` can only ever mark the caller's own.
 *
 * `cli.ts` calls `registerNotificationsCommands(program, action)` once.
 */
import {
  markNotificationsReadResponseSchema,
  notificationSchema,
  unreadCountSchema,
} from '@launch/shared/notifications'
import { paginatedResponse } from '@launch/shared/pagination'
import chalk from 'chalk'
import type { Command } from 'commander'
import { z } from 'zod'
import { type CommandContext, requireClient } from '../context'
import { CliError, EXIT_ERROR } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { positiveInt } from '../utils/input'
import { formatDate, formatPagination, renderTable } from '../utils/output'

export const notificationsResponseSchema = paginatedResponse(notificationSchema)

function clip(value: string | null, max = 80): string | null {
  if (!value) return null
  return value.length > max ? `${value.slice(0, max)}…` : value
}

// ---- notifications ls / read -----------------------------------------------------------------

export interface NotificationsListOptions {
  unread?: boolean
  page?: number
  pageSize?: number
}

export async function runNotificationsList(
  ctx: CommandContext,
  options: NotificationsListOptions = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/notifications', {
    schema: notificationsResponseSchema,
    query: {
      unreadOnly: options.unread ? 'true' : undefined,
      page: options.page,
      pageSize: options.pageSize,
    },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'When', value: n => formatDate(n.createdAt) },
      { header: 'Id', value: n => n.id },
      { header: '', value: n => (n.readAt ? ' ' : chalk.cyan('●')) },
      { header: 'Title', value: n => n.title },
      { header: 'Body', value: n => clip(n.body) },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}

export interface NotificationsReadOptions {
  all?: boolean
}

const uuid = z.string().uuid()

export async function runNotificationsRead(
  ctx: CommandContext,
  ids: string[],
  options: NotificationsReadOptions = {}
): Promise<void> {
  if (Boolean(options.all) === ids.length > 0) {
    throw new CliError('Give notification ids or --all (not both)', {
      exitCode: EXIT_ERROR,
      hint: `\`${ctx.binName} notifications ls --unread\` lists the unread ones with their ids.`,
    })
  }
  const bad = ids.find(id => !uuid.safeParse(id).success)
  if (bad) throw new CliError(`not a notification id: ${bad}`, { exitCode: EXIT_ERROR })
  const { data, raw } = await requireClient(ctx).request('POST', '/api/notifications/read', {
    schema: markNotificationsReadResponseSchema,
    body: options.all ? { all: true } : { ids },
  })
  ctx.out.data(raw, () => `Marked ${data.updated} notification(s) read.`)
}

/** `notifications count` — the bell's number: your unread notifications here. */
export async function runNotificationsCount(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/notifications/unread-count', {
    schema: unreadCountSchema,
  })
  ctx.out.data(raw, () => `${data.count} unread`)
}

export function registerNotificationsCommands(program: Command, action: ActionWrapper): void {
  const notifications = program
    .command('notifications')
    .description('your notifications in the active organisation')
  notifications
    .command('ls')
    .description('list your notifications, newest first (● = unread)')
    .option('--unread', 'only unread ones')
    .option('--page <n>', 'page number', positiveInt('--page'))
    .option('--page-size <n>', 'items per page (max 200)', positiveInt('--page-size'))
    .action(action((ctx, cmd) => runNotificationsList(ctx, cmd.opts<NotificationsListOptions>())))
  notifications
    .command('count')
    .description('how many unread notifications you have')
    .action(action(ctx => runNotificationsCount(ctx)))
  notifications
    .command('read [ids...]')
    .description('mark notifications read — by id, or every one with --all')
    .option('--all', 'mark every unread notification read')
    .action(
      action((ctx, cmd) =>
        runNotificationsRead(
          ctx,
          (cmd.args as string[]) ?? [],
          cmd.opts<NotificationsReadOptions>()
        )
      )
    )
}
