/**
 * Issue #5: releases serialise per app on a claim on the `apps` row
 * (`docs/plans/i5-ship-to-staging.md` §1.8) — `apps.release_claim_holder` (`session:<id>` |
 * `user:<id>`) and `apps.release_claimed_at`, taken by `UPDATE … WHERE holder IS NULL OR
 * claimed_at < now() - RELEASE_CLAIM_STALE_MINUTES RETURNING` (the `claimDevPrepare` precedent)
 * and released in a `finally`. A session's landing that loses waits and re-checks; `POST
 * /api/apps/:id/releases` answers 409 `release_in_progress`.
 *
 * S1 left a typed stub; slice S3 fills it (and owns this file).
 */
import type { Database } from '../../../../db/client'
import { NotWiredError } from '../../i5-not-wired'

/** A claim older than this is stale and may be taken over (its holder died mid-release). */
export const RELEASE_CLAIM_STALE_MINUTES = 10

/** Who holds an app's release claim: a session's landing, or a person pressing Release. */
export type ReleaseClaimHolder = `session:${string}` | `user:${string}`

/** `withReleaseClaim`'s answer: `fn`'s value when the claim was won, else who holds it. */
export type ReleaseClaimOutcome<T> =
  | { claimed: true; value: T }
  | { claimed: false; holder: string | null }

/**
 * Run `fn` holding `appId`'s release claim, tenant-first, and release it after whatever happened —
 * S3 fills it (plan §1.8). Not won → `{ claimed: false }` and `fn` never runs.
 */
export async function withReleaseClaim<T>(
  _db: Database,
  _input: { tenantId: string; appId: string; holder: ReleaseClaimHolder; now?: Date },
  _fn: () => Promise<T>
): Promise<ReleaseClaimOutcome<T>> {
  throw new NotWiredError('withReleaseClaim', 'S3')
}
