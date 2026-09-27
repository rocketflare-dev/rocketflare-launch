/**
 * `app_operations` — the durable, per-step log of a pipeline run (spec/06): what each step did,
 * how often it was tried, and the external ids it created. Those ids are what make a retry resume
 * at the failed step and a teardown remove exactly what was made — never a lookup by name.
 *
 * `run_id` groups one run's steps (a Workflow instance, or an import); **unique `(run_id, step)`
 * is the idempotency** — a retried step updates its own row instead of appending a second one.
 * `kind` is text so a new kind of run is no migration.
 */
import { APP_OPERATION_STATUSES, type AppOperationExternalIds } from '@launch/shared/launch-apps'
import { relations } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { apps } from './apps'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

/** Mirrors `APP_OPERATION_STATUSES` in `@launch/shared/launch-apps`; append-only. */
export const appOperationStatusEnum = pgEnum('app_operation_status', APP_OPERATION_STATUSES)

export const appOperations = pgTable(
  'app_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull(),
    /** `import`, `create`, … — what kind of run this step belongs to. */
    kind: text('kind').notNull(),
    step: text('step').notNull(),
    status: appOperationStatusEnum('status').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    error: text('error'),
    externalIds: jsonb('external_ids').$type<AppOperationExternalIds>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    unique('app_operations_run_step_key').on(table.runId, table.step),
    // The detail page's operations log, newest first.
    index('app_operations_tenant_app_created_idx').on(
      table.tenantId,
      table.appId,
      table.createdAt.desc()
    ),
    tenantIsolation('app_operations'),
  ]
)

export const appOperationsRelations = relations(appOperations, ({ one }) => ({
  tenant: one(tenants, { fields: [appOperations.tenantId], references: [tenants.id] }),
  app: one(apps, { fields: [appOperations.appId], references: [apps.id] }),
}))

export type AppOperationRow = typeof appOperations.$inferSelect
export type NewAppOperationRow = typeof appOperations.$inferInsert
