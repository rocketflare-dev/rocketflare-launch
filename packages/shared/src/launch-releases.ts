/**
 * Launch P4 contracts: releases (spec/08 "Shipping", `docs/plans/p4-approvals.md` §1.8). A release
 * is Launch doing the kit's release dance itself: bump the root `package.json` version on the
 * default branch, tag `X.Y.Z` (the tag starts `deploy.yml` staging), and later publish a GitHub
 * Release on that tag (which starts production) — but only once a `deploy.production` approval has
 * been granted.
 *
 * - `RELEASE_STATUSES` mirrors the `release_status` pg enum (append-only);
 * - `releasePrSchema` is the jsonb shape of `app_releases.prs` (dates as ISO strings, so the row
 *   round-trips through JSON unchanged);
 * - the bodies and responses of `/api/apps/:id/releases`, `…/:rid/promote` and `…/:rid/chain`;
 * - `bumpVersion()` / `parseReleaseVersion()` — the one implementation of the bump the Release
 *   button performs, pure so it is unit-tested here rather than through GitHub.
 *
 * Slice 4a owns this file; 4b–4f import from it and never edit it.
 */
import { z } from 'zod'
import { auditEventSchema } from './launch-audit'

// ---- enums -------------------------------------------------------------------------------------

/**
 * Mirrors the `release_status` pg enum — append-only. The lifecycle (plan §1.8):
 *
 *   tagged → staging → staging_active → awaiting_approval → promoting → production_active
 *                                          ↘ rejected                 (and `failed` from anywhere)
 */
export const RELEASE_STATUSES = [
  'tagged',
  'staging',
  'staging_active',
  'awaiting_approval',
  'promoting',
  'production_active',
  'rejected',
  'failed',
] as const
export const releaseStatusSchema = z.enum(RELEASE_STATUSES)
export type ReleaseStatus = z.infer<typeof releaseStatusSchema>

/**
 * The statuses Promote accepts: live on staging, or rejected before (asking again, once staging
 * still runs it). The route refuses anything else with 409 `release_not_promotable`, and the UI
 * offers the button on exactly these.
 */
export const PROMOTABLE_RELEASE_STATUSES = [
  'staging_active',
  'rejected',
] as const satisfies readonly ReleaseStatus[]

export function isPromotableRelease(status: ReleaseStatus): boolean {
  return (PROMOTABLE_RELEASE_STATUSES as readonly string[]).includes(status)
}

/** Which part of `X.Y.Z` the Release button bumps. */
export const RELEASE_BUMPS = ['patch', 'minor', 'major'] as const
export const releaseBumpSchema = z.enum(RELEASE_BUMPS)
export type ReleaseBump = z.infer<typeof releaseBumpSchema>

/** At most this many PRs are recorded on one release (`listPullRequestsForCommit` is capped). */
export const RELEASE_MAX_PRS = 100

/**
 * The `entity.changed` entity a release write nudges — and the root of the `releases` query-key
 * family (the `SESSION_REALTIME_ENTITY` pattern): the releases card and a release's chain refresh
 * with no socket code in a hook.
 */
export const RELEASE_REALTIME_ENTITY = 'release'

/**
 * A release still not live on staging this long after it was cut has stalled: a session's landing
 * gives up on it (`land-release.ts`) and the app page's pipeline strip stops calling it "deploying".
 */
export const RELEASE_STAGING_TIMEOUT_MINUTES = 45

/** Error codes the release routes answer with (the `code` of the error envelope). */
export const RELEASE_ERROR_CODES = {
  /**
   * Issue #5 (plan §1.8): another release of the app is being cut right now — a session's landing
   * or a person — and holds the app's release claim (`apps.release_claim_holder`). A 409.
   */
  inProgress: 'release_in_progress',
} as const

// ---- versions ----------------------------------------------------------------------------------

/**
 * A release version: plain `X.Y.Z`, no `v` prefix and no pre-release — the kit's `deploy.yml`
 * refuses a tag that does not equal the root `package.json` version, and the tag IS the version.
 */
export const RELEASE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export const releaseVersionSchema = z.string().regex(RELEASE_VERSION_RE, 'A version is X.Y.Z')

/** `[major, minor, patch]`, or null for anything that is not a plain `X.Y.Z`. */
export function parseReleaseVersion(version: string): [number, number, number] | null {
  const match = RELEASE_VERSION_RE.exec(version.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** The next version after `current`; throws on a version that is not `X.Y.Z`. */
export function bumpVersion(current: string, bump: ReleaseBump): string {
  const parsed = parseReleaseVersion(current)
  if (!parsed) throw new Error(`Not a release version: ${current}`)
  const [major, minor, patch] = parsed
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** The git ref of a release's tag — what the production run's OIDC `ref` must equal. */
export function releaseTagRef(tag: string): string {
  return `refs/tags/${tag}`
}

// ---- jsonb shapes ------------------------------------------------------------------------------

/** One pull request in a release (`app_releases.prs`). `sessionId` when a Launch session shipped it. */
export const releasePrSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  /** The GitHub login; null when GitHub does not say. Not mapped to a Launch user (plan §1.6). */
  author: z.string().nullable(),
  mergedAt: z.string().datetime().nullable(),
  mergeSha: z.string().nullable(),
  url: z.string().url().nullable().optional(),
  sessionId: z.string().uuid().nullable().optional(),
})
export type ReleasePr = z.infer<typeof releasePrSchema>

// ---- requests ----------------------------------------------------------------------------------

/** `POST /api/apps/:id/releases` — the app's owners and admins. */
export const createReleaseSchema = z.object({ bump: releaseBumpSchema })
export type CreateReleaseRequest = z.infer<typeof createReleaseSchema>

/** `POST /api/apps/:id/releases/:rid/promote` — opens `deploy.production` for the release. */
export const promoteReleaseSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
})
export type PromoteReleaseRequest = z.infer<typeof promoteReleaseSchema>

// ---- responses ---------------------------------------------------------------------------------

export const releaseSchema = z.object({
  id: z.string().uuid(),
  appId: z.string().uuid(),
  version: z.string(),
  tag: z.string(),
  sha: z.string(),
  previousTag: z.string().nullable(),
  prs: z.array(releasePrSchema),
  status: releaseStatusSchema,
  createdByUserId: z.string().uuid().nullable(),
  /** The `deploy.production` approval, once promoted. */
  approvalId: z.string().uuid().nullable(),
  stagingTicketId: z.string().uuid().nullable(),
  productionTicketId: z.string().uuid().nullable(),
  error: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type Release = z.infer<typeof releaseSchema>

/** `GET /api/apps/:id/releases` — newest first. */
export const releaseListResponseSchema = z.object({ items: z.array(releaseSchema) })
export type ReleaseListResponse = z.infer<typeof releaseListResponseSchema>

/** `POST …/promote` → the release (now `awaiting_approval`) and the approval it opened. */
export const promoteReleaseResponseSchema = z.object({
  release: releaseSchema,
  approvalId: z.string().uuid(),
})
export type PromoteReleaseResponse = z.infer<typeof promoteReleaseResponseSchema>

/**
 * `GET /api/apps/:id/releases/:rid/chain` — the release's whole audit chain in time order (plan
 * §1.11): the PRs' `session.*` and `pr.merged`, `release.*`, both tickets' `deploy.*` and the
 * approval's `approval.*`. Linked by ids on the rows, never inferred from timestamps.
 */
export const releaseChainSchema = z.object({
  release: releaseSchema,
  events: z.array(auditEventSchema),
})
export type ReleaseChain = z.infer<typeof releaseChainSchema>
