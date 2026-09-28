/**
 * A shared resource's values (Launch P5, plan §1.2, §1.3, §1.12, §4 5b):
 *
 * - `setValues`: `PUT /:id/values/:env` (owners and admins) — a new version N+1, sealed as one
 *   blob (`sealed.ts`); a blank or missing key keeps the previous version's value (opened and
 *   merged here, never returned); an unknown key is 400 `unknown_item_key`. When the environment
 *   has live holders it starts a `rotate` push (`push.startPush`, 5c) and answers `pushId`; the
 *   previous version goes `retiring` (5c retires it when every target succeeded). Checks
 *   `requireGrantPushWorkflow` before any row. Audited `shared_resource.values.set {environment,
 *   version, keys, values: 'set'}` — no value in any summary;
 * - `activeVersion`: the environment's `active` row, or null — for 5c and 5d. Real from 5a (one
 *   query), so neither of them waits on 5b.
 *
 * **Slice 5b owns this file.** From 5a `setValues` throws `NotWiredError`.
 */

import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import type {
  PutSharedResourceValuesRequest,
  PutSharedResourceValuesResponse,
} from '@launch/shared/launch-grants'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type SharedResourceValueRow, sharedResourceValues } from '../../../db/schema'
import type { AuditActor } from '../launch/audit'
import { type GrantDeps, type GrantViewer, NotWiredError } from './types'

export async function setValues(
  _deps: GrantDeps,
  _viewer: GrantViewer,
  _resourceId: string,
  _environment: AppEnvironmentName,
  _body: PutSharedResourceValuesRequest,
  _actor: AuditActor
): Promise<PutSharedResourceValuesResponse> {
  throw new NotWiredError('grants/values.setValues', '5b')
}

export async function activeVersion(
  db: Database,
  tenantId: string,
  resourceId: string,
  environment: AppEnvironmentName
): Promise<SharedResourceValueRow | null> {
  const [row] = await db
    .select()
    .from(sharedResourceValues)
    .where(
      and(
        eq(sharedResourceValues.tenantId, tenantId),
        eq(sharedResourceValues.resourceId, resourceId),
        eq(sharedResourceValues.environment, environment),
        eq(sharedResourceValues.status, 'active')
      )
    )
  return row ?? null
}
