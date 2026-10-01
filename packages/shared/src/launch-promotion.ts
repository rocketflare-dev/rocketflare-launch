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
 * - `approval` — the candidate's `deploy.production` request, with the people it still waits on.
 *
 * Promoting is unchanged: `POST /api/apps/:id/releases/:rid/promote`.
 */
import { z } from 'zod'
import { approvalStatusSchema } from './launch-approvals'
import { healthStatusSchema } from './launch-apps'
import { parseReleaseVersion, releaseSchema } from './launch-releases'

/**
 * -1 / 0 / 1 for two `X.Y.Z` versions — the one ordering the server's "what ships" and the strip's
 * "production already runs it" share. A missing or unparseable version sorts first.
 */
export function compareReleaseVersions(a: string | null, b: string | null): number {
  const pa = a ? parseReleaseVersion(a) : null
  const pb = b ? parseReleaseVersion(b) : null
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

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

/** `GET /api/apps/:id/promotion` — any member who may read the app. */
export const appPromotionSchema = z.object({
  candidate: releaseSchema.nullable(),
  staging: promotionEnvironmentSchema.nullable(),
  production: promotionEnvironmentSchema.nullable(),
  changes: z.array(promotionChangeSchema),
  /** More pull requests than `PROMOTION_MAX_CHANGES` lie between the two. */
  changesTruncated: z.boolean(),
  approval: promotionApprovalSchema.nullable(),
})
export type AppPromotion = z.infer<typeof appPromotionSchema>
