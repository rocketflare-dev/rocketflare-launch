/**
 * A release's audit chain (Launch P4, plan §1.11) — slice 4d builds it: `GET …/:rid/chain`
 * returns, in time order, the PRs' `session.*` and `pr.merged`, the `release.*` rows, both
 * tickets' `deploy.*` (by `deploy_tickets.release_id`) and the approval's `approval.*` (by
 * `audit_events.approval_id`, indexed `audit_events_tenant_approval_idx`). Linked by ids on the
 * rows, never inferred from timestamps.
 */
import type { AuditEvent } from '@launch/shared/launch-audit'
import type { Database } from '../../../../db/client'
import { NotWiredError } from '../../approvals/types'

export async function releaseChain(
  _db: Database,
  _input: { tenantId: string; appId: string; releaseId: string }
): Promise<AuditEvent[]> {
  throw new NotWiredError('releases.releaseChain', '4d')
}
