/**
 * `agent_credentials` — a person's connected AI account for one coding-agent runtime (§18.22): the
 * Claude token `claude setup-token` printed, or Codex's ChatGPT-plan `auth.json`. One per (tenant,
 * person, runtime); a reconnect replaces it.
 *
 * - **The secret is sealed** (`secret_sealed`, `encryptToken`) and read ONLY by
 *   `services/sessions/credentials/store.ts`, which never returns it to a route: the API speaks of a
 *   credential through `agentCredentialSchema` (`listPublic`), value-free.
 * - **`version` is the compare-and-set** a rotated secret is written back under (`resealIfVersion`:
 *   Codex's refresh token rotates, and two writers must not lose one's rotation).
 * - **The claim** (`claimed_by_session_id`, `claim_expires_at`) is how one `auth.json` is never used by
 *   two turns at once — a row claim, never a lock. `claimed_by_session_id` is a plain uuid with NO
 *   foreign key: `sessions.agent_credential_id` points the other way, and a stale claim is settled
 *   by its expiry (the sweep), not by a cascade.
 * - **Losing the membership loses the credential**, in the database: the composite FK to
 *   `tenant_users` cascades, the `group_members` pattern.
 */
import {
  AGENT_CREDENTIAL_KINDS,
  AGENT_CREDENTIAL_STATUSES,
  AGENT_RUNTIMES,
  type AgentCredentialMetadata,
} from '@launch/shared/launch-agents'
import { relations } from 'drizzle-orm'
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenantUsers } from './tenant-users'
import { tenants } from './tenants'
import { users } from './users'

export const agentCredentials = pgTable(
  'agent_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    runtime: text('runtime', { enum: AGENT_RUNTIMES }).notNull(),
    kind: text('kind', { enum: AGENT_CREDENTIAL_KINDS }).notNull(),
    /** The credential, sealed. Server-only: never selected into a response. */
    secretSealed: text('secret_sealed').notNull(),
    /** Bumped on every write of `secret_sealed`: the compare-and-set's expectation. */
    version: integer('version').notNull().default(1),
    status: text('status', { enum: AGENT_CREDENTIAL_STATUSES }).notNull().default('active'),
    /** Non-secret facts (`agentCredentialMetadataSchema`): plan, account, fingerprint. */
    metadata: jsonb('metadata').$type<AgentCredentialMetadata>().notNull().default({}),
    /** When the provider says it stops working (Claude's token: a year); null when it does not say. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    claimedBySessionId: uuid('claimed_by_session_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    ...timestamps(),
  },
  table => [
    unique('agent_credentials_user_runtime_key').on(table.tenantId, table.userId, table.runtime),
    foreignKey({
      columns: [table.tenantId, table.userId],
      foreignColumns: [tenantUsers.tenantId, tenantUsers.userId],
      name: 'agent_credentials_membership_fk',
    }).onDelete('cascade'),
    // The sweep's stale-claim scan.
    index('agent_credentials_claim_idx').on(table.tenantId, table.claimExpiresAt),
    tenantIsolation('agent_credentials'),
  ]
)

export const agentCredentialsRelations = relations(agentCredentials, ({ one }) => ({
  tenant: one(tenants, { fields: [agentCredentials.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [agentCredentials.userId], references: [users.id] }),
}))

export type AgentCredentialRow = typeof agentCredentials.$inferSelect
export type NewAgentCredentialRow = typeof agentCredentials.$inferInsert
