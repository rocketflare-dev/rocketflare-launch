/**
 * Grants (Launch P5, spec/09, `docs/plans/p5-grants.md` §2): `app_grants` — one app holding one
 * shared resource in one environment; `grant_pushes` / `grant_push_targets` — one `GRANT_PUSH`
 * run and its per-app parts; `app_config_scans` — what an app last declared it needs.
 *
 * Decisions worth stating:
 *
 * - **Status columns are TEXT typed by the shared closed sets** (`@launch/shared/launch-grants`),
 *   and the two partial-index predicates are RENDERED from the exported lists
 *   (`LIVE_GRANT_STATUSES`, `ACTIVE_GRANT_PUSH_STATUSES`) — an index whose SQL and whose TypeScript
 *   disagree about "live" is a bug no test sees (`database.md`, the `agent_runs` rule).
 * - **One live grant per app × resource × environment** (`app_grants_live_idx`): requesting again
 *   while one is `requested | active | revoking` finds it. A revoked or rejected grant stays as
 *   history, and a new request is a new row.
 * - **One running push per resource × environment** (`grant_pushes_active_idx`): the second
 *   rotation's insert conflicts → 409 `push_in_progress` (plan §1.10). `approval_id` is unique
 *   where set, so a retried `applyAfter` finds the push it already started.
 * - **`grant_push_targets` is the resumable part**: unique `(push_id, grant_id)` makes the `plan`
 *   step an idempotent insert, and a `succeeded` target is skipped by a retry. `error` is scrubbed
 *   and `names` holds KEYS, never a value.
 * - `resource_id` on a grant is `ON DELETE NO ACTION` (the plan's `restrict`, checked at the end of
 *   the statement so a tenant's cascade still works): a resource is archived, never deleted, while
 *   a grant points at it.
 * - `app_config_scans` is one row per app (the app id IS the key) — derived data, overwritten by
 *   each scan; ship's scan is an event and never lands here (plan §1.14).
 */
import {
  ACTIVE_GRANT_PUSH_STATUSES,
  type DeclaredConfigItem,
  GRANT_PUSH_REASONS,
  GRANT_PUSH_STATUSES,
  GRANT_PUSH_TARGET_STATUSES,
  GRANT_STATUSES,
  LIVE_GRANT_STATUSES,
} from '@launch/shared/launch-grants'
import { relations, sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { appEnvironmentNameEnum } from './app-environments'
import { approvalRequests } from './approvals'
import { apps } from './apps'
import { tenantIsolation } from './rls'
import { sharedResources, sharedResourceValues } from './shared-resources'
import { tenants } from './tenants'
import { users } from './users'

/** `'requested', 'active', 'revoking'` — `sql.raw` because a partial index predicate is DDL. */
const LIVE_GRANT_LITERALS = LIVE_GRANT_STATUSES.map(s => `'${s}'`).join(', ')
/** `'queued', 'running'`. */
const ACTIVE_PUSH_LITERALS = ACTIVE_GRANT_PUSH_STATUSES.map(s => `'${s}'`).join(', ')

export const appGrants = pgTable(
  'app_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    /** NO ACTION: see the header. */
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => sharedResources.id),
    environment: appEnvironmentNameEnum('environment').notNull(),
    status: text('status', { enum: GRANT_STATUSES }).notNull().default('requested'),
    /** The `grant.request` that decides it (subject `grant`, this id). */
    approvalId: uuid('approval_id').references(() => approvalRequests.id, {
      onDelete: 'set null',
    }),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Set when the sweep sent the 7-day reminder, so it is sent once. */
    expiryRemindedAt: timestamp('expiry_reminded_at', { withTimezone: true }),
    /** The version the app's Worker holds; null until the first push lands. */
    pushedVersionId: uuid('pushed_version_id').references(() => sharedResourceValues.id, {
      onDelete: 'set null',
    }),
    pushedAt: timestamp('pushed_at', { withTimezone: true }),
    /** The last push's failure for this grant, scrubbed. */
    pushError: text('push_error'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  table => [
    // One LIVE grant per app × resource × environment.
    uniqueIndex('app_grants_live_idx')
      .on(table.appId, table.resourceId, table.environment)
      .where(sql`${table.status} IN (${sql.raw(LIVE_GRANT_LITERALS)})`),
    // A resource's holders per environment (pushes, the holders table, the gateway's var drop).
    index('app_grants_tenant_resource_env_status_idx').on(
      table.tenantId,
      table.resourceId,
      table.environment,
      table.status
    ),
    // An app's grants (its config page).
    index('app_grants_tenant_app_idx').on(table.tenantId, table.appId),
    tenantIsolation('app_grants'),
  ]
)

export const grantPushes = pgTable(
  'grant_pushes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => sharedResources.id, { onDelete: 'cascade' }),
    environment: appEnvironmentNameEnum('environment').notNull(),
    reason: text('reason', { enum: GRANT_PUSH_REASONS }).notNull(),
    /** Null: every live grant of the environment; otherwise just this one. */
    grantId: uuid('grant_id').references(() => appGrants.id, { onDelete: 'cascade' }),
    /** The version pushed; null for a `revoke` / `expire` (they remove). */
    versionId: uuid('version_id').references(() => sharedResourceValues.id, {
      onDelete: 'cascade',
    }),
    approvalId: uuid('approval_id').references(() => approvalRequests.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: GRANT_PUSH_STATUSES }).notNull().default('queued'),
    total: integer('total').notNull().default(0),
    succeeded: integer('succeeded').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    /** The Workflow instance: the push id, `<pushId>-rN` after a retry. */
    instanceId: text('instance_id'),
    startedByUserId: uuid('started_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    // One running push per resource × environment: the second is 409 `push_in_progress`.
    uniqueIndex('grant_pushes_active_idx')
      .on(table.resourceId, table.environment)
      .where(sql`${table.status} IN (${sql.raw(ACTIVE_PUSH_LITERALS)})`),
    // A retried `applyAfter` finds the push its approval started.
    uniqueIndex('grant_pushes_approval_idx')
      .on(table.approvalId)
      .where(sql`${table.approvalId} IS NOT NULL`),
    index('grant_pushes_tenant_resource_created_idx').on(
      table.tenantId,
      table.resourceId,
      table.createdAt.desc()
    ),
    tenantIsolation('grant_pushes'),
  ]
)

export const grantPushTargets = pgTable(
  'grant_push_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    pushId: uuid('push_id')
      .notNull()
      .references(() => grantPushes.id, { onDelete: 'cascade' }),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => appGrants.id, { onDelete: 'cascade' }),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    status: text('status', { enum: GRANT_PUSH_TARGET_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Scrubbed of every value the step decrypted. */
    error: text('error'),
    /** The keys put or removed — names only. */
    names: jsonb('names').$type<string[]>().notNull().default([]),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  table => [
    unique('grant_push_targets_push_grant_key').on(table.pushId, table.grantId),
    index('grant_push_targets_tenant_push_idx').on(table.tenantId, table.pushId),
    tenantIsolation('grant_push_targets'),
  ]
)

export const appConfigScans = pgTable(
  'app_config_scans',
  {
    tenantId: tenantRef(tenants),
    appId: uuid('app_id')
      .primaryKey()
      .references(() => apps.id, { onDelete: 'cascade' }),
    ref: text('ref'),
    sha: text('sha'),
    scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
    declared: jsonb('declared').$type<DeclaredConfigItem[]>().notNull().default([]),
    /** Matched resource ids that no environment holds (the `grant_needed` diff reads it). */
    needs: jsonb('needs').$type<string[]>().notNull().default([]),
    /** Why the scan failed; the previous `declared` is kept. */
    error: text('error'),
  },
  table => [
    index('app_config_scans_tenant_app_idx').on(table.tenantId, table.appId),
    check('app_config_scans_error_length', sql`char_length(${table.error}) <= 2000`),
    tenantIsolation('app_config_scans'),
  ]
)

export const appGrantsRelations = relations(appGrants, ({ one }) => ({
  tenant: one(tenants, { fields: [appGrants.tenantId], references: [tenants.id] }),
  app: one(apps, { fields: [appGrants.appId], references: [apps.id] }),
  resource: one(sharedResources, {
    fields: [appGrants.resourceId],
    references: [sharedResources.id],
  }),
  pushedVersion: one(sharedResourceValues, {
    fields: [appGrants.pushedVersionId],
    references: [sharedResourceValues.id],
  }),
  approval: one(approvalRequests, {
    fields: [appGrants.approvalId],
    references: [approvalRequests.id],
  }),
}))

export const grantPushesRelations = relations(grantPushes, ({ one, many }) => ({
  resource: one(sharedResources, {
    fields: [grantPushes.resourceId],
    references: [sharedResources.id],
  }),
  targets: many(grantPushTargets),
}))

export const grantPushTargetsRelations = relations(grantPushTargets, ({ one }) => ({
  push: one(grantPushes, { fields: [grantPushTargets.pushId], references: [grantPushes.id] }),
  grant: one(appGrants, { fields: [grantPushTargets.grantId], references: [appGrants.id] }),
  app: one(apps, { fields: [grantPushTargets.appId], references: [apps.id] }),
}))

export const appConfigScansRelations = relations(appConfigScans, ({ one }) => ({
  app: one(apps, { fields: [appConfigScans.appId], references: [apps.id] }),
}))

export type AppGrantRow = typeof appGrants.$inferSelect
export type NewAppGrantRow = typeof appGrants.$inferInsert
export type GrantPushRow = typeof grantPushes.$inferSelect
export type NewGrantPushRow = typeof grantPushes.$inferInsert
export type GrantPushTargetRow = typeof grantPushTargets.$inferSelect
export type NewGrantPushTargetRow = typeof grantPushTargets.$inferInsert
export type AppConfigScanRow = typeof appConfigScans.$inferSelect
export type NewAppConfigScanRow = typeof appConfigScans.$inferInsert
