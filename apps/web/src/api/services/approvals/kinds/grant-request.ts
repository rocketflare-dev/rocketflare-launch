/**
 * `grant.request` (Launch P5, plan §1.7–§1.9, §4 5d): an app asks to hold a shared resource in one
 * environment. The subject is the `app_grants` row; `requestGrant` (`services/grants/requests.ts`)
 * opens it with the resource's own `policies[env]` when set (`OpenApprovalInput.policy`).
 *
 * - `defaultPolicy`: `DEFAULT_APPROVAL_POLICIES['grant.request']` — nobody by the policy's own
 *   lists, because the approvers are the kind's `eligibleExtra`;
 * - `eligibleExtra`: the members of the resource's owner group, read at decide time (a group
 *   handed to another team moves the decision with it). The requester is excluded by the engine
 *   like on every kind, so an owner asking for their own app needs another owner;
 * - `applyInTx`: the grant goes `requested → active` (a compare-and-set), pending its push
 *   (`pushed_version_id` stays null until 5c's push lands), audited `grant.approved` in the
 *   decider's name. A grant that left `requested` meanwhile is left alone: throwing would roll the
 *   decision back and leave a request nobody can settle;
 * - `applyAfter`: `startPush({ reason: 'grant', grantId, versionId: the active version,
 *   approvalId })` — idempotent by `approval_id` (unique on `grant_pushes`), so the sweep's retry
 *   finds the push it already started. A failure (a rotation's push running, 409
 *   `push_in_progress`) is recorded on the grant's `push_error` and retried by the engine;
 * - `onClosed`: a `requested` grant goes `rejected` (rejected or cancelled) or `expired`, so the
 *   live index frees and the app may ask again.
 *
 * **Slice 5d owns this file.**
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import {
  type ApprovalRequestRow,
  appGrants,
  groupMembers,
  sharedResources,
} from '../../../../db/schema'
import { nudgeAppConfig } from '../../grants/nudge'
import { startPush } from '../../grants/push'
import { activeVersion } from '../../grants/values'
import { recordAudit, SYSTEM_ACTOR } from '../../launch/audit'
import type { KindHandler } from '../types'
import { deciderActor } from './decider'

/** `push_error` is a sentence for a person, not a stack. */
const PUSH_ERROR_MAX = 1000

/** The resource the request is about: its context names it; the grant row is the fallback. */
async function resourceIdOf(db: Database, request: ApprovalRequestRow): Promise<string | null> {
  if (request.context.kind === 'grant.request') return request.context.resourceId
  const [grant] = await db
    .select({ resourceId: appGrants.resourceId })
    .from(appGrants)
    .where(and(eq(appGrants.tenantId, request.tenantId), eq(appGrants.id, request.subjectId)))
  return grant?.resourceId ?? null
}

async function grantOf(db: Database, request: ApprovalRequestRow) {
  const [grant] = await db
    .select()
    .from(appGrants)
    .where(and(eq(appGrants.tenantId, request.tenantId), eq(appGrants.id, request.subjectId)))
  return grant ?? null
}

export const grantRequestHandler: KindHandler<'grant.request'> = {
  kind: 'grant.request',
  async defaultPolicy() {
    return DEFAULT_APPROVAL_POLICIES['grant.request']
  },
  describe(request) {
    if (request.context.kind !== 'grant.request') return `A secret for ${request.subjectId}`
    const { resourceName, appSlug, environment } = request.context
    return `${resourceName} for ${appSlug} (${environment})`
  },
  async eligibleExtra(db, request) {
    const resourceId = await resourceIdOf(db, request)
    if (!resourceId) return []
    const rows = await db
      .select({ userId: groupMembers.userId })
      .from(sharedResources)
      .innerJoin(
        groupMembers,
        and(
          eq(groupMembers.groupId, sharedResources.ownerGroupId),
          eq(groupMembers.tenantId, sharedResources.tenantId)
        )
      )
      .where(
        and(eq(sharedResources.tenantId, request.tenantId), eq(sharedResources.id, resourceId))
      )
    return rows.map(r => r.userId)
  },
  async applyInTx(tx, request, deps) {
    const now = deps.now?.() ?? new Date()
    const [grant] = await tx
      .update(appGrants)
      .set({ status: 'active', approvalId: request.id, pushError: null, updatedAt: now })
      .where(
        and(
          eq(appGrants.tenantId, request.tenantId),
          eq(appGrants.id, request.subjectId),
          eq(appGrants.status, 'requested')
        )
      )
      .returning()
    if (!grant) {
      deps.logger.warn(
        { approvalId: request.id, grantId: request.subjectId },
        'grant.request approved, but the grant is no longer requested'
      )
      return
    }
    await recordAudit(tx, {
      tenantId: request.tenantId,
      ...(await deciderActor(tx, request, 'approve')),
      action: 'grant.approved',
      targetType: 'grant',
      targetId: grant.id,
      appId: grant.appId,
      approvalId: request.id,
      summary: {
        before: { status: 'requested' },
        after: {
          status: 'active',
          resourceId: grant.resourceId,
          environment: grant.environment,
        },
      },
    })
  },
  async applyAfter(request, deps) {
    const grant = await grantOf(deps.db, request)
    // Revoked (or never activated) since: nothing to push.
    if (!grant || grant.status !== 'active') return
    const version = await activeVersion(
      deps.db,
      request.tenantId,
      grant.resourceId,
      grant.environment
    )
    if (!version) {
      throw new Error(`The shared resource has no values for ${grant.environment}`)
    }
    try {
      await startPush(deps, {
        tenantId: request.tenantId,
        resourceId: grant.resourceId,
        environment: grant.environment,
        reason: 'grant',
        grantId: grant.id,
        versionId: version.id,
        approvalId: request.id,
        startedByUserId: (await deciderActor(deps.db, request, 'approve')).actorUserId,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await deps.db
        .update(appGrants)
        .set({ pushError: message.slice(0, PUSH_ERROR_MAX), updatedAt: deps.now?.() ?? new Date() })
        .where(and(eq(appGrants.tenantId, request.tenantId), eq(appGrants.id, grant.id)))
      throw err
    }
    nudgeAppConfig(deps.realtime, request.tenantId, grant.appId)
  },
  async onClosed(request, status, deps) {
    const next = status === 'expired' ? 'expired' : 'rejected'
    const [grant] = await deps.db
      .update(appGrants)
      .set({ status: next, updatedAt: deps.now?.() ?? new Date() })
      .where(
        and(
          eq(appGrants.tenantId, request.tenantId),
          eq(appGrants.id, request.subjectId),
          eq(appGrants.status, 'requested')
        )
      )
      .returning()
    if (!grant) return
    const actor =
      status === 'rejected' ? await deciderActor(deps.db, request, 'reject') : { ...SYSTEM_ACTOR }
    await recordAudit(deps.db, {
      tenantId: request.tenantId,
      ...actor,
      action: `grant.${next}`,
      targetType: 'grant',
      targetId: grant.id,
      appId: grant.appId,
      approvalId: request.id,
      summary: {
        before: { status: 'requested' },
        after: { status: next, approval: status, environment: grant.environment },
      },
    })
    nudgeAppConfig(deps.realtime, request.tenantId, grant.appId)
  },
}
