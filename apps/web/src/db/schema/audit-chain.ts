/**
 * `audit_chain` (Launch P4, spec/08 "Integrity options", plan §1.12) — the hash chain over
 * `audit_events`, one row per sealed event, per tenant in `seq` order:
 * `hash = sha256(prev_hash ‖ canonical JSON of the event)`.
 *
 * - **Appended by a sealer, not a trigger.** The `audit.seal` cron (`*` + `/5`) takes a
 *   per-tenant `pg_advisory_xact_lock` and seals up to 1 000 events a batch. A trigger would
 *   serialise every audit insert in the tenant behind one lock; the cost of the sealer is that
 *   tampering is evident within five minutes rather than at once.
 * - **Primary key `(tenant_id, seq)`**: two concurrent seals cannot fork the chain — the loser's
 *   insert conflicts. `audit_event_id` is UNIQUE (an event is sealed once) and cascades from the
 *   event, which itself only goes with its tenant.
 * - **Append-only by the database**, like `audit_events`: the same trigger function is attached
 *   (appended to the P4 migration) and the app role loses UPDATE, DELETE and TRUNCATE
 *   (`APPEND_ONLY_TABLES`). No surrogate `id`: `(tenant_id, seq)` is the identity.
 */
import { relations } from 'drizzle-orm'
import { bigint, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { auditEvents } from './audit-events'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

export const auditChain = pgTable(
  'audit_chain',
  {
    tenantId: tenantRef(tenants),
    /** 1, 2, 3 … per tenant, in sealing order (`at`, then `id`). */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    auditEventId: uuid('audit_event_id')
      .notNull()
      .references(() => auditEvents.id, { onDelete: 'cascade' }),
    /** The previous row's `hash`; the empty string for `seq = 1`. */
    prevHash: text('prev_hash').notNull(),
    /** Lower-case hex SHA-256. */
    hash: text('hash').notNull(),
    sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    primaryKey({ name: 'audit_chain_pkey', columns: [table.tenantId, table.seq] }),
    unique('audit_chain_audit_event_id_key').on(table.auditEventId),
    tenantIsolation('audit_chain'),
  ]
)

export const auditChainRelations = relations(auditChain, ({ one }) => ({
  tenant: one(tenants, { fields: [auditChain.tenantId], references: [tenants.id] }),
  event: one(auditEvents, { fields: [auditChain.auditEventId], references: [auditEvents.id] }),
}))

export type AuditChainRow = typeof auditChain.$inferSelect
export type NewAuditChainRow = typeof auditChain.$inferInsert
