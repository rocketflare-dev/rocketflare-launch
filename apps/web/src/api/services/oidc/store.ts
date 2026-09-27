/**
 * The OIDC protocol's database reads and writes (spec/05) — the PRE-TENANT path. A relying party
 * calls `/oidc/token` with nothing but a `client_id` and a code: there is no session and no tenant
 * yet, so these lookups are by the globally unique `client_id` and `code_hash`, and **the tenant is
 * then taken from the row** — every later query in the flow filters by that `tenantId`. This file
 * is allow-listed in `tests/config/unscoped-allowlist.test.ts` for exactly that reason; nothing
 * else here may query without a tenant.
 *
 * Slice 1a seeds the two lookups the allow-list entry describes; slice 1b owns this file and
 * builds the rest of the store (code issue, replay revocation, grants) beside them.
 */
import { and, eq, isNull } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type OidcClientRow, type OidcCodeRow, oidcClients, oidcCodes } from '../../../db/schema'

/** The registered client for a public `client_id` (`lc_…`), disabled or not; null if unknown. */
export async function findClientByClientId(
  db: Database,
  clientId: string
): Promise<OidcClientRow | null> {
  const [row] = await db.select().from(oidcClients).where(eq(oidcClients.clientId, clientId))
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
