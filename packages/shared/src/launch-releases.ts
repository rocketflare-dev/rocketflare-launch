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
 *
 * App page P3: `production_active → rolled_back` when a rollback to an EARLIER release goes live
 * in production (the release that was live is the one rolled back; the one rolled back to stays
 * `production_active` and records `rolledBackFrom`).
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
  'rolled_back',
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
  /** Retry (app page P2): nothing about the release is failing that Launch could retry. A 409. */
  notRetryable: 'release_not_retryable',
  /** Retry: the caller asked to retry a stage the release is no longer failing at. A 409. */
  stageChanged: 'release_stage_changed',
  /** Retry: the GitHub run is still going (re-running needs it completed). A 409. */
  runInProgress: 'release_run_in_progress',
  /** Retry / Cancel: GitHub refused the re-run, the re-tag or the cancel. A 502. */
  githubFailed: 'release_github_failed',
  /** Cancel: the release has no deploy run in flight to cancel. A 409. */
  notCancellable: 'release_not_cancellable',
  /**
   * Rollback (app page P3): the target is not an earlier release that was live in production
   * (`rollbackRefusal`), or Live runs nothing a rollback could be measured against. A 409.
   */
  notRollbackable: 'release_not_rollbackable',
  /** Rollback: another production deploy is already asked for, or approved and waiting. A 409. */
  productionBusy: 'release_production_busy',
} as const

// ---- failed stages (app page P2, plan decision 7) ----------------------------------------------

/**
 * Where a release is stuck — one Retry per stage, each a plain GitHub operation or a Launch-side
 * re-check (decision 3: the app stays detachable):
 *
 * - `tag` — the tag's push started no deploy run within `RELEASE_STAGING_TIMEOUT_MINUTES` → Retry
 *   pushes the tag again when GitHub no longer has it;
 * - `staging_deploy` — the tag's deploy run failed (its gate, or the staging job) → GitHub's
 *   "re-run failed jobs" on that run (a new attempt of the same run);
 * - `staging_health` — staging runs the release but its health check says `down` → probe now;
 * - `approval_rejected` — the production approval was rejected (or expired) → request it again;
 * - `production_deploy` — the production run failed after its approval → re-run its failed jobs,
 *   under the same approval;
 * - `production_health` — production runs the release but is `down` → probe now.
 */
export const RELEASE_FAILED_STAGES = [
  'tag',
  'staging_deploy',
  'staging_health',
  'approval_rejected',
  'production_deploy',
  'production_health',
] as const
export const releaseFailedStageSchema = z.enum(RELEASE_FAILED_STAGES)
export type ReleaseFailedStage = z.infer<typeof releaseFailedStageSchema>

/** What failed, in the words the app page uses (Staging and Live, decision 4). */
export const RELEASE_STAGE_LABELS: Record<ReleaseFailedStage, string> = {
  tag: 'Tag',
  staging_deploy: 'Staging deploy',
  staging_health: 'Staging health',
  approval_rejected: 'Live approval',
  production_deploy: 'Live deploy',
  production_health: 'Live health',
}

/** The Retry button's label: what pressing it does. */
export const RELEASE_RETRY_LABELS: Record<ReleaseFailedStage, string> = {
  tag: 'Push the tag again',
  staging_deploy: 'Retry staging deploy',
  staging_health: 'Check staging again',
  approval_rejected: 'Request approval again',
  production_deploy: 'Retry live deploy',
  production_health: 'Check Live again',
}

/** What a retry did: re-pushed the tag, re-ran a GitHub run, probed health, re-opened approval. */
export const RELEASE_RETRY_ACTIONS = ['retag', 'rerun', 'health_check', 'approval'] as const
export type ReleaseRetryAction = (typeof RELEASE_RETRY_ACTIONS)[number]

/** One environment as the stage derivation needs it: what it runs and whether that is up. */
export interface ReleaseStageEnvironment {
  lastDeployVersion: string | null
  healthStatus: string
}

export interface ReleaseStageFacts {
  status: ReleaseStatus
  version: string
  error: string | null
  productionTicketId: string | null
  /** When the release last moved — the clock of the `tag` stage. */
  updatedAt: Date
  /** Whether GitHub has shown a deploy run for the tag at all (`app_releases.tag_run`). */
  tagRunSeen: boolean
  staging: ReleaseStageEnvironment | null
  production: ReleaseStageEnvironment | null
}

/** `env` runs `version` and its health check says it is down. */
function downOn(env: ReleaseStageEnvironment | null, version: string): boolean {
  return !!env && env.lastDeployVersion === version && env.healthStatus === 'down'
}

/**
 * The stage a release is stuck at, or null when nothing is failing. Pure — the server stamps it on
 * every release it answers with (`failedStage`); the UI and the CLI only read it.
 *
 * A `failed` release names its environment in its error (`staging: …` / `production: …`, written by
 * the deploy gateway, the run poll and the tag-run follower); one without a prefix is production's
 * when a production run was recorded, else staging's.
 */
export function releaseFailedStage(
  f: ReleaseStageFacts,
  now: Date = new Date()
): ReleaseFailedStage | null {
  switch (f.status) {
    case 'rejected':
      return 'approval_rejected'
    case 'failed':
      if (f.error?.startsWith('production:')) return 'production_deploy'
      if (f.error?.startsWith('staging:')) return 'staging_deploy'
      return f.productionTicketId ? 'production_deploy' : 'staging_deploy'
    case 'tagged': {
      const stalled =
        now.getTime() - f.updatedAt.getTime() > RELEASE_STAGING_TIMEOUT_MINUTES * 60_000
      return stalled && !f.tagRunSeen ? 'tag' : null
    }
    case 'staging_active':
      return downOn(f.staging, f.version) ? 'staging_health' : null
    case 'production_active':
      return downOn(f.production, f.version) ? 'production_health' : null
    default:
      return null
  }
}

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

/**
 * -1 / 0 / 1 for two `X.Y.Z` versions; a missing or unparseable version sorts first. The one
 * ordering of releases (`@launch/shared/launch-promotion` re-exports it).
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

/**
 * The version a run on a release tag deployed (app page P3). The kit's `deploy.yml` labels a
 * `workflow_dispatch` build `<ref name>-<sha7>` even when the ref IS a tag, so a rollback (a
 * dispatch at tag `1.4.1`) uploads `1.4.1-abc1234`. A run whose `ref` is `refs/tags/X.Y.Z` and
 * whose version is exactly `X.Y.Z-<a prefix of the run's sha>` deployed `X.Y.Z`; anything else is
 * returned as it came. Pure.
 */
export function taggedRunVersion(
  version: string,
  run: { ref: string | null; sha: string | null }
): string {
  const tag = run.ref?.startsWith('refs/tags/') ? run.ref.slice('refs/tags/'.length) : null
  if (!tag || !RELEASE_VERSION_RE.test(tag) || !run.sha) return version
  if (!version.startsWith(`${tag}-`)) return version
  const suffix = version.slice(tag.length + 1)
  return /^[0-9a-f]{7,40}$/.test(suffix) && run.sha.startsWith(suffix) ? tag : version
}

/**
 * The statuses a rollback may target (app page P3): a release that went live in production —
 * still marked live (an older release a newer one replaced keeps `production_active`) or rolled
 * back itself since.
 */
export const ROLLBACK_TARGET_STATUSES = [
  'production_active',
  'rolled_back',
] as const satisfies readonly ReleaseStatus[]

/**
 * Why `target` cannot be rolled back to while Live runs `liveVersion`, or null when it can: it
 * must have been live in production before (`ROLLBACK_TARGET_STATUSES`) and be EARLIER than what
 * Live runs now. Pure — the route refuses with it (409 `release_not_rollbackable`), and the UI and
 * the CLI offer "Roll back to here" on exactly the releases it returns null for.
 */
export function rollbackRefusal(
  target: { status: ReleaseStatus; version: string },
  liveVersion: string | null | undefined
): string | null {
  if (!(ROLLBACK_TARGET_STATUSES as readonly string[]).includes(target.status)) {
    return `Release ${target.version} was never live in production`
  }
  if (!liveVersion || !parseReleaseVersion(liveVersion)) {
    return 'Live runs no release version a rollback could go back from'
  }
  if (compareReleaseVersions(target.version, liveVersion) >= 0) {
    return `Live runs ${liveVersion}; only an earlier release can be rolled back to`
  }
  return null
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
  /**
   * App page P2: where the release is stuck (`releaseFailedStage`), null when nothing is failing.
   * The server stamps it on every answer; a row parsed without it defaults to null.
   */
  failedStage: releaseFailedStageSchema.nullable().default(null),
  /**
   * App page P3: the version Live ran when a rollback to THIS release went live ("v1.4.1, rolled
   * back from v1.4.2"); null for a release never rolled back to.
   */
  rolledBackFrom: z.string().nullable().default(null),
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

// ---- retry and cancel (app page P2) ------------------------------------------------------------

/**
 * `POST /api/apps/:id/releases/:rid/retry` — the app's owners and admins. `stage`, when given, is
 * the stage the caller saw: a release that has moved on since answers 409 `release_stage_changed`
 * rather than retrying something else.
 */
export const retryReleaseSchema = z.object({
  stage: releaseFailedStageSchema.optional(),
  /** Why (an `approval_rejected` retry carries it onto the new request). */
  reason: z.string().trim().max(1000).optional(),
})
export type RetryReleaseRequest = z.infer<typeof retryReleaseSchema>

export const retryReleaseResponseSchema = z.object({
  release: releaseSchema,
  /** The stage that was retried. */
  stage: releaseFailedStageSchema,
  action: z.enum(RELEASE_RETRY_ACTIONS),
  /** A re-run: the GitHub run attempt it starts (2 for the first retry). Null otherwise. */
  attempt: z.number().int().positive().nullable(),
  /** The GitHub run re-run, when there is one. */
  runUrl: z.string().url().nullable(),
  /** A re-opened approval's id. */
  approvalId: z.string().uuid().nullable(),
  /** A health check: what the environment answered (`HEALTH_STATUSES`). */
  health: z.string().nullable(),
})
export type RetryReleaseResponse = z.infer<typeof retryReleaseResponseSchema>

/**
 * `POST /api/apps/:id/releases/:rid/cancel` — the app's owners and admins: cancels the release's
 * deploy run in flight on GitHub (`POST …/actions/runs/{id}/cancel`) and marks the release `failed`
 * (cancelled), so Retry re-runs it later. 409 `release_not_cancellable` with no run in flight.
 */
export const cancelReleaseResponseSchema = z.object({
  release: releaseSchema,
  runUrl: z.string().url().nullable(),
})
export type CancelReleaseResponse = z.infer<typeof cancelReleaseResponseSchema>

// ---- rollback and main-ahead (app page P3) -----------------------------------------------------

/**
 * `POST /api/apps/:id/releases/:rid/rollback` — the app's owners and admins. `:rid` is the release
 * to go back TO. Opens the same `deploy.production` approval Ship does (subject `rollback`, bound
 * to the release's tag); once granted, Launch dispatches the repo's own `deploy.yml` with
 * `environment=production` at that tag.
 */
export const rollbackReleaseSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
})
export type RollbackReleaseRequest = z.infer<typeof rollbackReleaseSchema>

export const rollbackReleaseResponseSchema = z.object({
  /** The release rolled back to. */
  release: releaseSchema,
  /** The version Live runs now, which the rollback replaces. */
  from: z.string(),
  approvalId: z.string().uuid(),
  /** `approved` when a policy approved it on the spot (the deploy is dispatched), else `pending`. */
  approvalStatus: z.string(),
})
export type RollbackReleaseResponse = z.infer<typeof rollbackReleaseResponseSchema>

/** At most this many commits are listed by the main-ahead compare (the count is GitHub's). */
export const RELEASE_COMPARE_MAX_COMMITS = 20

/** Launch asks GitHub at most once per app per this window, however many people watch the page. */
export const RELEASE_COMPARE_TTL_SECONDS = 60

export const releaseCompareCommitSchema = z.object({
  sha: z.string(),
  /** The commit message's first line. */
  message: z.string(),
  author: z.string().nullable(),
  /** The PR it merged, when its message says (`… (#12)` or `Merge pull request #12 …`). */
  prNumber: z.number().int().positive().nullable(),
})
export type ReleaseCompareCommit = z.infer<typeof releaseCompareCommitSchema>

/**
 * `GET /api/apps/:id/releases/compare` — the default branch against the latest release tag: how
 * many commits a "Release to staging" would carry. `aheadBy` is null when that is unknown — no
 * release tag yet, or GitHub failed (`error` says so); the UI then shows nothing.
 */
export const releaseCompareSchema = z.object({
  branch: z.string(),
  /** The tag compared against: the newest release's, else the highest `X.Y.Z` tag on GitHub. */
  base: z.string().nullable(),
  headSha: z.string().nullable(),
  aheadBy: z.number().int().nonnegative().nullable(),
  /** Newest first, at most `RELEASE_COMPARE_MAX_COMMITS`. */
  commits: z.array(releaseCompareCommitSchema),
  compareUrl: z.string().url().nullable(),
  /** When GitHub was asked (the answer is kept for `RELEASE_COMPARE_TTL_SECONDS`). */
  checkedAt: z.coerce.date(),
  error: z.string().nullable(),
})
export type ReleaseCompare = z.infer<typeof releaseCompareSchema>

/** The PR a commit message names (a squash `Title (#12)`, or `Merge pull request #12 …`). Pure. */
export function prNumberOfMessage(message: string): number | null {
  const first = message.split('\n', 1)[0] ?? ''
  const match = /^Merge pull request #(\d+)\b/.exec(first) ?? /\(#(\d+)\)\s*$/.exec(first)
  return match ? Number(match[1]) : null
}
