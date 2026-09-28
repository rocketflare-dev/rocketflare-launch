/**
 * Launch as the company's OIDC issuer (spec/05): the relying-party registrations, who may sign in
 * to each, the authorization codes and the signing keys. The P1 request-access queue
 * (`app_access_requests`) is gone: from P4 a request is an `app.access` approval (`approvals.ts`),
 * and the P4 migration moved the pending rows across.
 *
 * Decisions worth stating:
 *
 * - **Authorization codes live here, not in a Durable Object.** A code is single-use through
 *   `UPDATE … SET consumed_at = now() WHERE code_hash = $1 AND consumed_at IS NULL RETURNING`, and
 *   the row outlives its use on purpose: a replayed code must revoke the access token issued from
 *   the first redemption (`access_token_jti`, `revoked_at`), which needs the history.
 * - **Secrets and codes are stored as hashes** (`hashToken`, `utils/core/hash.ts`), never
 *   plaintext. `secret_hint` is the last four characters, so an admin can tell two secrets apart.
 * - **Redirect URIs are jsonb string arrays, not `text[]`**: postgres.js (`fetch_types: false`)
 *   returns a raw `text[]` as the literal `"{a,b}"` and Neon as an array (D35); jsonb agrees.
 * - **`oidc_signing_keys` has no tenant.** One issuer, one key set, published at
 *   `/.well-known/jwks.json` to every app — it is in `RLS_REVOKED_TABLES`. The private JWK is
 *   sealed with `OAUTH_ENCRYPTION_KEY`. At most one key is `active` (a partial unique index).
 * - `oidc_codes.session_id` is a plain uuid with no FK: signing out deletes the session, and the
 *   code's history must survive that.
 */
import {
  OIDC_ACCESS_POLICIES,
  OIDC_SIGNING_KEY_STATUSES,
  type OidcPublicJwk,
  type OidcRedirectUris,
} from '@launch/shared/launch-oidc'
import { relations, sql } from 'drizzle-orm'
import {
  check,
  index,
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
import { groups } from './groups'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

/** Mirrors `OIDC_ACCESS_POLICIES` in `@launch/shared/launch-oidc`; append-only. */
export const oidcAccessPolicyEnum = pgEnum('oidc_access_policy', OIDC_ACCESS_POLICIES)

/** Mirrors `OIDC_SIGNING_KEY_STATUSES`. */
export const oidcSigningKeyStatusEnum = pgEnum('oidc_signing_key_status', OIDC_SIGNING_KEY_STATUSES)

export const oidcClients = pgTable(
  'oidc_clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** One client per app. */
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    /** The public `client_id`, `lc_…`. */
    clientId: text('client_id').notNull(),
    secretHash: text('secret_hash').notNull(),
    /** The last four characters of the secret — enough to tell two apart, never enough to use. */
    secretHint: text('secret_hint').notNull(),
    secretRotatedAt: timestamp('secret_rotated_at', { withTimezone: true }),
    redirectUris: jsonb('redirect_uris').$type<OidcRedirectUris>().notNull().default([]),
    postLogoutRedirectUris: jsonb('post_logout_redirect_uris')
      .$type<OidcRedirectUris>()
      .notNull()
      .default([]),
    accessPolicy: oidcAccessPolicyEnum('access_policy').notNull().default('company'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  table => [
    unique('oidc_clients_app_id_key').on(table.appId),
    unique('oidc_clients_client_id_key').on(table.clientId),
    index('oidc_clients_tenant_idx').on(table.tenantId),
    tenantIsolation('oidc_clients'),
  ]
)

export const oidcClientGrants = pgTable(
  'oidc_client_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oidcClients.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    // A grant names a group OR a person, never both and never neither.
    check(
      'oidc_client_grants_one_grantee',
      sql`num_nonnulls(${table.groupId}, ${table.userId}) = 1`
    ),
    // NULLS NOT DISTINCT: without it `(client, NULL, user)` could be granted twice.
    unique('oidc_client_grants_grantee_key')
      .on(table.clientId, table.groupId, table.userId)
      .nullsNotDistinct(),
    index('oidc_client_grants_tenant_client_idx').on(table.tenantId, table.clientId),
    tenantIsolation('oidc_client_grants'),
  ]
)

export const oidcCodes = pgTable(
  'oidc_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    /** The `oidc_clients` row (not the public `client_id` string). */
    clientRowId: uuid('client_row_id')
      .notNull()
      .references(() => oidcClients.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The Launch session that authorised it. No FK — see the header. */
    sessionId: uuid('session_id'),
    redirectUri: text('redirect_uri').notNull(),
    /** PKCE S256 challenge. */
    codeChallenge: text('code_challenge').notNull(),
    nonce: text('nonce'),
    scope: text('scope').notNull(),
    /** When the user authenticated to Launch — the id_token's `auth_time`. */
    authTime: timestamp('auth_time', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** The `jti` of the access token this code was redeemed for, so a replay can revoke it. */
    accessTokenJti: text('access_token_jti'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    unique('oidc_codes_code_hash_key').on(table.codeHash),
    // userinfo's "was this token revoked by a replay?" lookup.
    index('oidc_codes_access_token_jti_idx').on(table.accessTokenJti),
    // The opportunistic prune of expired codes, per tenant.
    index('oidc_codes_tenant_expires_idx').on(table.tenantId, table.expiresAt),
    tenantIsolation('oidc_codes'),
  ]
)

export const oidcSigningKeys = pgTable(
  'oidc_signing_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kid: text('kid').notNull(),
    alg: text('alg').notNull().default('ES256'),
    publicJwk: jsonb('public_jwk').$type<OidcPublicJwk>().notNull(),
    /** The private JWK as JSON, sealed with `encryptToken` (OAUTH_ENCRYPTION_KEY). */
    privateJwkSealed: text('private_jwk_sealed').notNull(),
    status: oidcSigningKeyStatusEnum('status').notNull().default('next'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    /** A `retiring` key leaves the JWKS after this — the longest token it signed has expired. */
    retireAfter: timestamp('retire_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  table => [
    unique('oidc_signing_keys_kid_key').on(table.kid),
    // At most ONE signing key, by the database.
    uniqueIndex('oidc_signing_keys_one_active_idx')
      .on(table.status)
      .where(sql`${table.status} = 'active'`),
  ]
)

export const oidcClientsRelations = relations(oidcClients, ({ one }) => ({
  tenant: one(tenants, { fields: [oidcClients.tenantId], references: [tenants.id] }),
  app: one(apps, { fields: [oidcClients.appId], references: [apps.id] }),
}))

export const oidcClientGrantsRelations = relations(oidcClientGrants, ({ one }) => ({
  client: one(oidcClients, { fields: [oidcClientGrants.clientId], references: [oidcClients.id] }),
  group: one(groups, { fields: [oidcClientGrants.groupId], references: [groups.id] }),
  user: one(users, { fields: [oidcClientGrants.userId], references: [users.id] }),
}))

export const oidcCodesRelations = relations(oidcCodes, ({ one }) => ({
  client: one(oidcClients, { fields: [oidcCodes.clientRowId], references: [oidcClients.id] }),
  user: one(users, { fields: [oidcCodes.userId], references: [users.id] }),
}))

export type OidcClientRow = typeof oidcClients.$inferSelect
export type NewOidcClientRow = typeof oidcClients.$inferInsert
export type OidcClientGrantRow = typeof oidcClientGrants.$inferSelect
export type OidcCodeRow = typeof oidcCodes.$inferSelect
export type NewOidcCodeRow = typeof oidcCodes.$inferInsert
export type OidcSigningKeyRow = typeof oidcSigningKeys.$inferSelect
export type NewOidcSigningKeyRow = typeof oidcSigningKeys.$inferInsert
