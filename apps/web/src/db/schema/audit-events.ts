/**
 * `audit_events` — Launch's system of record for who did what (spec/08). Distinct from the kit's
 * `activity_events` on purpose: that one is a fire-and-forget feed; this one is awaited, and it is
 * **append-only by the database**.
 *
 * - A `BEFORE UPDATE OR DELETE` row trigger (appended to the P1 migration) raises unless
 *   `pg_trigger_depth() > 1`, so a tenant delete still cascades through the FK but no statement
 *   can edit or remove a row directly. The Worker connects as the table OWNER, so the trigger is
 *   the real enforcement; `scripts/db-roles.ts` also revokes UPDATE, DELETE and TRUNCATE from the
 *   app role (`APPEND_ONLY_TABLES`). There is no TRUNCATE trigger: the test harness truncates.
 * - `actor_user_id` and `app_id` are plain uuids with **no FK**: deleting a user or an app must
 *   never rewrite the log. `actor_email` is copied at write time for the same reason.
 * - `summary` is `{ before?, after? }` and **never holds a secret value** — only "set", "rotated"
 *   or "removed".
 */
import { AUDIT_ACTOR_TYPES, type AuditSummary } from '@launch/shared/launch-audit'
import { relations, sql } from 'drizzle-orm'
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

/** Mirrors `AUDIT_ACTOR_TYPES` in `@launch/shared/launch-audit`; append-only. */
export const auditActorTypeEnum = pgEnum('audit_actor_type', AUDIT_ACTOR_TYPES)

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorType: auditActorTypeEnum('actor_type').notNull(),
    /** No FK — see the header. */
    actorUserId: uuid('actor_user_id'),
    actorEmail: text('actor_email'),
    /** Dotted: `app.imported`, `oidc.signin`, `credential.rotated`. */
    action: text('action').notNull(),
    /** `App`, `AppEnvironment`, `OidcClient`, `Credential`, … */
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** The app the event concerns, when there is one. No FK — see the header. */
    appId: uuid('app_id'),
    summary: jsonb('summary').$type<AuditSummary>().notNull().default({}),
    requestId: text('request_id'),
    /** The P4 approval behind the action, when there is one. */
    approvalId: uuid('approval_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  table => [
    index('audit_events_tenant_at_idx').on(table.tenantId, table.at.desc()),
    // "Everything that happened to this target".
    index('audit_events_tenant_target_idx').on(table.tenantId, table.targetType, table.targetId),
    // The app detail page's history.
    index('audit_events_tenant_app_at_idx').on(table.tenantId, table.appId, table.at.desc()),
    // P4: an approval's whole trail (the release chain, `GET …/releases/:rid/chain`).
    index('audit_events_tenant_approval_idx')
      .on(table.tenantId, table.approvalId)
      .where(sql`${table.approvalId} IS NOT NULL`),
    tenantIsolation('audit_events'),
  ]
)

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  tenant: one(tenants, { fields: [auditEvents.tenantId], references: [tenants.id] }),
}))

export type AuditEventRow = typeof auditEvents.$inferSelect
export type NewAuditEventRow = typeof auditEvents.$inferInsert
