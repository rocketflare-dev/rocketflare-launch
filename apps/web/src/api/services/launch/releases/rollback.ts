/**
 * Rollback (app page P3, plan decision 8): `POST /api/apps/:id/releases/:rid/rollback` (the app's
 * owners and admins) puts an EARLIER release back on Live. It is the repo's own deploy workflow
 * (`deploy.yml`, `workflow_dispatch`, `environment=production`) run at the old tag — the same
 * thing a person would do by hand in GitHub, so the app stays detachable (decision 3). Never a
 * Cloudflare-side instant rollback: the old tag is built and deployed through the gateway again,
 * with its binding check, its migrator and its ticket.
 *
 * 1. **Eligible** (`rollbackRefusal`, shared and pure): the target was live in production before
 *    (`production_active`, or `rolled_back` since) and is earlier than what Live runs now. 409
 *    `release_not_rollbackable` otherwise.
 * 2. **Nothing else is on its way to Live**: no pending `deploy.production` request for the app and
 *    no granted pre-approval still waiting for its run. 409 `release_production_busy` otherwise.
 * 3. **The same approval policy as Ship**: `open(deploy.production)`, subject `rollback` (the
 *    target), context bound to the target's tag and naming what it replaces (`rollbackFrom`). The
 *    requester is excluded, as for every production deploy. On approval the kind writes a
 *    pre-approval bound to `refs/tags/X.Y.Z` and linked to the release, and dispatches the workflow
 *    at the tag; the run's `start` claims it and is linked to the release by its ref.
 * 4. **When the run goes live** (`lifecycle.ts`, `releaseRedeployed`): the target records
 *    `rolled_back_from`, the release that was live goes `rolled_back`, audited `release.rolled_back`.
 *    A rollback deployed by hand in GitHub is recognised the same way, by its tag.
 *
 * **Concurrency**: under the app's release claim (`claim.ts`), so two rollbacks — or a rollback
 * and a release being cut — never pass the "nothing else is on its way" check together; the
 * approvals engine's pending index makes a repeated press for the same target return the open
 * request. Audited `release.rollback_requested` on the target.
 *
 * Migrations and secrets do not revert: the old build runs against today's database schema and
 * today's config. The dialog says so; the deploy cannot undo a migration it never ran.
 */
import { RELEASE_ERROR_CODES, releaseTagRef, rollbackRefusal } from '@launch/shared/launch-releases'
import type { MembershipRole } from '@launch/shared/tenants'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { AppReleaseRow, AppRow, ApprovalRequestRow } from '../../../../db/schema'
import { appReleases, approvalRequests } from '../../../../db/schema'
import { ConflictError } from '../../../utils/core/errors'
import { open } from '../../approvals/engine'
import type { ApprovalDeps } from '../../approvals/types'
import { type AuditActor, recordAudit } from '../audit'
import { findOpenIntent } from '../deploy/tickets'
import { withReleaseClaim } from './claim'
import { stageEnvironments } from './failed-stage'
import { getRelease, nudgeRelease } from './release'

export interface RollbackReleaseInput {
  tenantId: string
  app: AppRow
  /** The release to go back TO. */
  releaseId: string
  user: { id: string; email: string; role: string | null }
  reason?: string | null
  actor: AuditActor
}

export interface RollbackReleaseOutcome {
  release: AppReleaseRow
  from: string
  approvalId: string
  approvalStatus: string
}

/** The app's pending `deploy.production` requests, newest first. */
async function pendingProductionRequests(
  deps: ApprovalDeps,
  tenantId: string,
  appId: string
): Promise<ApprovalRequestRow[]> {
  return deps.db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.appId, appId),
        eq(approvalRequests.kind, 'deploy.production'),
        eq(approvalRequests.status, 'pending')
      )
    )
    .orderBy(desc(approvalRequests.createdAt))
}

/** A release of the app still on its way to production (`promoting` holds a granted approval). */
async function releasePromoting(deps: ApprovalDeps, tenantId: string, appId: string) {
  const [row] = await deps.db
    .select({ version: appReleases.version })
    .from(appReleases)
    .where(
      and(
        eq(appReleases.tenantId, tenantId),
        eq(appReleases.appId, appId),
        inArray(appReleases.status, ['promoting'])
      )
    )
    .limit(1)
  return row ?? null
}

function busy(message: string): never {
  throw new ConflictError(message, RELEASE_ERROR_CODES.productionBusy)
}

async function requestRollback(
  deps: ApprovalDeps,
  input: RollbackReleaseInput
): Promise<RollbackReleaseOutcome> {
  const { tenantId, app } = input
  const target = await getRelease(deps, { tenantId, appId: app.id, releaseId: input.releaseId })
  const { production, staging } = await stageEnvironments(deps.db, tenantId, app.id)
  if (!production) {
    throw new ConflictError('This app has no production environment', 'app_environment_missing')
  }
  const live = production.lastDeployVersion

  const pending = await pendingProductionRequests(deps, tenantId, app.id)
  // Pressed again: the request already open for this target.
  const mine = pending.find(r => r.subjectType === 'rollback' && r.subjectId === target.id)
  if (mine) {
    return { release: target, from: live ?? '', approvalId: mine.id, approvalStatus: mine.status }
  }

  const refusal = rollbackRefusal(target, live)
  if (refusal) throw new ConflictError(refusal, RELEASE_ERROR_CODES.notRollbackable)
  const from = live as string

  if (pending.length > 0) {
    busy('Another production deploy is waiting for approval; decide or cancel it first')
  }
  const scope = { tenantId, appId: app.id, environmentId: production.id }
  if (await findOpenIntent(deps.db, scope, deps.now?.() ?? new Date())) {
    busy('A production deploy is already approved and waiting for its run')
  }
  const promoting = await releasePromoting(deps, tenantId, app.id)
  if (promoting) busy(`Release ${promoting.version} is on its way to production`)

  const compareUrl =
    app.repoOwner && app.repoName
      ? `https://github.com/${app.repoOwner}/${app.repoName}/compare/${target.tag}...${from}`
      : null
  const opened = await open(deps, {
    tenantId,
    kind: 'deploy.production',
    subject: { type: 'rollback', id: target.id },
    appId: app.id,
    requester: {
      userId: input.user.id,
      email: input.user.email,
      role: input.user.role as MembershipRole | null,
    },
    reason: input.reason?.trim() || `Roll Live back to ${target.version} from ${from}`,
    context: {
      kind: 'deploy.production',
      environment: 'production',
      version: target.version,
      tag: target.tag,
      sha: target.sha,
      ref: releaseTagRef(target.tag),
      compareUrl,
      prs: [],
      stagingHealth: staging?.healthStatus ?? null,
      stagingVersion: staging?.healthVersion ?? staging?.lastDeployVersion ?? null,
      rollbackFrom: from,
    },
    excludedUserIds: [input.user.id],
    actor: input.actor,
  })

  await recordAudit(deps.db, {
    tenantId,
    ...input.actor,
    action: 'release.rollback_requested',
    targetType: 'release',
    targetId: target.id,
    appId: app.id,
    approvalId: opened.request.id,
    summary: {
      before: { live: from },
      after: {
        version: target.version,
        tag: target.tag,
        approvalStatus: opened.request.status,
        autoApproved: opened.autoApproved,
      },
    },
  })
  nudgeRelease(deps, target)
  return {
    release: target,
    from,
    approvalId: opened.request.id,
    approvalStatus: opened.request.status,
  }
}

export async function rollbackRelease(
  deps: ApprovalDeps,
  input: RollbackReleaseInput
): Promise<RollbackReleaseOutcome> {
  const outcome = await withReleaseClaim(
    deps.db,
    { tenantId: input.tenantId, appId: input.app.id, holder: `user:${input.user.id}` },
    () => requestRollback(deps, input)
  )
  if (!outcome.claimed) {
    throw new ConflictError(
      'A release of this app is being cut or rolled back right now; try again in a minute',
      RELEASE_ERROR_CODES.inProgress
    )
  }
  return outcome.value
}
