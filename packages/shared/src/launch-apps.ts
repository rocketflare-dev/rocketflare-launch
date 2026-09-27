/**
 * Launch app registry contracts (spec/06): the closed sets the `apps`, `app_environments`,
 * `app_health_checks` and `app_operations` tables are built from, and the shapes of their jsonb
 * columns. The pg enums in `apps/web/src/db/schema/app*.ts` mirror these lists — append-only.
 *
 * Slice 1d owns this file and adds the request/response contracts for `/api/apps` (import,
 * catalogue, detail, health, OIDC client registration) beside what is here.
 */
import { z } from 'zod'

/** `requested → provisioning → live → archived`, or `failed` (spec/06). */
export const APP_STATUSES = ['requested', 'provisioning', 'live', 'archived', 'failed'] as const
export const appStatusSchema = z.enum(APP_STATUSES)
export type AppStatus = z.infer<typeof appStatusSchema>

/** How the app arrived: registered from an existing repo (P1), or launched by the pipeline. */
export const APP_SOURCES = ['imported', 'created'] as const
export const appSourceSchema = z.enum(APP_SOURCES)
export type AppSource = z.infer<typeof appSourceSchema>

export const APP_ENVIRONMENT_NAMES = ['staging', 'production'] as const
export const appEnvironmentNameSchema = z.enum(APP_ENVIRONMENT_NAMES)
export type AppEnvironmentName = z.infer<typeof appEnvironmentNameSchema>

/** `up`: health and ready both 200. `degraded`: health 200, ready not. Otherwise `down`. */
export const HEALTH_STATUSES = ['unknown', 'up', 'degraded', 'down'] as const
export const healthStatusSchema = z.enum(HEALTH_STATUSES)
export type HealthStatus = z.infer<typeof healthStatusSchema>

export const APP_OPERATION_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
] as const
export const appOperationStatusSchema = z.enum(APP_OPERATION_STATUSES)
export type AppOperationStatus = z.infer<typeof appOperationStatusSchema>

/**
 * The resource ids an environment's toml declares (spec/06: "resource ids are recorded when
 * created, never looked up by name later"). Every list is optional so an app that binds no queue
 * simply has none.
 */
export const appEnvironmentResourcesSchema = z.object({
  kv: z.array(z.object({ binding: z.string(), id: z.string() })).optional(),
  queues: z.array(z.object({ binding: z.string(), queue: z.string() })).optional(),
  r2: z.array(z.object({ binding: z.string(), bucketName: z.string() })).optional(),
  durableObjects: z.array(z.object({ binding: z.string(), className: z.string() })).optional(),
  workflows: z
    .array(z.object({ binding: z.string(), name: z.string(), className: z.string() }))
    .optional(),
  hyperdrive: z.array(z.object({ binding: z.string(), id: z.string() })).optional(),
})
export type AppEnvironmentResources = z.infer<typeof appEnvironmentResourcesSchema>

/** The Neon project an environment runs on. Ids only — a connection string is a secret. */
export const appEnvironmentNeonSchema = z
  .object({
    projectId: z.string(),
    branchId: z.string().optional(),
    databaseName: z.string().optional(),
    roleName: z.string().optional(),
  })
  .passthrough()
export type AppEnvironmentNeon = z.infer<typeof appEnvironmentNeonSchema>

/** Cloudflare route / custom-domain ids an environment owns. */
export const appRouteIdsSchema = z.array(z.string())
export type AppRouteIds = z.infer<typeof appRouteIdsSchema>

/** What a pipeline step created, by kind — what makes retry and teardown exact (spec/06). */
export const appOperationExternalIdsSchema = z.record(z.string(), z.string())
export type AppOperationExternalIds = z.infer<typeof appOperationExternalIdsSchema>
