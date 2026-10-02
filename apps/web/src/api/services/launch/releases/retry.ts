/**
 * Stage-aware Retry (app page P2, plan decision 7): `POST /api/apps/:id/releases/:rid/retry`
 * (the app's owners and admins) does the ONE thing that unsticks the stage the release is stuck at
 * (`failedStageOf`). Every branch is a plain GitHub operation or a Launch-side re-check — never
 * Launch-only state GitHub does not reflect (decision 3: the app stays detachable):
 *
 * - **`staging_deploy` / `production_deploy`** → GitHub's "Re-run failed jobs" on THAT run
 *   (`rerunFailedJobs`), which starts its next attempt on the same commit. The attempts are kept:
 *   attempt 2's deploy job opens a ticket of its own (`run_attempt` 2) and `releaseRunStarted`
 *   moves the release onto it, and attempt 1's ticket stays in the history. Production re-runs
 *   under the approval its first attempt was granted: a pre-approval bound to the release's tag
 *   ref and carrying that approval (`insertIntent`, `source: 'approval'`) waits for attempt 2's
 *   `start` to claim it — so the re-run is not mistaken for a stranger and sent to approval again;
 * - **`tag`** → the tag's push started no run: when GitHub no longer has the tag, push it again
 *   on the release's commit (which starts `deploy.yml`); when it has it, there is nothing Launch
 *   can redo (409) — the repo's workflow did not run on the tag;
 * - **`staging_health` / `production_health`** → probe now (`checkAppHealth`, the app page's
 *   "Check now");
 * - **`approval_rejected`** → request the production approval again (`promoteRelease`).
 *
 * **Concurrency**: the release moves out of `failed` by a compare-and-set BEFORE GitHub is asked,
 * so two Retry presses are one re-run and one 409; a GitHub refusal moves it back (and drops the
 * unclaimed pre-approval) and answers 502. The tag-run follower's read turn is stamped in the same
 * write, so a reading taken before the re-run cannot fail the release again.
 *
 * Each retry is audited `release.retried { stage, action, attempt, runUrl }` on the release, so it
 * reads in the release's chain.
 */
import { PRODUCTION_INTENT_TTL_MS } from '@launch/shared/launch-pipeline'
import {
  RELEASE_ERROR_CODES,
  type ReleaseFailedStage,
  type ReleaseRetryAction,
  type ReleaseStatus,
  releaseTagRef,
} from '@launch/shared/launch-releases'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { AppReleaseRow, AppRow } from '../../../../db/schema'
import { appReleases, deployTickets } from '../../../../db/schema'
import { ApiError, ConflictError, isApiError } from '../../../utils/core/errors'
import type { ApprovalDeps } from '../../approvals/types'
import { type AuditActor, recordAudit } from '../audit'
import { insertIntent } from '../deploy/tickets'
import {
  createRef,
  GITHUB_TOKEN_PERMISSIONS,
  type GitHubOptions,
  getRef,
  isGitHubNotFound,
  rerunFailedJobs,
} from '../github-app'
import { checkAppHealth } from '../health'
import { failedStageOf, stageEnvironments } from './failed-stage'
import { withRepoToken } from './github'
import { promoteRelease } from './promote'
import { getRelease, nudgeRelease } from './release'
import { findReleaseRun, type ReleaseEnvironment, runCompleted } from './release-run'

export interface RetryReleaseInput {
  tenantId: string
  app: AppRow
  releaseId: string
  /** The stage the caller saw; a release that has moved on since is 409 `release_stage_changed`. */
  expectedStage?: ReleaseFailedStage
  user: { id: string; email: string; role: string | null }
  reason?: string | null
  actor: AuditActor
  now?: Date
}

export interface RetryReleaseOutcome {
  release: AppReleaseRow
  stage: ReleaseFailedStage
  action: ReleaseRetryAction
  attempt: number | null
  runUrl: string | null
  approvalId: string | null
  health: string | null
}

function notRetryable(message: string): never {
  throw new ConflictError(message, RELEASE_ERROR_CODES.notRetryable)
}

/** A GitHub failure as the route answers it: 502 with GitHub's own message (never a token). */
function githubFailed(err: unknown, what: string): never {
  if (isApiError(err)) throw err
  const message = err instanceof Error ? err.message : String(err)
  throw new ApiError(502, `GitHub refused ${what}: ${message}`, RELEASE_ERROR_CODES.githubFailed)
}

async function audit(
  deps: ApprovalDeps,
  input: RetryReleaseInput,
  before: AppReleaseRow,
  outcome: RetryReleaseOutcome
): Promise<void> {
  await recordAudit(deps.db, {
    tenantId: input.tenantId,
    ...input.actor,
    action: 'release.retried',
    targetType: 'release',
    targetId: before.id,
    appId: before.appId,
    approvalId: outcome.approvalId,
    summary: {
      before: { status: before.status, error: before.error },
      after: {
        status: outcome.release.status,
        version: before.version,
        tag: before.tag,
        stage: outcome.stage,
        action: outcome.action,
        attempt: outcome.attempt,
        runUrl: outcome.runUrl,
        ...(outcome.health ? { health: outcome.health } : {}),
      },
    },
  })
}

/**
 * `failed → to`, the error cleared and the tag-run follower's read turn taken, or null when the
 * release is no longer `failed` (another Retry won).
 */
async function claimFailed(
  deps: ApprovalDeps,
  release: AppReleaseRow,
  to: ReleaseStatus,
  now: Date
): Promise<AppReleaseRow | null> {
  const [row] = await deps.db
    .update(appReleases)
    .set({ status: to, error: null, tagRun: null, tagRunPolledAt: now, updatedAt: now })
    .where(
      and(
        eq(appReleases.tenantId, release.tenantId),
        eq(appReleases.id, release.id),
        eq(appReleases.status, 'failed')
      )
    )
    .returning()
  return row ?? null
}

/** Undo `claimFailed` after GitHub refused: back to `failed` with the error it had. */
async function unclaim(deps: ApprovalDeps, claimed: AppReleaseRow, before: AppReleaseRow) {
  await deps.db
    .update(appReleases)
    .set({ status: 'failed', error: before.error, tagRun: before.tagRun, updatedAt: new Date() })
    .where(
      and(
        eq(appReleases.tenantId, claimed.tenantId),
        eq(appReleases.id, claimed.id),
        eq(appReleases.status, claimed.status)
      )
    )
}

/** Re-run the failed jobs of the release's run in `environment`. */
async function rerun(
  deps: ApprovalDeps,
  input: RetryReleaseInput,
  release: AppReleaseRow,
  stage: ReleaseFailedStage,
  environment: ReleaseEnvironment,
  now: Date
): Promise<RetryReleaseOutcome> {
  const gh: GitHubOptions = { fetch: deps.fetch }
  return withRepoToken(
    deps.db,
    deps.cfg,
    input.app,
    GITHUB_TOKEN_PERMISSIONS.releaseRun,
    async (token, repo) => {
      const found = await findReleaseRun(deps.db, token, repo, release, environment, gh).catch(
        err => githubFailed(err, 'the read of the deploy run')
      )
      if (!found) {
        if (environment === 'staging' && !(await tagExists(token, repo, release.tag, gh))) {
          // No run because the tag itself is gone: that is the tag step's retry.
          return retag(deps, input, release, now, { token, repo, gh })
        }
        notRetryable(
          environment === 'staging'
            ? `GitHub has no deploy run for the tag ${release.tag} to re-run`
            : 'Launch has no record of the production run to re-run; ship the release again'
        )
      }
      if (!found.run) notRetryable('GitHub no longer lists the deploy run; it cannot be re-run')
      if (!runCompleted(found.run)) {
        throw new ConflictError(
          'The deploy run is still going on GitHub; retry once it has finished',
          RELEASE_ERROR_CODES.runInProgress
        )
      }
      if (found.run.conclusion === 'success') {
        notRetryable('The deploy run succeeded on GitHub; there are no failed jobs to re-run')
      }

      // Production re-runs under the approval its first attempt was granted, and only then.
      let approvalId: string | null = null
      if (environment === 'production') {
        const ticket = found.ticket
        approvalId = ticket?.approvalId ?? release.approvalId
        if (!ticket?.decidedAt || ticket.status === 'rejected' || ticket.status === 'pending') {
          notRetryable('That production deploy was never approved; ship the release again')
        }
      }

      const target: ReleaseStatus =
        environment === 'production' ? 'promoting' : release.stagingTicketId ? 'staging' : 'tagged'
      const claimed = await claimFailed(deps, release, target, now)
      if (!claimed) {
        throw new ConflictError(
          'Someone else retried this release a moment ago',
          RELEASE_ERROR_CODES.stageChanged
        )
      }

      let intentId: string | null = null
      if (environment === 'production' && found.ticket) {
        const intent = await insertIntent(
          deps.db,
          {
            tenantId: release.tenantId,
            appId: release.appId,
            environmentId: found.ticket.environmentId,
          },
          {
            userId: input.user.id,
            expiresAt: new Date(now.getTime() + PRODUCTION_INTENT_TTL_MS),
            now,
            ref: found.ticket.ref ?? releaseTagRef(release.tag),
            approvalId,
            releaseId: release.id,
            source: 'approval',
          }
        )
        intentId = intent.id
      }

      try {
        await rerunFailedJobs(token, repo.owner, repo.repo, found.runId, gh)
      } catch (err) {
        await unclaim(deps, claimed, release)
        if (intentId) {
          await deps.db
            .delete(deployTickets)
            .where(
              and(
                eq(deployTickets.tenantId, release.tenantId),
                eq(deployTickets.id, intentId),
                isNull(deployTickets.runId)
              )
            )
        }
        githubFailed(err, 'the re-run')
      }

      return {
        release: claimed,
        stage,
        action: 'rerun' as const,
        attempt: (found.run.run_attempt ?? 1) + 1,
        runUrl: found.url,
        approvalId,
        health: null,
      }
    },
    gh
  )
}

async function tagExists(
  token: string,
  repo: { owner: string; repo: string },
  tag: string,
  gh: GitHubOptions
): Promise<boolean> {
  try {
    await getRef(token, repo.owner, repo.repo, `tags/${tag}`, gh)
    return true
  } catch (err) {
    if (isGitHubNotFound(err)) return false
    githubFailed(err, 'the read of the tag')
  }
}

/** Push the release's tag again on its commit, when GitHub no longer has it. */
async function retag(
  deps: ApprovalDeps,
  input: RetryReleaseInput,
  release: AppReleaseRow,
  now: Date,
  github: { token: string; repo: { owner: string; repo: string }; gh: GitHubOptions }
): Promise<RetryReleaseOutcome> {
  const { token, repo, gh } = github
  if (await tagExists(token, repo, release.tag, gh)) {
    notRetryable(
      `GitHub has the tag ${release.tag} but started no deploy run for it; check that the repository's deploy workflow runs on tag pushes`
    )
  }
  // `tagged` (stalled) or `failed`: either way it goes back to waiting for the tag's run.
  const [claimed] = await deps.db
    .update(appReleases)
    .set({ status: 'tagged', error: null, tagRun: null, tagRunPolledAt: null, updatedAt: now })
    .where(
      and(
        eq(appReleases.tenantId, release.tenantId),
        eq(appReleases.id, release.id),
        eq(appReleases.status, release.status),
        // The row as read (to the millisecond a JS Date keeps): a second press finds it moved.
        sql`date_trunc('milliseconds', ${appReleases.updatedAt}) = ${release.updatedAt.toISOString()}::timestamptz`
      )
    )
    .returning()
  if (!claimed) {
    throw new ConflictError(
      'The release moved on a moment ago; reload and try again',
      RELEASE_ERROR_CODES.stageChanged
    )
  }
  try {
    await createRef(token, repo.owner, repo.repo, releaseTagRef(release.tag), release.sha, gh)
  } catch (err) {
    await deps.db
      .update(appReleases)
      .set({ status: release.status, error: release.error, tagRun: release.tagRun })
      .where(and(eq(appReleases.tenantId, release.tenantId), eq(appReleases.id, release.id)))
    githubFailed(err, 'the tag')
  }
  return {
    release: claimed,
    stage: 'tag',
    action: 'retag',
    attempt: null,
    runUrl: null,
    approvalId: null,
    health: null,
  }
}

async function recheckHealth(
  deps: ApprovalDeps,
  input: RetryReleaseInput,
  release: AppReleaseRow,
  stage: ReleaseFailedStage
): Promise<RetryReleaseOutcome> {
  const name = stage === 'staging_health' ? 'staging' : 'production'
  const probed = await checkAppHealth(deps.db, input.tenantId, release.appId, { fetch: deps.fetch })
  const env = probed.find(r => r.name === name)
  return {
    release,
    stage,
    action: 'health_check',
    attempt: null,
    runUrl: null,
    approvalId: null,
    health: env?.healthStatus ?? null,
  }
}

export async function retryRelease(
  deps: ApprovalDeps,
  input: RetryReleaseInput
): Promise<RetryReleaseOutcome> {
  const now = input.now ?? new Date()
  const release = await getRelease(deps, {
    tenantId: input.tenantId,
    appId: input.app.id,
    releaseId: input.releaseId,
  })
  const stage = failedStageOf(
    release,
    await stageEnvironments(deps.db, input.tenantId, input.app.id),
    now
  )
  if (!stage) {
    notRetryable(`Release ${release.version} is ${release.status}; nothing about it is failing`)
  }
  if (input.expectedStage && input.expectedStage !== stage) {
    throw new ConflictError(
      `The release is no longer stuck at that step (it is now: ${stage}); reload and try again`,
      RELEASE_ERROR_CODES.stageChanged,
      { stage }
    )
  }

  let outcome: RetryReleaseOutcome
  switch (stage) {
    case 'staging_deploy':
      outcome = await rerun(deps, input, release, stage, 'staging', now)
      break
    case 'production_deploy':
      outcome = await rerun(deps, input, release, stage, 'production', now)
      break
    case 'tag':
      outcome = await withRepoToken(
        deps.db,
        deps.cfg,
        input.app,
        GITHUB_TOKEN_PERMISSIONS.releaseTag,
        (token, repo) =>
          retag(deps, input, release, now, { token, repo, gh: { fetch: deps.fetch } }),
        { fetch: deps.fetch }
      )
      break
    case 'staging_health':
    case 'production_health':
      outcome = await recheckHealth(deps, input, release, stage)
      break
    case 'approval_rejected': {
      const promoted = await promoteRelease(deps, {
        tenantId: input.tenantId,
        app: input.app,
        releaseId: release.id,
        user: input.user,
        reason: input.reason ?? null,
        actor: input.actor,
      })
      outcome = {
        release: promoted.release,
        stage,
        action: 'approval',
        attempt: null,
        runUrl: null,
        approvalId: promoted.approvalId,
        health: null,
      }
      break
    }
  }
  await audit(deps, input, release, outcome)
  nudgeRelease(deps, outcome.release)
  return outcome
}
