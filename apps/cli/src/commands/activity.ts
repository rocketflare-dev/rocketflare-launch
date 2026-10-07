/**
 * `launch activity ls` — what the organisation has been doing (`GET /api/activity`, D19, admin+).
 * The generic per-tenant feed every mutation may append to; the hash-chained audit log is
 * `launch audit`.
 *
 * `cli.ts` calls `registerActivityCommands(program, action)` once.
 */
import { activityEventSchema } from '@launch/shared/activity'
import { paginatedResponse } from '@launch/shared/pagination'
import { type Command, InvalidArgumentError } from 'commander'
import { type CommandContext, requireClient } from '../context'
import type { ActionWrapper } from '../plugins/types'
import { positiveInt } from '../utils/input'
import { formatDate, formatPagination, renderTable } from '../utils/output'

export const activityListResponseSchema = paginatedResponse(activityEventSchema)

function clip(value: unknown, max = 80): string | null {
  if (value === null || value === undefined) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === '{}') return null
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// ---- activity ls -----------------------------------------------------------------------------

export interface ActivityListOptions {
  type?: string
  subjectType?: string
  subjectId?: string
  from?: string
  to?: string
  page?: number
  pageSize?: number
}

export async function runActivityList(
  ctx: CommandContext,
  options: ActivityListOptions = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/activity', {
    schema: activityListResponseSchema,
    query: { ...options },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'When', value: e => formatDate(e.createdAt) },
      { header: 'Type', value: e => e.type },
      { header: 'Actor', value: e => e.actor?.email ?? e.userId },
      {
        header: 'Subject',
        value: e => (e.subjectType ? `${e.subjectType} ${e.subjectId ?? ''}`.trim() : null),
      },
      { header: 'Details', value: e => clip(e.metadata) },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}

// ---- registration ----------------------------------------------------------------------------

function isoDate(label: string) {
  return (value: string) => {
    if (Number.isNaN(new Date(value).getTime())) {
      throw new InvalidArgumentError(`${label} must be an ISO date or timestamp`)
    }
    return value
  }
}

export function registerActivityCommands(program: Command, action: ActionWrapper): void {
  const activity = program
    .command('activity')
    .description('the organisation’s activity feed (admin+)')
  activity
    .command('ls')
    .description('list recent activity, newest first')
    .option('--type <type>', 'only this event type, e.g. member.invited')
    .option('--subject-type <type>', 'only events about this kind of thing, e.g. AgentRun')
    .option('--subject-id <id>', 'only events about this one thing')
    .option('--from <iso>', 'only events at or after this time', isoDate('--from'))
    .option('--to <iso>', 'only events at or before this time', isoDate('--to'))
    .option('--page <n>', 'page number', positiveInt('--page'))
    .option('--page-size <n>', 'items per page (max 200)', positiveInt('--page-size'))
    .action(action((ctx, cmd) => runActivityList(ctx, cmd.opts<ActivityListOptions>())))
}
