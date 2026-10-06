/**
 * Issue #5: releases serialise per app on a claim on the `apps` row
 * (`docs/plans/i5-ship-to-staging.md` §1.8) — `apps.release_claim_holder` (`session:<id>` |
 * `user:<id>`) and `apps.release_claimed_at`, taken by `UPDATE … WHERE holder IS NULL OR
 * claimed_at < now() - RELEASE_CLAIM_STALE_MINUTES RETURNING` (the `claimDevPrepare` precedent)
 * and released in a `finally`. A session's landing that loses waits and re-checks; `POST
 * /api/apps/:id/releases` answers 409 `release_in_progress`.
 *
 * The claim is a ROW, never a lock or a `Map`: it survives the Worker that took it, and a holder
 * that died mid-release (a Workflow step killed between the claim and the `finally`) leaves a claim
 * that goes stale after ten minutes and is then taken over — or at once by the same SESSION, whose
 * landing re-runs `land.release` after its Workflow step died (a `wrangler dev` reload, a deploy):
 * one landing runs at a time, so a session's own claim is always a dead attempt's. A PERSON's own
 * claim is never re-entered (a second press of Release is still 409). The release is still safe without it —
 * the tag is the idempotency key (unique `(app_id, tag)`, GitHub's 422 on an existing ref) — the
 * claim only stops two releases from bumping the same version at once and failing one of them.
 */
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { apps } from '../../../../db/schema'

/** A claim older than this is stale and may be taken over (its holder died mid-release). */
export const RELEASE_CLAIM_STALE_MINUTES = 10

/** Who holds an app's release claim: a session's landing, or a person pressing Release. */
export type ReleaseClaimHolder = `session:${string}` | `user:${string}`

/** `withReleaseClaim`'s answer: `fn`'s value when the claim was won, else who holds it. */
export type ReleaseClaimOutcome<T> =
  | { claimed: true; value: T }
  | { claimed: false; holder: string | null }

/**
 * Run `fn` holding `appId`'s release claim, tenant-first, and release it after whatever happened
 * (plan §1.8). Not won → `{ claimed: false, holder }` and `fn` never runs. `fn`'s error is
 * rethrown after the release. The release only clears a claim that is still THIS one (same holder
 * and `claimed_at`), so a holder whose claim went stale and was taken over never frees the
 * newcomer's.
 */
export async function withReleaseClaim<T>(
  db: Database,
  input: { tenantId: string; appId: string; holder: ReleaseClaimHolder; now?: Date },
  fn: () => Promise<T>
): Promise<ReleaseClaimOutcome<T>> {
  const { tenantId, appId, holder } = input
  const claimedAt = input.now ?? new Date()
  const staleBefore = new Date(claimedAt.getTime() - RELEASE_CLAIM_STALE_MINUTES * 60_000)
  const [won] = await db
    .update(apps)
    .set({ releaseClaimHolder: holder, releaseClaimedAt: claimedAt })
    .where(
      and(
        eq(apps.tenantId, tenantId),
        eq(apps.id, appId),
        or(
          isNull(apps.releaseClaimHolder),
          lt(apps.releaseClaimedAt, staleBefore),
          holder.startsWith('session:') ? eq(apps.releaseClaimHolder, holder) : undefined
        )
      )
    )
    .returning({ id: apps.id })
  if (!won) {
    const [row] = await db
      .select({ holder: apps.releaseClaimHolder })
      .from(apps)
      .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
      .limit(1)
    return { claimed: false, holder: row?.holder ?? null }
  }
  try {
    return { claimed: true, value: await fn() }
  } finally {
    await db
      .update(apps)
      .set({ releaseClaimHolder: null, releaseClaimedAt: null })
      .where(
        and(
          eq(apps.tenantId, tenantId),
          eq(apps.id, appId),
          eq(apps.releaseClaimHolder, holder),
          eq(apps.releaseClaimedAt, claimedAt)
        )
      )
  }
}
