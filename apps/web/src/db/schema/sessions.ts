/**
 * `sessions` and `session_events` — Launch P3's coding sessions (spec/07, `docs/plans/p3-sessions.md`
 * §2). One `sessions` row per chat-with-a-sandbox on an app, and its append-only event log.
 *
 * - **The row is the claim and the truth.** A `SessionWorkflow` instance drives the lifecycle and is
 *   the ONE writer of `status` transitions and of `session_events`; routes write only the request
 *   columns (`pending_message`, `requested_action`, `cancel_requested_at`) and wake the instance.
 *   Every transition is a compare-and-set on `status`.
 * - **`sandbox_id` is unique**, because the model proxy and the GitHub egress handler find the
 *   session from the platform's `ctx.containerId` → this column, BEFORE any tenant is known (the
 *   unscoped allow-list's `services/sessions/egress/*` entries). The sandbox can never name itself.
 * - **`short_id` is unique** and, with `preview_token`, spells the preview host
 *   (`<port>-<short_id>-<token>.<preview domain>`, `@launch/shared/launch-sessions`).
 * - **Secrets are sealed** (`encryptToken`): `db_uri_sealed` (the session branch's connection
 *   string) and `github_token_sealed` (the one-repo installation token the egress handler injects).
 *   Neither is ever selected by a route or returned from a Workflow step.
 * - **`sessions_app_active_idx`** is the concurrency check's index: its predicate is RENDERED from
 *   `ACTIVE_SESSION_STATUSES`, the `agent_runs` precedent, so the SQL and the TypeScript cannot
 *   disagree about what "active" means.
 * - Metering columns are running totals updated atomically by the model proxy
 *   (`cost_microcents = cost_microcents + $1`); `ai_usage.session_id` is the ledger behind them.
 *
 * `session_events` has the `agent_run_events` shape: `(session_id, seq)` unique, numbering
 * continues across turns and resumes, `turn` 0 for boot and lifecycle rows.
 */
import {
  ACTIVE_SESSION_STATUSES,
  type PrChecks,
  SESSION_ACTIONS,
  SESSION_KINDS,
  SESSION_STATUSES,
  type SessionDb,
  type SessionEventType,
  type SessionPolicy,
} from '@launch/shared/launch-sessions'
import { relations, sql } from 'drizzle-orm'
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { apps } from './apps'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

/** Mirrors `SESSION_KINDS`; `pgEnum` values are append-only. */
export const sessionKindEnum = pgEnum('session_kind', SESSION_KINDS)

/** Mirrors `SESSION_STATUSES`; append-only. */
export const sessionStatusEnum = pgEnum('session_status', SESSION_STATUSES)

/**
 * `'requested', 'booting', …` as SQL literals, derived from the shared list rather than typed out
 * (`sql.raw` because this renders into DDL — a partial index predicate cannot hold a parameter).
 */
const ACTIVE_STATUS_LITERALS = ACTIVE_SESSION_STATUSES.map(status => `'${status}'`).join(', ')

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    kind: sessionKindEnum('kind').notNull().default('session'),
    /** 12 base32 characters; the git branch is `session/<short_id>`. Global — see the header. */
    shortId: text('short_id').notNull(),
    /** 10 random characters: the preview host's second secret. Never in a response. */
    previewToken: text('preview_token').notNull(),
    title: text('title'),
    status: sessionStatusEnum('status').notNull().default('requested'),

    // ---- git
    /** What the session started from (a branch, tag or sha) and the commit it resolved to. */
    baseRef: text('base_ref'),
    baseSha: text('base_sha'),
    /** `session/<short_id>`. */
    branch: text('branch'),
    /** The last commit Launch pushed (after each turn's checkpoint). */
    headSha: text('head_sha'),

    // ---- sandbox
    /** The `SessionWorkflow` instance: the session id, or `<id>-rN` after a restart. */
    instanceId: text('instance_id'),
    /** The container id the platform hands outbound handlers (`ctx.containerId`). Unique. */
    sandboxId: text('sandbox_id'),
    /**
     * Set when an idle suspend KEPT the container (warm, `services/sessions/warm.ts`): a resume
     * inside `SESSION_WARM_KEEP_MINUTES` reuses it. Null once it is destroyed (the cool step, a
     * drain, the Durable Object's `onStop`) or reused.
     */
    containerKeptAt: timestamp('container_kept_at', { withTimezone: true }),

    // ---- database
    db: jsonb('db').$type<SessionDb>(),
    /** The session branch's connection string, sealed. Server-only. */
    dbUriSealed: text('db_uri_sealed'),

    // ---- GitHub token (the egress handler's; re-minted under 10 minutes left)
    githubTokenSealed: text('github_token_sealed'),
    githubTokenExpiresAt: timestamp('github_token_expires_at', { withTimezone: true }),

    // ---- Claude Code
    /** `system.init`'s `session_id` — what the next turn passes to `--resume`. */
    claudeSessionId: text('claude_session_id'),
    /** R2 key of the checkpointed transcript: `sessions/<id>/claude.jsonl`. */
    transcriptKey: text('transcript_key'),

    // ---- runtime
    /** The session image this session ran on (drain and rollouts, plan §1.8). */
    imageVersion: text('image_version'),
    /** `launch_settings.session_policy` with defaults, frozen at create. */
    policy: jsonb('policy').$type<SessionPolicy>().notNull(),

    // ---- turns and requests (routes write these; the Workflow consumes them)
    turnCount: integer('turn_count').notNull().default(0),
    /** The next user message, written by `POST /:id/turns`; the turn step turns it into `user.message`. */
    pendingMessage: text('pending_message'),
    requestedAction: text('requested_action', { enum: SESSION_ACTIONS }),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),

    // ---- metering (running totals; `ai_usage.session_id` is the ledger)
    tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
    tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
    cacheRead: bigint('cache_read', { mode: 'number' }).notNull().default(0),
    cacheWrite: bigint('cache_write', { mode: 'number' }).notNull().default(0),
    costMicrocents: bigint('cost_microcents', { mode: 'number' }).notNull().default(0),
    /** Every `POST /:id/budget` extension, summed; the cap is `policy.maxSessionUsd` plus this. */
    budgetExtraMicrocents: bigint('budget_extra_microcents', { mode: 'number' })
      .notNull()
      .default(0),
    /** Container wall time, added by the Sandbox DO's `onStop`. */
    containerSeconds: integer('container_seconds').notNull().default(0),

    // ---- pull request
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    prChecks: jsonb('pr_checks').$type<PrChecks>(),

    // ---- timing
    /** Why the session failed, for the page. Never a vendor body with a secret in it. */
    error: text('error'),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    unique('sessions_short_id_key').on(table.shortId),
    // The egress handlers' pre-tenant lookup. NULLs (no sandbox yet) are distinct.
    unique('sessions_sandbox_id_key').on(table.sandboxId),
    index('sessions_tenant_app_created_idx').on(
      table.tenantId,
      table.appId,
      table.createdAt.desc()
    ),
    // The concurrency check (`maxConcurrentPerApp`) — a count over the app's ACTIVE sessions.
    index('sessions_app_active_idx')
      .on(table.appId)
      .where(sql`${table.status} IN (${sql.raw(ACTIVE_STATUS_LITERALS)})`),
    tenantIsolation('sessions'),
  ]
)

export const sessionEvents = pgTable(
  'session_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    tenantId: tenantRef(tenants),
    /** Position within this session's stream, from 1. */
    seq: integer('seq').notNull(),
    /** The turn it belongs to; 0 for boot and lifecycle rows. */
    turn: integer('turn').notNull().default(0),
    type: text('type').$type<SessionEventType>().notNull(),
    data: jsonb('data').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex('session_events_session_seq_idx').on(table.sessionId, table.seq),
    index('session_events_tenant_session_idx').on(table.tenantId, table.sessionId),
    tenantIsolation('session_events'),
  ]
)

export const sessionsRelations = relations(sessions, ({ one }) => ({
  tenant: one(tenants, { fields: [sessions.tenantId], references: [tenants.id] }),
  app: one(apps, { fields: [sessions.appId], references: [apps.id] }),
  createdBy: one(users, { fields: [sessions.createdByUserId], references: [users.id] }),
}))

export const sessionEventsRelations = relations(sessionEvents, ({ one }) => ({
  session: one(sessions, { fields: [sessionEvents.sessionId], references: [sessions.id] }),
  tenant: one(tenants, { fields: [sessionEvents.tenantId], references: [tenants.id] }),
}))

export type SessionRow = typeof sessions.$inferSelect
export type NewSessionRow = typeof sessions.$inferInsert
export type SessionEventRow = typeof sessionEvents.$inferSelect
export type NewSessionEventRow = typeof sessionEvents.$inferInsert
