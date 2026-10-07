/**
 * Permission VOCABULARY shared by API and UI (D10, D13): actions, subjects, the typed `AppAbility`,
 * and the wire format of rules (`packRules` from `@casl/ability/extra`). The role → grant matrix
 * lives in `src/permissions/abilities.ts`; this file only names the pieces so both bundles agree.
 * Type-only dependency on @casl/ability — nothing here runs CASL.
 */
import type { MongoAbility, RawRuleOf } from '@casl/ability'
import type { PackRule } from '@casl/ability/extra'
import { z } from 'zod'
import { type DeclaredBy, type SHARED_PLUGINS, sharedPlugins } from './plugins'
import { type MembershipRole, membershipRoleSchema } from './tenants'

export const ACTIONS = ['manage', 'create', 'read', 'update', 'delete', 'access'] as const
export type Actions = (typeof ACTIONS)[number]

/** Core subjects every kit app has. Apps extend `Subjects` (and the matrix) with their own. */
export const CORE_SUBJECTS = [
  'all',
  'Tenant',
  'TenantMember',
  'Invitation',
  'ApiKey',
  'Notification',
  'AccessRequest',
  'ActivityEvent',
  'User',
  'File',
  'AiConfig',
  'Prompt',
  'Conversation',
  'AgentRun',
  'Document',
  /** Groups (D29): group types, groups and their membership — admin+ `manage`, member `read`. */
  'Group',
  /**
   * Feature flags (D30) — ADMINISTERING them, never using a feature. A platform subject like
   * `AccessRequest` and `User`: reachable only through `manage all`, so it is deliberately absent
   * from `ADMIN_MANAGED` and `MEMBER_READABLE`. Using a feature is `AuthContext.features`, which is
   * not a permission at all — see the warning on `FeatureSubject` below.
   */
  'FeatureFlag',
  /**
   * AI traces (D32) — the local span store behind `/api/traces`. Admin+ `read` only: a span holds
   * other people's prompts and tool results. Deliberately NOT in `ADMIN_MANAGED`, which would hand
   * every member `read` through `MEMBER_READABLE`.
   */
  'Trace',
  /**
   * Thumbs feedback on AI answers (D33). Every member may `create` it — on an answer they could
   * read, which the service checks — and admin+ `read` it, because the list is how promotion
   * candidates are found and each row points at another member's conversation.
   */
  'Feedback',
  /**
   * Launch: a registered app (spec/06). Every member may `read` the catalogue; admin+ `manage`
   * (import, edit, register its OIDC client). In `ADMIN_MANAGED`, so members get `read` through
   * `MEMBER_READABLE`.
   */
  'App',
  /**
   * Launch: the audit log (spec/08). Admin+ `read` only — nobody writes one through the API (rows
   * are appended by the services that act, and the table refuses UPDATE and DELETE). NOT in
   * `ADMIN_MANAGED`, which would hand every member `read`.
   */
  'AuditEvent',
  /**
   * Launch P3: a coding session (spec/07). Every member may `create` one and `read`/`update` their
   * OWN — the route filters by creator, exactly as `AgentRun` does, and the app's owners count as
   * owners of its sessions (`services/sessions/access.ts`, `maySeeSession`). Admin+ `manage` every session in the
   * organisation. Deliberately NOT in `ADMIN_MANAGED`, which would hand every member `read` on
   * everyone's sessions through `MEMBER_READABLE`.
   */
  'Session',
  /**
   * Launch P4: an approval request (spec/08). Every member may `read` — the approvals SERVICE
   * filters the rows (waiting on me, requested by me) and decides eligibility per request from its
   * policy, exactly as `AgentRun` leaves "own" to the route. Admin+ `manage` (the `all` box, cancel
   * anyone's). Deciding is NOT a CASL action: it is the engine's eligibility check (plan §1.3).
   * Deliberately NOT in `ADMIN_MANAGED`.
   */
  'Approval',
  /**
   * Launch P4: an approval POLICY (who approves which kind, at tenant, group or app scope). Admin+
   * `manage` only — an app owner loosening their own production gate would defeat it (plan §1.5).
   * NOT in `ADMIN_MANAGED`, which would hand every member `read`.
   */
  'ApprovalPolicy',
  /**
   * Launch P5: a shared resource (spec/09 — shared config: a bundle of vars and secrets many apps
   * may hold). Every member may `read` the list, the item names and the policy — what they need to
   * ASK for it — and admin+ `manage` (create, archive, owner group, policies). In `ADMIN_MANAGED`,
   * so members get `read` through `MEMBER_READABLE`. The OWNER group's rights (set values, edit
   * items, see holders) are not a grant: the service checks group membership (plan §1.3). Values
   * are never readable through any subject.
   */
  'SharedResource',
] as const
export type CoreSubject = (typeof CORE_SUBJECTS)[number]

/**
 * Feature flags are subjects too: `can('access', 'Feature:analytics')` (D10).
 *
 * **Never gate a surface that ships dark on this.** `globalAdmin` is `can('manage', 'all')` and
 * `support` is granted `access all`; in CASL those are wildcards covering `access` on every
 * `Feature:` subject, so an ability check answers "on" for platform staff no matter what the
 * deployment ships. A feature flag is CONFIGURATION, not a permission: every gate reads the
 * features ARRAY (`hasFeature(auth.features, name)` on the server, `session.features` in the
 * browser). `applyFeatureFlags` still populates these subjects for an app that genuinely wants
 * permission-style entitlements, and nothing that hides an unreleased surface may use them (D30).
 */
export type FeatureSubject = `Feature:${string}`
export const featureSubject = (feature: string): FeatureSubject => `Feature:${feature}`

/**
 * Every feature key the KIT ships (D30). Code, not data: a key that no code reads does nothing,
 * so inventing one at runtime buys nothing, while a registry makes `requireFeature('new-reprots')`
 * a TYPE ERROR instead of a route that 404s for ever. Adding a flag is a line here plus its
 * metadata in `features.ts` — no migration. Retiring one: delete the gate from the code, deploy,
 * then delete the line. Append-only in spirit; the metadata registry is keyed on this. A plugin
 * brings its own through `SharedPlugin.features`, which is where both halves arrive together.
 */
export const CORE_FEATURES = [
  // The kit's own AI surfaces (Chat, Agents, Knowledge, Search) — hidden in Launch for now: the
  // flag is `environmentGated` and no toml lists it, so it is off everywhere (`features.ts`).
  'kit-ai',
] as const satisfies readonly string[]

/** Distributive: `keyof (A | B)` is the keys A and B SHARE, which is never for two plugins' flags. */
type KeysOfEach<T> = T extends unknown ? keyof T : never
type PluginFeatureKey = Extract<
  KeysOfEach<NonNullable<DeclaredBy<(typeof SHARED_PLUGINS)[number], 'features'>>>,
  string
>

/**
 * Core keys plus every installed plugin's (D31).
 *
 * **It may legitimately be EMPTY** — a kit with no core flag and no installed plugin declaring
 * one (Launch ships one core flag, `kit-ai`). So `FeatureName` can be `never`, `Record<FeatureName, …>` can be `{}`, and
 * `featureNameSchema` cannot be a `z.enum` (which needs a non-empty tuple). `features.ts` spells it
 * as a refined `z.string()` for exactly that reason.
 */
export const FEATURES = [
  ...CORE_FEATURES,
  ...(sharedPlugins.flatMap(p => Object.keys(p.features ?? {})) as PluginFeatureKey[]),
] as const
export type FeatureName = (typeof FEATURES)[number]

/** Subjects an installed plugin adds (D31) — its own nouns, granted by `ServerPlugin.grants`. */
export type PluginSubject = NonNullable<
  DeclaredBy<(typeof SHARED_PLUGINS)[number], 'subjects'>
>[number]

export type Subjects = CoreSubject | PluginSubject | FeatureSubject

export type AppAbility = MongoAbility<[Actions, Subjects]>

/** The roles the ability matrix knows; `globalAdmin` is the `users.isGlobalAdmin` flag, not a role. */
export const roleSchema = membershipRoleSchema
export type Role = MembershipRole
export type EffectiveRole = Role | 'globalAdmin'

/**
 * One rule as `packRules` emits it: `[actions, subjects, conditions?, inverted?, fields?, reason?]`
 * with actions/subjects comma-joined. Validated loosely on the wire (the tail varies by rule);
 * `unpackRules` in src/permissions narrows it back to `PackedRule`.
 */
export const packedRuleSchema = z.tuple([z.string(), z.string()]).rest(z.unknown())
export const packedRulesSchema = z.array(packedRuleSchema)
export type PackedRules = z.infer<typeof packedRulesSchema>
export type PackedRule = PackRule<RawRuleOf<AppAbility>>

/**
 * The tenant roles that administer the Launch DEPLOYMENT itself in single mode: the setup wizard
 * (credentials, apps domain, public URL), the OIDC issuer's keys and the access-request queue.
 * `support` is absent on purpose — it is a global admin visiting, who passes on the flag.
 */
export const PLATFORM_ADMIN_ROLES = ['owner', 'admin'] as const satisfies readonly MembershipRole[]

/**
 * THE one predicate for the platform surface (`/api/platform/*` — Settings' Platform pages, Coding agents, Kit version and access requests): a global
 * admin anywhere, or — in a single-tenant deployment, where the one organisation IS the company
 * that runs Launch — its owner or admin. In multi mode it is exactly `isGlobalAdmin`, as before:
 * one tenant's admin must never hold deployment-wide credentials that every tenant depends on.
 *
 * Not a CASL subject: the answer varies on DEPLOYMENT configuration, not on the role alone, and the
 * matrix is role × subject by design (`apps/web/src/permissions/CLAUDE.md`). Pure, so the server's
 * middleware and the UI's nav guard call the same function and cannot disagree.
 */
export function canAdministerPlatform(input: {
  isGlobalAdmin: boolean
  role: MembershipRole | null | undefined
  tenancyMode: 'multi' | 'single'
}): boolean {
  if (input.isGlobalAdmin) return true
  if (input.tenancyMode !== 'single' || !input.role) return false
  return (PLATFORM_ADMIN_ROLES as readonly MembershipRole[]).includes(input.role)
}
