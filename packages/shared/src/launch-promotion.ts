/**
 * The app page's "pipeline" strip (rocketflare-launch#5 part 8): staging → [Promote to production]
 * → production, in one read. `GET /api/apps/:id/promotion` answers `appPromotionSchema` — what the
 * strip needs that the releases list and the app detail cannot give cheaply: the sessions behind
 * each PR (their titles), and who a pending `deploy.production` request waits on, named, for any
 * member of the organisation (the approval's own page answers only the people it concerns).
 *
 * The server only gathers; the STATE (enabled, which disabled reason, awaiting approval, deploying,
 * live) is decided client-side by a pure function over this shape, so the wording is unit-tested
 * and the server stays a read.
 *
 * - `candidate` — the newest release: what Promote would ship, or what is on its way;
 * - `staging` / `production` — each environment's version, when it went live, its health and URL,
 *   and the release it runs (null when no release carries that version);
 * - `changes` — the pull requests between production and the candidate, newest release first,
 *   each with the release that brought it and, when a Launch session wrote it, that session's title;
 * - `approval` — the candidate's `deploy.production` request, with the people it still waits on;
 * - `candidateRun` — while the candidate is `tagged` or `staging`, the GitHub Actions run its tag
 *   push started (`deploy.yml`): queued, which job it is on, or which job failed. Launch hears
 *   nothing from that run until its staging job calls `/ci`, so this is what fills the minutes
 *   between the tag and the staging deploy (and says why a release never got there).
 *
 * Promoting is unchanged: `POST /api/apps/:id/releases/:rid/promote`.
 */
import { z } from 'zod'
import { approvalStatusSchema } from './launch-approvals'
import { healthStatusSchema } from './launch-apps'
import { releaseSchema } from './launch-releases'

/**
 * -1 / 0 / 1 for two `X.Y.Z` versions — the one ordering the server's "what ships", the strip's
 * "production already runs it" and a rollback's "earlier than Live" share (defined beside the
 * versions in `launch-releases`). A missing or unparseable version sorts first.
 */
export { compareReleaseVersions } from './launch-releases'

/** At most this many pull requests are listed in one promotion. */
export const PROMOTION_MAX_CHANGES = 50

/** A change's `summary` (the session's stored ship summary body) is clipped to this many characters. */
export const PROMOTION_SUMMARY_MAX = 600

/** One environment as the strip shows it. */
export const promotionEnvironmentSchema = z.object({
  /** The version it last went live with (`app_environments.last_deploy_version`). */
  version: z.string().nullable(),
  deployedAt: z.coerce.date().nullable(),
  healthStatus: healthStatusSchema,
  url: z.string().nullable(),
  /** The release carrying `version`, when there is one. */
  releaseId: z.string().uuid().nullable(),
  /**
   * App page P3: Live runs `version` because a rollback put it there — the version it replaced
   * ("v1.4.1 (rolled back from v1.4.2)"). Null otherwise, and always on staging.
   */
  rolledBackFrom: z.string().nullable().default(null),
})
export type PromotionEnvironment = z.infer<typeof promotionEnvironmentSchema>

/** One pull request the promotion ships. */
export const promotionChangeSchema = z.object({
  /** The release that brought it. */
  version: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url().nullable(),
  sessionId: z.string().uuid().nullable(),
  /** The Launch session that wrote it, in its own words. */
  sessionTitle: z.string().nullable(),
  /**
   * Issue #5: the session's ship summary body (`sessions.ship_summary`), clipped to
   * `PROMOTION_SUMMARY_MAX`; null without a session or a stored summary. Defaulted so an older
   * answer without it still parses.
   */
  summary: z.string().nullable().default(null),
})
export type PromotionChange = z.infer<typeof promotionChangeSchema>

const promotionPersonSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string(),
})

/** The candidate's `deploy.production` request. */
export const promotionApprovalSchema = z.object({
  id: z.string().uuid(),
  status: approvalStatusSchema,
  /** While pending: who may still decide it (eligible, not excluded, not yet decided). */
  approvers: z.array(promotionPersonSchema),
})
export type PromotionApproval = z.infer<typeof promotionApprovalSchema>

/**
 * App page P3: a rollback asked for and not yet decided — the `deploy.production` request with
 * subject `rollback` — so the Live row can say "→ v1.4.1 (rollback) · Waiting for approval".
 */
export const promotionRollbackSchema = z.object({
  releaseId: z.string().uuid(),
  version: z.string(),
  /** What Live ran when it was asked for. */
  from: z.string().nullable(),
  approval: promotionApprovalSchema,
})
export type PromotionRollback = z.infer<typeof promotionRollbackSchema>

/** A GitHub Actions run's status, folded to three (`waiting`/`requested`/`pending` read `queued`). */
export const CANDIDATE_RUN_STATUSES = ['queued', 'in_progress', 'completed'] as const
export type CandidateRunStatus = (typeof CANDIDATE_RUN_STATUSES)[number]

/** A completed run's conclusions that mean "it did not deploy" (the release moves to `failed`). */
export const CANDIDATE_RUN_FAILED_CONCLUSIONS = [
  'failure',
  'cancelled',
  'timed_out',
  'startup_failure',
] as const

/**
 * The deploy run the candidate's tag push started (`deploy.yml`, `event=push`, `head_branch` the
 * tag), as GitHub reports it. Read only while the candidate is `tagged` or `staging`; a `failed`
 * candidate carries the last reading so the strip can name the job that failed.
 */
export const candidateRunSchema = z.object({
  status: z.enum(CANDIDATE_RUN_STATUSES),
  /** GitHub's conclusion once `completed` (`success`, `failure`, `cancelled`, …), else null. */
  conclusion: z.string().nullable(),
  /** The run on GitHub. */
  url: z.string().url().nullable(),
  /** The job running now (or the first one still queued), by its display name. */
  currentJob: z.string().nullable(),
  /** The first job that failed, by its display name. */
  failedJob: z.string().nullable(),
})
export type CandidateRun = z.infer<typeof candidateRunSchema>

/** Whether `run` completed without deploying (see `CANDIDATE_RUN_FAILED_CONCLUSIONS`). Pure. */
export function candidateRunFailed(run: Pick<CandidateRun, 'status' | 'conclusion'>): boolean {
  return (
    run.status === 'completed' &&
    (CANDIDATE_RUN_FAILED_CONCLUSIONS as readonly string[]).includes(run.conclusion ?? '')
  )
}

/** `GET /api/apps/:id/promotion` — any member who may read the app. */
export const appPromotionSchema = z.object({
  candidate: releaseSchema.nullable(),
  staging: promotionEnvironmentSchema.nullable(),
  production: promotionEnvironmentSchema.nullable(),
  changes: z.array(promotionChangeSchema),
  /** More pull requests than `PROMOTION_MAX_CHANGES` lie between the two. */
  changesTruncated: z.boolean(),
  approval: promotionApprovalSchema.nullable(),
  /**
   * The candidate's tag deploy run on GitHub, or null (not `tagged`/`staging`/`failed`, no run
   * found, GitHub unreachable). Defaulted so an older answer without it still parses.
   */
  candidateRun: candidateRunSchema.nullable().default(null),
  /** A pending rollback request (app page P3), or null. */
  rollback: promotionRollbackSchema.nullable().default(null),
})
export type AppPromotion = z.infer<typeof appPromotionSchema>
