/**
 * The issuer's ES256 signing keys (spec/05): one set for the whole deployment, published at
 * `/.well-known/jwks.json` to every app. `oidc_signing_keys` has no tenant.
 *
 * A key's life is `next → active → retiring → retired`:
 *
 * - **`next`** is published BEFORE it signs anything, so a relying party that refreshed its JWKS
 *   since the last rotation already holds the key the next token will name.
 * - **`active`** signs. At most one, enforced by a partial unique index; `ensureKeys` creates the
 *   first lazily (on the first JWKS or token request) and races safely — the loser's insert is a
 *   no-op on that index and it re-reads the winner.
 * - **`retiring`** is the old active key after `rotateKeys`: still published until `retire_after`
 *   = rotation + the longest token lifetime + a JWKS-cache margin, so every token it signed still
 *   verifies. Then it is `retired` and leaves the JWKS.
 *
 * The private JWK is SEALED at rest (`encryptToken`, `OAUTH_ENCRYPTION_KEY`). The isolate caches
 * only PLAIN JWK data — never a `CryptoKey`, never a promise shared across requests — and re-reads
 * which key is active at most every `ACTIVE_CACHE_MS`, so a rotation made by another isolate is
 * picked up within a minute; until then the old key signs, and it is still published.
 */
import type { OidcSigningKey } from '@launch/shared/launch-oidc'
import { and, asc, desc, eq, gt, inArray, lte, or } from 'drizzle-orm'
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  type KeyObject,
} from 'jose'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type OidcSigningKeyRow, oidcSigningKeys } from '../../../db/schema'
import { decryptToken, encryptToken } from '../../auth/oauth-encryption'
import { KEY_RETIRE_MARGIN_S, MAX_TOKEN_TTL_S, SIGNING_ALG } from './discovery'

/** How long an isolate trusts its idea of which key is active. */
const ACTIVE_CACHE_MS = 60_000

interface CachedKey {
  kid: string
  privateJwk: JWK
}

/** kid → the unsealed private JWK (plain data). Keys never change once written. */
const privateJwks = new Map<string, JWK>()
let activeCache: { kid: string; at: number } | null = null

/** Tests only: forget every cached key. */
export function resetKeyCache(): void {
  privateJwks.clear()
  activeCache = null
}

export interface SigningKey {
  kid: string
  key: CryptoKey | KeyObject | Uint8Array
}

/** The public facts of one key, for the admin list. */
export function toSigningKey(row: OidcSigningKeyRow, now = new Date()): OidcSigningKey {
  return {
    id: row.id,
    kid: row.kid,
    alg: row.alg,
    status: row.status,
    published: isPublished(row, now),
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    retireAfter: row.retireAfter,
  }
}

function isPublished(row: OidcSigningKeyRow, now: Date): boolean {
  if (row.status === 'next' || row.status === 'active') return true
  return row.status === 'retiring' && row.retireAfter !== null && row.retireAfter > now
}

/** A fresh ES256 pair: the public JWK (kid = its RFC 7638 thumbprint) and the sealed private JWK. */
async function generateKey(cfg: AppConfig) {
  const { publicKey, privateKey } = await generateKeyPair(SIGNING_ALG, { extractable: true })
  const pub = await exportJWK(publicKey)
  const kid = await calculateJwkThumbprint(pub)
  const priv = await exportJWK(privateKey)
  const publicJwk = { kty: pub.kty ?? 'EC', crv: pub.crv, x: pub.x, y: pub.y }
  const sealed = await encryptToken(cfg, JSON.stringify({ ...priv, kid }))
  if (!sealed) throw new Error('signing key could not be sealed')
  return { kid, publicJwk, privateJwkSealed: sealed }
}

async function insertKey(
  db: Database,
  cfg: AppConfig,
  status: 'next' | 'active',
  createdByUserId: string | null
): Promise<OidcSigningKeyRow | null> {
  const key = await generateKey(cfg)
  const [row] = await db
    .insert(oidcSigningKeys)
    .values({
      ...key,
      alg: SIGNING_ALG,
      status,
      activatedAt: status === 'active' ? new Date() : null,
      createdByUserId,
    })
    // `active` races on the one-active index: the loser inserts nothing and re-reads the winner.
    .onConflictDoNothing()
    .returning()
  return row ?? null
}

/**
 * Make sure there is an active key and a published next one; returns the active row. Idempotent,
 * and cheap once both exist (one indexed read).
 */
export async function ensureKeys(
  db: Database,
  cfg: AppConfig,
  createdByUserId: string | null = null
): Promise<OidcSigningKeyRow> {
  const live = await db
    .select()
    .from(oidcSigningKeys)
    .where(inArray(oidcSigningKeys.status, ['next', 'active']))
  let active = live.find(k => k.status === 'active') ?? null
  if (!active) {
    active = await insertKey(db, cfg, 'active', createdByUserId)
    if (!active) {
      const [winner] = await db
        .select()
        .from(oidcSigningKeys)
        .where(eq(oidcSigningKeys.status, 'active'))
      if (!winner) throw new Error('no active signing key after a concurrent create')
      active = winner
    }
  }
  if (!live.some(k => k.status === 'next')) await insertKey(db, cfg, 'next', createdByUserId)
  return active
}

async function unseal(cfg: AppConfig, row: OidcSigningKeyRow): Promise<JWK> {
  const cached = privateJwks.get(row.kid)
  if (cached) return cached
  const plain = await decryptToken(cfg, row.privateJwkSealed)
  if (!plain) throw new Error(`signing key ${row.kid} has no sealed material`)
  const jwk = JSON.parse(plain) as JWK
  privateJwks.set(row.kid, jwk)
  return jwk
}

/** The key to sign with now: the active one (created on first use). */
export async function signingKey(db: Database, cfg: AppConfig): Promise<SigningKey> {
  let cached: CachedKey | null = null
  if (activeCache && Date.now() - activeCache.at < ACTIVE_CACHE_MS) {
    const jwk = privateJwks.get(activeCache.kid)
    if (jwk) cached = { kid: activeCache.kid, privateJwk: jwk }
  }
  if (!cached) {
    const row = await ensureKeys(db, cfg)
    cached = { kid: row.kid, privateJwk: await unseal(cfg, row) }
    activeCache = { kid: row.kid, at: Date.now() }
  }
  return { kid: cached.kid, key: await importJWK(cached.privateJwk, SIGNING_ALG) }
}

/** Every key a verifier may meet right now: next, active, and retiring before `retire_after`. */
export async function publishedKeys(db: Database, now = new Date()): Promise<OidcSigningKeyRow[]> {
  return db
    .select()
    .from(oidcSigningKeys)
    .where(
      or(
        inArray(oidcSigningKeys.status, ['next', 'active']),
        and(eq(oidcSigningKeys.status, 'retiring'), gt(oidcSigningKeys.retireAfter, now))
      )
    )
    .orderBy(desc(oidcSigningKeys.createdAt))
}

/** `/.well-known/jwks.json` — public members only, and never a `d`. */
export async function jwks(db: Database, cfg: AppConfig) {
  await ensureKeys(db, cfg)
  const rows = await publishedKeys(db)
  return {
    keys: rows.map(row => ({
      kty: row.publicJwk.kty,
      crv: row.publicJwk.crv,
      x: row.publicJwk.x,
      y: row.publicJwk.y,
      kid: row.kid,
      alg: row.alg,
      use: 'sig',
    })),
  }
}

/** The public key for `kid` if it is published now — what the userinfo endpoint verifies with. */
export async function publishedVerificationKey(
  db: Database,
  kid: string
): Promise<CryptoKey | KeyObject | Uint8Array | null> {
  const row = (await publishedKeys(db)).find(k => k.kid === kid)
  if (!row) return null
  return importJWK({ ...row.publicJwk, alg: row.alg }, row.alg)
}

/** Every key, newest first, for the Identity page. */
export async function listKeys(db: Database): Promise<OidcSigningKeyRow[]> {
  return db.select().from(oidcSigningKeys).orderBy(desc(oidcSigningKeys.createdAt))
}

export interface RotationResult {
  active: OidcSigningKeyRow
  retiring: OidcSigningKeyRow | null
  next: OidcSigningKeyRow
}

/**
 * Rotate: the published `next` key becomes `active` (so relying parties already hold it), the old
 * active key becomes `retiring` until the longest token it signed has expired (plus the JWKS-cache
 * margin), expired retiring keys become `retired`, and a fresh `next` is published. One
 * transaction: the one-active index never sees two, and a crash leaves the old set intact.
 */
export async function rotateKeys(
  db: Database,
  cfg: AppConfig,
  userId: string | null,
  now = new Date()
): Promise<RotationResult> {
  await ensureKeys(db, cfg, userId)
  // Seal the replacement BEFORE the transaction: key generation is CPU work, not a lock holder.
  const fresh = await generateKey(cfg)
  const result = await db.transaction(async tx => {
    const [current] = await tx
      .select()
      .from(oidcSigningKeys)
      .where(eq(oidcSigningKeys.status, 'active'))
      .for('update')
    const [promote] = await tx
      .select()
      .from(oidcSigningKeys)
      .where(eq(oidcSigningKeys.status, 'next'))
      .orderBy(asc(oidcSigningKeys.createdAt))
      .limit(1)
      .for('update')
    if (!promote) throw new Error('no next signing key to promote')

    let retiring: OidcSigningKeyRow | null = null
    if (current) {
      const retireAfter = new Date(now.getTime() + (MAX_TOKEN_TTL_S + KEY_RETIRE_MARGIN_S) * 1000)
      ;[retiring = null] = await tx
        .update(oidcSigningKeys)
        .set({ status: 'retiring', retireAfter })
        .where(eq(oidcSigningKeys.id, current.id))
        .returning()
    }
    const [active] = await tx
      .update(oidcSigningKeys)
      .set({ status: 'active', activatedAt: now })
      .where(eq(oidcSigningKeys.id, promote.id))
      .returning()
    if (!active) throw new Error('promoting the next signing key failed')
    await tx
      .update(oidcSigningKeys)
      .set({ status: 'retired' })
      .where(and(eq(oidcSigningKeys.status, 'retiring'), lte(oidcSigningKeys.retireAfter, now)))
    const [next] = await tx
      .insert(oidcSigningKeys)
      .values({ ...fresh, alg: SIGNING_ALG, status: 'next', createdByUserId: userId })
      .returning()
    if (!next) throw new Error('publishing the next signing key failed')
    return { active, retiring, next }
  })
  activeCache = null
  return result
}
