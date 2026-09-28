/**
 * Promote (Launch P4, plan §1.8 / §4d) — slice 4d builds it. `POST …/releases/:rid/promote` needs
 * the staging environment's `lastDeployVersion` = the release and staging `up`; it then opens a
 * `deploy.production` approval with subject `release` and the context `{version, tag, sha,
 * compareUrl, prs (+checks), stagingHealth, stagingVersion}`, excluding the promoter and the
 * creators of the release's sessions (plan §1.6). The release goes `awaiting_approval`.
 */
import type { AppReleaseRow, AppRow } from '../../../../db/schema'
import { type ApprovalDeps, NotWiredError } from '../../approvals/types'
import type { AuditActor } from '../audit'

export interface PromoteReleaseInput {
  tenantId: string
  app: AppRow
  releaseId: string
  user: { id: string; email: string; role: string | null }
  reason?: string | null
  actor: AuditActor
}

export async function promoteRelease(
  _deps: ApprovalDeps,
  _input: PromoteReleaseInput
): Promise<{ release: AppReleaseRow; approvalId: string }> {
  throw new NotWiredError('releases.promoteRelease', '4d')
}
