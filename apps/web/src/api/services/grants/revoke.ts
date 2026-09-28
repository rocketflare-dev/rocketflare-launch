/**
 * Revoking a grant (Launch P5, plan §1.13, §4 5c): the app's owners, the resource's owners or an
 * admin (403 otherwise; a grant that is not this app's is 404). The grant goes `active → revoking`
 * (compare-and-set; 409 `grant_not_active` from anything else) with `revoked_by_user_id`, audited
 * `grant.revoke_requested` (the person and the reason), and a `revoke` push removes the names from
 * the Worker. Its target settles the grant `revoked` (`revoked_at`) and audits `grant.revoked`.
 * The app then answers 503 by the kit's missing-config convention. `DELETE
 * /api/apps/:id/grants/:gid` (5d's route) calls it.
 *
 * A push already running for the environment (a rotation) is 409 `push_in_progress`, and the grant
 * goes back to `active` — nothing is half-revoked.
 *
 * **Slice 5c owns this file.**
 */
import { GRANT_ERROR_CODES } from '@launch/shared/launch-grants'
import { and, eq } from 'drizzle-orm'
import { type AppGrantRow, appGrants, apps } from '../../../db/schema'
import { ConflictError, ForbiddenError, NotFoundError } from '../../utils/core/errors'
import { type AuditActor, recordAudit } from '../launch/audit'
import { isAppOwner } from '../oidc/policy'
import { canSeeHolders } from './access'
import { startPush } from './push'
import { loadResource } from './resources'
import { type GrantDeps, type GrantViewer, requireGrantPushWorkflow } from './types'

export interface RevokeGrantInput {
  appId: string
  grantId: string
  reason?: string | null
  actor: AuditActor
}

export async function revokeGrant(
  deps: GrantDeps,
  viewer: GrantViewer,
  input: RevokeGrantInput
): Promise<{ grant: AppGrantRow; pushId: string | null }> {
  const { db } = deps
  const tenantId = viewer.tenantId
  const [grant] = await db
    .select()
    .from(appGrants)
    .where(
      and(
        eq(appGrants.tenantId, tenantId),
        eq(appGrants.appId, input.appId),
        eq(appGrants.id, input.grantId)
      )
    )
  if (!grant) throw new NotFoundError('Grant not found')
  const resource = await loadResource(db, tenantId, grant.resourceId)
  const [app] = await db
    .select({ id: apps.id, ownerGroupId: apps.ownerGroupId })
    .from(apps)
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, grant.appId)))
  if (!app) throw new NotFoundError('Grant not found')
  const allowed =
    canSeeHolders(viewer, resource) ||
    (await isAppOwner(db, tenantId, app, viewer.userId, viewer.groupIds))
  if (!allowed) {
    throw new ForbiddenError(
      "Only the app's owners, the resource's owners or an admin may revoke it"
    )
  }
  // Before any write: a deployment that cannot push must not strand a grant in `revoking`.
  requireGrantPushWorkflow(deps.env)

  const at = deps.now?.() ?? new Date()
  const [revoking] = await db
    .update(appGrants)
    .set({ status: 'revoking', revokedByUserId: viewer.userId, updatedAt: at })
    .where(
      and(
        eq(appGrants.tenantId, tenantId),
        eq(appGrants.id, grant.id),
        eq(appGrants.status, 'active')
      )
    )
    .returning()
  if (!revoking) {
    throw new ConflictError(
      `This grant is ${grant.status}; only an active grant can be revoked`,
      GRANT_ERROR_CODES.grantNotActive
    )
  }

  let pushId: string
  try {
    ;({ pushId } = await startPush(deps, {
      tenantId,
      resourceId: grant.resourceId,
      environment: grant.environment,
      reason: 'revoke',
      grantId: grant.id,
      versionId: null,
      startedByUserId: viewer.userId,
    }))
  } catch (err) {
    await db
      .update(appGrants)
      .set({ status: 'active', revokedByUserId: null, updatedAt: at })
      .where(
        and(
          eq(appGrants.tenantId, tenantId),
          eq(appGrants.id, grant.id),
          eq(appGrants.status, 'revoking')
        )
      )
    throw err
  }

  await recordAudit(db, {
    ...input.actor,
    tenantId,
    action: 'grant.revoke_requested',
    targetType: 'grant',
    targetId: grant.id,
    appId: grant.appId,
    approvalId: grant.approvalId,
    summary: {
      before: { status: grant.status },
      after: {
        status: 'revoking',
        resourceId: grant.resourceId,
        environment: grant.environment,
        pushId,
        reason: input.reason ?? null,
      },
    },
  })
  return { grant: revoking, pushId }
}
