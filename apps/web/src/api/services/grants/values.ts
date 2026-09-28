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
 * - `activeVersion`: the environment's `active` row, or null — for 5c and 5d.
 *
 * How a write lands, in one transaction with the resource row locked (so two writers queue rather
 * than both claiming version N+1):
 *
 * 1. the active version is opened and merged under the body (blank = keep); keys the resource no
 *    longer has an item for are dropped;
 * 2. "holders" are the environment's `active` grants. With holders, a push already running for
 *    this environment is 409 `push_in_progress` BEFORE anything is written, and the previous
 *    version becomes `retiring`; with none, nobody holds the old values and it is `retired` now;
 * 3. version N+1 is inserted `active`, and audited.
 *
 * After commit, with holders, `startPush({ reason: 'rotate', grantId: null })` hands the version to
 * `GRANT_PUSH`. The values themselves never leave: not in the answer, the audit row, a log line or
 * an error message — only the KEYS that changed are named.
 *
 * **Slice 5b owns this file.**
 */

import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  ACTIVE_GRANT_PUSH_STATUSES,
  GRANT_ERROR_CODES,
  type PutSharedResourceValuesRequest,
  type PutSharedResourceValuesResponse,
  SHARED_RESOURCE_REALTIME_ENTITY,
} from '@launch/shared/launch-grants'
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  appGrants,
  grantPushes,
  type SharedResourceValueRow,
  sharedResources,
  sharedResourceValues,
} from '../../../db/schema'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} from '../../utils/core/errors'
import type { AuditActor } from '../launch/audit'
import { recordAudit } from '../launch/audit'
import { nudge, realtimeEvent } from '../realtime'
import { canSeeHolders } from './access'
import { startPush } from './push'
import { loadResource } from './resources'
import { openValues, sealValues } from './sealed'
import { type GrantDeps, type GrantViewer, requireGrantPushWorkflow } from './types'

export async function setValues(
  deps: GrantDeps,
  viewer: GrantViewer,
  resourceId: string,
  environment: AppEnvironmentName,
  body: PutSharedResourceValuesRequest,
  actor: AuditActor
): Promise<PutSharedResourceValuesResponse> {
  requireGrantPushWorkflow(deps.env)
  const { db, cfg } = deps
  const tenantId = viewer.tenantId
  const resource = await loadResource(db, tenantId, resourceId)
  if (!canSeeHolders(viewer, resource)) {
    throw new ForbiddenError(
      "Only the resource's owner group or an admin can set its values",
      GRANT_ERROR_CODES.notResourceOwner
    )
  }
  if (resource.archivedAt) {
    throw new ConflictError(
      'This shared resource is archived and takes no new values',
      GRANT_ERROR_CODES.resourceArchived
    )
  }
  const itemKeys = resource.items.map(i => i.key)
  const unknown = Object.keys(body.values).filter(k => !itemKeys.includes(k))
  if (unknown.length > 0) {
    throw new BadRequestError(
      `This resource has no item called ${unknown.join(', ')}`,
      GRANT_ERROR_CODES.unknownItemKey,
      { keys: unknown }
    )
  }
  // Blank keeps the previous value; so does a key that is not in the body at all.
  const changed = itemKeys.filter(k => (body.values[k] ?? '') !== '')
  if (changed.length === 0) {
    throw new ValidationError(
      [{ path: ['values'], message: 'Give at least one value; blank fields keep the current one' }],
      'Nothing to set'
    )
  }

  const written = await db.transaction(async raw => {
    const tx = raw as unknown as Database
    await tx
      .select({ id: sharedResources.id })
      .from(sharedResources)
      .where(and(eq(sharedResources.tenantId, tenantId), eq(sharedResources.id, resourceId)))
      .for('update')
    const [latest] = await tx
      .select()
      .from(sharedResourceValues)
      .where(
        and(
          eq(sharedResourceValues.tenantId, tenantId),
          eq(sharedResourceValues.resourceId, resourceId),
          eq(sharedResourceValues.environment, environment)
        )
      )
      .orderBy(desc(sharedResourceValues.version))
      .limit(1)
    const previous = await activeVersion(tx, tenantId, resourceId, environment)
    const kept = previous ? await openValues(cfg, previous.sealed) : {}
    const merged: Record<string, string> = {}
    for (const key of itemKeys) {
      const next = body.values[key] ?? ''
      if (next !== '') merged[key] = next
      else if (kept[key] !== undefined) merged[key] = kept[key]
    }

    const [holding] = await tx
      .select({ n: count() })
      .from(appGrants)
      .where(
        and(
          eq(appGrants.tenantId, tenantId),
          eq(appGrants.resourceId, resourceId),
          eq(appGrants.environment, environment),
          eq(appGrants.status, 'active')
        )
      )
    const holders = Number(holding?.n ?? 0)
    if (holders > 0) {
      const [running] = await tx
        .select({ id: grantPushes.id })
        .from(grantPushes)
        .where(
          and(
            eq(grantPushes.tenantId, tenantId),
            eq(grantPushes.resourceId, resourceId),
            eq(grantPushes.environment, environment),
            inArray(grantPushes.status, [...ACTIVE_GRANT_PUSH_STATUSES])
          )
        )
        .limit(1)
      if (running) {
        throw new ConflictError(
          `A push is already running for ${environment}; wait for it to finish, then set the values again`,
          GRANT_ERROR_CODES.pushInProgress,
          { pushId: running.id }
        )
      }
    }

    const sealed = await sealValues(cfg, merged)
    const now = deps.now?.() ?? new Date()
    if (previous) {
      await tx
        .update(sharedResourceValues)
        .set(holders > 0 ? { status: 'retiring' } : { status: 'retired', retiredAt: now })
        .where(
          and(eq(sharedResourceValues.tenantId, tenantId), eq(sharedResourceValues.id, previous.id))
        )
    }
    const [row] = await tx
      .insert(sharedResourceValues)
      .values({
        tenantId,
        resourceId,
        environment,
        version: (latest?.version ?? 0) + 1,
        sealed,
        status: 'active',
        setByUserId: viewer.userId,
        setAt: now,
      })
      .returning()
    if (!row) throw new Error('shared_resource_values insert returned no row')
    await recordAudit(tx, {
      tenantId,
      ...actor,
      action: 'shared_resource.values.set',
      targetType: 'shared_resource',
      targetId: resourceId,
      summary: {
        after: {
          slug: resource.slug,
          environment,
          version: row.version,
          previousVersion: previous?.version ?? null,
          keys: changed,
          kept: Object.keys(merged).filter(k => !changed.includes(k)),
          values: 'set',
          holders,
        },
      },
    })
    return { row, holders }
  })

  let pushId: string | null = null
  if (written.holders > 0) {
    const push = await startPush(deps, {
      tenantId,
      resourceId,
      environment,
      reason: 'rotate',
      grantId: null,
      versionId: written.row.id,
      startedByUserId: viewer.userId,
    })
    pushId = push.pushId
  }
  nudge(
    deps.realtime,
    realtimeEvent('entity.changed', tenantId, {
      entity: SHARED_RESOURCE_REALTIME_ENTITY,
      id: resourceId,
    })
  )
  return { versionId: written.row.id, version: written.row.version, pushId }
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
