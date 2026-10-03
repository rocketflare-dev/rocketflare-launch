/**
 * `ai_usage` — one row per model generation (D18): who spent what, on which provider/model, for
 * which feature. Written by `services/ai/usage.ts` from the provider's usage tap (chat route,
 * agent runs, connection tests). Append-only, no `updated_at`. `costMicrocents` stays null until an
 * app supplies a pricing table — cheap to record now, impossible to backfill later.
 */
import type { AiProvider } from '@launch/shared/ai/config'
import { AI_USAGE_BILLINGS } from '@launch/shared/ai/usage'
import { relations } from 'drizzle-orm'
import { bigint, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenantRef } from './_helpers'
import { agentRuns } from './agent-runs'
import { tenantIsolation } from './rls'
import { sessions } from './sessions'
import { tenants } from './tenants'
import { users } from './users'

export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The run this generation was billed to, when it was an agent run. Nullable and `set null`: a
     * chat turn and a connection test have no run, and a deleted run must not take the ledger with
     * it. **Recorded now because it cannot be backfilled** — the same argument `costMicrocents`
     * makes. Without it "what did this run cost?" is unanswerable for every row already written.
     */
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    /**
     * Launch P3: the coding session a model call was billed to — written by the model proxy
     * (`services/sessions/egress/anthropic.ts`), one row per upstream call. `set null` for the same
     * reason as `agent_run_id`; the session's running totals are the sum of these.
     */
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    /** Prompt key or feature name: `chat`, `summarize-text`, `connection-test`. */
    feature: text('feature').notNull(),
    provider: text('provider').$type<AiProvider>().notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costMicrocents: bigint('cost_microcents', { mode: 'number' }),
    /**
     * §18.22: `subscription` — a person's own plan paid (a coding session on a connected account):
     * tokens recorded, `cost_microcents` null and never estimated (`summarizeUsage`).
     */
    billing: text('billing', { enum: AI_USAGE_BILLINGS }).notNull().default('metered'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('ai_usage_tenant_at_idx').on(table.tenantId, table.at.desc()),
    index('ai_usage_session_idx').on(table.sessionId),
    tenantIsolation('ai_usage'),
  ]
)

export const aiUsageRelations = relations(aiUsage, ({ one }) => ({
  tenant: one(tenants, { fields: [aiUsage.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [aiUsage.userId], references: [users.id] }),
  agentRun: one(agentRuns, { fields: [aiUsage.agentRunId], references: [agentRuns.id] }),
  session: one(sessions, { fields: [aiUsage.sessionId], references: [sessions.id] }),
}))

export type AiUsageRow = typeof aiUsage.$inferSelect
export type NewAiUsageRow = typeof aiUsage.$inferInsert
