/**
 * Launch as an OIDC issuer (spec/05): the closed sets and jsonb shapes behind `oidc_clients`,
 * `oidc_client_grants`, `oidc_signing_keys` and `app_access_requests`. The pg enums in
 * `apps/web/src/db/schema/oidc.ts` mirror these lists — append-only.
 *
 * Slice 1b owns this file and adds the admin and request-access contracts beside what is here.
 */
import { z } from 'zod'

/** `company`: every member of the tenant may sign in. `restricted`: only granted users/groups. */
export const OIDC_ACCESS_POLICIES = ['company', 'restricted'] as const
export const oidcAccessPolicySchema = z.enum(OIDC_ACCESS_POLICIES)
export type OidcAccessPolicy = z.infer<typeof oidcAccessPolicySchema>

/**
 * A signing key's life: published before use (`next`), signing (`active`, at most one), still
 * published so tokens it signed verify (`retiring`), then gone from the JWKS (`retired`).
 */
export const OIDC_SIGNING_KEY_STATUSES = ['next', 'active', 'retiring', 'retired'] as const
export const oidcSigningKeyStatusSchema = z.enum(OIDC_SIGNING_KEY_STATUSES)
export type OidcSigningKeyStatus = z.infer<typeof oidcSigningKeyStatusSchema>

export const APP_ACCESS_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const
export const appAccessRequestStatusSchema = z.enum(APP_ACCESS_REQUEST_STATUSES)
export type AppAccessRequestStatus = z.infer<typeof appAccessRequestStatusSchema>

/** Registered redirect / post-logout URIs. jsonb, not `text[]`, so both drivers agree (D35). */
export const oidcRedirectUrisSchema = z.array(z.string().url())
export type OidcRedirectUris = z.infer<typeof oidcRedirectUrisSchema>

/** The PUBLIC half of a signing key as published in the JWKS. Never the private members. */
export const oidcPublicJwkSchema = z
  .object({
    kty: z.string(),
    kid: z.string().optional(),
    alg: z.string().optional(),
    use: z.string().optional(),
    crv: z.string().optional(),
    x: z.string().optional(),
    y: z.string().optional(),
  })
  .passthrough()
export type OidcPublicJwk = z.infer<typeof oidcPublicJwkSchema>
