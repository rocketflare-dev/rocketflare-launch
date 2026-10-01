/**
 * Issue #5 Phase B's bodies (`docs/plans/i5-ship-to-staging.md` §1.8–§1.9): after the merge, the
 * `SessionWorkflow` calls these through the `landRelease` / `landStaging` / `landHealth` hooks
 * (`hooks.ts`) — cut (or share) the patch release under the app's release claim, follow it to
 * `staging_active`, then wait for staging to answer healthy on its version.
 *
 * S1 left typed stubs; slice S3 fills them (and owns this file).
 */
import { NotWiredError } from '../i5-not-wired'
import type {
  LandHealthResult,
  LandReleaseResult,
  LandStagingResult,
  SessionStepContext,
} from './hooks'

/** `land.release#K.R` — S3 fills it (plan §1.8). */
export async function landRelease(_ctx: SessionStepContext): Promise<LandReleaseResult> {
  throw new NotWiredError('landRelease', 'S3')
}

/** `land.staging#K.R` — S3 fills it (plan §1.9). */
export async function landStaging(_ctx: SessionStepContext): Promise<LandStagingResult> {
  throw new NotWiredError('landStaging', 'S3')
}

/** `land.health#K.R` — S3 fills it (plan §1.9). */
export async function landHealth(_ctx: SessionStepContext): Promise<LandHealthResult> {
  throw new NotWiredError('landHealth', 'S3')
}
