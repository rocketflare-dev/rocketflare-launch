/**
 * Cancel release (app page P2, the ⋯ menu): `POST /api/apps/:id/releases/:rid/cancel` (the app's
 * owners and admins) cancels the release's deploy run IN FLIGHT on GitHub — the plain
 * `POST …/actions/runs/{id}/cancel` anyone with the repo could press — and marks the release
 * `failed` ("cancelled"), so the app page shows it stopped and Retry re-runs it later:
 *
 * - `tagged` / `staging` → the tag's run (its gate, or its staging job);
 * - `promoting` → the production run.
 *
 * A release with no run going (waiting on a person, settled, or a run already finished) is 409
 * `release_not_cancellable`. The ticket the cancelled job held is settled the usual way: its run
 * poll sees the run ended and fails it (revoking a migrator credential it still held), and
 * `releaseRunFailed` leaves the already-failed release alone. Awaiting approval is not a run —
 * withdrawing that request is the approval's own action.
 */
import { RELEASE_ERROR_CODES, type ReleaseStatus } from '@launch/shared/launch-releases'
import type { AppReleaseRow, AppRow } from '../../../../db/schema'
import { ApiError, ConflictError, isApiError } from '../../../utils/core/errors'
import type { ApprovalDeps } from '../../approvals/types'
import { type AuditActor, recordAudit } from '../audit'
import { cancelWorkflowRun, GITHUB_TOKEN_PERMISSIONS, type GitHubOptions } from '../github-app'
import { withRepoToken } from './github'
import { moveRelease } from './lifecycle'
import { getRelease, nudgeRelease } from './release'
import { findReleaseRun, type ReleaseEnvironment, runCompleted } from './release-run'

const CANCELLABLE: Record<string, ReleaseEnvironment> = {
  tagged: 'staging',
  staging: 'staging',
  promoting: 'production',
}

export interface CancelReleaseInput {
  tenantId: string
  app: AppRow
  releaseId: string
  user: { id: string; email: string }
  actor: AuditActor
}

function notCancellable(message: string): never {
  throw new ConflictError(message, RELEASE_ERROR_CODES.notCancellable)
}

export async function cancelRelease(
  deps: ApprovalDeps,
  input: CancelReleaseInput
): Promise<{ release: AppReleaseRow; runUrl: string }> {
  const release = await getRelease(deps, {
    tenantId: input.tenantId,
    appId: input.app.id,
    releaseId: input.releaseId,
  })
  const environment = CANCELLABLE[release.status]
  if (!environment) {
    notCancellable(`Release ${release.version} is ${release.status}; no deploy run is in flight`)
  }
  const gh: GitHubOptions = { fetch: deps.fetch }
  const cancelled = await withRepoToken(
    deps.db,
    deps.cfg,
    input.app,
    GITHUB_TOKEN_PERMISSIONS.releaseRun,
    async (token, repo) => {
      const found = await findReleaseRun(deps.db, token, repo, release, environment, gh)
      if (!found?.run || runCompleted(found.run)) {
        notCancellable('No deploy run of this release is going on GitHub right now')
      }
      try {
        await cancelWorkflowRun(token, repo.owner, repo.repo, found.runId, gh)
      } catch (err) {
        if (isApiError(err)) throw err
        const message = err instanceof Error ? err.message : String(err)
        throw new ApiError(
          502,
          `GitHub refused the cancel: ${message}`,
          RELEASE_ERROR_CODES.githubFailed
        )
      }
      return found
    },
    gh
  )

  const error = `${environment}: cancelled in Launch by ${input.user.email} (${cancelled.url})`
  const moved = await moveRelease(deps.db, release, [release.status as ReleaseStatus], 'failed', {
    error,
  })
  const current =
    moved ??
    (await getRelease(deps, {
      tenantId: input.tenantId,
      appId: input.app.id,
      releaseId: release.id,
    }))
  await recordAudit(deps.db, {
    tenantId: input.tenantId,
    ...input.actor,
    action: 'release.cancelled',
    targetType: 'release',
    targetId: release.id,
    appId: release.appId,
    summary: {
      before: { status: release.status },
      after: {
        status: current.status,
        version: release.version,
        tag: release.tag,
        environment,
        runUrl: cancelled.url,
        attempt: cancelled.run?.run_attempt ?? null,
      },
    },
  })
  nudgeRelease(deps, current)
  return { release: current, runUrl: cancelled.url }
}
