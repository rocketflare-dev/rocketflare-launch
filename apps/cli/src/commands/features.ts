/**
 * `launch features list` (D30) — `GET /api/features`, any member.
 *
 * The EFFECTIVE flags for the key's organisation, not the platform rollout state. Administering a
 * flag is a global-admin act: `/api/admin/*` takes the session cookie or an ADMIN-scoped key
 * (`launch login --admin`), so that lives under `launch admin`, never here with a tenant key.
 */
import { effectiveFeaturesResponseSchema } from '@launch/shared/features'
import { type CommandContext, requireClient } from '../context'
import { renderTable } from '../utils/output'

export async function runFeaturesList(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/features', {
    schema: effectiveFeaturesResponseSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Feature', value: f => f.key },
      { header: 'Name', value: f => f.label },
      { header: 'Enabled', value: f => (f.enabled ? 'yes' : 'no') },
    ])
  )
}
