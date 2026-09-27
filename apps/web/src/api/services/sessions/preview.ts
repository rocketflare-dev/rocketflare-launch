/**
 * Preview grants and cookies (Launch P3, plan §1.6) — the two signed tokens that gate a session's
 * live preview. WebCrypto only.
 *
 * - **The key** is derived, never stored: HKDF-SHA-256 over `OAUTH_ENCRYPTION_KEY` with info
 *   `launch-preview`, as an HMAC-SHA-256 key. Rotating `OAUTH_ENCRYPTION_KEY` invalidates every
 *   grant and cookie, which is the right failure: a person re-opens the preview.
 * - **A grant** is minted by `POST /api/sessions/:id/preview-grant` after the access check, lives
 *   60 s, and is exchanged ONCE by the iframe at `https://<preview host>/__launch/grant?g=…` for
 *   the cookie. It names the session, the user and the exact preview host, so a grant replayed on
 *   another session's host (or another port of the same session) is refused.
 * - **A cookie** (`__Host-launch-preview`, host-only) carries the same three facts and lives
 *   `PREVIEW_COOKIE_TTL_S`; the gateway verifies it on every request.
 *
 * Both are `base64url(json) "." base64url(hmac)`, with a `k` (kind) field inside the signed JSON,
 * so a cookie can never be presented as a grant or the other way round. Verification is
 * constant-time (`crypto.subtle.verify`) and a malformed token is simply `null`.
 */
import type { AppConfig } from '../../../config'
import { requireEncryptionKey } from '../../auth/oauth-encryption'

/** Where the iframe exchanges its grant on the preview host. Namespaced so it never shadows an app route. */
export const PREVIEW_GRANT_PATH = '/__launch/grant'
/** The container port the preview iframe shows: the app's Vite dev UI (`:3000` is the SDK's, S7). */
export const PREVIEW_UI_PORT = 5173

/** How long a grant may wait between the route minting it and the iframe exchanging it. */
export const PREVIEW_GRANT_TTL_S = 60
/** The preview cookie's life — a session's maximum length (`maxSessionHours` default). */
export const PREVIEW_COOKIE_TTL_S = 8 * 60 * 60

export type PreviewTokenKind = 'grant' | 'cookie'

/** What a verified grant or cookie says. */
export interface PreviewClaims {
  /** The session id. */
  sid: string
  /** The user it was minted for. */
  uid: string
  /** The preview host (lower-case, with its port when it has one) it is valid on. */
  host: string
  /** Expiry, seconds since the epoch. */
  exp: number
}

interface SignedClaims extends PreviewClaims {
  k: 'g' | 'c'
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    return Uint8Array.from(binary, ch => ch.charCodeAt(0))
  } catch {
    return null
  }
}

/** One derived key per root key per isolate: HKDF is cheap, but not free on every request. */
const keyCache = new Map<string, Promise<CryptoKey>>()

/** The HMAC key, HKDF-derived from `OAUTH_ENCRYPTION_KEY` (info `launch-preview`). */
export function previewKey(cfg: AppConfig): Promise<CryptoKey> {
  const root = requireEncryptionKey(cfg)
  let key = keyCache.get(root)
  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.importKey('raw', encoder.encode(root), 'HKDF', false, [
        'deriveKey',
      ])
      return crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new Uint8Array(0),
          info: encoder.encode('launch-preview'),
        },
        material,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign', 'verify']
      )
    })()
    keyCache.set(root, key)
  }
  return key
}

/** A host as the gateway compares it: lower-case, trimmed. */
export function normalizePreviewHost(host: string): string {
  return host.trim().toLowerCase()
}

async function sign(cfg: AppConfig, claims: SignedClaims): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)))
  const key = await previewKey(cfg)
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)))
  return `${payload}.${toBase64Url(mac)}`
}

async function verify(
  cfg: AppConfig,
  token: string | null | undefined,
  kind: 'g' | 'c',
  expect: { host: string; now: Date }
): Promise<PreviewClaims | null> {
  if (!token || token.length > 2048) return null
  const [payload, mac, extra] = token.split('.')
  if (!payload || !mac || extra !== undefined) return null
  const macBytes = fromBase64Url(mac)
  const payloadBytes = fromBase64Url(payload)
  if (!macBytes || !payloadBytes) return null
  const key = await previewKey(cfg)
  const ok = await crypto.subtle.verify('HMAC', key, macBytes, encoder.encode(payload))
  if (!ok) return null
  let claims: Partial<SignedClaims>
  try {
    claims = JSON.parse(decoder.decode(payloadBytes)) as Partial<SignedClaims>
  } catch {
    return null
  }
  if (
    claims.k !== kind ||
    typeof claims.sid !== 'string' ||
    typeof claims.uid !== 'string' ||
    typeof claims.host !== 'string' ||
    typeof claims.exp !== 'number'
  ) {
    return null
  }
  if (claims.host !== normalizePreviewHost(expect.host)) return null
  if (claims.exp <= Math.floor(expect.now.getTime() / 1000)) return null
  return { sid: claims.sid, uid: claims.uid, host: claims.host, exp: claims.exp }
}

export interface MintInput {
  sessionId: string
  userId: string
  /** The preview host the token is for (`5173-<short>-<token>.<domain>`). */
  host: string
  now?: Date
}

async function mint(cfg: AppConfig, kind: 'g' | 'c', ttlS: number, input: MintInput) {
  const now = input.now ?? new Date()
  const exp = Math.floor(now.getTime() / 1000) + ttlS
  const token = await sign(cfg, {
    k: kind,
    sid: input.sessionId,
    uid: input.userId,
    host: normalizePreviewHost(input.host),
    exp,
  })
  return { token, expiresAt: new Date(exp * 1000) }
}

/** A 60 s grant for one user on one session's one preview host. */
export function mintGrant(cfg: AppConfig, input: MintInput) {
  return mint(cfg, 'g', PREVIEW_GRANT_TTL_S, input)
}

/** The cookie a verified grant is exchanged for. */
export function mintCookie(cfg: AppConfig, input: MintInput) {
  return mint(cfg, 'c', PREVIEW_COOKIE_TTL_S, input)
}

/** The grant's claims when it is genuine, unexpired and for `host`; otherwise null. */
export function verifyGrant(
  cfg: AppConfig,
  token: string | null | undefined,
  expect: { host: string; now?: Date }
): Promise<PreviewClaims | null> {
  return verify(cfg, token, 'g', { host: expect.host, now: expect.now ?? new Date() })
}

/** The cookie's claims when it is genuine, unexpired and for `host`; otherwise null. */
export function verifyCookie(
  cfg: AppConfig,
  token: string | null | undefined,
  expect: { host: string; now?: Date }
): Promise<PreviewClaims | null> {
  return verify(cfg, token, 'c', { host: expect.host, now: expect.now ?? new Date() })
}
