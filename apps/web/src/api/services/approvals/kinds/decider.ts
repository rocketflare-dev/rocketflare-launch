/**
 * Who decided a request, as an audit actor — for the effects a kind writes in its OWN name (the
 * grant an `app.access` approval adds, the extension a `session.budget` approval makes, the app a
 * rejected `app.create` archives). A handler is handed the request, not the person, so the person
 * is read back from `approval_decisions`: `applyInTx` runs in the decide transaction AFTER the
 * decision row is written, so the latest `approve` is the one that tipped it.
 *
 * No decision of that kind (an auto-approve, an expiry, a cancel) → `SYSTEM_ACTOR`. Slice 4c's.
 */
import type { ApprovalDecisionValue } from '@launch/shared/launch-approvals'
import { and, desc, eq } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type ApprovalRequestRow, approvalDecisions } from '../../../../db/schema'
import { type AuditActor, SYSTEM_ACTOR } from '../../launch/audit'

export async function deciderActor(
  db: Database,
  request: Pick<ApprovalRequestRow, 'id' | 'tenantId'>,
  decision: ApprovalDecisionValue
): Promise<AuditActor> {
  const [row] = await db
    .select({ userId: approvalDecisions.userId, email: approvalDecisions.userEmail })
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.tenantId, request.tenantId),
        eq(approvalDecisions.requestId, request.id),
        eq(approvalDecisions.decision, decision)
      )
    )
    .orderBy(desc(approvalDecisions.at))
    .limit(1)
  if (!row) return { ...SYSTEM_ACTOR }
  return { ...SYSTEM_ACTOR, actorType: 'user', actorUserId: row.userId, actorEmail: row.email }
}
