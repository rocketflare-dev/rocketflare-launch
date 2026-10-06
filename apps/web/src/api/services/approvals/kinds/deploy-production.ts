/**
 * `deploy.production` (Launch P4, plan §1.8 / §1.9 / §4d): the production gate. Three subjects,
 * one kind:
 *
 * | Subject | Opened by | `applyInTx` (in the decide transaction) | `applyAfter` (after commit) |
 * |---|---|---|---|
 * | `release` | Promote | a pre-approval bound to `refs/tags/X.Y.Z` + the approval + the release; the release `promoting` | publish the GitHub Release (idempotent by `getReleaseByTag`; issue #12: the kit's staging DRAFT for the tag is published by PATCH, so production deploys its build-once bundle, else a new one is POSTed — `releases/publish.ts`; issue #21: on a build-once kit a draft not attached yet is waited for — the attempt fails and the sweep retries — and a bundle that is not staging's is refused) — `release: published` starts the job, whose `start` claims the pre-approval |
 * | `deploy_ticket` | a production run with nothing to claim (a Release published or a dispatch made by hand in GitHub) | `decidePending(source: 'approval')`; 409 `deploy_run_gone` once the run stopped waiting (the decision rolls back — the approver uses Promote) | nothing: the job's next poll sees `approved` |
 * | `app` | "Deploy to production" with no release | a pre-approval bound to the default branch | `workflow_dispatch` of `deploy.yml` |
 * | `rollback` (app page P3) | Roll back, the subject the release to go back TO | a pre-approval bound to that release's `refs/tags/X.Y.Z`, linked to it | `workflow_dispatch` of `deploy.yml` at the tag (`environment=production`) — the repo's own workflow, as by hand |
 *
 * `onClosed` (rejected, expired, cancelled): a release goes `rejected` (no GitHub Release is ever
 * published); a waiting ticket is rejected so the job fails at its next poll.
 *
 * The run's `ref` must equal the pre-approval's (`claimIntent`), so approving tag A never lets a
 * run of tag B through. Nothing here publishes or dispatches inside the transaction.
 */
import {
  APPROVAL_ERROR_CODES,
  APPROVAL_MAX_APPLY_ATTEMPTS,
  DEFAULT_APPROVAL_POLICIES,
} from '@launch/shared/launch-approvals'
import { releaseBundleAssetName, releaseTagRef } from '@launch/shared/launch-releases'
import { and, desc, eq } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import {
  type AppReleaseRow,
  type ApprovalRequestRow,
  appEnvironments,
  appReleases,
  approvalDecisions,
  apps,
  auditEvents,
} from '../../../../db/schema'
import { ConflictError, NotFoundError } from '../../../utils/core/errors'
import { recordAudit, SYSTEM_ACTOR } from '../../launch/audit'
import {
  decidePending,
  findApprovalIntent,
  getTenantTicket,
  insertIntent,
} from '../../launch/deploy/tickets'
import { dispatchWorkflow } from '../../launch/github-app'
import { DEPLOY_WORKFLOW_FILE, withRepoToken } from '../../launch/releases/github'
import { verifyBundleAsset } from '../../launch/releases/bundle-manifest'
import { moveRelease } from '../../launch/releases/lifecycle'
import {
  BUNDLE_DRAFT_WAIT_MINUTES,
  draftExpectation,
  hasBundle,
  publishGitHubRelease,
  type RebuildReason,
  releaseNoteFacts,
  releaseNotes,
} from '../../launch/releases/publish'
import { nudgeRelease } from '../../launch/releases/release'
import type { ApprovalDeps, KindHandler } from '../types'

/**
 * How long a granted production approval's pre-approval waits for its run. Longer than P2's
 * 15-minute "Deploy to production": the publish that starts the run is retried by the sweep.
 */
export const RELEASE_INTENT_TTL_MS = 60 * 60 * 1000

/** The audit row of an `app` subject's dispatch — also what makes a retried `applyAfter` a no-op. */
const DISPATCHED_ACTION = 'deploy.production.dispatched'

/** P2's "Deploy to production" window, kept for the `app` subject. */
export const APP_INTENT_TTL_MS = 15 * 60 * 1000

function nowOf(deps: Pick<ApprovalDeps, 'now'>): Date {
  return deps.now?.() ?? new Date()
}

/** The person whose approval completed the request (the latest `approve`), for the ticket row. */
async function approverOf(tx: Database, request: ApprovalRequestRow): Promise<string | null> {
  const [row] = await tx
    .select({ userId: approvalDecisions.userId })
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.tenantId, request.tenantId),
        eq(approvalDecisions.requestId, request.id),
        eq(approvalDecisions.decision, 'approve')
      )
    )
    .orderBy(desc(approvalDecisions.at))
    .limit(1)
  return row?.userId ?? null
}

/** What the person who rejected wrote — it becomes the ticket's `error`, which the job prints. */
async function rejectionComment(db: Database, request: ApprovalRequestRow): Promise<string | null> {
  const [row] = await db
    .select({ comment: approvalDecisions.comment })
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.tenantId, request.tenantId),
        eq(approvalDecisions.requestId, request.id),
        eq(approvalDecisions.decision, 'reject')
      )
    )
    .orderBy(desc(approvalDecisions.at))
    .limit(1)
  return row?.comment || null
}

async function productionScope(db: Database, request: ApprovalRequestRow, appId: string) {
  const [env] = await db
    .select({ id: appEnvironments.id })
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, request.tenantId),
        eq(appEnvironments.appId, appId),
        eq(appEnvironments.name, 'production')
      )
    )
    .limit(1)
  if (!env) {
    throw new ConflictError('This app has no production environment', 'app_environment_missing')
  }
  return { tenantId: request.tenantId, appId, environmentId: env.id }
}

async function releaseOf(db: Database, request: ApprovalRequestRow): Promise<AppReleaseRow> {
  const [row] = await db
    .select()
    .from(appReleases)
    .where(and(eq(appReleases.tenantId, request.tenantId), eq(appReleases.id, request.subjectId)))
    .limit(1)
  if (!row) throw new NotFoundError('Release not found', 'release_not_found')
  return row
}

async function appOf(db: Database, tenantId: string, appId: string) {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
    .limit(1)
  if (!row) throw new NotFoundError('App not found', 'app_not_found')
  return row
}

/** The release notes of a published Release: the PRs it carries. */
/**
 * `workflow_dispatch` of `deploy.yml` with `environment=production` at `ref` (a branch or a tag
 * name) for the approval's pre-approval — once. Already claimed (a retry after the run started),
 * expired or gone: nothing left to dispatch for. A retry after a dispatch that went out (and only
 * the `applied_at` write failed) must not start a second run: the dispatch's own audit row is the
 * record.
 */
async function dispatchProduction(
  request: ApprovalRequestRow,
  deps: ApprovalDeps,
  app: Awaited<ReturnType<typeof appOf>>,
  ref: string
): Promise<void> {
  const { db } = deps
  const intent = await findApprovalIntent(db, request.tenantId, request.id)
  if (!intent || intent.runId !== null || intent.status !== 'approved') return
  if (intent.expiresAt && intent.expiresAt <= nowOf(deps)) return
  const [sent] = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, request.tenantId),
        eq(auditEvents.approvalId, request.id),
        eq(auditEvents.action, DISPATCHED_ACTION)
      )
    )
    .limit(1)
  if (sent) return
  await withRepoToken(
    db,
    deps.cfg,
    app,
    { actions: 'write' },
    (token, { owner, repo }) =>
      dispatchWorkflow(
        token,
        owner,
        repo,
        DEPLOY_WORKFLOW_FILE,
        { ref, inputs: { environment: 'production' } },
        { fetch: deps.fetch }
      ),
    { fetch: deps.fetch }
  )
  await recordAudit(db, {
    ...SYSTEM_ACTOR,
    tenantId: request.tenantId,
    action: DISPATCHED_ACTION,
    targetType: 'deploy_ticket',
    targetId: intent.id,
    appId: app.id,
    approvalId: request.id,
    summary: { after: { workflow: DEPLOY_WORKFLOW_FILE, ref: intent.ref } },
  })
}

export const deployProductionHandler: KindHandler<'deploy.production'> = {
  kind: 'deploy.production',
  async defaultPolicy() {
    return DEFAULT_APPROVAL_POLICIES['deploy.production']
  },
  describe(request) {
    const context = request.context.kind === 'deploy.production' ? request.context : null
    if (request.subjectType === 'rollback' && context) {
      return `Roll production back to ${context.version ?? context.tag ?? 'an earlier release'}${context.rollbackFrom ? ` (from ${context.rollbackFrom})` : ''}`
    }
    return `Deploy ${context ? (context.version ?? context.ref ?? 'a build') : request.subjectId} to production`
  },

  async applyInTx(tx, request, deps) {
    const now = nowOf(deps)
    const approver = await approverOf(tx, request)

    if (request.subjectType === 'deploy_ticket') {
      const ticket = await getTenantTicket(tx, request.tenantId, request.subjectId)
      const decided = ticket
        ? await decidePending(
            tx,
            ticket,
            { approve: true, userId: approver, source: 'approval' },
            now
          )
        : null
      if (!ticket || !decided) {
        // The run stopped waiting (its window closed, or it was decided some other way): the
        // approval cannot reach it. Rolling back leaves the request pending for its own expiry.
        throw new ConflictError(
          'The GitHub run is no longer waiting for this approval; promote the release instead',
          APPROVAL_ERROR_CODES.deployRunGone
        )
      }
      await recordAudit(tx, {
        ...SYSTEM_ACTOR,
        tenantId: request.tenantId,
        action: 'deploy.production.approved',
        targetType: 'deploy_ticket',
        targetId: decided.id,
        appId: decided.appId,
        approvalId: request.id,
        summary: {
          before: { status: 'pending' },
          after: { status: decided.status, source: 'approval', runId: decided.runId },
        },
      })
      return
    }

    if (request.subjectType === 'release') {
      const release = await releaseOf(tx, request)
      const scope = await productionScope(tx, request, release.appId)
      await insertIntent(tx, scope, {
        userId: approver,
        expiresAt: new Date(now.getTime() + RELEASE_INTENT_TTL_MS),
        now,
        ref: releaseTagRef(release.tag),
        approvalId: request.id,
        releaseId: release.id,
        source: 'approval',
      })
      await moveRelease(
        tx,
        release,
        ['staging_active', 'awaiting_approval', 'rejected'],
        'promoting',
        { approvalId: request.id, error: null }
      )
      return
    }

    if (request.subjectType === 'app') {
      const app = await appOf(tx, request.tenantId, request.subjectId)
      const scope = await productionScope(tx, request, app.id)
      await insertIntent(tx, scope, {
        userId: approver,
        expiresAt: new Date(now.getTime() + APP_INTENT_TTL_MS),
        now,
        ref: `refs/heads/${app.defaultBranch ?? 'main'}`,
        approvalId: request.id,
        source: 'approval',
      })
      return
    }

    if (request.subjectType === 'rollback') {
      // App page P3: a pre-approval bound to the OLD tag, linked to that release, for the run the
      // dispatch in `applyAfter` starts. The release itself does not move until it goes live.
      const release = await releaseOf(tx, request)
      const scope = await productionScope(tx, request, release.appId)
      await insertIntent(tx, scope, {
        userId: approver,
        expiresAt: new Date(now.getTime() + RELEASE_INTENT_TTL_MS),
        now,
        ref: releaseTagRef(release.tag),
        approvalId: request.id,
        releaseId: release.id,
        source: 'approval',
      })
      return
    }

    throw new ConflictError(
      `A production deploy cannot be approved for a ${request.subjectType}`,
      'approval_subject_unsupported'
    )
  },

  async applyAfter(request, deps) {
    const { db } = deps
    if (request.subjectType === 'release') {
      const release = await releaseOf(db, request)
      const app = await appOf(db, request.tenantId, release.appId)
      // Issue #21: on a build-once kit the draft may not be there YET (the staging run's
      // `release-bundle` job attaches it after staging went live): wait for it — by failing this
      // attempt, which the approvals sweep retries — unless it is long gone or this is the last
      // attempt the engine allows, and then publish without it.
      const expected = await draftExpectation(db, release, nowOf(deps))
      const lastAttempt = request.applyAttempts >= APPROVAL_MAX_APPLY_ATTEMPTS
      const rebuildReason: RebuildReason | null =
        expected.state === 'gone'
          ? 'draft_gone'
          : expected.state === 'wait' && lastAttempt
            ? 'draft_wait_timed_out'
            : null
      const published = await withRepoToken(
        db,
        deps.cfg,
        app,
        { contents: 'write' },
        async (token, { owner, repo }) => {
          const gh = { fetch: deps.fetch }
          // Issue #12: published already → nothing (idempotent: a retry after a publish that
          // succeeded finds it); the kit's draft for the tag → PATCH it published, so production
          // deploys its bundle; no draft → POST, and production rebuilds (`releases/publish.ts`).
          const facts = await releaseNoteFacts(db, release, { token, owner, repo, gh })
          const stagingDigest = expected.stagingDigest
          return publishGitHubRelease(
            token,
            owner,
            repo,
            {
              tag: release.tag,
              name: release.version,
              body: bundle =>
                releaseNotes(release, { ...facts, bundle, rebuildReason: bundle ? null : rebuildReason }),
              waitForDraft: expected.state === 'wait' && !lastAttempt,
              // Issue #21: the bundle must be the build staging deployed.
              verifyDraft: stagingDigest
                ? async draft => {
                    const asset = (draft.assets ?? []).find(
                      a => a.name === releaseBundleAssetName(release.tag)
                    )
                    if (!asset) return
                    await verifyBundleAsset(
                      token,
                      owner,
                      repo,
                      { assetId: asset.id, tag: release.tag, stagingDigest },
                      gh
                    )
                  }
                : undefined,
            },
            gh
          )
        },
        { fetch: deps.fetch }
      )
      if (published.action === 'waiting') {
        throw new Error(
          `Waiting for the staging run to attach the release bundle to ${release.tag}'s draft; Launch publishes it as soon as it appears (at most ${BUNDLE_DRAFT_WAIT_MINUTES} minutes after staging went live)`
        )
      }
      if (published.action !== 'existing') {
        await recordAudit(db, {
          ...SYSTEM_ACTOR,
          tenantId: request.tenantId,
          action: 'release.published',
          targetType: 'release',
          targetId: release.id,
          appId: release.appId,
          approvalId: request.id,
          summary: {
            after: {
              tag: release.tag,
              url: published.release.html_url,
              status: release.status,
              // `draft`: the kit's staging draft was published (production deploys its bundle
              // when it carries one); `created`: a new release (production rebuilds).
              via: published.action === 'published_draft' ? 'draft' : 'created',
              bundle: hasBundle(published.release, release.tag),
              // Issue #21: a build-once kit published without its bundle, and why.
              ...(published.action === 'created' && rebuildReason ? { rebuildReason } : {}),
            },
          },
        })
      }
      nudgeRelease(deps, release)
      return
    }

    if (request.subjectType === 'app') {
      const app = await appOf(db, request.tenantId, request.subjectId)
      await dispatchProduction(request, deps, app, app.defaultBranch ?? 'main')
      return
    }

    if (request.subjectType === 'rollback') {
      // App page P3: the repo's OWN deploy workflow, dispatched at the old tag — exactly what a
      // person would do by hand in GitHub to roll back, so the app stays detachable.
      const release = await releaseOf(db, request)
      const app = await appOf(db, request.tenantId, release.appId)
      await dispatchProduction(request, deps, app, release.tag)
      nudgeRelease(deps, release)
    }
    // `deploy_ticket`: the waiting job reads `approved` on its next poll; nothing to do.
  },

  async onClosed(request, status, deps) {
    const { db } = deps
    if (request.subjectType === 'release') {
      const [release] = await db
        .select()
        .from(appReleases)
        .where(
          and(eq(appReleases.tenantId, request.tenantId), eq(appReleases.id, request.subjectId))
        )
        .limit(1)
      if (!release) return
      const moved = await moveRelease(db, release, ['awaiting_approval'], 'rejected', {
        error: `The production deploy was ${status}`,
      })
      if (moved) {
        await recordAudit(db, {
          ...SYSTEM_ACTOR,
          tenantId: request.tenantId,
          action: 'release.rejected',
          targetType: 'release',
          targetId: release.id,
          appId: release.appId,
          approvalId: request.id,
          summary: {
            before: { status: release.status },
            after: { status: 'rejected', why: status },
          },
        })
        nudgeRelease(deps, moved)
      }
      return
    }
    if (request.subjectType === 'deploy_ticket') {
      const ticket = await getTenantTicket(db, request.tenantId, request.subjectId)
      if (!ticket) return
      const error =
        status === 'expired'
          ? 'Nobody approved it in time'
          : ((await rejectionComment(db, request)) ?? `The approval was ${status}`)
      const decided = await decidePending(
        db,
        ticket,
        { approve: false, userId: null, source: 'approval', error },
        nowOf(deps)
      )
      if (decided) {
        await recordAudit(db, {
          ...SYSTEM_ACTOR,
          tenantId: request.tenantId,
          action: 'deploy.production.rejected',
          targetType: 'deploy_ticket',
          targetId: decided.id,
          appId: decided.appId,
          approvalId: request.id,
          summary: { before: { status: 'pending' }, after: { status: 'rejected', why: status } },
        })
      }
    }
    if (request.subjectType === 'rollback') {
      // Nothing was written before approval; the Live row's "waiting" line just goes away.
      const [release] = await db
        .select()
        .from(appReleases)
        .where(
          and(eq(appReleases.tenantId, request.tenantId), eq(appReleases.id, request.subjectId))
        )
        .limit(1)
      if (release) nudgeRelease(deps, release)
    }
    // `app`: nothing was written before approval.
  },
}
