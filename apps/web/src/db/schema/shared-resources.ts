/**
 * Shared config (Launch P5, spec/09, `docs/plans/p5-grants.md` §2): a `shared_resources` row is a
 * named bundle of config items owned by a group, and `shared_resource_values` holds its sealed
 * values, one VERSION per environment per write.
 *
 * Decisions worth stating:
 *
 * - **The owner group is required and may not be deleted from under a resource**: `owner_group_id`
 *   is `ON DELETE NO ACTION` — deleting a group that owns a resource fails, and `deleteGroup` /
 *   `deleteGroupType` answer 409 `group_owns_shared_config` before it gets there. The plan says `restrict`; NO ACTION is the same refusal checked at
 *   the END of the statement, which is what lets a tenant's cascade delete the group and the
 *   resource together (RESTRICT would fail the tenant purge on the order Postgres happens to pick).
 * - **Values are one sealed blob per version** (`encryptToken(cfg, JSON)`, the P1
 *   `admin_credentials` pattern, plan §1.2): a write is version N+1 for that environment, never an
 *   UPDATE of a value. `sealed` is never selected by a route that answers a client.
 * - **One `active` version per resource × environment** by a partial unique index; a rotation
 *   leaves the previous one `retiring` until every holder has the new one (plan §1.12).
 * - `items` and `policies` are jsonb typed from `@launch/shared/launch-grants`; `status` is TEXT
 *   typed by the shared closed set (the P4 pattern, no enum migration to add a state).
 */
import {
  SHARED_RESOURCE_VALUE_STATUSES,
  type SharedResourceItem,
  type SharedResourcePolicies,
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
import { groups } from './groups'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const sharedResources = pgTable(
  'shared_resources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    /** A kit group (D29). NO ACTION: see the header. */
    ownerGroupId: uuid('owner_group_id')
      .notNull()
      .references(() => groups.id),
    items: jsonb('items').$type<SharedResourceItem[]>().notNull().default([]),
    policies: jsonb('policies').$type<SharedResourcePolicies>().notNull().default({}),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    unique('shared_resources_tenant_slug_key').on(table.tenantId, table.slug),
    index('shared_resources_tenant_owner_group_idx').on(table.tenantId, table.ownerGroupId),
    tenantIsolation('shared_resources'),
  ]
)

export const sharedResourceValues = pgTable(
  'shared_resource_values',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => sharedResources.id, { onDelete: 'cascade' }),
    environment: appEnvironmentNameEnum('environment').notNull(),
    version: integer('version').notNull(),
    /** `encryptToken(cfg, JSON.stringify({ KEY: value }))` — never returned. */
    sealed: text('sealed').notNull(),
    status: text('status', { enum: SHARED_RESOURCE_VALUE_STATUSES }).notNull().default('active'),
    setByUserId: uuid('set_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  table => [
    unique('shared_resource_values_version_key').on(
      table.resourceId,
      table.environment,
      table.version
    ),
    // One active version per resource × environment.
    uniqueIndex('shared_resource_values_active_idx')
      .on(table.resourceId, table.environment)
      .where(sql`${table.status} = 'active'`),
    index('shared_resource_values_tenant_resource_idx').on(
      table.tenantId,
      table.resourceId,
      table.environment
    ),
    check('shared_resource_values_version_check', sql`${table.version} >= 1`),
    tenantIsolation('shared_resource_values'),
  ]
)

export const sharedResourcesRelations = relations(sharedResources, ({ one, many }) => ({
  tenant: one(tenants, { fields: [sharedResources.tenantId], references: [tenants.id] }),
  ownerGroup: one(groups, { fields: [sharedResources.ownerGroupId], references: [groups.id] }),
  values: many(sharedResourceValues),
}))

export const sharedResourceValuesRelations = relations(sharedResourceValues, ({ one }) => ({
  resource: one(sharedResources, {
    fields: [sharedResourceValues.resourceId],
    references: [sharedResources.id],
  }),
  setBy: one(users, { fields: [sharedResourceValues.setByUserId], references: [users.id] }),
}))

export type SharedResourceRow = typeof sharedResources.$inferSelect
export type NewSharedResourceRow = typeof sharedResources.$inferInsert
export type SharedResourceValueRow = typeof sharedResourceValues.$inferSelect
export type NewSharedResourceValueRow = typeof sharedResourceValues.$inferInsert
