/**
 * `apps` and `app_owners` — the registry (spec/06). One row per Rocketflare app the company runs,
 * imported from an existing repo (P1) or launched by the pipeline.
 *
 * Two decisions worth stating:
 *
 * - **`slug` is unique across the whole database** (`apps_slug_key`), not per tenant: it names
 *   hostnames, Workers and Neon projects, and those are global. Every other lookup is tenant-first.
 * - **Ownership is a GROUP plus named people.** `owner_group_id` points at the kit's `groups` (D29 —
 *   there is no `teams` table) and is `set null`, so deleting a group orphans the app rather than
 *   deleting it. `app_owners` carries the same composite FK `(tenant_id, user_id) → tenant_users`
 *   as `group_members`, so a person who leaves the organisation stops owning its apps in the
 *   DATABASE rather than in service code.
 */
import { APP_SOURCES, APP_STATUSES } from '@launch/shared/launch-apps'
import type { AppSessionDb } from '@launch/shared/launch-sessions'
import { relations } from 'drizzle-orm'
import {
  bigint,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { groups } from './groups'
import { tenantIsolation } from './rls'
import { tenantUsers } from './tenant-users'
import { tenants } from './tenants'
import { users } from './users'

/** Mirrors `APP_STATUSES` in `@launch/shared/launch-apps`; `pgEnum` values are append-only. */
export const appStatusEnum = pgEnum('app_status', APP_STATUSES)

/** Mirrors `APP_SOURCES`. */
export const appSourceEnum = pgEnum('app_source', APP_SOURCES)

export const apps = pgTable(
  'apps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** The naming key for every resource the app owns. Global — see the header. */
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    ownerGroupId: uuid('owner_group_id').references(() => groups.id, { onDelete: 'set null' }),
    source: appSourceEnum('source').notNull(),
    /** The template adapter (spec/02). Only `rocketflare` exists. */
    template: text('template').notNull().default('rocketflare'),
    templateContractVersion: text('template_contract_version'),
    /** The kit version the app was cut from, e.g. `0.15.0`. */
    templateVersion: text('template_version'),
    repoOwner: text('repo_owner'),
    repoName: text('repo_name'),
    defaultBranch: text('default_branch'),
    /**
     * GitHub's numeric repository id (P2). The GitHub OIDC `repository_id` claim — unlike
     * `owner/name`, it survives a rename — so it is what `/ci/*` maps a job to an app by.
     */
    githubRepoId: text('github_repo_id'),
    /** The kit tag and commit a created app was scaffolded from (P2, `launch_settings.template_pin`). */
    templateRef: text('template_ref'),
    templateCommit: text('template_commit'),
    /** The latest launch pipeline run (`app_operations.run_id`, the Workflow instance's base id). */
    launchRunId: uuid('launch_run_id'),
    /**
     * The Workflow instance currently running `launch_run_id`: the run id itself, or `<runId>-rN`
     * after a retry. `/ci/scaffold/done` and `/ci/deploy/:id/finish` send their events here.
     */
    launchInstanceId: text('launch_instance_id'),
    status: appStatusEnum('status').notNull().default('requested'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Set by teardown (P2) when the app reaches `archived`. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /**
     * P3: the prepared `dev` database coding sessions branch from (`AppSessionDb` — the Neon branch
     * id, or the local template database, and the commit it was migrated and seeded at). Null until
     * the first session prepares it. Non-secret.
     */
    sessionDb: jsonb('session_db').$type<AppSessionDb>(),
    /** P3: this app's monthly session budget, overriding `session_policy.appMonthlyUsd`. */
    sessionMonthlyBudgetMicrocents: bigint('session_monthly_budget_microcents', { mode: 'number' }),
    ...timestamps(),
  },
  table => [
    // A CONSTRAINT with a known name, so an import's duplicate slug is a 23505 the service can map.
    unique('apps_slug_key').on(table.slug),
    // `/ci/*` resolves a GitHub job to its app by this, before any tenant is known; one repo is
    // one app. NULLs (an import made before P2) are distinct, so they never collide.
    unique('apps_github_repo_id_key').on(table.githubRepoId),
    index('apps_tenant_status_idx').on(table.tenantId, table.status),
    tenantIsolation('apps'),
  ]
)

export const appOwners = pgTable(
  'app_owners',
  {
    tenantId: tenantRef(tenants),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    primaryKey({ columns: [table.appId, table.userId] }),
    // Leaving the organisation stops you owning its apps — the `group_members` pattern (D29).
    foreignKey({
      columns: [table.tenantId, table.userId],
      foreignColumns: [tenantUsers.tenantId, tenantUsers.userId],
      name: 'app_owners_membership_fk',
    }).onDelete('cascade'),
    // "Which apps does this person own?" — the policy check on every sign-in (spec/05).
    index('app_owners_tenant_user_idx').on(table.tenantId, table.userId),
    tenantIsolation('app_owners'),
  ]
)

export const appsRelations = relations(apps, ({ one }) => ({
  tenant: one(tenants, { fields: [apps.tenantId], references: [tenants.id] }),
  ownerGroup: one(groups, { fields: [apps.ownerGroupId], references: [groups.id] }),
  createdBy: one(users, { fields: [apps.createdByUserId], references: [users.id] }),
}))

export const appOwnersRelations = relations(appOwners, ({ one }) => ({
  app: one(apps, { fields: [appOwners.appId], references: [apps.id] }),
  user: one(users, { fields: [appOwners.userId], references: [users.id] }),
}))

export type AppRow = typeof apps.$inferSelect
export type NewAppRow = typeof apps.$inferInsert
export type AppOwnerRow = typeof appOwners.$inferSelect
