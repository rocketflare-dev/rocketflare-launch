/**
 * Release (Launch P4, plan §1.8 / §4d) — slice 4d builds it. `POST /api/apps/:id/releases {bump}`
 * (the app's owners and admins):
 *
 * 1. read the root `package.json` on the default branch (`getRepoFile`);
 * 2. `commitFiles` the bump (`bumpVersion` from `@launch/shared/launch-releases`) — the job
 *    refuses a tag that does not equal the version;
 * 3. `createRef refs/tags/X.Y.Z` (which starts `deploy.yml` staging);
 * 4. the PRs since the previous tag (`prs.ts`) → `app_releases.prs`;
 * 5. audit `release.created`, plus `pr.merged` for any PR not yet recorded.
 *
 * Under an installation token narrowed to the one repo (`installationFor` / `installationToken`),
 * revoked afterwards (`revokeInstallationToken`).
 */
import type { ReleaseBump } from '@launch/shared/launch-releases'
import type { AppReleaseRow, AppRow } from '../../../../db/schema'
import { type ApprovalDeps, NotWiredError } from '../../approvals/types'
import type { AuditActor } from '../audit'

export interface CreateReleaseInput {
  tenantId: string
  app: AppRow
  bump: ReleaseBump
  userId: string
  actor: AuditActor
}

export async function createRelease(
  _deps: ApprovalDeps,
  _input: CreateReleaseInput
): Promise<AppReleaseRow> {
  throw new NotWiredError('releases.createRelease', '4d')
}

export async function listReleases(
  _deps: Pick<ApprovalDeps, 'db'>,
  _input: { tenantId: string; appId: string }
): Promise<AppReleaseRow[]> {
  throw new NotWiredError('releases.listReleases', '4d')
}

export async function getRelease(
  _deps: Pick<ApprovalDeps, 'db'>,
  _input: { tenantId: string; appId: string; releaseId: string }
): Promise<AppReleaseRow> {
  throw new NotWiredError('releases.getRelease', '4d')
}
