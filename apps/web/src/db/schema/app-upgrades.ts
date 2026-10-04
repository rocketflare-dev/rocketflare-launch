/**
 * `app_upgrades` — Launch's history of an app's kit upgrades (P6 slice 6c, `docs/plans/p6-fleet.md`
 * §2; the single-app half). One row per attempt: what it moved from and to, the coding session
 * doing it (`sessions.upgrade_id` points back), the PR it opened, and where it stands.
 *
 * - **`status` is text typed by `APP_UPGRADE_STATUSES`** (`@launch/shared/launch-upgrades`), not a
 *   pg enum: a new status is a code change, not a migration.
 * - **`app_upgrades_open_idx`** is the "one open upgrade per app and target" guarantee — a partial
 *   unique index whose predicate is RENDERED from `OPEN_APP_UPGRADE_STATUSES`, so the SQL and the
 *   TypeScript cannot disagree about what "open" means. `coalesce(plugin_id, '')` makes the kit's
 *   own row (no plugin) collide with itself, which a plain NULL would not.
 * - `fleet_run_id` and `wait_reason` arrive with the fleet slice ("Upgrade all"); until then every
 *   row is one app's, started by a person.
 */
import {
  type AppUpgradeStatus,
  OPEN_APP_UPGRADE_STATUSES,
  type UpgradeTargetKind,
} from '@launch/shared/launch-upgrades'
import { relations, sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { apps } from './apps'
import { tenantIsolation } from './rls'
import { sessions } from './sessions'
import { tenants } from './tenants'
import { users } from './users'

const OPEN_STATUS_LITERALS = OPEN_APP_UPGRADE_STATUSES.map(status => `'${status}'`).join(', ')

export const appUpgrades = pgTable(
  'app_upgrades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    targetKind: text('target_kind').$type<UpgradeTargetKind>().notNull().default('kit'),
    /** The plugin an upgrade of kind `plugin` moves; null for the kit. */
    pluginId: text('plugin_id'),
    /** `apps.template_version` when it started (null when Launch could not read one). */
    fromVersion: text('from_version'),
    /** The pin's tag when it started — what the release must reach. */
    toVersion: text('to_version').notNull(),
    status: text('status').$type<AppUpgradeStatus>().notNull().default('running'),
    /** The coding session doing it (kind `upgrade`); kept null once that session row is gone. */
    sessionId: uuid('session_id').references((): AnyPgColumn => sessions.id, {
      onDelete: 'set null',
    }),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    /** Why it needs attention, failed or was cancelled — a sentence for the app page. */
    error: text('error'),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('app_upgrades_open_idx')
      .on(table.appId, table.targetKind, sql`coalesce(${table.pluginId}, '')`)
      .where(sql`${table.status} IN (${sql.raw(OPEN_STATUS_LITERALS)})`),
    index('app_upgrades_tenant_app_created_idx').on(
      table.tenantId,
      table.appId,
      table.createdAt.desc()
    ),
    tenantIsolation('app_upgrades'),
  ]
)

export const appUpgradesRelations = relations(appUpgrades, ({ one }) => ({
  tenant: one(tenants, { fields: [appUpgrades.tenantId], references: [tenants.id] }),
  app: one(apps, { fields: [appUpgrades.appId], references: [apps.id] }),
}))

export type AppUpgradeRow = typeof appUpgrades.$inferSelect
export type NewAppUpgradeRow = typeof appUpgrades.$inferInsert
