/**
 * `app_environments` and `app_health_checks` (spec/06). One environment row per app × `staging |
 * production`, holding the ids of everything that environment owns — **recorded when created (or
 * read from the toml on import), never looked up by name later** — plus the last deploy and the
 * current health. The health columns are the LATEST result; `app_health_checks` is the history
 * the `*\/5` cron appends to and prunes after seven days.
 *
 * `health_changed_at` moves only when `health_status` does, which is what lets the poller audit
 * `app.health.changed` on a transition rather than on every tick.
 */
import {
  APP_ENVIRONMENT_NAMES,
  type AppEnvironmentNeon,
  type AppEnvironmentResources,
  type AppRouteIds,
  HEALTH_STATUSES,
} from '@launch/shared/launch-apps'
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

/** Mirrors `APP_ENVIRONMENT_NAMES` in `@launch/shared/launch-apps`; append-only. */
export const appEnvironmentNameEnum = pgEnum('app_environment_name', APP_ENVIRONMENT_NAMES)

/** Mirrors `HEALTH_STATUSES`; shared by the environment's latest status and each check. */
export const healthStatusEnum = pgEnum('health_status', HEALTH_STATUSES)

export const appEnvironments = pgTable(
  'app_environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    name: appEnvironmentNameEnum('name').notNull(),
    /** The public origin (`[vars].APP_URL`), no trailing slash. Health is polled beneath it. */
    url: text('url'),
    workerName: text('worker_name'),
    resources: jsonb('resources').$type<AppEnvironmentResources>().notNull().default({}),
    neon: jsonb('neon').$type<AppEnvironmentNeon>(),
    resendKeyId: text('resend_key_id'),
    /**
     * The app's `OAUTH_ENCRYPTION_KEY` for this environment, sealed with `encryptToken` (spec/03)
     * — generated once by the launch, so a retried `worker_secrets` step puts the SAME key back
     * rather than orphaning everything the app already encrypted.
     */
    encryptionKeySealed: text('encryption_key_sealed'),
    routeIds: jsonb('route_ids').$type<AppRouteIds>().notNull().default([]),
    lastDeployVersion: text('last_deploy_version'),
    lastDeployAt: timestamp('last_deploy_at', { withTimezone: true }),
    /** Free text on purpose: a deploy may be a person, a pipeline run or a GitHub actor. */
    lastDeployBy: text('last_deploy_by'),
    healthStatus: healthStatusEnum('health_status').notNull().default('unknown'),
    healthCheckedAt: timestamp('health_checked_at', { withTimezone: true }),
    healthChangedAt: timestamp('health_changed_at', { withTimezone: true }),
    /** The version `/api/health` reported on the last check. */
    healthVersion: text('health_version'),
    healthLatencyMs: integer('health_latency_ms'),
    healthError: text('health_error'),
    ...timestamps(),
  },
  table => [
    unique('app_environments_app_name_key').on(table.appId, table.name),
    index('app_environments_tenant_app_idx').on(table.tenantId, table.appId),
    tenantIsolation('app_environments'),
  ]
)

export const appHealthChecks = pgTable(
  'app_health_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => appEnvironments.id, { onDelete: 'cascade' }),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    status: healthStatusEnum('status').notNull(),
    /** `/api/health`'s status code; null when the request never completed (timeout, DNS). */
    httpStatus: integer('http_status'),
    /** `/api/ready`'s status code. */
    readyStatus: integer('ready_status'),
    latencyMs: integer('latency_ms'),
    version: text('version'),
    error: text('error'),
  },
  table => [
    // The detail page's history, newest first — and the seven-day prune, per tenant.
    index('app_health_checks_tenant_env_checked_idx').on(
      table.tenantId,
      table.environmentId,
      table.checkedAt.desc()
    ),
    tenantIsolation('app_health_checks'),
  ]
)

export const appEnvironmentsRelations = relations(appEnvironments, ({ one }) => ({
  tenant: one(tenants, { fields: [appEnvironments.tenantId], references: [tenants.id] }),
  app: one(apps, { fields: [appEnvironments.appId], references: [apps.id] }),
}))

export const appHealthChecksRelations = relations(appHealthChecks, ({ one }) => ({
  environment: one(appEnvironments, {
    fields: [appHealthChecks.environmentId],
    references: [appEnvironments.id],
  }),
}))

export type AppEnvironmentRow = typeof appEnvironments.$inferSelect
export type NewAppEnvironmentRow = typeof appEnvironments.$inferInsert
export type AppHealthCheckRow = typeof appHealthChecks.$inferSelect
export type NewAppHealthCheckRow = typeof appHealthChecks.$inferInsert
