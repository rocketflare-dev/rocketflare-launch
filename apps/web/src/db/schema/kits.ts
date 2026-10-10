/**
 * `kits` — the kit catalogue (D36 K1, `docs/plans/multi-kit.md`): every kit a platform admin
 * registered, the repo, the pin, the manifest snapshot read at the pin and the result of the
 * conformance check. Platform-scoped like `launch_settings`: a kit belongs to the Launch
 * deployment, not to an organisation in it, so there is no `tenant_id` and the table is in
 * `RLS_REVOKED_TABLES`. Only `services/launch/kits/store.ts` touches it.
 *
 * - **`slug` is the catalogue key** (unique); the built-in Rocketflare row is `rocketflare`.
 * - **`pin` is `{ tag?, commit, follow? }`** (`kitStoredPinSchema`) — the repo is the row's. It is
 *   NULL only on the Rocketflare row Launch creates itself: that row follows `DEFAULT_TEMPLATE_PIN`
 *   (moving with Launch), exactly as an unset `template_pin` setting did.
 * - **At most one default** (`kits_one_default_idx`, partial unique on `is_default` WHERE true):
 *   new apps are cut from it until Create app has a picker (K5). Swapping it is one transaction.
 * - `manifest` / `manifest_source` / `contract_version` / `status` / `problems` / `checked_at` are
 *   the last check at the pin; re-pinning clears them to `unchecked` until the check runs.
 * - `latest_check` is the last newest-release lookup of a Follow latest pin (`kitLatestCheckSchema`).
 */
import type { KitManifest } from '@launch/shared/kit-manifest'
import type { KitCheckStatus, KitManifestSource, KitStoredPin } from '@launch/shared/kits'
import type { KitLatestCheck } from '@launch/shared/launch-setup'
import { sql } from 'drizzle-orm'
import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { timestamps } from './_helpers'
import { users } from './users'

export const kits = pgTable(
  'kits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** `owner/name` on GitHub. Public, or private with the GitHub App installed on its owner. */
    repo: text('repo').notNull(),
    /** Null = Launch's code default (the built-in Rocketflare row only). */
    pin: jsonb('pin').$type<KitStoredPin>(),
    /** The manifest at `pin`, parsed (`kitManifestSchema`); null until a check read one. */
    manifest: jsonb('manifest').$type<KitManifest>(),
    manifestSource: text('manifest_source').$type<KitManifestSource>(),
    contractVersion: text('contract_version'),
    isDefault: boolean('is_default').notNull().default(false),
    status: text('status').$type<KitCheckStatus>().notNull().default('unchecked'),
    problems: jsonb('problems').$type<string[]>().notNull().default([]),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    latestCheck: jsonb('latest_check').$type<KitLatestCheck>(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  table => [
    uniqueIndex('kits_slug_key').on(table.slug),
    uniqueIndex('kits_one_default_idx').on(table.isDefault).where(sql`${table.isDefault}`),
  ]
)

export type KitRow = typeof kits.$inferSelect
export type NewKitRow = typeof kits.$inferInsert
