/**
 * Issue #5 Phase A and the landing's settle steps (`docs/plans/i5-ship-to-staging.md` §1.2–§1.7):
 * what a `shipping` session with a `landing` does in its turn loop — watch CI on the gate SHA,
 * open and wait for the `session.merge` review, squash-merge, or give the session back — and the
 * two steps that end Phase B (`land.live#K`, `land.stalled#K`). The Workflow
 * (`SessionWorkflow.land` / `.release`) runs each as one step over a `StepScope`; Phase B's own
 * bodies are the `landRelease` / `landStaging` / `landHealth` hooks (`land-release.ts`).
 *
 * S1 left typed stubs; slice S2 fills them (and owns this file).
 */
import type { ShipReopenReason, ShipStalledReason } from '@launch/shared/launch-sessions'
import type { Database } from '../../../db/client'
import type { AppBindings } from '../../types'
import type { Logger } from '../../utils/core/logger'
import { NotWiredError } from '../i5-not-wired'
import type { StepScope } from './steps'

/**
 * What a Phase A round tells the loop to do next.
 *
 * - `wait`: nothing to do yet — `land.wait#N` waits `waitSeconds` for `SESSION_WAKE_EVENT`
 *   (CI rounds: 30 s for the first 10 minutes, then 2 minutes);
 * - `review`: CI is green and a review is required — `land.review#N` next;
 * - `merge`: CI is green and no review is required, or the review approved — `land.merge#N`;
 * - `release`: merged (by Launch, or by a person meanwhile) — the loop returns, `cleanup` runs,
 *   then Phase B;
 * - `reopen`: give the session back — `land.reopen#N` with the reason and the person's sentence.
 */
export type LandRound =
  | { next: 'wait'; waitSeconds: number }
  | { next: 'review' }
  | { next: 'merge' }
  | { next: 'release'; mergeSha: string }
  | { next: 'reopen'; reason: ShipReopenReason; message: string }

/** What `land.ci#N` read on the gate SHA (plan §1.4). */
export type LandCiVerdict =
  | 'pending'
  | 'success'
  | 'failure'
  | 'none'
  | 'merged'
  | 'closed'
  | 'head_moved'

/**
 * `land.ci#N` — S2 fills it (plan §1.4–§1.5): `getPullRequest` + `getChecks` on `landing.gateSha`,
 * fresh each round; a red CI carries `failedCheckLog`'s redacted tail on `ship.ci`.
 */
export async function landCiStep(
  _scope: StepScope
): Promise<LandRound & { verdict: LandCiVerdict }> {
  throw new NotWiredError('landCiStep', 'S2')
}

/**
 * `land.review#N` — S2 fills it (plan §1.11–§1.12): open the `session.merge` approval idempotently
 * (`landing.approvalId` first, then the pending-subject index), then read it: pending → `wait`,
 * approved on this head → `merge`, rejected / expired / cancelled → `reopen`.
 */
export async function landReviewStep(_scope: StepScope): Promise<LandRound> {
  throw new NotWiredError('landReviewStep', 'S2')
}

/**
 * `land.merge#N` — S2 fills it (plan §1.6): read first (a recorded or GitHub-side merge wins), check
 * the head and CI again, squash on the gate SHA, then one CAS `shipping → shipped` / stage
 * `releasing`. Answers `release` or `reopen`, never `wait`.
 */
export async function landMergeStep(
  _scope: StepScope
): Promise<Extract<LandRound, { next: 'release' | 'reopen' }>> {
  throw new NotWiredError('landMergeStep', 'S2')
}

/**
 * `land.reopen#N` — S2 fills it (plan §1.7): `shipping → ready` while the container is still the
 * loop's (`bootId`'s boot marker), else `shipping → suspended`; `landing := null`, events
 * `ship.reopened` + `error`, audit `session.ship_reopened`. Null when the row was no longer
 * `shipping` (another instance settled it).
 */
export async function landReopenStep(
  _scope: StepScope,
  _input: { reason: ShipReopenReason; message: string; bootId: string | null }
): Promise<{ status: 'ready' | 'suspended' } | null> {
  throw new NotWiredError('landReopenStep', 'S2')
}

/**
 * Release the container while the landing waits in `ci` or `approval` — backup + destroy
 * (`backupWorkspace`), `landing.containerReleased = true` — S2 fills it (plan §1.7). True when it
 * released one now.
 */
export async function releaseLandingContainer(
  _scope: StepScope,
  _reason: 'idle' | 'approval' | 'drain'
): Promise<boolean> {
  throw new NotWiredError('releaseLandingContainer', 'S2')
}

/**
 * `land.live#K` — S2 fills it (plan §1.9): stage `live` with `stagingUrl` and the version,
 * `ship.staging {status:'live'}`, audit `session.landed`.
 */
export async function landLiveStep(
  _scope: StepScope,
  _input: { url: string | null; version: string }
): Promise<void> {
  throw new NotWiredError('landLiveStep', 'S2')
}

/**
 * `land.stalled#K` — S2 fills it (decision §0.1): stage `stalled` with the reason and a sentence
 * linking the app page; the session stays `shipped`, never reopens.
 */
export async function landStalledStep(
  _scope: StepScope,
  _input: { reason: ShipStalledReason; error: string }
): Promise<void> {
  throw new NotWiredError('landStalledStep', 'S2')
}

/**
 * The `sessions.checks` cron's safety net — S2 fills it (plan §1.4): wake (or restart) every
 * `shipping`/`shipped` session whose landing is in a moving stage (`MOVING_LANDING_STAGES`) and
 * whose `stageAt` is older than three rounds. Cross-tenant, like the rest of that cron. Returns
 * how many it woke.
 */
export async function nudgeLandingSessions(
  _db: Database,
  _env: AppBindings,
  _logger: Logger,
  _now: Date
): Promise<number> {
  throw new NotWiredError('nudgeLandingSessions', 'S2')
}
