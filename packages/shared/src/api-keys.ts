/**
 * API key contracts (D12, D13). The plaintext appears exactly once, in `createApiKeyResponseSchema`;
 * every list/read uses `apiKeySchema`, which carries only the prefix.
 */
import { z } from 'zod'
import { paginatedResponse } from './pagination'

/** `*` = every scope — minted only by the CLI handoff (`GET /auth/cli`, D26). */
export const apiKeyScopeSchema = z.enum(['read', 'write', '*'])
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>

/**
 * What a key may REACH (`api_keys.scope`; distinct from `scopes`, the read/write list). `tenant`:
 * the tenant routes only. `admin`: also `/api/admin/*` and `/api/platform/*` while its creator is
 * still a platform administrator — minted only by `GET /auth/cli?scope=admin` (`launch login
 * --admin`), named `cli-admin:<host>`, expiring after `ADMIN_API_KEY_TTL_DAYS`.
 */
export const apiKeyAccessScopeSchema = z.enum(['tenant', 'admin'])
export type ApiKeyAccessScope = z.infer<typeof apiKeyAccessScopeSchema>

/** An admin key's lifetime: the CLI handoff sets `expiresAt` this far ahead. */
export const ADMIN_API_KEY_TTL_DAYS = 30

/** 403 `code` on `/api/admin/*` and `/api/platform/*` for a Bearer key that is not admin-scoped. */
export const ADMIN_KEY_REQUIRED_CODE = 'admin_key_required'

export const apiKeySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(apiKeyScopeSchema),
  /** Additive: a server before admin keys omits it, which means `tenant`. */
  scope: apiKeyAccessScopeSchema.default('tenant'),
  createdByUserId: z.string().uuid(),
  lastUsedAt: z.coerce.date().nullable(),
  expiresAt: z.coerce.date().nullable(),
  revokedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})
export type ApiKey = z.infer<typeof apiKeySchema>

export const createApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(apiKeyScopeSchema).min(1).default(['read', 'write']),
  /** Omit for a non-expiring key. */
  expiresAt: z.coerce.date().nullable().optional(),
})
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>

export const createApiKeyResponseSchema = apiKeySchema.extend({
  /** The full plaintext key — shown once, never retrievable again. */
  key: z.string(),
})
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>

/** `GET /api/keys` — paginated like every list (D13). */
export const apiKeysListResponseSchema = paginatedResponse(apiKeySchema)
export type ApiKeysListResponse = z.infer<typeof apiKeysListResponseSchema>
