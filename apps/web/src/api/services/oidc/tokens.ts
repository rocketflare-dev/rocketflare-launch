/**
 * What the token and userinfo endpoints sign, verify and compare (spec/05).
 *
 * - **id_token**: ES256, `typ: JWT`, `aud` = the client, carrying `sub` (the Launch user id — never
 *   the email), `auth_time` (when the Launch session began), the `nonce` the app sent, and the
 *   claims its scopes ask for: `email` + `email_verified: true` (Launch admits people only through
 *   verified sign-in methods), `name`, and `groups` (the user's group names in the CLIENT's tenant).
 * - **access token**: an RFC 9068 `at+jwt` with a `jti`, whose only audience is `/oidc/userinfo`.
 *   The `jti` is written onto the code row, which is how a replayed code revokes it.
 * - **client secrets and PKCE verifiers are compared in constant time** — both are hashed first, so
 *   the comparison is over equal-length hex and a miss costs the same as a hit.
 */
import type { GroupRef } from '@launch/shared/groups'
import { decodeProtectedHeader, type JWTPayload, jwtVerify, SignJWT } from 'jose'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { OidcClientRow, User } from '../../../db/schema'
import { hashToken, safeEqual } from '../../utils/core/hash'
import { randomToken, toBase64Url } from '../../utils/core/ids'
import {
  ACCESS_TOKEN_TTL_S,
  accessTokenAudience,
  ID_TOKEN_TTL_S,
  issuerOf,
  SIGNING_ALG,
} from './discovery'
import { publishedVerificationKey, signingKey } from './keys'

/** `openid email profile` → `Set{openid,email,profile}`. */
export function scopeSet(scope: string | null | undefined): Set<string> {
  return new Set((scope ?? '').split(' ').filter(Boolean))
}

/** The identity claims a scope set releases. Shared by the id_token and userinfo. */
export function identityClaims(
  user: Pick<User, 'id' | 'email' | 'name'>,
  groups: GroupRef[],
  scope: string
): Record<string, unknown> {
  const scopes = scopeSet(scope)
  const claims: Record<string, unknown> = {}
  if (scopes.has('email')) {
    claims.email = user.email
    claims.email_verified = true
  }
  if (scopes.has('profile')) claims.name = user.name
  if (scopes.has('groups')) claims.groups = groups.map(g => g.name)
  return claims
}

export interface IssuedTokens {
  idToken: string
  accessToken: string
  jti: string
  expiresIn: number
}

export async function issueTokens(
  db: Database,
  cfg: AppConfig,
  input: {
    client: Pick<OidcClientRow, 'clientId'>
    user: Pick<User, 'id' | 'email' | 'name'>
    groups: GroupRef[]
    scope: string
    nonce: string | null
    authTime: Date
  }
): Promise<IssuedTokens> {
  const { kid, key } = await signingKey(db, cfg)
  const iss = issuerOf(cfg)
  const now = Math.floor(Date.now() / 1000)
  const idToken = await new SignJWT({
    auth_time: Math.floor(input.authTime.getTime() / 1000),
    ...(input.nonce ? { nonce: input.nonce } : {}),
    ...identityClaims(input.user, input.groups, input.scope),
  })
    .setProtectedHeader({ alg: SIGNING_ALG, kid, typ: 'JWT' })
    .setIssuer(iss)
    .setSubject(input.user.id)
    .setAudience(input.client.clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + ID_TOKEN_TTL_S)
    .sign(key)
  const jti = randomToken(16)
  const accessToken = await new SignJWT({ scope: input.scope, client_id: input.client.clientId })
    .setProtectedHeader({ alg: SIGNING_ALG, kid, typ: 'at+jwt' })
    .setIssuer(iss)
    .setSubject(input.user.id)
    .setAudience(accessTokenAudience(cfg))
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_S)
    .setJti(jti)
    .sign(key)
  return { idToken, accessToken, jti, expiresIn: ACCESS_TOKEN_TTL_S }
}

export interface AccessTokenClaims extends JWTPayload {
  sub: string
  jti: string
  scope: string
  client_id: string
}

/**
 * Verify an access token against the keys published NOW (a retiring key still verifies; a retired
 * one does not). Null for anything wrong with it — the caller answers `invalid_token` either way,
 * so a probe learns nothing from the difference.
 */
export async function verifyAccessToken(
  db: Database,
  cfg: AppConfig,
  token: string
): Promise<AccessTokenClaims | null> {
  try {
    const { kid, alg } = decodeProtectedHeader(token)
    if (!kid || alg !== SIGNING_ALG) return null
    const key = await publishedVerificationKey(db, kid)
    if (!key) return null
    const { payload } = await jwtVerify(token, key, {
      issuer: issuerOf(cfg),
      audience: accessTokenAudience(cfg),
      typ: 'at+jwt',
      algorithms: [SIGNING_ALG],
      requiredClaims: ['sub', 'jti', 'exp', 'iat'],
    })
    if (typeof payload.scope !== 'string' || typeof payload.client_id !== 'string') return null
    return payload as AccessTokenClaims
  } catch {
    return null
  }
}

/** RFC 7636 §4.1: 43–128 characters of `[A-Za-z0-9-._~]`. */
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/
/** An S256 challenge is a base64url SHA-256: exactly 43 characters. */
export const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/

/** PKCE S256: `BASE64URL(SHA256(verifier)) == challenge`, compared in constant time. */
export async function verifyPkce(verifier: string | null, challenge: string): Promise<boolean> {
  if (!verifier || !VERIFIER_RE.test(verifier)) return false
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return safeEqual(toBase64Url(new Uint8Array(digest)), challenge)
}

/**
 * Check a presented client secret against the stored `secret_hash` (`hashToken`, SHA-256 hex).
 * The presented value is hashed even when there is no client, so an unknown `client_id` takes the
 * same time as a wrong secret.
 */
export async function clientSecretMatches(
  client: Pick<OidcClientRow, 'secretHash'> | null,
  presented: string
): Promise<boolean> {
  const hash = await hashToken(presented)
  const expected = client?.secretHash ?? '0'.repeat(64)
  return safeEqual(hash, expected) && client !== null
}
