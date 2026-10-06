/**
 * Realtime event contracts (D8). "DB is the truth, WebSocket is a nudge": an event names WHAT
 * changed (its `type`, optionally an `entity.changed` payload `{ entity, id }`) and the client
 * re-queries — it never treats a payload as state. `REALTIME_INVALIDATIONS` maps each event type
 * to the TanStack query-key ROOTS the UI invalidates (the `queryKeys.<family>.all` prefixes in
 * `apps/web/src/ui/lib/query-keys.ts`); the server emits, the UI reacts, both through this file.
 */
import { z } from 'zod'
import { RELEASE_REALTIME_ENTITY } from './launch-releases'
import { SESSION_REALTIME_ENTITY } from './launch-sessions'
import { sharedPlugins } from './plugins/index'

export const realtimeEventTypeSchema = z.enum([
  'notification.created',
  'notification.read',
  'member.changed',
  'invitation.changed',
  'tenant.changed',
  /** D29: this person's group membership changed — what they may READ has moved under them. */
  'access.changed',
  /** D30: a feature flag moved for this tenant — what EXISTS for them has changed. */
  'features.changed',
  'entity.changed',
  'ping',
])
export type RealtimeEventType = z.infer<typeof realtimeEventTypeSchema>

/**
 * Generic nudge: `entity` is a query-key root (`'members'`, `'activity'`…), `id` narrows it, and
 * `appId` names the app a per-app row belongs to (a release, a CI deploy run) so the UI can refresh
 * just that app's views (`apps/web/src/ui/lib/realtime-invalidations.ts`). Ids only — never state:
 * the client re-reads through the normal, authorized API.
 */
export const entityChangedPayloadSchema = z.object({
  entity: z.string().min(1),
  id: z.string().optional(),
  appId: z.string().optional(),
})
export type EntityChangedPayload = z.infer<typeof entityChangedPayloadSchema>

/** What travels over the socket, `JSON.stringify`-ed. `at` is an ISO timestamp set by the emitter. */
export const realtimeEventSchema = z.object({
  type: realtimeEventTypeSchema,
  tenantId: z.string(),
  at: z.string().datetime(),
  payload: z.unknown().optional(),
})
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>

/**
 * Event type → query-key roots to invalidate. Roots are the first element(s) of the families in
 * `queryKeys`; `entity.changed` is resolved from its payload at runtime and `ping` invalidates
 * nothing. A ui test asserts every root here is a real `queryKeys` family.
 */
const CORE_REALTIME_INVALIDATIONS: Record<RealtimeEventType, string[][]> = {
  'notification.created': [['notifications']],
  'notification.read': [['notifications']],
  'member.changed': [['members']],
  'invitation.changed': [['invitations'], ['pending-invitations']],
  'tenant.changed': [['tenant'], ['tenants'], ['auth']],
  // Sent to the affected people only (`nudgeUsers`): their ability to see content changed, so the
  // session (which carries their groups), both visibility-bearing resources and the groups view
  // are all stale at once.
  'access.changed': [['auth'], ['documents'], ['groups']],
  // Features ride the session, so the session is what has to be re-fetched; `features` covers the
  // read-only list the CLI and the debugging surface use.
  'features.changed': [['auth'], ['features']],
  'entity.changed': [],
  ping: [],
}

/**
 * The same map with every installed plugin's `realtimeRoots` added to `access.changed` (D29, D31).
 *
 * Only that event: a plugin whose rows carry `visibility` has to be re-fetched when somebody's
 * group membership moves under them, or they keep looking at content they can no longer open.
 * Everything else a plugin needs is an `entity.changed` nudge naming its own query-key root, which
 * needs no registration at all.
 */
export const REALTIME_INVALIDATIONS: Record<RealtimeEventType, string[][]> = {
  ...CORE_REALTIME_INVALIDATIONS,
  'access.changed': [
    ...CORE_REALTIME_INVALIDATIONS['access.changed'],
    ...sharedPlugins.flatMap(p => (p.realtimeRoots ?? []).map(root => [root])),
  ],
}

/**
 * Narrower keys for the nudges that fire most while something ships. A session's Workflow nudges
 * `{ entity: 'session', id }` after every durable write (a turn's every flush, every landing
 * round), and a release moves several times between its tag and production; invalidating the whole
 * root for each one would refetch every OTHER session's page and every other app's release card in
 * the tenant. So a nudge that names its row refreshes that row's queries and the lists it appears
 * in — never a sibling's detail. A nudge without the id (or the app, for a release) falls back to
 * the whole root.
 *
 * Each key is a PREFIX of a `queryKeys` factory in `apps/web/src/ui/lib/query-keys.ts`
 * (`sessions.detail(id)`, `sessions.forApp(appId, …)`, `releases.promotion(appId)`…); a ui test
 * asserts every key of those families is covered, so a new sub-key cannot silently go stale.
 */
const ENTITY_TARGETS: Record<string, (payload: EntityChangedPayload) => string[][] | null> = {
  [SESSION_REALTIME_ENTITY]: ({ id }) =>
    id
      ? [
          [SESSION_REALTIME_ENTITY, 'detail', id],
          [SESSION_REALTIME_ENTITY, 'pr', id],
          [SESSION_REALTIME_ENTITY, 'events', id],
          // The lists a session row appears in: any app's (the nudge names no app) and the admin's.
          [SESSION_REALTIME_ENTITY, 'app'],
          [SESSION_REALTIME_ENTITY, 'admin'],
        ]
      : null,
  [RELEASE_REALTIME_ENTITY]: ({ id, appId }) =>
    appId
      ? [
          [RELEASE_REALTIME_ENTITY, 'app', appId],
          [RELEASE_REALTIME_ENTITY, 'promotion', appId],
          [RELEASE_REALTIME_ENTITY, 'compare', appId],
          ...(id
            ? [
                [RELEASE_REALTIME_ENTITY, 'detail', id],
                [RELEASE_REALTIME_ENTITY, 'chain', id],
              ]
            : []),
        ]
      : null,
}

/**
 * The query keys an event should invalidate: the type's roots, or for `entity.changed` the
 * payload's root — narrowed to the named row for the entities in `ENTITY_TARGETS`.
 */
export function invalidationsFor(event: RealtimeEvent): string[][] {
  if (event.type === 'entity.changed') {
    const parsed = entityChangedPayloadSchema.safeParse(event.payload)
    if (!parsed.success) return []
    return ENTITY_TARGETS[parsed.data.entity]?.(parsed.data) ?? [[parsed.data.entity]]
  }
  return REALTIME_INVALIDATIONS[event.type]
}
