/**
 * Query-key factory (D13, D20). Every `useQuery`/`invalidateQueries` uses a key from here — never
 * an inline array — so one invalidation reliably covers a family (`all` is the prefix of everything
 * beneath it). Filters are spread into the key as a plain object (TanStack hashes them stably).
 *
 * Families are deliberately independent (`members` is NOT under `tenant`) so a tenant rename does
 * not refetch the member list; switching tenant clears the whole client instead (useAuth).
 */
import type { DeclaredBy } from '@launch/shared/plugins'
import { type UI_PLUGINS, uiPlugins } from '@/plugins/ui'

/** Cleaned filters as they appear in a key. Callers pass any plain object (interfaces welcome). */
export type Filters = Record<string, string | number | boolean>

/** `A | B | C` → `A & B & C`. Distributes over the union, then collapses it by inference. */
type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (
  i: infer I
) => void
  ? I
  : never

const CORE_QUERY_KEYS = {
  /** `/api/health` — version + environment; effectively immutable for the tab's lifetime */
  appInfo: {
    all: ['app-info'] as const,
  },
  /** `/auth/*` — the session is the UI's bootstrap; methods drive the login page */
  auth: {
    all: ['auth'] as const,
    session: ['auth', 'session'] as const,
    methods: ['auth', 'methods'] as const,
    providers: ['auth', 'providers'] as const,
  },
  /** `/api/me*` — the signed-in person and their per-tenant preferences */
  me: {
    all: ['me'] as const,
    profile: ['me', 'profile'] as const,
    preferences: ['me', 'preferences'] as const,
  },
  /** `/api/tenant*` — the active organisation and its settings */
  tenant: {
    all: ['tenant'] as const,
    current: ['tenant', 'current'] as const,
    settings: ['tenant', 'settings'] as const,
  },
  /** `/api/tenants` — every organisation the user belongs to */
  tenants: {
    all: ['tenants'] as const,
  },
  members: {
    all: ['members'] as const,
    list: (filters: object = {}) => ['members', 'list', filters] as const,
  },
  invitations: {
    all: ['invitations'] as const,
    list: (filters: object = {}) => ['invitations', 'list', filters] as const,
    /** Public `/api/invite/:token` details — keyed by token, never by tenant */
    details: (token: string) => ['invitations', 'details', token] as const,
  },
  /** `/api/invitations/pending` — MY invitations across tenants (banner) */
  pendingInvitations: {
    all: ['pending-invitations'] as const,
  },
  keys: {
    all: ['keys'] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    list: (filters: object = {}) => ['notifications', 'list', filters] as const,
    unreadCount: ['notifications', 'unread-count'] as const,
  },
  activity: {
    all: ['activity'] as const,
    list: (filters: object = {}) => ['activity', 'list', filters] as const,
  },
  /** `/api/ai/*` — providers, readiness, prompt registry and usage (D17, D18) */
  ai: {
    all: ['ai'] as const,
    configs: ['ai', 'configs'] as const,
    providers: ['ai', 'providers'] as const,
    readiness: ['ai', 'readiness'] as const,
    prompts: ['ai', 'prompts'] as const,
    usage: {
      all: ['ai', 'usage'] as const,
      summary: (filters: object = {}) => ['ai', 'usage', 'summary', filters] as const,
    },
    /** `/api/ai/agent-models` — every prompt key with its assignment + effective model (D17) */
    agentModels: ['ai', 'agent-models'] as const,
    /** `/api/feedback/mine` — the caller's own thumbs on a set of answers (D33) */
    feedback: {
      all: ['ai', 'feedback'] as const,
      mine: (target = '', ids: readonly string[] = []) =>
        ['ai', 'feedback', 'mine', target, [...ids].sort().join(',')] as const,
    },
  },
  /** `/api/agents` — the registered agent roster (code: changes with a deploy) (D7) */
  agents: {
    all: ['agents'] as const,
    list: ['agents', 'list'] as const,
  },
  /**
   * `/api/agents/runs` (D7, D8). The root is `agent-run` ON PURPOSE: the server's progress nudge is
   * `entity.changed { entity: 'agent-run', id }` and `invalidationsFor()` resolves that payload's
   * `entity` to a query-key root, so `WebSocketProvider` refreshes the runs list and the open run
   * with zero hook-side socket code. Its own family (not under `agents`) so a run event never
   * refetches the registry.
   */
  agentRuns: {
    all: ['agent-run'] as const,
    list: (filters: object = {}) => ['agent-run', 'list', filters] as const,
    detail: (id: string) => ['agent-run', 'detail', id] as const,
    /** `GET /runs/:id?events=0` — the bare row, one indexed read, refreshed by the nudge. */
    row: (id: string) => ['agent-run', 'row', id] as const,
    /**
     * `GET /interrupts?status=pending&pageSize=1` — the "n waiting" SideNav badge (issue #17).
     * Under `['agent-run']` so BOTH server nudges already cover it: a park writes an `interrupt`
     * event row (`entity: 'agent-run'`) and an answer additionally nudges `agent-interrupt`.
     * **Never polled** — a badge that polls is a request every few seconds on every page.
     */
    awaiting: ['agent-run', 'awaiting'] as const,
  },
  /**
   * The run's AG-UI timeline (issue #7) — **its own root on purpose, and it must stay out of
   * `REALTIME_INVALIDATIONS`.** The kit's convention is that an `entity.changed` entity string IS
   * a query-key root, and the runtime nudges `entity: 'agent-run'` on EVERY durable row it writes.
   * Park this list under `['agent-run']` and each of those nudges throws away the list the stream
   * just built and re-fetches the whole run — turning the stream into a more expensive poll.
   */
  agentRunAgui: {
    all: ['agent-run-agui'] as const,
    detail: (id: string) => ['agent-run-agui', id] as const,
  },
  /** `/api/ai/documents` — the tenant knowledge base and its search (D18) */
  documents: {
    all: ['documents'] as const,
    list: (filters: object = {}) => ['documents', 'list', filters] as const,
    detail: (id: string) => ['documents', 'detail', id] as const,
    /** One window of the text — keyed by offset so paging keeps each window cached (D18). */
    content: (id: string, offset: number) => ['documents', 'content', id, offset] as const,
    passages: (id: string, filters: object = {}) => ['documents', 'passages', id, filters] as const,
    card: (id: string) => ['documents', 'card', id] as const,
  },
  /** `/api/chat/*` — MY conversations (the route filters by user) and their messages (D17) */
  chat: {
    all: ['chat'] as const,
    conversations: {
      all: ['chat', 'conversations'] as const,
      list: (filters: object = {}) => ['chat', 'conversations', 'list', filters] as const,
      detail: (id: string) => ['chat', 'conversations', 'detail', id] as const,
      /** The inspector's derived view of one thread (admin+); same family, so a turn refreshes it. */
      stats: (id: string) => ['chat', 'conversations', 'stats', id] as const,
    },
  },
  /**
   * `/api/groups` (D29). The root is `groups` because the server nudges
   * `entity.changed { entity: 'groups' }` from every group mutation, and `access.changed` names it
   * too — so the admin UI and a person's own group list both refresh with no socket code here.
   */
  groups: {
    all: ['groups'] as const,
    types: ['groups', 'types'] as const,
    list: (filters: object = {}) => ['groups', 'list', filters] as const,
    detail: (id: string) => ['groups', 'detail', id] as const,
    mine: ['groups', 'mine'] as const,
  },
  /**
   * `/api/features` (D30). The root is `features` because the server's `features.changed` nudge
   * names it alongside `auth` — flags ride the session, so both have to be re-fetched when one moves.
   */
  features: {
    all: ['features'] as const,
  },
  /**
   * Launch: `/api/apps` — the registry (spec/06). Detail is keyed by SLUG (the URL), health and
   * operations by app id; one `apps.all` invalidation after an import or an edit refreshes all.
   */
  apps: {
    all: ['apps'] as const,
    list: (filters: object = {}) => ['apps', 'list', filters] as const,
    detail: (slug: string) => ['apps', 'detail', slug] as const,
    health: (appId: string) => ['apps', 'health', appId] as const,
    operations: (appId: string) => ['apps', 'operations', appId] as const,
    oidcClient: (appId: string) => ['apps', 'oidc-client', appId] as const,
    /** P2: the create/teardown run's steps (polled while `provisioning`). */
    pipeline: (appId: string) => ['apps', 'pipeline', appId] as const,
    /** P2: the app's deploy tickets. */
    deploys: (appId: string) => ['apps', 'deploys', appId] as const,
  },
  /**
   * Launch P3: coding sessions (`/api/sessions`, `/api/apps/:id/sessions`, spec/07). The root is
   * `session` ON PURPOSE — it is `SESSION_REALTIME_ENTITY`: the Workflow nudges
   * `entity.changed { entity: 'session', id }` after every durable write, and `invalidationsFor()`
   * resolves that to this root, so the session page, the app's sessions card and the admin list
   * refresh with no socket code in a hook.
   */
  sessions: {
    all: ['session'] as const,
    /** `GET /api/apps/:id/sessions` — keyed by app id (and `scope`). */
    forApp: (appId: string, filters: object = {}) => ['session', 'app', appId, filters] as const,
    detail: (id: string) => ['session', 'detail', id] as const,
    events: (id: string) => ['session', 'events', id] as const,
    pr: (id: string) => ['session', 'pr', id] as const,
    /** `GET /api/admin/sessions` — live sessions across the deployment and the drain flag. */
    admin: (filters: object = {}) => ['session', 'admin', filters] as const,
  },
  /**
   * A session's AG-UI chat timeline — **its own root, and it must stay out of
   * `REALTIME_INVALIDATIONS`**, for the reason `agentRunAgui` gives: every durable event nudges
   * `session`, and a list under that root would be thrown away and re-fetched on every one.
   */
  sessionAgui: {
    all: ['session-agui'] as const,
    detail: (id: string) => ['session-agui', id] as const,
  },
  /**
   * Launch P4: approvals (`/api/approvals`, spec/08). The root is `approval` ON PURPOSE — it is
   * `APPROVAL_REALTIME_ENTITY`: every open, decision and expiry nudges
   * `entity.changed { entity: 'approval', id }`, and `invalidationsFor()` resolves that to this
   * root, so the inbox, the nav badge and a request's page refresh with no socket code in a hook.
   */
  approvals: {
    all: ['approval'] as const,
    list: (filters: object = {}) => ['approval', 'list', filters] as const,
    count: ['approval', 'count'] as const,
    detail: (id: string) => ['approval', 'detail', id] as const,
  },
  /** Launch P4: `/api/approval-policies` — admin settings; not nudged, invalidated on save. */
  approvalPolicies: {
    all: ['approval-policies'] as const,
    list: (filters: object = {}) => ['approval-policies', 'list', filters] as const,
  },
  /**
   * Launch P4: an app's releases (`/api/apps/:id/releases`). The root is `release` — it is
   * `RELEASE_REALTIME_ENTITY`, the same pattern as `approvals` and `sessions`.
   */
  releases: {
    all: ['release'] as const,
    forApp: (appId: string) => ['release', 'app', appId] as const,
    detail: (releaseId: string) => ['release', 'detail', releaseId] as const,
    chain: (releaseId: string) => ['release', 'chain', releaseId] as const,
  },
  /**
   * Launch P5: shared config (`/api/shared-resources`, spec/09). Invalidated on save; the push
   * progress lives under `grantPushes` (nudged), and 5c's finish also nudges this root so the
   * holders' versions refresh (`SHARED_RESOURCE_REALTIME_ENTITY`, the same value).
   */
  sharedResources: {
    all: ['shared_resource'] as const,
    list: (filters: object = {}) => ['shared_resource', 'list', filters] as const,
    detail: (id: string) => ['shared_resource', 'detail', id] as const,
  },
  /**
   * Launch P5: a resource's pushes (`/api/shared-resources/:id/pushes`). The root is `grant_push`
   * ON PURPOSE — it is `GRANT_PUSH_REALTIME_ENTITY`: every settled target nudges
   * `entity.changed { entity: 'grant_push', id }`, so the progress bar refreshes with no socket code.
   */
  grantPushes: {
    all: ['grant_push'] as const,
    forResource: (resourceId: string, filters: object = {}) =>
      ['grant_push', 'resource', resourceId, filters] as const,
    detail: (pushId: string) => ['grant_push', 'detail', pushId] as const,
  },
  /**
   * Launch P5: an app's declared config and grants (`/api/apps/:id/config`). The root is
   * `app_config` — `APP_CONFIG_REALTIME_ENTITY`, nudged by a scan, a grant transition and a push
   * landing.
   */
  appConfig: {
    all: ['app_config'] as const,
    detail: (appId: string) => ['app_config', 'detail', appId] as const,
  },
  /** Launch: `/api/app-access` — an app's sign-in policy, grants and access requests (spec/05) */
  appAccess: {
    all: ['app-access'] as const,
    policy: (appId: string) => ['app-access', 'policy', appId] as const,
    grants: (appId: string) => ['app-access', 'grants', appId] as const,
    requests: (appId: string, filters: object = {}) =>
      ['app-access', 'requests', appId, filters] as const,
    mine: ['app-access', 'mine'] as const,
    /** The request-access page: one app (by OIDC client id) and where the caller stands. */
    requestContext: (clientId: string) => ['app-access', 'request-context', clientId] as const,
  },
  /** Launch: `/api/audit` — the append-only audit log (spec/08), cursor-paged */
  audit: {
    all: ['audit'] as const,
    list: (filters: object = {}) => ['audit', 'list', filters] as const,
    /** P4: `GET /api/audit/verify` — the hash chain's check. */
    verify: ['audit', 'verify'] as const,
  },
  /**
   * Launch: `/api/admin/setup` (spec/03) — under the `admin` root on purpose, so the one
   * `admin.all` invalidation after an admin mutation covers it like every other admin screen.
   */
  setup: {
    all: ['admin', 'setup'] as const,
    status: ['admin', 'setup', 'status'] as const,
  },
  /** Launch: `/api/admin/oidc` — the issuer's signing keys (spec/05); under `admin` like `setup` */
  oidcAdmin: {
    all: ['admin', 'oidc'] as const,
    keys: ['admin', 'oidc', 'keys'] as const,
  },
  /** `/api/admin/*` — cross-tenant; one `admin.all` invalidation after any admin mutation */
  admin: {
    all: ['admin'] as const,
    accessRequests: {
      all: ['admin', 'access-requests'] as const,
      list: (filters: object = {}) => ['admin', 'access-requests', 'list', filters] as const,
    },
    tenants: {
      all: ['admin', 'tenants'] as const,
      list: (filters: object = {}) => ['admin', 'tenants', 'list', filters] as const,
      detail: (id: string) => ['admin', 'tenants', 'detail', id] as const,
    },
    featureFlags: {
      all: ['admin', 'feature-flags'] as const,
      overrides: (key: string) => ['admin', 'feature-flags', 'overrides', key] as const,
    },
    users: {
      all: ['admin', 'users'] as const,
      list: (filters: object = {}) => ['admin', 'users', 'list', filters] as const,
      detail: (id: string) => ['admin', 'users', 'detail', id] as const,
    },
  },
} as const

/**
 * Families contributed by installed plugins (D31), merged in. Every root a plugin declares starts
 * with `<id>:` — `tests/config/plugins.test.ts` is the check — so a plugin can no more collide with
 * a kit family, or with another plugin's, than two plugins can share a table name.
 *
 * The cast is the price of merging objects the kit cannot know the shape of: at runtime this is
 * one spread, and at compile time it is the intersection of everything the barrel declares, which
 * is exactly what a plugin's own hooks need to see when they read `queryKeys`.
 */
type DeclaredQueryKeys = UnionToIntersection<
  NonNullable<DeclaredBy<(typeof UI_PLUGINS)[number], 'queryKeys'>>
>
/** No plugins (or none with families) → `unknown`, which intersects away instead of erasing. */
type PluginQueryKeys = [DeclaredQueryKeys] extends [never] ? unknown : DeclaredQueryKeys

export const queryKeys = {
  ...CORE_QUERY_KEYS,
  ...(Object.assign({}, ...uiPlugins.map(p => p.queryKeys ?? {})) as Record<string, unknown>),
} as typeof CORE_QUERY_KEYS & PluginQueryKeys

/** Drop undefined/empty filters so `{ q: '' }` and `{}` share one cache entry. */
export function cleanFilters(filters: object): Filters {
  const out: Filters = {}
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === '') continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

/** `?page=2&q=acme` from the same cleaned filters the key uses. */
export function toSearchParams(filters: object): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(cleanFilters(filters))) params.set(k, String(v))
  const s = params.toString()
  return s ? `?${s}` : ''
}
