/**
 * Promote (Launch P4, plan §1.8 / §4d). `POST …/releases/:rid/promote` (the app's owners and
 * admins) asks for the release's production deploy BEFORE any runner is waiting, so the job's
 * `WAIT_SECONDS` stops mattering:
 *
 * 1. **Staging runs this release and is up.** `lastDeployVersion` must equal the release's version;
 *    when the last health reading is not `up` for that version, staging is probed now
 *    (`checkAppHealth`, the same two GETs as the app page's button). 409 otherwise.
 * 2. **`open(deploy.production)`**, subject `release`, with what the approver needs to decide —
 *    `{version, tag, sha, compareUrl, prs (+ each session PR's CI), stagingHealth, stagingVersion}`
 *    — excluding the promoter, whoever cut the release and the creators of its sessions (plan
 *    §1.6), so the author can never approve their own production deploy.
 * 3. The release goes `awaiting_approval` (unless the policy auto-approved it and the kind already
 *    moved it to `promoting`).
 *
 * Idempotent: promoting a release already awaiting approval returns the open request. A release
 * that was rejected (or whose approval expired) may be promoted again — a new request.
 */
import type { ApprovalContextOf } from '@launch/shared/launch-approvals'
import {
  isPromotableRelease,
  PROMOTABLE_RELEASE_STATUSES,
  releaseTagRef,
} from '@launch/shared/launch-releases'
import type { MembershipRole } from '@launch/shared/tenants'
import { and, eq, inArray } from 'drizzle-orm'
import type { AppEnvironmentRow, AppReleaseRow, AppRow } from '../../../../db/schema'
import { appEnvironments, sessions } from '../../../../db/schema'
import { ConflictError } from '../../../utils/core/errors'
import { open } from '../../approvals/engine'
import type { ApprovalDeps } from '../../approvals/types'
import type { AuditActor } from '../audit'
import { checkAppHealth } from '../health'
import { moveRelease, releaseExclusions } from './lifecycle'
import { getRelease, nudgeRelease } from './release'

export interface PromoteReleaseInput {
  tenantId: string
  app: AppRow
  releaseId: string
  user: { id: string; email: string; role: string | null }
  reason?: string | null
  actor: AuditActor
}

/** Statuses a release may be promoted from. */
type ApprovalPrChecks = NonNullable<ApprovalContextOf<'deploy.production'>['prs'][number]['checks']>

/** A session PR's CI, as the approver sees it. */
function checksOf(state: string | undefined): ApprovalPrChecks | null {
  if (state === 'success') return 'passing'
  if (state === 'failure') return 'failing'
  if (state === 'pending') return 'pending'
  if (state === 'none') return 'none'
  return null
}

async function stagingOf(
  deps: ApprovalDeps,
  tenantId: string,
  appId: string
): Promise<AppEnvironmentRow | null> {
  const [row] = await deps.db
    .select()
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, tenantId),
        eq(appEnvironments.appId, appId),
        eq(appEnvironments.name, 'staging')
      )
    )
    .limit(1)
  return row ?? null
}

/** Staging, probed now when its last reading is not `up` for `version`. */
async function stagingFor(
  deps: ApprovalDeps,
  tenantId: string,
  appId: string,
  version: string
): Promise<AppEnvironmentRow> {
  const staging = await stagingOf(deps, tenantId, appId)
  if (!staging) {
    throw new ConflictError('This app has no staging environment', 'app_environment_missing')
  }
  if (staging.lastDeployVersion !== version) {
    throw new ConflictError(
      `Staging runs ${staging.lastDeployVersion ?? 'nothing'}, not ${version}: deploy the release to staging first`,
      'release_not_on_staging'
    )
  }
  if (staging.healthStatus === 'up' && staging.healthVersion === version) return staging
  const probed = await checkAppHealth(deps.db, tenantId, appId, { fetch: deps.fetch })
  const fresh = probed.find(r => r.id === staging.id) ?? staging
  if (fresh.healthStatus !== 'up') {
    throw new ConflictError(
      `Staging is ${fresh.healthStatus}; promote once it is up`,
      'release_staging_unhealthy'
    )
  }
  return fresh
}

/** The release's PRs with each session PR's CI at promote time. */
async function prsWithChecks(
  deps: ApprovalDeps,
  release: AppReleaseRow
): Promise<ApprovalContextOf<'deploy.production'>['prs']> {
  const sessionIds = release.prs.map(p => p.sessionId).filter((id): id is string => Boolean(id))
  const checks = new Map<string, ApprovalPrChecks | null>()
  if (sessionIds.length > 0) {
    const rows = await deps.db
      .select({ id: sessions.id, prChecks: sessions.prChecks })
      .from(sessions)
      .where(and(eq(sessions.tenantId, release.tenantId), inArray(sessions.id, sessionIds)))
    for (const row of rows) checks.set(row.id, checksOf(row.prChecks?.state))
  }
  return release.prs.map(p => ({
    ...p,
    checks: p.sessionId ? (checks.get(p.sessionId) ?? null) : null,
  }))
}

export async function promoteRelease(
  deps: ApprovalDeps,
  input: PromoteReleaseInput
): Promise<{ release: AppReleaseRow; approvalId: string }> {
  const { tenantId, app } = input
  const release = await getRelease(deps, { tenantId, appId: app.id, releaseId: input.releaseId })
  if (release.status === 'awaiting_approval' && release.approvalId) {
    return { release, approvalId: release.approvalId }
  }
  if (!isPromotableRelease(release.status)) {
    throw new ConflictError(
      `The release is ${release.status}; only a release live on staging can be promoted`,
      'release_not_promotable'
    )
  }
  const staging = await stagingFor(deps, tenantId, app.id, release.version)

  const compareUrl =
    app.repoOwner && app.repoName && release.previousTag
      ? `https://github.com/${app.repoOwner}/${app.repoName}/compare/${release.previousTag}...${release.tag}`
      : null
  const excluded = [...new Set([input.user.id, ...(await releaseExclusions(deps.db, release))])]
  const opened = await open(deps, {
    tenantId,
    kind: 'deploy.production',
    subject: { type: 'release', id: release.id },
    appId: app.id,
    requester: {
      userId: input.user.id,
      email: input.user.email,
      role: input.user.role as MembershipRole | null,
    },
    reason: input.reason ?? null,
    context: {
      kind: 'deploy.production',
      environment: 'production',
      version: release.version,
      tag: release.tag,
      sha: release.sha,
      ref: releaseTagRef(release.tag),
      compareUrl,
      prs: await prsWithChecks(deps, release),
      stagingHealth: staging.healthStatus,
      stagingVersion: staging.healthVersion ?? staging.lastDeployVersion,
    },
    excludedUserIds: excluded,
    actor: input.actor,
  })
  const approvalId = opened.request.id

  const moved = await moveRelease(
    deps.db,
    release,
    PROMOTABLE_RELEASE_STATUSES,
    'awaiting_approval',
    {
      approvalId,
      error: null,
    }
  )
  const current =
    moved ?? (await getRelease(deps, { tenantId, appId: app.id, releaseId: release.id }))
  nudgeRelease(deps, current)
  return { release: current, approvalId }
}
