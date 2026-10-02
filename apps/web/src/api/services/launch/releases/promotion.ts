/**
 * The app page's pipeline strip (rocketflare-launch#5 part 8): one read of what promoting would
 * ship, `appPromotionSchema`. A read only — Promote itself is `promote.ts`, unchanged.
 *
 * - The CANDIDATE is the newest release: what Promote would ship, or what is on its way there.
 * - Each environment is its row's `last_deploy_version` / `last_deploy_at` / health / URL, matched
 *   to the release carrying that version.
 * - The CHANGES are the PRs of every release after production's version, up to and including the
 *   candidate (newest release first) — the code is cumulative, so an intermediate release that never
 *   reached production still ships with this one. When the candidate is already in production,
 *   they are what it brought over the production release before it.
 * - Each change carries its session's title and, since issue #5, the session's stored ship summary
 *   body (`sessions.ship_summary->>'body'`, plan §1.15) clipped to `PROMOTION_SUMMARY_MAX` — null
 *   for a PR no Launch session wrote, or a session shipped before summaries were kept.
 * - The APPROVAL is the candidate's `deploy.production` request with the people it still waits on
 *   (eligible under its snapshotted policy, not excluded, not yet decided) — the same list the
 *   approval's own page names, but readable by every member here, because "who must approve" is
 *   the strip's whole point and names of colleagues are no secret inside the organisation.
 * - The CANDIDATE RUN (`tag-run.ts`): while the candidate is `tagged` or `staging`, the GitHub run
 *   its tag push started — throttled per release, settled on read (a run that failed before the
 *   staging job moves the release to `failed`, audited `release.failed`), null on any GitHub
 *   error. A `failed` candidate carries the reading that failed it; no other status reads GitHub.
 *
 * - App page P3: production carries `rolledBackFrom` when a rollback put its version there, and
 *   `rollback` is the app's pending rollback request (subject `rollback`) with who it waits on.
 *
 * Every query is tenant-first: the app comes from `getAppRow(tenantId, id)`, and each later lookup
 * repeats `tenant_id` rather than trusting ids read from another row.
 */
import type { AppPromotion, PromotionEnvironment } from '@launch/shared/launch-promotion'
import {
  compareReleaseVersions as compareVersions,
  PROMOTION_MAX_CHANGES,
  PROMOTION_SUMMARY_MAX,
} from '@launch/shared/launch-promotion'
import type { Release } from '@launch/shared/launch-releases'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import {
  type AppEnvironmentRow,
  type AppReleaseRow,
  type AppRow,
  appEnvironments,
  approvalDecisions,
  approvalRequests,
  sessions,
  users,
} from '../../../../db/schema'
import { eligibleApprovers } from '../../approvals/policy'
import { environmentsOf, toReleaseView } from './failed-stage'
import { listReleases } from './release'
import { followTagRun, type TagRunOptions } from './tag-run'

/** At most this many approvers are named (the approval page's own cap). */
const MAX_APPROVERS = 25

function environmentOf(
  row: AppEnvironmentRow | undefined,
  releases: readonly AppReleaseRow[]
): PromotionEnvironment | null {
  if (!row) return null
  const version = row.lastDeployVersion
  const release = version ? releases.find(r => r.version === version) : undefined
  // A check from before the last deploy says nothing about the version running now.
  const stale =
    row.lastDeployAt !== null &&
    (row.healthCheckedAt === null || row.healthCheckedAt < row.lastDeployAt)
  return {
    version,
    deployedAt: row.lastDeployAt,
    healthStatus: stale ? 'unknown' : row.healthStatus,
    url: row.url,
    releaseId: release?.id ?? null,
    // App page P3: Live runs this release because a rollback put it there.
    rolledBackFrom: row.name === 'production' ? (release?.rolledBackFrom ?? null) : null,
  }
}

/** The app's pending rollback request (app page P3), with who it waits on, or null. */
async function pendingRollbackOf(
  db: Database,
  tenantId: string,
  appId: string,
  releases: readonly AppReleaseRow[]
): Promise<AppPromotion['rollback']> {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.appId, appId),
        eq(approvalRequests.kind, 'deploy.production'),
        eq(approvalRequests.subjectType, 'rollback'),
        eq(approvalRequests.status, 'pending')
      )
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(1)
  const release = row ? releases.find(r => r.id === row.subjectId) : undefined
  if (!row || !release) return null
  const approval = await approvalOf(db, tenantId, appId, row.id)
  if (!approval) return null
  const context = row.context.kind === 'deploy.production' ? row.context : null
  return {
    releaseId: release.id,
    version: release.version,
    from: context?.rollbackFrom ?? null,
    approval,
  }
}

/** The releases whose PRs this promotion ships, newest first. */
function releasesBetween(
  releases: readonly AppReleaseRow[],
  candidate: AppReleaseRow,
  productionVersion: string | null
): AppReleaseRow[] {
  // The floor: production's version when it is behind the candidate, else the newest release in
  // production before the candidate (the candidate is live; show what it brought).
  let floor =
    productionVersion && compareVersions(productionVersion, candidate.version) < 0
      ? productionVersion
      : null
  if (!floor) {
    for (const r of releases) {
      if (r.status !== 'production_active' || r.id === candidate.id) continue
      if (compareVersions(r.version, candidate.version) >= 0) continue
      if (!floor || compareVersions(r.version, floor) > 0) floor = r.version
    }
  }
  return releases
    .filter(
      r =>
        compareVersions(r.version, candidate.version) <= 0 &&
        (!floor || compareVersions(r.version, floor) > 0)
    )
    .sort((a, b) => compareVersions(b.version, a.version))
}

/** Each session's title and stored ship summary body (issue #5, plan §1.15), tenant-first. */
async function sessionsOf(
  db: Database,
  tenantId: string,
  appId: string,
  ids: readonly string[]
): Promise<Map<string, { title: string | null; summary: string | null }>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      summary: sql<string | null>`${sessions.shipSummary}->>'body'`,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.tenantId, tenantId),
        eq(sessions.appId, appId),
        inArray(sessions.id, [...ids])
      )
    )
  return new Map(rows.map(r => [r.id, { title: r.title, summary: clipSummary(r.summary) }]))
}

/** A stored summary as a change row carries it: trimmed, empty → null, at most the cap. */
function clipSummary(body: string | null): string | null {
  const text = body?.trim()
  if (!text) return null
  return text.length > PROMOTION_SUMMARY_MAX
    ? `${text.slice(0, PROMOTION_SUMMARY_MAX - 1).trimEnd()}…`
    : text
}

async function approvalOf(
  db: Database,
  tenantId: string,
  appId: string,
  approvalId: string
): Promise<AppPromotion['approval']> {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.appId, appId),
        eq(approvalRequests.id, approvalId)
      )
    )
    .limit(1)
  if (!row) return null
  if (row.status !== 'pending') return { id: row.id, status: row.status, approvers: [] }
  const decided = await db
    .select({ userId: approvalDecisions.userId })
    .from(approvalDecisions)
    .where(and(eq(approvalDecisions.tenantId, tenantId), eq(approvalDecisions.requestId, row.id)))
  const done = new Set(decided.map(d => d.userId))
  const ids = (await eligibleApprovers(db, row)).filter(id => !done.has(id))
  const approvers =
    ids.length === 0
      ? []
      : await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, ids))
          .orderBy(asc(sql`coalesce(${users.name}, ${users.email})`))
          .limit(MAX_APPROVERS)
  return { id: row.id, status: row.status, approvers }
}

export async function appPromotion(
  db: Database,
  cfg: AppConfig,
  input: {
    tenantId: string
    app: Pick<AppRow, 'id' | 'repoOwner' | 'repoName' | 'defaultBranch'>
  },
  options: TagRunOptions = {}
): Promise<AppPromotion> {
  const { tenantId, app } = input
  const appId = app.id
  const [releases, envs] = await Promise.all([
    listReleases({ db }, { tenantId, appId }),
    db
      .select()
      .from(appEnvironments)
      .where(and(eq(appEnvironments.tenantId, tenantId), eq(appEnvironments.appId, appId))),
  ])
  const staging = environmentOf(
    envs.find(e => e.name === 'staging'),
    releases
  )
  const production = environmentOf(
    envs.find(e => e.name === 'production'),
    releases
  )
  if (!releases[0]) {
    return {
      candidate: null,
      staging,
      production,
      changes: [],
      changesTruncated: false,
      approval: null,
      candidateRun: null,
      rollback: await pendingRollbackOf(db, tenantId, appId, releases),
    }
  }
  // The tag's deploy run (`tag-run.ts`); a run that failed may move the candidate to `failed`.
  const followed = await followTagRun(db, cfg, app, releases[0] as AppReleaseRow, options)
  const candidateRow = followed.release

  const shipped = releasesBetween(releases, candidateRow, production?.version ?? null)
  const prs = shipped.flatMap(r => r.prs.map(pr => ({ version: r.version, pr })))
  const kept = prs.slice(0, PROMOTION_MAX_CHANGES)
  const bySession = await sessionsOf(
    db,
    tenantId,
    appId,
    kept.map(c => c.pr.sessionId).filter((id): id is string => Boolean(id))
  )
  const candidate: Release = toReleaseView(candidateRow, environmentsOf(envs))
  return {
    candidate,
    staging,
    production,
    changes: kept.map(({ version, pr }) => ({
      version,
      number: pr.number,
      title: pr.title,
      url: pr.url ?? null,
      sessionId: pr.sessionId ?? null,
      sessionTitle: pr.sessionId ? (bySession.get(pr.sessionId)?.title ?? null) : null,
      summary: pr.sessionId ? (bySession.get(pr.sessionId)?.summary ?? null) : null,
    })),
    changesTruncated: prs.length > kept.length,
    approval: candidate.approvalId
      ? await approvalOf(db, tenantId, appId, candidate.approvalId)
      : null,
    candidateRun: followed.run,
    rollback: await pendingRollbackOf(db, tenantId, appId, releases),
  }
}
