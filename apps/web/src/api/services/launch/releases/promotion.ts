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
 * - The APPROVAL is the candidate's `deploy.production` request with the people it still waits on
 *   (eligible under its snapshotted policy, not excluded, not yet decided) — the same list the
 *   approval's own page names, but readable by every member here, because "who must approve" is
 *   the strip's whole point and names of colleagues are no secret inside the organisation.
 *
 * Every query is tenant-first: the app comes from `getAppRow(tenantId, id)`, and each later lookup
 * repeats `tenant_id` rather than trusting ids read from another row.
 */
import type { AppPromotion, PromotionEnvironment } from '@launch/shared/launch-promotion'
import {
  compareReleaseVersions as compareVersions,
  PROMOTION_MAX_CHANGES,
} from '@launch/shared/launch-promotion'
import { type Release, releaseSchema } from '@launch/shared/launch-releases'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import {
  type AppEnvironmentRow,
  type AppReleaseRow,
  appEnvironments,
  approvalDecisions,
  approvalRequests,
  sessions,
  users,
} from '../../../../db/schema'
import { eligibleApprovers } from '../../approvals/policy'
import { listReleases } from './release'

/** At most this many approvers are named (the approval page's own cap). */
const MAX_APPROVERS = 25

function environmentOf(
  row: AppEnvironmentRow | undefined,
  releases: readonly AppReleaseRow[]
): PromotionEnvironment | null {
  if (!row) return null
  const version = row.lastDeployVersion
  return {
    version,
    deployedAt: row.lastDeployAt,
    healthStatus: row.healthStatus,
    url: row.url,
    releaseId: (version && releases.find(r => r.version === version)?.id) || null,
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

async function sessionTitles(
  db: Database,
  tenantId: string,
  ids: readonly string[]
): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ id: sessions.id, title: sessions.title })
    .from(sessions)
    .where(and(eq(sessions.tenantId, tenantId), inArray(sessions.id, [...ids])))
  return new Map(rows.map(r => [r.id, r.title]))
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
  input: { tenantId: string; appId: string }
): Promise<AppPromotion> {
  const { tenantId, appId } = input
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
  const candidateRow = releases[0] ?? null
  if (!candidateRow) {
    return {
      candidate: null,
      staging,
      production,
      changes: [],
      changesTruncated: false,
      approval: null,
    }
  }

  const shipped = releasesBetween(releases, candidateRow, production?.version ?? null)
  const prs = shipped.flatMap(r => r.prs.map(pr => ({ version: r.version, pr })))
  const kept = prs.slice(0, PROMOTION_MAX_CHANGES)
  const titles = await sessionTitles(
    db,
    tenantId,
    kept.map(c => c.pr.sessionId).filter((id): id is string => Boolean(id))
  )
  const candidate: Release = releaseSchema.parse(candidateRow)
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
      sessionTitle: pr.sessionId ? (titles.get(pr.sessionId) ?? null) : null,
    })),
    changesTruncated: prs.length > kept.length,
    approval: candidate.approvalId
      ? await approvalOf(db, tenantId, appId, candidate.approvalId)
      : null,
  }
}
