/**
 * Deploy tickets (Launch P2) — the rows behind `/ci/deploy` and `/ci/scaffold`
 * (`db/schema/deploy-tickets.ts`). Slice 2d owns this file and adds the compare-and-set
 * transitions of DEPLOYER.md's status table here (`UPDATE … WHERE status = $from RETURNING`).
 *
 * **Lookups by ticket id are pre-tenant by design** (allow-listed in
 * `tests/config/unscoped-allowlist.test.ts`): a CI call names a ticket id and carries a GitHub
 * OIDC token, not a session. The caller proves itself first (`resolveCaller`), the ticket is then
 * read by id, and it must belong to the caller's app and environment — its `tenant_id` is the
 * row's, never the request's.
 */
import { eq } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type DeployTicketRow, deployTickets } from '../../../../db/schema'

/** A ticket by id, whatever its tenant, or null. The caller checks app, environment and run. */
export async function getTicketById(
  db: Database,
  ticketId: string
): Promise<DeployTicketRow | null> {
  const [row] = await db.select().from(deployTickets).where(eq(deployTickets.id, ticketId)).limit(1)
  return row ?? null
}
