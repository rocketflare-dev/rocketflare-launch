/**
 * Codex's `auth.json` for a ChatGPT plan (§18.22-B) — the ONE secret a ChatGPT-plan credential is.
 * `codex login --device-auth` writes it (`login.ts` captures it), a turn's lease writes it into
 * `$CODEX_HOME` and reads it back (`credentials.ts`), and the egress's refresh capture rewrites its
 * tokens when Codex rotates them (`egress/openai-auth.ts`). Shape, from Codex 0.160's
 * `login/src/auth/storage.rs` (`AuthDotJson`) and `token_data.rs` (`TokenData`):
 *
 * ```json
 * { "auth_mode": "chatgpt", "OPENAI_API_KEY": null,
 *   "tokens": { "id_token": "<jwt>", "access_token": "<jwt>", "refresh_token": "…", "account_id": "…" },
 *   "last_refresh": "2026-10-03T07:00:00Z" }
 * ```
 *
 * Fields Codex adds later are kept (`passthrough`): Launch rewrites only the tokens and
 * `last_refresh`, and stores whatever else Codex wrote unchanged.
 *
 * The JWT claims are DECODED, never verified — and only for non-secret metadata (the plan, an
 * account fingerprint) and the access token's expiry. Nothing here trusts a claim for a decision
 * about who may do what.
 */
import { z } from 'zod'

export const codexAuthTokensSchema = z
  .object({
    id_token: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: z.string().nullable().optional(),
  })
  .passthrough()

export const codexAuthJsonSchema = z
  .object({
    auth_mode: z.string().nullable().optional(),
    OPENAI_API_KEY: z.string().nullable().optional(),
    tokens: codexAuthTokensSchema,
    last_refresh: z.string().nullable().optional(),
  })
  .passthrough()
export type CodexAuthJson = z.infer<typeof codexAuthJsonSchema>

/** `text` as a ChatGPT-plan `auth.json`, or null — never throws, never echoes what it read. */
export function parseCodexAuthJson(text: string | null | undefined): CodexAuthJson | null {
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = codexAuthJsonSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** A JWT's payload, decoded WITHOUT verification; null when it is not one. */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const json = new TextDecoder().decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0)))
    const claims = JSON.parse(json) as unknown
    return claims && typeof claims === 'object' && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** A JWT's `exp` as a Date, or null. */
export function jwtExpiry(jwt: string): Date | null {
  const exp = decodeJwtClaims(jwt)?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? new Date(exp * 1000) : null
}

/** When `last_refresh` says the tokens were minted (ms), or 0 when it says nothing usable. */
export function lastRefreshMs(auth: Pick<CodexAuthJson, 'last_refresh'>): number {
  const at = auth.last_refresh ? Date.parse(auth.last_refresh) : Number.NaN
  return Number.isFinite(at) ? at : 0
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The non-secret facts `agent_credentials.metadata` keeps for a ChatGPT plan: the plan type (as
 * Codex reads it, `https://api.openai.com/auth.chatgpt_plan_type`) and a FINGERPRINT of the account
 * id (never the id itself — it is the `ChatGPT-Account-ID` header Codex sends).
 */
export async function codexAuthMetadata(
  auth: CodexAuthJson
): Promise<Record<string, string | null>> {
  const claims = decodeJwtClaims(auth.tokens.id_token) ?? {}
  const authClaims = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>
  const plan =
    typeof authClaims.chatgpt_plan_type === 'string' ? authClaims.chatgpt_plan_type : null
  const accountId =
    auth.tokens.account_id ??
    (typeof authClaims.chatgpt_account_id === 'string' ? authClaims.chatgpt_account_id : null)
  return {
    plan,
    account: accountId ? (await sha256Hex(accountId)).slice(0, 12) : null,
  }
}

/** `auth` with the rotated tokens an `/oauth/token` refresh returned, stamped `now`. */
export function withRefreshedTokens(
  auth: CodexAuthJson,
  rotated: { id_token?: unknown; access_token?: unknown; refresh_token?: unknown },
  now: Date
): CodexAuthJson {
  const pick = (value: unknown, fallback: string) =>
    typeof value === 'string' && value ? value : fallback
  return {
    ...auth,
    tokens: {
      ...auth.tokens,
      id_token: pick(rotated.id_token, auth.tokens.id_token),
      access_token: pick(rotated.access_token, auth.tokens.access_token),
      refresh_token: pick(rotated.refresh_token, auth.tokens.refresh_token),
    },
    last_refresh: now.toISOString(),
  }
}

/** Did `a` and `b` carry the same tokens? (`last_refresh` alone is not a change worth a reseal.) */
export function sameTokens(a: CodexAuthJson, b: CodexAuthJson): boolean {
  return (
    a.tokens.id_token === b.tokens.id_token &&
    a.tokens.access_token === b.tokens.access_token &&
    a.tokens.refresh_token === b.tokens.refresh_token
  )
}
