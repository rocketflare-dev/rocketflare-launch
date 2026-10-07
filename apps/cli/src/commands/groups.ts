/**
 * `launch groups list|members|mine|create|set|rm|add|remove` and `groups types ls|create|set|rm`
 * (D29) — `/api/groups`, `manage Group` (admin+) except `mine`, parsed with the shared schemas.
 *
 * Writes (issue #6) state who loses access before they act: `rm` names the group's members and,
 * when the server answers 409 `group_in_use`, the documents and dashboards that would narrow to
 * their owner and admins — `--force` is the web page's "Delete anyway" (it sends `?force=1`, which
 * fails CLOSED: nothing becomes tenant-wide). Every narrowing write asks; `--yes` skips the prompt
 * and is required without a terminal. The writes live in `groups-write.ts`.
 */
import { groupDetailSchema, groupListResponseSchema } from '@launch/shared/groups'
import { type CommandContext, requireClient } from '../context'
import { formatDate, renderTable } from '../utils/output'

export async function runGroupsList(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/groups', {
    schema: groupListResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Type', value: g => g.typeName },
      { header: 'Group', value: g => g.name },
      { header: 'People', value: g => String(g.memberCount) },
      { header: 'Id', value: g => g.id },
    ])
  )
}

export async function runGroupMembers(ctx: CommandContext, groupId: string): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', `/api/groups/${groupId}`, {
    schema: groupDetailSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.members, [
      { header: 'Email', value: m => m.email },
      { header: 'Name', value: m => m.name },
      { header: 'Added', value: m => formatDate(m.addedAt) },
    ])
  )
}
