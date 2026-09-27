/**
 * The OIDC protocol's database reads and writes (spec/05) — the PRE-TENANT path. A relying party
 * calls `/oidc/token` with nothing but a `client_id` and a code: there is no session and no tenant
 * yet, so these lookups are by the globally unique `client_id`, `code_hash` and access-token `jti`,
 * and **the tenant is then taken from the row** — every later query in the flow filters by that
 * `tenantId`. This file is allow-listed in `tests/config/unscoped-allowlist.test.ts` for exactly
 * that reason; nothing else here may query without a tenant, and nothing outside this file may.
 *
 * Codes are stored as `hashToken(code)` — a database read never yields a redeemable code — and the
 * row outlives its use: a replay must be able to revoke the access token the first redemption
 * issued (RFC 6749 §4.1.2), which needs `access_token_jti` and `revoked_at` after the fact.
 */
import { and, eq, isNull, lt } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  type NewOidcCodeRow,
  type OidcClientRow,
  type OidcCodeRow,
  oidcClients,
  oidcCodes,
  type User,
  userSessions,
  users,
} from '../../../db/schema'

/** The registered client for a public `client_id` (`lc_…`), disabled or not; null if unknown. */
export async function findClientByClientId(
  db: Database,
  clientId: string
): Promise<OidcClientRow | null> {
  const [row] = await db.select().from(oidcClients).where(eq(oidcClients.clientId, clientId))
  return row ?? null
}

/** A code's row by its hash, consumed or not; null if it was never issued (or has been pruned). */
export async function findCodeByHash(db: Database, codeHash: string): Promise<OidcCodeRow | null> {
  const [row] = await db.select().from(oidcCodes).where(eq(oidcCodes.codeHash, codeHash))
  return row ?? null
}

/**
 * Redeem a code ONCE: `consumed_at` is set only if it was unset, in one statement, so two
 * concurrent redemptions yield one row and one null. A null for a code that exists is a REPLAY —
 * the caller then revokes whatever the first redemption issued.
 */
export async function consumeCode(db: Database, codeHash: string): Promise<OidcCodeRow | null> {
  const [row] = await db
    .update(oidcCodes)
    .set({ consumedAt: new Date() })
    .where(and(eq(oidcCodes.codeHash, codeHash), isNull(oidcCodes.consumedAt)))
    .returning()
  return row ?? null
}

/** The code an access token was issued from, by the token's `jti` — userinfo's revocation check. */
export async function findCodeByAccessTokenJti(
  db: Database,
  jti: string
): Promise<OidcCodeRow | null> {
  const [row] = await db.select().from(oidcCodes).where(eq(oidcCodes.accessTokenJti, jti))
  return row ?? null
}

/** Store a freshly issued code (its hash — the plaintext only ever goes to the browser). */
export async function insertCode(db: Database, input: NewOidcCodeRow): Promise<OidcCodeRow> {
  const [row] = await db.insert(oidcCodes).values(input).returning()
  if (!row) throw new Error('oidc_codes insert returned no row')
  return row
}

/** Remember which access token a code was redeemed for, so a later replay can revoke it. */
export async function recordAccessTokenJti(
  db: Database,
  code: Pick<OidcCodeRow, 'id' | 'tenantId'>,
  jti: string
): Promise<void> {
  await db
    .update(oidcCodes)
    .set({ accessTokenJti: jti })
    .where(and(eq(oidcCodes.tenantId, code.tenantId), eq(oidcCodes.id, code.id)))
}

/**
 * A replayed code: mark it revoked. Userinfo refuses any access token whose `jti` points at a
 * revoked code — including one the first redemption records AFTER this runs, because the check
 * reads `revoked_at` from the same row. Returns true the first time only.
 */
export async function revokeCode(
  db: Database,
  code: Pick<OidcCodeRow, 'id' | 'tenantId'>
): Promise<boolean> {
  const rows = await db
    .update(oidcCodes)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(oidcCodes.tenantId, code.tenantId),
        eq(oidcCodes.id, code.id),
        isNull(oidcCodes.revokedAt)
      )
    )
    .returning({ id: oidcCodes.id })
  return rows.length > 0
}

/**
 * Drop one tenant's codes that expired before `before`. The caller keeps them well past their own
 * 60 s life — a replay must still find the row while the access token it could revoke is alive.
 */
export async function pruneExpiredCodes(
  db: Database,
  tenantId: string,
  before: Date
): Promise<void> {
  await db
    .delete(oidcCodes)
    .where(and(eq(oidcCodes.tenantId, tenantId), lt(oidcCodes.expiresAt, before)))
}

/** When the Launch session was created — the id_token's `auth_time`. Null if it is gone. */
export async function sessionCreatedAt(db: Database, sessionId: string): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: userSessions.createdAt })
    .from(userSessions)
    .where(eq(userSessions.id, sessionId))
  return row?.createdAt ?? null
}

/** One person by id. `users` is global (a person may belong to many tenants); membership is the
 * caller's separate, tenant-scoped check. */
export async function findUser(db: Database, userId: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, userId))
  return row ?? null
}
