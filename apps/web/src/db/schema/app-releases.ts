/**
 * `app_releases` (Launch P4, spec/08 "Shipping", plan §1.8) — one row per release Launch cut for
 * an app: the version bump committed to the default branch, the `X.Y.Z` tag on it (which starts
 * `deploy.yml` staging), the PRs it carries, and where it has got to on the way to production.
 *
 * - **Unique `(app_id, tag)`**: a tag is a release, and Release is idempotent by it.
 * - **The chain is linked, not inferred** (plan §1.11): `deploy_tickets.release_id` points here
 *   (set at `start` by matching the run's tag), `approval_id` names the `deploy.production`
 *   request, and `staging_ticket_id` / `production_ticket_id` are the two runs that shipped it.
 *   The ticket ids are plain uuids — the FK lives on the ticket's side (`release_id`), which keeps
 *   the two schema files from importing each other.
 * - `prs` is `releasePrSchema[]`, capped at `RELEASE_MAX_PRS`; GitHub-only authors are logins,
 *   never mapped to Launch users.
 * - `tag_run` / `tag_run_polled_at`: the last reading of the GitHub run the tag push started
 *   (`candidateRunSchema`), and when it was taken — the read throttle of `releases/tag-run.ts`
 *   (one GitHub read per release per window, however many people watch the strip).
 */
import type { CandidateRun } from '@launch/shared/launch-promotion'
import { RELEASE_STATUSES, type ReleasePr } from '@launch/shared/launch-releases'
import { relations } from 'drizzle-orm'
import { index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { approvalRequests } from './approvals'
import { apps } from './apps'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

/** Mirrors `RELEASE_STATUSES` in `@launch/shared/launch-releases`; append-only. */
export const releaseStatusEnum = pgEnum('release_status', RELEASE_STATUSES)

export const appReleases = pgTable(
  'app_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    /** `X.Y.Z` — equal to the root `package.json` version at `sha`. */
    version: text('version').notNull(),
    /** The git tag, which IS the version (no `v`). */
    tag: text('tag').notNull(),
    /** The bump commit the tag points at. */
    sha: text('sha').notNull(),
    /** The previous release's tag, the base of the compare; null for the first. */
    previousTag: text('previous_tag'),
    prs: jsonb('prs').$type<ReleasePr[]>().notNull().default([]),
    status: releaseStatusEnum('status').notNull().default('tagged'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvalId: uuid('approval_id').references(() => approvalRequests.id, {
      onDelete: 'set null',
    }),
    /** Plain uuids — see the header. */
    stagingTicketId: uuid('staging_ticket_id'),
    productionTicketId: uuid('production_ticket_id'),
    error: text('error'),
    /** The tag's deploy run as last read from GitHub (see the header); null before any reading. */
    tagRun: jsonb('tag_run').$type<CandidateRun>(),
    tagRunPolledAt: timestamp('tag_run_polled_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    unique('app_releases_app_tag_key').on(table.appId, table.tag),
    // The app page's releases, newest first.
    index('app_releases_tenant_app_created_idx').on(
      table.tenantId,
      table.appId,
      table.createdAt.desc()
    ),
    tenantIsolation('app_releases'),
  ]
)

export const appReleasesRelations = relations(appReleases, ({ one }) => ({
  tenant: one(tenants, { fields: [appReleases.tenantId], references: [tenants.id] }),
  app: one(apps, { fields: [appReleases.appId], references: [apps.id] }),
  approval: one(approvalRequests, {
    fields: [appReleases.approvalId],
    references: [approvalRequests.id],
  }),
}))

export type AppReleaseRow = typeof appReleases.$inferSelect
export type NewAppReleaseRow = typeof appReleases.$inferInsert
