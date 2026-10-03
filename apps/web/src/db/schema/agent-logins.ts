/**
 * `agent_logins` — one relayed sign-in (§18.22): the provider's own CLI, unmodified, runs in a
 * throwaway sandbox (`login-<id>`) driven by `AgentLoginWorkflow`; the person finishes the
 * provider's flow in their browser, and the credential the CLI writes is sealed into
 * `agent_credentials`. Launch never runs the OAuth exchange itself.
 *
 * - **The row is the claim and the truth**, as for a session: routes write `status` only by
 *   compare-and-set (the code, a cancel) and wake the instance; the Workflow re-reads the row.
 * - **One active login per (tenant, person, runtime)**: the partial unique index
 *   `agent_logins_active_idx`, its predicate RENDERED from `AGENT_LOGIN_ACTIVE_STATUSES` (the
 *   `sessions_app_active_idx` pattern).
 * - **`sandbox_id` is unique**: the egress handlers find a login sandbox from the platform's
 *   `ctx.containerId` (`egress/sandbox-lookup.ts` `loginForSandbox`), pre-tenant, exactly as they
 *   find a session's.
 * - `verification_url` and `user_code` are what the person needs, not credentials; `code_sealed`
 *   (Claude's pasted code) IS sealed and lives only until the sandbox has it. All three are nulled
 *   by `cleanup`.
 */
import {
  AGENT_LOGIN_ACTIVE_STATUSES,
  AGENT_LOGIN_STATUSES,
  AGENT_RUNTIMES,
} from '@launch/shared/launch-agents'
import { relations, sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

const ACTIVE_LOGIN_LITERALS = AGENT_LOGIN_ACTIVE_STATUSES.map(status => `'${status}'`).join(', ')

export const agentLogins = pgTable(
  'agent_logins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    runtime: text('runtime', { enum: AGENT_RUNTIMES }).notNull(),
    status: text('status', { enum: AGENT_LOGIN_STATUSES }).notNull().default('starting'),
    /** The `AgentLoginWorkflow` instance: the login id. */
    instanceId: text('instance_id'),
    /** The login sandbox's container id (`ctx.containerId`). Unique; written before it starts. */
    sandboxId: text('sandbox_id'),
    verificationUrl: text('verification_url'),
    userCode: text('user_code'),
    /** The code the person pasted back, sealed, until the sandbox has it. Server-only. */
    codeSealed: text('code_sealed'),
    /** Why it failed, for the modal. Never CLI output with a secret in it. */
    error: text('error'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    unique('agent_logins_sandbox_id_key').on(table.sandboxId),
    uniqueIndex('agent_logins_active_idx')
      .on(table.tenantId, table.userId, table.runtime)
      .where(sql`${table.status} IN (${sql.raw(ACTIVE_LOGIN_LITERALS)})`),
    // The sweep: active logins past their expiry.
    index('agent_logins_tenant_expires_idx').on(table.tenantId, table.expiresAt),
    tenantIsolation('agent_logins'),
  ]
)

export const agentLoginsRelations = relations(agentLogins, ({ one }) => ({
  tenant: one(tenants, { fields: [agentLogins.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [agentLogins.userId], references: [users.id] }),
}))

export type AgentLoginRow = typeof agentLogins.$inferSelect
export type NewAgentLoginRow = typeof agentLogins.$inferInsert
