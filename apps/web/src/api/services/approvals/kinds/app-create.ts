/**
 * `app.create` (Launch P4, plan §4c): creating an app is an approval, so a member below
 * `launch_settings.app_create_role` ASKS rather than getting P2's 403. `POST /api/apps` writes the
 * app `requested` (`requestApp`: the rows, the creator as owner, `app.create.requested`, a reserved
 * run id) and opens this with the subject the app.
 *
 * - `defaultPolicy` overlays `autoApproveRole` with the setting (`?? 'admin'`), so a creator at or
 *   above it is auto-approved by the engine — still a row, decided by `system` — and the launch
 *   starts in the same request, exactly as P2 did. `meetsAppCreateRole` survives only as that
 *   default; a policy row may say otherwise.
 * - `applyInTx`: nothing — the app row already exists; its first real change is the run's.
 * - `applyAfter` starts `APP_LAUNCH_WORKFLOW` under the reserved run id (`launchRequestedApp`):
 *   a no-op unless the app is still `requested`, and `instance.already_exists` counts as started,
 *   so a sweep retry cannot launch twice. A failed start marks the app `failed` (Retry on the
 *   pipeline page), as P2's route did.
 * - `onClosed` (rejected, expired, cancelled): a still-`requested` app goes `archived`, audited
 *   `app.create.rejected` with the approval id. The slug stays taken, as an archived app's does.
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { and, eq } from 'drizzle-orm'
import { apps } from '../../../../db/schema'
import { recordAudit, SYSTEM_ACTOR } from '../../launch/audit'
import { loadPipelineSettings } from '../../launch/pipeline/context'
import { launchRequestedApp } from '../../launch/pipeline/create'
import type { KindHandler } from '../types'
import { deciderActor } from './decider'

export const appCreateHandler: KindHandler<'app.create'> = {
  kind: 'app.create',
  async defaultPolicy(db) {
    const { appCreateRole } = await loadPipelineSettings(db)
    return { ...DEFAULT_APPROVAL_POLICIES['app.create'], autoApproveRole: appCreateRole }
  },
  describe(request) {
    if (request.context.kind !== 'app.create') return `Create app ${request.subjectId}`
    return `Create app ${request.context.displayName} (${request.context.slug})`
  },
  async applyInTx() {
    // The `requested` row was written when the request opened; the launch is `applyAfter`'s.
  },
  async applyAfter(request, deps) {
    await launchRequestedApp(
      deps.db,
      deps.env.APP_LAUNCH_WORKFLOW,
      request.tenantId,
      request.appId ?? request.subjectId
    )
  },
  async onClosed(request, status, deps) {
    const appId = request.appId ?? request.subjectId
    // A rejection names who rejected; an expiry or a cancel is the system closing it.
    const actor =
      status === 'rejected' ? await deciderActor(deps.db, request, 'reject') : SYSTEM_ACTOR
    await deps.db.transaction(async tx => {
      const [archived] = await tx
        .update(apps)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(
          and(eq(apps.tenantId, request.tenantId), eq(apps.id, appId), eq(apps.status, 'requested'))
        )
        .returning({ id: apps.id, slug: apps.slug })
      if (!archived) return
      await recordAudit(tx, {
        tenantId: request.tenantId,
        ...actor,
        action: 'app.create.rejected',
        targetType: 'App',
        targetId: archived.id,
        appId: archived.id,
        approvalId: request.id,
        summary: {
          before: { status: 'requested' },
          after: { status: 'archived', slug: archived.slug, approval: status },
        },
      })
    })
  },
}
