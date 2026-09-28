/**
 * A release's audit chain (Launch P4, plan §1.11): `GET …/:rid/chain` returns, in time order, every
 * audit row on the way from PR to production —
 *
 * - the PRs' sessions (`session.*`, by the `sessionId` on each of `app_releases.prs`) and their
 *   merges (`pr.merged`, by the PR number, `pr-audit.ts`);
 * - the release's own rows (`release.*`, target the release);
 * - both runs' `deploy.*` — every ticket whose `release_id` is this release, plus the two the
 *   release names (`staging_ticket_id`, `production_ticket_id`);
 * - every `deploy.production` approval of it (`approval.*`, by `audit_events.approval_id`, indexed
 *   `audit_events_tenant_approval_idx`) — the Promote requests and a job-originated ticket's.
 *
 * All linked by ids on the rows, never inferred from timestamps. Ordered by `(at, id)`.
 */
import type { AuditEvent } from '@launch/shared/launch-audit'
import { and, asc, eq, inArray, like, or, type SQL } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { approvalRequests, auditEvents, deployTickets } from '../../../../db/schema'
import { toAuditEvent } from '../audit'
import { PR_MERGED_ACTION, PR_TARGET_TYPE } from './pr-audit'
import { getRelease } from './release'

/** More than a release's chain ever holds; a guard, not a page size. */
const CHAIN_MAX_EVENTS = 1000

export async function releaseChain(
  db: Database,
  input: { tenantId: string; appId: string; releaseId: string }
): Promise<AuditEvent[]> {
  const { tenantId, appId } = input
  const release = await getRelease({ db }, input)

  const tickets = await db
    .select({ id: deployTickets.id, approvalId: deployTickets.approvalId })
    .from(deployTickets)
    .where(and(eq(deployTickets.tenantId, tenantId), eq(deployTickets.releaseId, release.id)))
  const ticketIds = new Set(tickets.map(t => t.id))
  if (release.stagingTicketId) ticketIds.add(release.stagingTicketId)
  if (release.productionTicketId) ticketIds.add(release.productionTicketId)

  const approvals = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.subjectType, 'release'),
        eq(approvalRequests.subjectId, release.id)
      )
    )
  const approvalIds = new Set(approvals.map(a => a.id))
  if (release.approvalId) approvalIds.add(release.approvalId)
  for (const t of tickets) if (t.approvalId) approvalIds.add(t.approvalId)

  const sessionIds = release.prs.map(p => p.sessionId).filter((id): id is string => Boolean(id))
  const prNumbers = release.prs.map(p => String(p.number))

  const links: SQL[] = [
    and(eq(auditEvents.targetType, 'release'), eq(auditEvents.targetId, release.id)) as SQL,
  ]
  if (sessionIds.length > 0) {
    links.push(
      and(
        eq(auditEvents.targetType, 'session'),
        inArray(auditEvents.targetId, sessionIds),
        like(auditEvents.action, 'session.%')
      ) as SQL
    )
  }
  if (prNumbers.length > 0) {
    links.push(
      and(
        eq(auditEvents.appId, appId),
        eq(auditEvents.targetType, PR_TARGET_TYPE),
        eq(auditEvents.action, PR_MERGED_ACTION),
        inArray(auditEvents.targetId, prNumbers)
      ) as SQL
    )
  }
  if (ticketIds.size > 0) {
    links.push(
      and(
        eq(auditEvents.targetType, 'deploy_ticket'),
        inArray(auditEvents.targetId, [...ticketIds])
      ) as SQL
    )
  }
  if (approvalIds.size > 0) links.push(inArray(auditEvents.approvalId, [...approvalIds]))

  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, tenantId), or(...links)))
    .orderBy(asc(auditEvents.at), asc(auditEvents.id))
    .limit(CHAIN_MAX_EVENTS)
  // Rows written in ONE transaction share `at` (Postgres' `now()` is the transaction's start) —
  // an approval's decided/approved pair and the kind's own row. Break those ties by the order the
  // steps happen in, so the chain reads the same way every time.
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        a.row.at.getTime() - b.row.at.getTime() ||
        tieRank(a.row.action) - tieRank(b.row.action) ||
        a.index - b.index
    )
    .map(({ row }) => toAuditEvent(row))
}

/** The order of the actions a single transaction can write together (lower first). */
const TIE_ORDER = [
  'approval.requested',
  'approval.decided',
  'approval.approved',
  'approval.rejected',
  'approval.expired',
  'approval.cancelled',
  'deploy.production.approved',
  'deploy.production.rejected',
  'release.rejected',
]

function tieRank(action: string): number {
  const at = TIE_ORDER.indexOf(action)
  return at === -1 ? TIE_ORDER.length : at
}
