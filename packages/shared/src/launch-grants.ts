/**
 * Launch P5 contracts: shared config and grants (spec/09, `docs/plans/p5-grants.md`). A SHARED
 * RESOURCE is a named bundle of config items (M365: two vars and a secret) owned by a group, with
 * sealed values per environment; an app HOLDS it through a grant (one app × resource ×
 * environment, approved as a `grant.request`), and `GRANT_PUSH` writes the values into the app's
 * Worker as secrets. "Catalogue" already means the apps list, so the UI calls this "shared config"
 * (`/shared-config`) and the API `/api/shared-resources`.
 *
 * Everything the API, the UI and the CLI say about it is here:
 *
 * - the closed sets the text columns are typed by (`SHARED_RESOURCE_VALUE_STATUSES`,
 *   `GRANT_STATUSES`, `GRANT_PUSH_REASONS`, `GRANT_PUSH_STATUSES`, `GRANT_PUSH_TARGET_STATUSES`)
 *   and the two partial-index predicates rendered from them (`LIVE_GRANT_STATUSES`,
 *   `ACTIVE_GRANT_PUSH_STATUSES`);
 * - `sharedResourceItemSchema` (the `shared_resources.items` jsonb) and
 *   `sharedResourcePoliciesSchema` (`policies`, full `ApprovalPolicy` values per environment);
 * - the bodies of `/api/shared-resources` (create, patch, values) and the list/detail answers —
 *   **values are write-only**: no schema here carries a secret, and a var's value only travels in
 *   `vars`, which the server fills for the resource's owners and admins alone (plan §1.3);
 * - an app's config (`appConfigSchema`: declared, matched, needs, grants per environment), the
 *   request/revoke bodies of `/api/apps/:id/grants`, and a push with its targets;
 * - the Workflow params, the realtime entities, the notification types and the error codes.
 *
 * Slice 5a owns this file; 5b–5f import from it and never edit it — a slice that needs a change
 * here stops and reports.
 */
import { z } from 'zod'
import { approvalPolicySchema, GRANT_ITEM_KINDS, grantItemKindSchema } from './launch-approvals'
import { appEnvironmentNameSchema } from './launch-apps'

// ---- closed sets -------------------------------------------------------------------------------

/** `var` (not secret, but still pushed as a Worker secret — plan §1.4) or `secret`. */
export const SHARED_RESOURCE_ITEM_KINDS = GRANT_ITEM_KINDS
export const sharedResourceItemKindSchema = grantItemKindSchema
export type SharedResourceItemKind = z.infer<typeof sharedResourceItemKindSchema>

/**
 * `shared_resource_values.status`. One `active` version per resource × environment (a partial
 * unique index); a rotation leaves the previous one `retiring` until every holder has the new
 * version, then `retired` (plan §1.12).
 */
export const SHARED_RESOURCE_VALUE_STATUSES = ['active', 'retiring', 'retired'] as const
export const sharedResourceValueStatusSchema = z.enum(SHARED_RESOURCE_VALUE_STATUSES)
export type SharedResourceValueStatus = z.infer<typeof sharedResourceValueStatusSchema>

/**
 * `app_grants.status`:
 *
 *   requested → active → revoking → revoked
 *       ↘ rejected (the approval was rejected or cancelled) / expired (the approval or the grant
 *         lapsed — the sweep's `expire` push)
 */
export const GRANT_STATUSES = [
  'requested',
  'active',
  'revoking',
  'revoked',
  'rejected',
  'expired',
] as const
export const grantStatusSchema = z.enum(GRANT_STATUSES)
export type GrantStatus = z.infer<typeof grantStatusSchema>

/**
 * A LIVE grant — at most one per app × resource × environment (`app_grants_live_idx`, whose
 * predicate is rendered from this list). Asking again while one is live finds it.
 */
export const LIVE_GRANT_STATUSES = [
  'requested',
  'active',
  'revoking',
] as const satisfies readonly GrantStatus[]

export function isLiveGrant(status: GrantStatus): boolean {
  return (LIVE_GRANT_STATUSES as readonly string[]).includes(status)
}

/** Why a push runs (plan §1.10). `repair` re-pushes after an activate undid a newer push (§1.6). */
export const GRANT_PUSH_REASONS = ['grant', 'rotate', 'revoke', 'expire', 'repair'] as const
export const grantPushReasonSchema = z.enum(GRANT_PUSH_REASONS)
export type GrantPushReason = z.infer<typeof grantPushReasonSchema>

/** `grant_pushes.status`. `partial` = some targets failed; a retry is offered. */
export const GRANT_PUSH_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed'] as const
export const grantPushStatusSchema = z.enum(GRANT_PUSH_STATUSES)
export type GrantPushStatus = z.infer<typeof grantPushStatusSchema>

/**
 * One running push per resource × environment (`grant_pushes_active_idx`, rendered from this
 * list): a second rotation is 409 `push_in_progress`.
 */
export const ACTIVE_GRANT_PUSH_STATUSES = [
  'queued',
  'running',
] as const satisfies readonly GrantPushStatus[]

export function isActiveGrantPush(status: GrantPushStatus): boolean {
  return (ACTIVE_GRANT_PUSH_STATUSES as readonly string[]).includes(status)
}

/** `grant_push_targets.status`. `skipped` = the grant already held a newer version, or went away. */
export const GRANT_PUSH_TARGET_STATUSES = ['pending', 'succeeded', 'failed', 'skipped'] as const
export const grantPushTargetStatusSchema = z.enum(GRANT_PUSH_TARGET_STATUSES)
export type GrantPushTargetStatus = z.infer<typeof grantPushTargetStatusSchema>

/**
 * Where a push writes (plan §1.11, the `GRANT_BACKEND` var): `cloudflare` — the app Worker's
 * secrets; `local` — record the names and call no vendor (`APP_ENV=development` only).
 */
export const GRANT_BACKENDS = ['cloudflare', 'local'] as const
export const grantBackendSchema = z.enum(GRANT_BACKENDS)
export type GrantBackend = z.infer<typeof grantBackendSchema>

// ---- limits ------------------------------------------------------------------------------------

/** A shared resource's slug: lower-case, starts with a letter (`m365`, `openai-company`). */
export const SHARED_RESOURCE_SLUG_RE = /^[a-z][a-z0-9-]{0,39}$/
/** A config key as the kit's plugins declare it: an env-var name (`M365_CLIENT_SECRET`). */
export const CONFIG_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/
export const SHARED_RESOURCE_MAX_ITEMS = 50
/** Cloudflare caps a Worker secret at 5 KiB. */
export const SHARED_RESOURCE_VALUE_MAX = 5 * 1024
export const SHARED_RESOURCE_DESCRIPTION_MAX = 2000
export const GRANT_REASON_MAX = 1000
/** Targets one `push#N` step handles (plan §1.10). */
export const GRANT_PUSH_BATCH = 10
/** The sweep reminds an app's owners this many days before a grant expires (plan §1.13). */
export const GRANT_EXPIRY_REMINDER_DAYS = 7
/** The plugin id detection files the kit's own optional secrets under (plan §1.14). */
export const KIT_CONFIG_PLUGIN_ID = 'kit'

export const sharedResourceSlugSchema = z
  .string()
  .regex(SHARED_RESOURCE_SLUG_RE, 'A slug is lower-case letters, digits and "-", at most 40')
export const configKeySchema = z
  .string()
  .regex(CONFIG_KEY_RE, 'A key is an env-var name: upper-case letters, digits and "_"')

// ---- the resource ------------------------------------------------------------------------------

/** One item of a bundle — the `shared_resources.items` jsonb, one entry per key. */
export const sharedResourceItemSchema = z.object({
  key: configKeySchema,
  kind: sharedResourceItemKindSchema,
  description: z.string().trim().max(500).optional(),
  /** A secret older than this is due for rotation: the sweep reminds the owners (plan §1.13). */
  rotationDays: z.number().int().min(1).max(3650).optional(),
})
export type SharedResourceItem = z.infer<typeof sharedResourceItemSchema>

/** A resource's items: 1–50, keys unique. */
export const sharedResourceItemsSchema = z
  .array(sharedResourceItemSchema)
  .min(1)
  .max(SHARED_RESOURCE_MAX_ITEMS)
  .superRefine((items, ctx) => {
    const seen = new Set<string>()
    items.forEach((item, i) => {
      if (seen.has(item.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'key'],
          message: `${item.key} appears twice`,
        })
      }
      seen.add(item.key)
    })
  })

/**
 * The `shared_resources.policies` jsonb: a full `ApprovalPolicy` per environment, set by admins
 * only (the P4 rule). A missing environment falls back to `resolvePolicy('grant.request')` — any
 * `approval_policies` row, then the code default (plan §1.8–§1.9).
 */
export const sharedResourcePoliciesSchema = z.object({
  staging: approvalPolicySchema.optional(),
  production: approvalPolicySchema.optional(),
})
export type SharedResourcePolicies = z.infer<typeof sharedResourcePoliciesSchema>

const personRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string(),
})
export type GrantPersonRef = z.infer<typeof personRefSchema>

const appRefSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  displayName: z.string(),
})

const resourceRefSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  displayName: z.string(),
})

/**
 * One environment's values as anybody may see them: set or not, which version, when, by whom —
 * never a secret. `vars` carries the VAR items' values and is present only for the resource's
 * owners and admins (plan §1.3); absent for everyone else.
 */
export const sharedResourceEnvironmentSchema = z.object({
  environment: appEnvironmentNameSchema,
  /** Null: no values have been set for this environment. */
  version: z.number().int().positive().nullable(),
  versionId: z.string().uuid().nullable(),
  setAt: z.coerce.date().nullable(),
  setBy: personRefSchema.nullable(),
  /** The keys the active version carries (an item added later is missing until the next set). */
  keysSet: z.array(z.string()),
  /** Earlier versions still being replaced by a partial rotation. */
  retiringVersions: z.array(z.number().int().positive()).default([]),
  /** Secrets older than their `rotationDays`. */
  rotationDue: z.array(z.string()).default([]),
  /** How many apps hold it in this environment (a count everyone may see). */
  holderCount: z.number().int().nonnegative(),
  vars: z.record(z.string(), z.string()).optional(),
})
export type SharedResourceEnvironment = z.infer<typeof sharedResourceEnvironmentSchema>

/** A list row of `GET /api/shared-resources` (members see every resource: they need it to ask). */
export const sharedResourceSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  ownerGroup: z.object({ id: z.string().uuid(), name: z.string() }),
  items: z.array(sharedResourceItemSchema),
  environments: z.array(sharedResourceEnvironmentSchema),
  archivedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type SharedResource = z.infer<typeof sharedResourceSchema>

export const sharedResourceListQuerySchema = z.object({
  /** Archived resources are hidden unless asked for. */
  archived: z
    .enum(['true', 'false'])
    .optional()
    .transform(v => v === 'true'),
})
export type SharedResourceListQuery = z.infer<typeof sharedResourceListQuerySchema>

export const sharedResourceListResponseSchema = z.object({ items: z.array(sharedResourceSchema) })
export type SharedResourceListResponse = z.infer<typeof sharedResourceListResponseSchema>

/** One app holding the resource — shown to the resource's owners and admins only. */
export const sharedResourceHolderSchema = z.object({
  grantId: z.string().uuid(),
  app: appRefSchema,
  environment: appEnvironmentNameSchema,
  status: grantStatusSchema,
  /** The version the app's Worker holds; null until the first push lands. */
  pushedVersion: z.number().int().positive().nullable(),
  pushedAt: z.coerce.date().nullable(),
  pushError: z.string().nullable(),
  expiresAt: z.coerce.date().nullable(),
})
export type SharedResourceHolder = z.infer<typeof sharedResourceHolderSchema>

/** A push as a list row (the resource page's history, and the running one's progress). */
export const grantPushSummarySchema = z.object({
  id: z.string().uuid(),
  resourceId: z.string().uuid(),
  environment: appEnvironmentNameSchema,
  reason: grantPushReasonSchema,
  /** Null: every live grant of the environment; otherwise the one grant. */
  grantId: z.string().uuid().nullable(),
  versionId: z.string().uuid().nullable(),
  version: z.number().int().positive().nullable(),
  approvalId: z.string().uuid().nullable(),
  status: grantPushStatusSchema,
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  startedByUserId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable(),
})
export type GrantPushSummary = z.infer<typeof grantPushSummarySchema>

/**
 * `GET /api/shared-resources/:id`. `holders` is present for the owners and admins only;
 * `canManage` = may edit the owner group and the policies (admins); `canSetValues` = may set
 * values and edit the description and items (the owner group's members and admins).
 */
export const sharedResourceDetailSchema = sharedResourceSchema.extend({
  policies: sharedResourcePoliciesSchema,
  createdByUserId: z.string().uuid().nullable(),
  holders: z.array(sharedResourceHolderSchema).optional(),
  /** The push running now per environment, if any. */
  activePushes: z.array(grantPushSummarySchema).default([]),
  canManage: z.boolean(),
  canSetValues: z.boolean(),
})
export type SharedResourceDetail = z.infer<typeof sharedResourceDetailSchema>

// ---- resource requests -------------------------------------------------------------------------

/** `POST /api/shared-resources` (admins). */
export const createSharedResourceSchema = z.object({
  slug: sharedResourceSlugSchema,
  displayName: z.string().trim().min(1).max(100),
  description: z.string().trim().max(SHARED_RESOURCE_DESCRIPTION_MAX).optional(),
  ownerGroupId: z.string().uuid(),
  items: sharedResourceItemsSchema,
  policies: sharedResourcePoliciesSchema.default({}),
})
export type CreateSharedResourceRequest = z.infer<typeof createSharedResourceSchema>

/**
 * `PATCH /api/shared-resources/:id`. Owners edit `displayName`, `description` and `items`; only
 * admins edit `ownerGroupId` and `policies` (403 `not_resource_admin` otherwise).
 */
export const patchSharedResourceSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(SHARED_RESOURCE_DESCRIPTION_MAX).nullable().optional(),
    items: sharedResourceItemsSchema.optional(),
    ownerGroupId: z.string().uuid().optional(),
    policies: sharedResourcePoliciesSchema.optional(),
  })
  .refine(body => Object.values(body).some(v => v !== undefined), {
    message: 'Nothing to change',
  })
export type PatchSharedResourceRequest = z.infer<typeof patchSharedResourceSchema>

/**
 * `PUT /api/shared-resources/:id/values/:env` (owners and admins). One string per item key; a
 * BLANK (or missing) key keeps the previous version's value — the server decrypts and merges
 * (plan §1.2). An unknown key is 400 `unknown_item_key`.
 */
export const putSharedResourceValuesSchema = z.object({
  values: z.record(configKeySchema, z.string().max(SHARED_RESOURCE_VALUE_MAX)),
})
export type PutSharedResourceValuesRequest = z.infer<typeof putSharedResourceValuesSchema>

/**
 * The answer to a values `PUT`: the new version, and the `rotate` push it started when the
 * environment has holders (202), or `pushId: null` when nobody holds it yet (200).
 */
export const putSharedResourceValuesResponseSchema = z.object({
  versionId: z.string().uuid(),
  version: z.number().int().positive(),
  pushId: z.string().uuid().nullable(),
})
export type PutSharedResourceValuesResponse = z.infer<typeof putSharedResourceValuesResponseSchema>

export const sharedResourceEnvParamSchema = z.object({
  id: z.string().uuid(),
  env: appEnvironmentNameSchema,
})

// ---- pushes ------------------------------------------------------------------------------------

/** One app's part of a push. `error` is scrubbed; `names` are the keys put or removed. */
export const grantPushTargetSchema = z.object({
  id: z.string().uuid(),
  grantId: z.string().uuid(),
  app: appRefSchema,
  status: grantPushTargetStatusSchema,
  attempts: z.number().int().nonnegative(),
  error: z.string().nullable(),
  names: z.array(z.string()),
  finishedAt: z.coerce.date().nullable(),
})
export type GrantPushTarget = z.infer<typeof grantPushTargetSchema>

/** `GET /api/shared-resources/:id/pushes/:pushId` — the push and every target. */
export const grantPushSchema = grantPushSummarySchema.extend({
  targets: z.array(grantPushTargetSchema),
})
export type GrantPush = z.infer<typeof grantPushSchema>

export const grantPushListQuerySchema = z.object({
  environment: appEnvironmentNameSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type GrantPushListQuery = z.infer<typeof grantPushListQuerySchema>

/** `GET /api/shared-resources/:id/pushes`, newest first. */
export const grantPushListResponseSchema = z.object({ items: z.array(grantPushSummarySchema) })
export type GrantPushListResponse = z.infer<typeof grantPushListResponseSchema>

/**
 * `GRANT_PUSH_WORKFLOW.create({ id, params })` — ids only. The instance id is the push id
 * (`<pushId>-rN` on a retry, plan §1.10).
 */
export const grantPushParamsSchema = z.object({
  tenantId: z.string().uuid(),
  pushId: z.string().uuid(),
})
export type GrantPushParams = z.infer<typeof grantPushParamsSchema>

// ---- an app's config and grants ----------------------------------------------------------------

/**
 * One key an app declares (`rocketflare/declared-config.ts`, spec/02's `declaredConfig`): from a
 * plugin's `plugin.json` `vars[]`, or the kit's optional secrets under `KIT_CONFIG_PLUGIN_ID`.
 * The `app_config_scans.declared` jsonb.
 */
export const declaredConfigItemSchema = z.object({
  key: z.string(),
  secret: z.boolean(),
  pluginId: z.string(),
  example: z.string().optional(),
})
export type DeclaredConfigItem = z.infer<typeof declaredConfigItemSchema>

/** An app's grant as its owners see it (the config page, `launch grants ls`). */
export const appGrantSchema = z.object({
  id: z.string().uuid(),
  appId: z.string().uuid(),
  resource: resourceRefSchema,
  environment: appEnvironmentNameSchema,
  status: grantStatusSchema,
  approvalId: z.string().uuid().nullable(),
  requestedByUserId: z.string().uuid().nullable(),
  reason: z.string().nullable(),
  expiresAt: z.coerce.date().nullable(),
  pushedVersion: z.number().int().positive().nullable(),
  pushedAt: z.coerce.date().nullable(),
  pushError: z.string().nullable(),
  revokedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type AppGrant = z.infer<typeof appGrantSchema>

/**
 * A shared resource some declared key matched (exact name, plan §1.14), with the app's grant per
 * environment (the live one, else the latest) — what the Request button and the status chips read.
 */
export const appConfigMatchSchema = z.object({
  resource: resourceRefSchema.extend({
    items: z.array(z.object({ key: z.string(), kind: sharedResourceItemKindSchema })),
    archived: z.boolean(),
  }),
  /** The declared keys it covers. */
  keys: z.array(z.string()),
  /** The plugins whose keys matched. */
  declaredBy: z.array(z.string()),
  grants: z.object({
    staging: appGrantSchema.nullable(),
    production: appGrantSchema.nullable(),
  }),
})
export type AppConfigMatch = z.infer<typeof appConfigMatchSchema>

/** The last scan's facts (null before the first). */
export const appConfigScanSchema = z.object({
  ref: z.string().nullable(),
  sha: z.string().nullable(),
  scannedAt: z.coerce.date(),
  error: z.string().nullable(),
})
export type AppConfigScan = z.infer<typeof appConfigScanSchema>

/** `GET /api/apps/:id/config` (app readers). */
export const appConfigSchema = z.object({
  appId: z.string().uuid(),
  scan: appConfigScanSchema.nullable(),
  declared: z.array(declaredConfigItemSchema),
  matched: z.array(appConfigMatchSchema),
  /** Matched resource ids that no environment of the app holds. */
  needs: z.array(z.string().uuid()),
  /** Declared keys that match no resource ("ask an admin to add it"). */
  unmatched: z.array(z.string()),
  /** Every grant of the app, declared or not, newest first. */
  grants: z.array(appGrantSchema),
  /** The app's owners and admins may request, revoke and re-push. */
  canRequest: z.boolean(),
})
export type AppConfigView = z.infer<typeof appConfigSchema>

/**
 * `POST /api/apps/:id/grants` (the app's owners and admins): one grant and one `grant.request`
 * approval per environment (plan §1.7).
 */
export const requestGrantSchema = z.object({
  resourceId: z.string().uuid(),
  environments: z
    .array(appEnvironmentNameSchema)
    .min(1)
    .refine(envs => new Set(envs).size === envs.length, 'Each environment once'),
  reason: z.string().trim().min(1).max(GRANT_REASON_MAX),
  /** Optional lapse; must be in the future (the service checks against its clock). */
  expiresAt: z.coerce.date().optional(),
})
export type RequestGrantRequest = z.infer<typeof requestGrantSchema>

/** 202 — one entry per environment asked for. */
export const requestGrantResponseSchema = z.object({
  grants: z.array(
    z.object({
      id: z.string().uuid(),
      environment: appEnvironmentNameSchema,
      approvalId: z.string().uuid().nullable(),
      status: grantStatusSchema,
    })
  ),
})
export type RequestGrantResponse = z.infer<typeof requestGrantResponseSchema>

/** `DELETE /api/apps/:id/grants/:gid` (the app's owners, the resource's owners, admins). */
export const revokeGrantSchema = z.object({
  reason: z.string().trim().max(GRANT_REASON_MAX).optional(),
})
export type RevokeGrantRequest = z.infer<typeof revokeGrantSchema>

/** The answer to a revoke or a re-push: the grant and the push that carries it out. */
export const grantActionResponseSchema = z.object({
  grant: appGrantSchema,
  pushId: z.string().uuid().nullable(),
})
export type GrantActionResponse = z.infer<typeof grantActionResponseSchema>

export const appGrantParamSchema = z.object({
  id: z.string().uuid(),
  gid: z.string().uuid(),
})

// ---- realtime, notifications, errors -----------------------------------------------------------

/**
 * `entity.changed { entity: 'shared_resource', id: resourceId }` after a write to a resource, its
 * values or its holders (a push finishing) — the root of `queryKeys.sharedResources`.
 */
export const SHARED_RESOURCE_REALTIME_ENTITY = 'shared_resource'

/**
 * `entity.changed { entity: 'grant_push', id: pushId }` after every target a push settles — the
 * root of `queryKeys.grantPushes`, so the progress bar refreshes with no socket code in a hook.
 */
export const GRANT_PUSH_REALTIME_ENTITY = 'grant_push'

/**
 * `entity.changed { entity: 'app_config', id: appId }` after a scan, a grant transition or a
 * push landing — the root of `queryKeys.appConfig`.
 */
export const APP_CONFIG_REALTIME_ENTITY = 'app_config'

/**
 * The `notifications.type` values P5 writes, each with the `data` `notificationLink` reads:
 *
 * - `grant_needed` → the app's owners, once per newly matched resource: `{ appId, appSlug,
 *   resourceIds }` → `appConfigPath(appSlug)`;
 * - `grant_push_failed` → the resource's owners (and the pusher): `{ resourceId, pushId }` →
 *   `sharedResourcePath(resourceId)`;
 * - `grant_expiring` → the app's owners, 7 days out: `{ appId, appSlug, grantId }` → the app's
 *   config page;
 * - `grant_rotation_due` → the resource's owners: `{ resourceId, environment, keys }` → the
 *   resource page.
 */
export const GRANT_NOTIFICATION_TYPES = {
  needed: 'grant_needed',
  pushFailed: 'grant_push_failed',
  expiring: 'grant_expiring',
  rotationDue: 'grant_rotation_due',
} as const
export type GrantNotificationType =
  (typeof GRANT_NOTIFICATION_TYPES)[keyof typeof GRANT_NOTIFICATION_TYPES]

/** Error codes the P5 routes answer with (the `code` of the error envelope). */
export const GRANT_ERROR_CODES = {
  /** 503: the Worker has no `GRANT_PUSH_WORKFLOW` binding — raised before any row is written. */
  notConfigured: 'grants_not_configured',
  /** 409: a push is already running for this resource × environment. */
  pushInProgress: 'push_in_progress',
  /** 409: archiving a resource some app still holds. */
  resourceHasHolders: 'resource_has_holders',
  /** 409: the slug is taken in this organisation. */
  slugTaken: 'shared_resource_slug_taken',
  /** 409: the resource is archived (no new values, no new grants). */
  resourceArchived: 'shared_resource_archived',
  /** 403: setting values or editing items needs the owner group (or an admin). */
  notResourceOwner: 'not_resource_owner',
  /** 403: the owner group and the policies are admins' to edit. */
  notResourceAdmin: 'not_resource_admin',
  /** 400: a values body names a key the resource has no item for. */
  unknownItemKey: 'unknown_item_key',
  /** 409: a grant needs values in that environment first. */
  valuesNotSet: 'values_not_set',
  /** 409: the app already holds (or has asked for) the resource in that environment. */
  alreadyHeld: 'grant_already_held',
  /** 409: the grant is not in a state that allows this (revoke a revoked one, re-push a request). */
  grantNotActive: 'grant_not_active',
  /** A push target's error: the app environment has no `worker_name` recorded. */
  appHasNoWorker: 'app_has_no_worker',
} as const

/** The shared config pages (the resource by id) and an app's config page (by slug). */
export function sharedResourcePath(id: string): string {
  return `/shared-config/${id}`
}

export function appConfigPath(appSlug: string): string {
  return `/apps/${appSlug}/config`
}
