/**
 * The `app_config` nudge (Launch P5, plan §4 5d): `entity.changed { entity: 'app_config', id:
 * appId }` tenant-wide after a grant transition, so an open config page refetches. A leaf of its
 * own because both `requests.ts` (which opens approvals through the engine) and the `grant.request`
 * kind (which the engine imports) send it — importing one from the other would close a module
 * cycle through the engine.
 *
 * A nudge, never the truth: a no-op without a realtime (a cron) or a hub binding.
 */
import { APP_CONFIG_REALTIME_ENTITY } from '@launch/shared/launch-grants'
import { nudge, type Realtime, realtimeEvent } from '../realtime'

export function nudgeAppConfig(
  realtime: Realtime | undefined,
  tenantId: string,
  appId: string
): void {
  nudge(
    realtime,
    realtimeEvent('entity.changed', tenantId, { entity: APP_CONFIG_REALTIME_ENTITY, id: appId })
  )
}
