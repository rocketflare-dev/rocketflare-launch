/**
 * `app_prebuilds` (issue #16) — ONE row per app: its PREBUILD, a workspace backup of the default
 * branch with `node_modules` installed (`services/sessions/prebuild.ts`), and the claim on the
 * build that will replace it. A new session restores it instead of cloning and installing.
 *
 * - **The prebuild** (`backup` … `build_ms`): the Sandbox SDK's handle and what it was taken at —
 *   the commit and its tree, the lockfile's hash, the session image, the backup mode and the
 *   sandbox host (an archive moved through the R2 binding is not one a presigned restore can
 *   read, and the remote sandbox host has a bucket of its own). Null until the
 *   first build is saved; a later build REPLACES it and deletes the old archive (one per app).
 * - **The claim** (`building_session_id`, `building_since`): the `prebuild` run building the next
 *   one. A request while it is held does nothing — concurrency is this row, never a `Map`.
 *   `last_error` / `last_attempt_at`: the last build that failed, which holds off the next request
 *   for a while (`PREBUILD_RETRY_AFTER_MS`).
 *
 * Holds no secret: the prebuild is built without a database, so its archive has no `.dev.vars`.
 */
import { SESSION_SANDBOX_HOSTS } from '@launch/shared/launch-setup'
import { relations } from 'drizzle-orm'
import { integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { apps } from './apps'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'

/** `app_prebuilds.backup` — the Sandbox SDK's handle (`SandboxBackup`), restorable by any session. */
export interface AppPrebuildBackup {
  id: string
  dir: string
  /** Made through the Durable Object and the R2 binding (`binding` mode). */
  localBucket?: boolean
}

export const appPrebuilds = pgTable(
  'app_prebuilds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),

    // ---- the prebuild (null until the first build is saved)
    backup: jsonb('backup').$type<AppPrebuildBackup>(),
    /** `binding` or `presigned`, and the sandbox host it was built on: a restore must match both. */
    mode: text('mode'),
    sandboxHost: text('sandbox_host', { enum: SESSION_SANDBOX_HOSTS }),
    /** `SESSION_IMAGE_VERSION` it was built on: `node_modules` is only good on the same image. */
    imageVersion: text('image_version'),
    /** The default-branch commit it holds, and that commit's tree. */
    baseSha: text('base_sha'),
    treeSha: text('tree_sha'),
    /** sha256 of its `pnpm-lock.yaml`: a session whose lockfile differs installs after the restore. */
    lockfileHash: text('lockfile_hash'),
    builtAt: timestamp('built_at', { withTimezone: true }),
    /** How long the build's clone + install took — what each restore saves. */
    buildMs: integer('build_ms'),

    // ---- the build in flight
    buildingSessionId: uuid('building_session_id'),
    buildingSince: timestamp('building_since', { withTimezone: true }),
    lastError: text('last_error'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    unique('app_prebuilds_tenant_app_key').on(table.tenantId, table.appId),
    tenantIsolation('app_prebuilds'),
  ]
)

export const appPrebuildsRelations = relations(appPrebuilds, ({ one }) => ({
  tenant: one(tenants, { fields: [appPrebuilds.tenantId], references: [tenants.id] }),
  app: one(apps, { fields: [appPrebuilds.appId], references: [apps.id] }),
}))

export type AppPrebuildRow = typeof appPrebuilds.$inferSelect
export type NewAppPrebuildRow = typeof appPrebuilds.$inferInsert
