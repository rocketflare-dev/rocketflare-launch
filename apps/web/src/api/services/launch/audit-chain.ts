/**
 * The audit hash chain (Launch P4, spec/08, plan §1.12) — slice 4e builds it.
 *
 * - `canonicalAuditJson(event)`: the one canonical serialisation (sorted keys, ISO timestamps),
 *   so a seal and a verify hash the same bytes on every driver.
 * - `sealTenant`: under `pg_advisory_xact_lock(tenant)`, append `audit_chain` rows for the next
 *   ≤ 1 000 unsealed events in `(at, id)` order — `hash = sha256(prev_hash ‖ canonical JSON)`.
 * - `verifyChain`: recompute every sealed row; `auditVerifySchema`.
 * - `auditSeal`: the `audit.seal` task on the five-minute cron (registered in `api/scheduled.ts`).
 *
 * Cross-tenant by design, like every cron (allow-listed in `unscoped-allowlist.test.ts`):
 * `hasUnsealedEvents` looks across every tenant before the per-tenant loop, and every write after
 * it names the tenant it seals. Keep it (or the allow-list entry goes stale and its test fails).
 */
import type { AuditEvent, AuditVerify } from '@launch/shared/launch-audit'
import { eq, isNull } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { auditChain, auditEvents } from '../../../db/schema'
import type { ScheduledTask } from '../../scheduled'
import { NotWiredError } from '../approvals/types'

/** Events sealed per tenant per batch. */
export const AUDIT_SEAL_BATCH = 1000

/** Is there any audit event, in any tenant, not yet in the chain? The seal's cheap first look. */
export async function hasUnsealedEvents(db: Database): Promise<boolean> {
  const [row] = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .leftJoin(auditChain, eq(auditChain.auditEventId, auditEvents.id))
    .where(isNull(auditChain.auditEventId))
    .limit(1)
  return Boolean(row)
}

export function canonicalAuditJson(_event: AuditEvent): string {
  throw new NotWiredError('audit.canonicalAuditJson', '4e')
}

export async function sealTenant(
  _db: Database,
  _tenantId: string,
  _opts: { batch?: number } = {}
): Promise<{ sealed: number; through: number | null }> {
  throw new NotWiredError('audit.sealTenant', '4e')
}

export async function verifyChain(_db: Database, _tenantId: string): Promise<AuditVerify> {
  throw new NotWiredError('audit.verifyChain', '4e')
}

/** Registered on `*` + `/5` in `api/scheduled.ts`. A no-op until slice 4e. */
export const auditSeal: ScheduledTask = {
  name: 'audit.seal',
  async run({ logger }) {
    logger.debug('audit.seal: not wired yet (P4 slice 4e)')
  },
}
