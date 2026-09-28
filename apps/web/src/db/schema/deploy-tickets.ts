/**
 * `deploy_tickets` (P2) — one row per GitHub-OIDC job Launch let near an app: a deploy through the
 * external deployer protocol (`docs/DEPLOYER.md` in the kit, `/ci/deploy`) or the one-shot scaffold
 * job (`/ci/scaffold`). Postgres rather than a Durable Object, as with P1's `oidc_codes`: it needs
 * no binding and it keeps the history the app page shows.
 *
 * Four decisions worth stating (and, from P4, `release_id` / `approval_id` link a ticket into a
 * release's audit chain — `app-releases.ts`):
 *
 * - **Every transition is a compare-and-set** (`UPDATE … WHERE status = $from RETURNING`), so two
 *   calls racing on one ticket are one success and one 409, never a lost write.
 * - **Unique `(environment_id, purpose, run_id, run_attempt)`** is the idempotency of `start`: a
 *   retried call from the same run attempt gets the same ticket back. `run_id` is NULL on a
 *   "Deploy to production" pre-approval until the run it dispatched claims it, and Postgres treats
 *   NULLs as distinct, so any number of unclaimed intents may exist; the partial index finds them.
 * - **Deployed means `activated_at`.** Only `activate` sets it; `finished` + `cf_version_id` is
 *   an upload that may never have gone live (a job that died at its migration still calls
 *   `finish`), so no reader infers a deploy from status and version.
 * - **No credential is ever stored.** The migrator URL is minted on upload and revoked by
 *   `credentials_revoked_at`'s password reset; the columns record only WHEN.
 */
import {
  CI_TICKET_PURPOSES,
  DEPLOY_DECISION_SOURCES,
  DEPLOY_TICKET_STATUSES,
} from '@launch/shared/launch-pipeline'
import { relations, sql } from 'drizzle-orm'
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
import { appEnvironments } from './app-environments'
import { appReleases } from './app-releases'
import { approvalRequests } from './approvals'
import { apps } from './apps'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

/** Mirrors `CI_TICKET_PURPOSES` in `@launch/shared/launch-pipeline`; append-only. */
export const ciTicketPurposeEnum = pgEnum('ci_ticket_purpose', CI_TICKET_PURPOSES)

/** Mirrors `DEPLOY_TICKET_STATUSES` (DEPLOYER.md "Ticket statuses"); append-only. */
export const deployTicketStatusEnum = pgEnum('deploy_ticket_status', DEPLOY_TICKET_STATUSES)

/** Mirrors `DEPLOY_DECISION_SOURCES`; append-only. */
export const deployDecisionSourceEnum = pgEnum('deploy_decision_source', DEPLOY_DECISION_SOURCES)

export const deployTickets = pgTable(
  'deploy_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => appEnvironments.id, { onDelete: 'cascade' }),
    purpose: ciTicketPurposeEnum('purpose').notNull(),
    status: deployTicketStatusEnum('status').notNull().default('pending'),

    // From the GitHub OIDC token of the run that opened (or claimed) the ticket.
    /** Stable across renames — what the caller resolver maps to the app. */
    repositoryId: text('repository_id'),
    /** `owner/name` at the time of the call. */
    repository: text('repository'),
    /** GitHub's run id (a large integer, kept as text). NULL on an unclaimed production intent. */
    runId: text('run_id'),
    runAttempt: integer('run_attempt'),
    sha: text('sha'),
    ref: text('ref'),
    actor: text('actor'),
    jobWorkflowRef: text('job_workflow_ref'),

    // The deploy itself.
    /** The release version the job sent (`RELEASE_VERSION`). */
    version: text('version'),
    /** The Workers version id the upload created. An uploaded version is NOT a deploy. */
    cfVersionId: text('cf_version_id'),
    /**
     * When `activate` put `cf_version_id` live at 100% — set by the `uploaded → active`
     * compare-and-set and by nothing else. THE answer to "did this ticket deploy": a ticket
     * `finish` closed without it (the job died between upload and activate) never served a request,
     * whatever its status or version say.
     */
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    /**
     * When `activate` began its vendor calls (Workflows, schedules, the deployment) on an `uploaded`
     * ticket — the progress read's "activating". Informational only: never "deployed"
     * (`activated_at` is), and a failed activation keeps it, which is what says where it stopped.
     */
    activationStartedAt: timestamp('activation_started_at', { withTimezone: true }),
    /**
     * The deploy progress read's claim on this ticket's GitHub run (`deploy/progress.ts`): one read
     * per window polls the run, however many tabs read the page. Never `updated_at`, which says
     * when the ticket last MOVED.
     */
    runPolledAt: timestamp('run_polled_at', { withTimezone: true }),
    /** The bindings the build declared, as checked (`binding-check.ts`). Ids and names only. */
    bindings: jsonb('bindings').$type<Record<string, unknown>>(),
    /** `"<kind> <binding>=<value>"` per refused binding. */
    refused: jsonb('refused').$type<string[]>(),

    // The migrator credential — WHEN, never what.
    credentialsIssuedAt: timestamp('credentials_issued_at', { withTimezone: true }),
    credentialsRevokedAt: timestamp('credentials_revoked_at', { withTimezone: true }),

    // The decision.
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionSource: deployDecisionSourceEnum('decision_source'),
    /** A pending approval or an unclaimed intent stops counting after this. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    /** The launch run waiting on this ticket (`SCAFFOLD_FINISHED_EVENT` / `DEPLOY_FINISHED_EVENT`). */
    launchRunId: uuid('launch_run_id'),
    /** P4: the release whose tag this run carries, matched at `start` (the audit chain's link). */
    releaseId: uuid('release_id').references(() => appReleases.id, { onDelete: 'set null' }),
    /** P4: the `deploy.production` approval that decided (or pre-approved) this ticket. */
    approvalId: uuid('approval_id').references(() => approvalRequests.id, {
      onDelete: 'set null',
    }),
    error: text('error'),
    ...timestamps(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  table => [
    unique('deploy_tickets_run_key').on(
      table.environmentId,
      table.purpose,
      table.runId,
      table.runAttempt
    ),
    // The app page's deploy history, newest first.
    index('deploy_tickets_tenant_app_created_idx').on(
      table.tenantId,
      table.appId,
      table.createdAt.desc()
    ),
    // A production `start` claims the environment's unclaimed pre-approval.
    index('deploy_tickets_unclaimed_intent_idx')
      .on(table.environmentId)
      .where(sql`${table.runId} IS NULL AND ${table.status} = 'approved'`),
    tenantIsolation('deploy_tickets'),
  ]
)

export const deployTicketsRelations = relations(deployTickets, ({ one }) => ({
  tenant: one(tenants, { fields: [deployTickets.tenantId], references: [tenants.id] }),
  app: one(apps, { fields: [deployTickets.appId], references: [apps.id] }),
  environment: one(appEnvironments, {
    fields: [deployTickets.environmentId],
    references: [appEnvironments.id],
  }),
}))

export type DeployTicketRow = typeof deployTickets.$inferSelect
export type NewDeployTicketRow = typeof deployTickets.$inferInsert
