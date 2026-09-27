/**
 * `admin_credentials` and `launch_settings` — the platform configuration Launch runs on (spec/03).
 * Neither has a `tenant_id`: they belong to the Launch deployment, not to an organisation in it,
 * and both are in `RLS_REVOKED_TABLES`. Only `services/launch/credentials.ts` touches them.
 *
 * - **One row per credential KIND** (`kind` is unique): setting one again is a rotation, not a
 *   second row.
 * - **`sealed` is the credential's JSON sealed with `OAUTH_ENCRYPTION_KEY`** (`encryptToken`) and
 *   is never returned by any route. `metadata` holds only non-secret facts (account id, app id,
 *   installation id, a fingerprint) — what the setup page can show.
 * - `last_check_status` / `last_check` are the most recent vendor probe, so the setup page renders
 *   without calling a vendor.
 * - `launch_settings` is key → jsonb value for the non-secret platform settings (apps domain,
 *   Cloudflare account id, Neon region, GitHub org): `key` is the primary key, the feature-flag
 *   precedent — the key is the identity every consumer uses.
 */
import {
  CREDENTIAL_CHECK_STATUSES,
  CREDENTIAL_KINDS,
  type CredentialLastCheck,
  type CredentialMetadata,
} from '@launch/shared/launch-setup'
import { jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { timestamps } from './_helpers'
import { users } from './users'

/** Mirrors `CREDENTIAL_KINDS` in `@launch/shared/launch-setup`; append-only. */
export const credentialKindEnum = pgEnum('credential_kind', CREDENTIAL_KINDS)

/** Mirrors `CREDENTIAL_CHECK_STATUSES`. */
export const credentialCheckStatusEnum = pgEnum(
  'credential_check_status',
  CREDENTIAL_CHECK_STATUSES
)

export const adminCredentials = pgTable(
  'admin_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: credentialKindEnum('kind').notNull(),
    /** Sealed JSON. Server-only; never selected by a route. */
    sealed: text('sealed').notNull(),
    metadata: jsonb('metadata').$type<CredentialMetadata>().notNull().default({}),
    lastCheckStatus: credentialCheckStatusEnum('last_check_status'),
    lastCheck: jsonb('last_check').$type<CredentialLastCheck>(),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    setByUserId: uuid('set_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null until the credential is replaced for the first time. */
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [unique('admin_credentials_kind_key').on(table.kind)]
)

export const launchSettings = pgTable('launch_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})

export type AdminCredentialRow = typeof adminCredentials.$inferSelect
export type NewAdminCredentialRow = typeof adminCredentials.$inferInsert
export type LaunchSettingRow = typeof launchSettings.$inferSelect
