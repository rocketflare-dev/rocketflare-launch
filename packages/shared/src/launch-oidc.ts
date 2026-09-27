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

// ---- Issuer administration (`/api/admin/oidc`, global admin) ---------------------------------

/** One signing key as the Identity page lists it — the public facts only, never key material. */
export const oidcSigningKeySchema = z.object({
  id: z.string().uuid(),
  kid: z.string(),
  alg: z.string(),
  status: oidcSigningKeyStatusSchema,
  /** In the JWKS right now: `next`, `active`, or `retiring` before its `retireAfter`. */
  published: z.boolean(),
  createdAt: z.coerce.date(),
  activatedAt: z.coerce.date().nullable(),
  retireAfter: z.coerce.date().nullable(),
})
export type OidcSigningKey = z.infer<typeof oidcSigningKeySchema>

/** `GET /api/admin/oidc/keys` — the issuer and its key set, newest first. */
export const oidcKeysResponseSchema = z.object({
  issuer: z.string(),
  discoveryUrl: z.string(),
  jwksUrl: z.string(),
  keys: z.array(oidcSigningKeySchema),
})
export type OidcKeysResponse = z.infer<typeof oidcKeysResponseSchema>

/** `POST /api/admin/oidc/keys/rotate` — the key that now signs, the one it replaced, the next. */
export const oidcRotateResponseSchema = z.object({
  active: oidcSigningKeySchema,
  retiring: oidcSigningKeySchema.nullable(),
  next: oidcSigningKeySchema,
})
export type OidcRotateResponse = z.infer<typeof oidcRotateResponseSchema>

// ---- App access (`/api/app-access`) --------------------------------------------------------

/** The app an access page or request is about — enough to name it, nothing more. */
export const appAccessAppSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  displayName: z.string(),
})
export type AppAccessApp = z.infer<typeof appAccessAppSchema>

/**
 * Where a signed-in person stands with one app: `allowed` (the policy admits them), `pending` (they
 * asked and nobody has decided), `rejected` (the last request was turned down — they may ask
 * again), or `none`.
 */
export const APP_ACCESS_STANDINGS = ['allowed', 'pending', 'rejected', 'none'] as const
export const appAccessStandingSchema = z.enum(APP_ACCESS_STANDINGS)
export type AppAccessStanding = z.infer<typeof appAccessStandingSchema>

/** `GET /api/app-access/request-context?clientId=` — what the request-access page shows. */
export const appAccessRequestContextQuerySchema = z.object({
  clientId: z.string().trim().min(1).max(200),
})
export const appAccessRequestContextSchema = z.object({
  app: appAccessAppSchema,
  standing: appAccessStandingSchema,
})
export type AppAccessRequestContext = z.infer<typeof appAccessRequestContextSchema>

/** `POST /api/app-access/requests` — ask an app's owners for access. */
export const createAppAccessRequestSchema = z.object({
  /** The OIDC `client_id` the authorize endpoint sent the person here with. */
  clientId: z.string().trim().min(1).max(200),
  message: z.string().trim().max(1000).optional(),
})
export type CreateAppAccessRequest = z.infer<typeof createAppAccessRequestSchema>

export const appAccessRequestSchema = z.object({
  id: z.string().uuid(),
  appId: z.string().uuid(),
  userId: z.string().uuid(),
  userEmail: z.string(),
  userName: z.string(),
  message: z.string().nullable(),
  status: appAccessRequestStatusSchema,
  decidedByUserId: z.string().uuid().nullable(),
  decidedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})
export type AppAccessRequest = z.infer<typeof appAccessRequestSchema>

/** `POST /requests` answers with the requester's standing afterwards and the open request. */
export const createAppAccessRequestResponseSchema = z.object({
  standing: appAccessStandingSchema,
  request: appAccessRequestSchema.nullable(),
})
export type CreateAppAccessRequestResponse = z.infer<typeof createAppAccessRequestResponseSchema>

/** `GET /:app/policy` — the app's sign-in policy and its OIDC client, for owners and admins. */
export const appAccessPolicySchema = z.object({
  app: appAccessAppSchema,
  /** False until the app has an OIDC client (registered from the app's detail page). */
  hasClient: z.boolean(),
  clientId: z.string().nullable(),
  accessPolicy: oidcAccessPolicySchema.nullable(),
})
export type AppAccessPolicy = z.infer<typeof appAccessPolicySchema>

export const updateAppAccessPolicySchema = z.object({ accessPolicy: oidcAccessPolicySchema })
export type UpdateAppAccessPolicy = z.infer<typeof updateAppAccessPolicySchema>

/** One grant: a group or a person, never both. */
export const appAccessGrantSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['group', 'user']),
  groupId: z.string().uuid().nullable(),
  userId: z.string().uuid().nullable(),
  /** The group's name, or the person's name. */
  name: z.string(),
  /** The person's email; null for a group. */
  email: z.string().nullable(),
  createdAt: z.coerce.date(),
})
export type AppAccessGrant = z.infer<typeof appAccessGrantSchema>

export const appAccessGrantListSchema = z.object({ items: z.array(appAccessGrantSchema) })
export type AppAccessGrantList = z.infer<typeof appAccessGrantListSchema>

/** Grant a group by id, or a person by id or by their email in the organisation. */
export const createAppAccessGrantSchema = z.union([
  z.object({ groupId: z.string().uuid() }).strict(),
  z.object({ userId: z.string().uuid() }).strict(),
  z.object({ email: z.string().trim().toLowerCase().email() }).strict(),
])
export type CreateAppAccessGrant = z.infer<typeof createAppAccessGrantSchema>

export const appAccessRequestListQuerySchema = z.object({
  status: appAccessRequestStatusSchema.optional(),
})
export type AppAccessRequestListQuery = z.infer<typeof appAccessRequestListQuerySchema>
export const appAccessRequestListSchema = z.object({ items: z.array(appAccessRequestSchema) })
export type AppAccessRequestList = z.infer<typeof appAccessRequestListSchema>

/** Approving adds a user grant for the requester; rejecting only closes the request. */
export const decideAppAccessRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
})
export type DecideAppAccessRequest = z.infer<typeof decideAppAccessRequestSchema>
