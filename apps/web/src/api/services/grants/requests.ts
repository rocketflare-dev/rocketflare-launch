/**
 * An app's grants (Launch P5, plan §1.7–§1.9, §4 5d), behind `/api/apps/:id/config` and
 * `/api/apps/:id/grants`:
 *
 * - `appConfigView`: `GET /config` (app readers) — the last scan's declared keys, the resources they
 *   match (exact key name, plan §1.14) with the app's grant per environment (the live one, else the
 *   latest), `needs` (matched, not archived, held in no environment), `unmatched`, every grant, and
 *   `canRequest` (the app's owners and admins);
 * - `requestGrant`: `POST /grants` (the app's owners and admins) — `requireGrantPushWorkflow`
 *   first, then EVERY refusal before any row (403, `shared_resource_archived`, a past `expiresAt`,
 *   `values_not_set`, `grant_already_held`), then per environment one `app_grants` row
 *   (`requested`) and one `engine.open` of `grant.request` (subject `grant`, the grant id) with
 *   `policy: resource.policies[env] ?? resolvePolicy(…)` (§1.9) — so a resource's own policy wins,
 *   and any `approval_policies` row for the kind still applies below it. A policy that
 *   auto-approves (`autoApproveRole`, staging self-serve) activates the grant and starts its push
 *   inside the same call. Answers 202 `requestGrantResponseSchema`;
 * - `repushGrant`: `POST /grants/:gid/repush` — a `repair` push of the active version for that one
 *   grant (after a failed push, or a Worker rebuilt by hand). The app's owners, the resource's
 *   owners and admins.
 *
 * Revoking is `revoke.revokeGrant` (5c), called by the same route file; `appGrantView` is the one
 * mapping of a row to the wire for all of them.
 *
 * No function here reads a value: the grant carries the VERSION it holds, never what is in it.
 *
 * **Slice 5d owns this file.**
 */

import { approvalPolicySchema } from '@launch/shared/launch-approvals'
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  type AppConfigMatch,
  type AppConfigView,
  type AppGrant,
  GRANT_ERROR_CODES,
  type GrantActionResponse,
  isLiveGrant,
  LIVE_GRANT_STATUSES,
  type RequestGrantRequest,
  type RequestGrantResponse,
} from '@launch/shared/launch-grants'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  type AppGrantRow,
  type AppRow,
  appConfigScans,
  appGrants,
  type SharedResourceRow,
  sharedResources,
  sharedResourceValues,
} from '../../../db/schema'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/core/errors'
import { open as openApproval } from '../approvals/engine'
import { resolvePolicy } from '../approvals/policy'
import { getAppRow } from '../launch/apps'
import { type AuditActor, recordAudit } from '../launch/audit'
import { isAppOwner } from '../oidc/policy'
import { nudgeAppConfig } from './nudge'
import { startPush } from './push'
import { loadResource } from './resources'
import { type GrantDeps, type GrantViewer, requireGrantPushWorkflow } from './types'
import { activeVersion } from './values'

const nowOf = (deps: Pick<GrantDeps, 'now'>) => deps.now?.() ?? new Date()

/** The app's owners (named or through its group) and the organisation's admins. */
async function mayRequestFor(db: Database, viewer: GrantViewer, app: AppRow): Promise<boolean> {
  return viewer.isAdmin || isAppOwner(db, viewer.tenantId, app, viewer.userId, viewer.groupIds)
}

/**
 * A resource's owners are its owner group's members (plan §1.3) — read from the viewer's groups,
 * as `access.isResourceOwner` (5b) does.
 */
function ownsResource(viewer: GrantViewer, resource: Pick<SharedResourceRow, 'ownerGroupId'>) {
  return viewer.groupIds.includes(resource.ownerGroupId)
}

// ---- the wire shape ----------------------------------------------------------------------------

/** Grants as the wire carries them: the resource named, the pushed VERSION NUMBER, never a value. */
async function toAppGrants(db: Database, tenantId: string, rows: AppGrantRow[]) {
  if (rows.length === 0) return []
  const resourceIds = [...new Set(rows.map(r => r.resourceId))]
  const versionIds = [
    ...new Set(rows.map(r => r.pushedVersionId).filter((v): v is string => Boolean(v))),
  ]
  const [resources, versions] = await Promise.all([
    db
      .select({
        id: sharedResources.id,
        slug: sharedResources.slug,
        displayName: sharedResources.displayName,
      })
      .from(sharedResources)
      .where(and(eq(sharedResources.tenantId, tenantId), inArray(sharedResources.id, resourceIds))),
    versionIds.length === 0
      ? Promise.resolve([] as { id: string; version: number }[])
      : db
          .select({ id: sharedResourceValues.id, version: sharedResourceValues.version })
          .from(sharedResourceValues)
          .where(
            and(
              eq(sharedResourceValues.tenantId, tenantId),
              inArray(sharedResourceValues.id, versionIds)
            )
          ),
  ])
  const resourceOf = new Map(resources.map(r => [r.id, r]))
  const versionOf = new Map(versions.map(v => [v.id, v.version]))
  return rows.map((row): AppGrant => {
    const resource = resourceOf.get(row.resourceId)
    if (!resource) throw new Error(`app_grants ${row.id}: resource ${row.resourceId} not found`)
    return {
      id: row.id,
      appId: row.appId,
      resource,
      environment: row.environment,
      status: row.status,
      approvalId: row.approvalId,
      requestedByUserId: row.requestedByUserId,
      reason: row.reason,
      expiresAt: row.expiresAt,
      pushedVersion: row.pushedVersionId ? (versionOf.get(row.pushedVersionId) ?? null) : null,
      pushedAt: row.pushedAt,
      pushError: row.pushError,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  })
}

async function findGrant(db: Database, tenantId: string, appId: string, grantId: string) {
  const [row] = await db
    .select()
    .from(appGrants)
    .where(
      and(eq(appGrants.tenantId, tenantId), eq(appGrants.appId, appId), eq(appGrants.id, grantId))
    )
  return row ?? null
}

/**
 * One grant of one app as the wire carries it — 404 `grant_not_found` for a grant of another app
 * or organisation, the same as a missing one.
 */
export async function appGrantView(
  db: Database,
  tenantId: string,
  appId: string,
  grantId: string
): Promise<AppGrant> {
  const row = await findGrant(db, tenantId, appId, grantId)
  if (!row) throw new NotFoundError('Grant not found', 'grant_not_found')
  const [grant] = await toAppGrants(db, tenantId, [row])
  if (!grant) throw new NotFoundError('Grant not found', 'grant_not_found')
  return grant
}

// ---- the config view ---------------------------------------------------------------------------

export async function appConfigView(
  db: Database,
  viewer: GrantViewer,
  appId: string
): Promise<AppConfigView> {
  const { tenantId } = viewer
  const app = await getAppRow(db, tenantId, appId)
  const [[scan], resources, grantRows, canRequest] = await Promise.all([
    db
      .select()
      .from(appConfigScans)
      .where(and(eq(appConfigScans.tenantId, tenantId), eq(appConfigScans.appId, app.id))),
    db
      .select({
        id: sharedResources.id,
        slug: sharedResources.slug,
        displayName: sharedResources.displayName,
        items: sharedResources.items,
        archivedAt: sharedResources.archivedAt,
      })
      .from(sharedResources)
      .where(eq(sharedResources.tenantId, tenantId))
      .orderBy(sharedResources.slug),
    db
      .select()
      .from(appGrants)
      .where(and(eq(appGrants.tenantId, tenantId), eq(appGrants.appId, app.id)))
      .orderBy(desc(appGrants.createdAt)),
    mayRequestFor(db, viewer, app),
  ])
  const grants = await toAppGrants(db, tenantId, grantRows)
  const declared = scan?.declared ?? []

  // The grant an environment shows: the live one, else the latest (grants are newest first).
  const grantFor = (resourceId: string, environment: AppEnvironmentName) => {
    const mine = grants.filter(g => g.resource.id === resourceId && g.environment === environment)
    return mine.find(g => isLiveGrant(g.status)) ?? mine[0] ?? null
  }

  const matched: AppConfigMatch[] = []
  const matchedKeys = new Set<string>()
  for (const resource of resources) {
    const itemKeys = new Set(resource.items.map(i => i.key))
    const hits = declared.filter(d => itemKeys.has(d.key))
    if (hits.length === 0) continue
    for (const hit of hits) matchedKeys.add(hit.key)
    matched.push({
      resource: {
        id: resource.id,
        slug: resource.slug,
        displayName: resource.displayName,
        items: resource.items.map(i => ({ key: i.key, kind: i.kind })),
        archived: resource.archivedAt !== null,
      },
      keys: [...new Set(hits.map(h => h.key))],
      declaredBy: [...new Set(hits.map(h => h.pluginId))],
      grants: {
        staging: grantFor(resource.id, 'staging'),
        production: grantFor(resource.id, 'production'),
      },
    })
  }

  const needs = matched
    .filter(m => !m.resource.archived)
    .filter(m => !grants.some(g => g.resource.id === m.resource.id && isLiveGrant(g.status)))
    .map(m => m.resource.id)
  const unmatched = [...new Set(declared.map(d => d.key))].filter(k => !matchedKeys.has(k))

  return {
    appId: app.id,
    scan: scan
      ? { ref: scan.ref, sha: scan.sha, scannedAt: scan.scannedAt, error: scan.error }
      : null,
    declared,
    matched,
    needs,
    unmatched,
    grants,
    canRequest,
  }
}

// ---- requesting --------------------------------------------------------------------------------

/** The plugins whose declared keys this resource covers (the approver's "why"). */
async function declaredByFor(
  db: Database,
  tenantId: string,
  appId: string,
  resource: SharedResourceRow
): Promise<string[]> {
  const [scan] = await db
    .select({ declared: appConfigScans.declared })
    .from(appConfigScans)
    .where(and(eq(appConfigScans.tenantId, tenantId), eq(appConfigScans.appId, appId)))
  const keys = new Set(resource.items.map(i => i.key))
  return [...new Set((scan?.declared ?? []).filter(d => keys.has(d.key)).map(d => d.pluginId))]
}

function alreadyHeld(resource: SharedResourceRow, environment: string): ConflictError {
  return new ConflictError(
    `This app already holds (or has asked for) ${resource.displayName} in ${environment}`,
    GRANT_ERROR_CODES.alreadyHeld
  )
}

export async function requestGrant(
  deps: GrantDeps,
  viewer: GrantViewer,
  appId: string,
  input: RequestGrantRequest,
  actor: AuditActor
): Promise<RequestGrantResponse> {
  // A deployment that cannot push must not record a grant it can never deliver (plan §2).
  requireGrantPushWorkflow(deps.env)
  const { db } = deps
  const { tenantId } = viewer
  const now = nowOf(deps)
  const app = await getAppRow(db, tenantId, appId)
  if (!(await mayRequestFor(db, viewer, app))) {
    throw new ForbiddenError('Only the app’s owners and admins request shared config', 'forbidden')
  }
  const resource = await loadResource(db, tenantId, input.resourceId)
  if (resource.archivedAt) {
    throw new ConflictError(
      `${resource.displayName} is archived`,
      GRANT_ERROR_CODES.resourceArchived
    )
  }
  if (input.expiresAt && input.expiresAt <= now) {
    throw new BadRequestError(
      'A grant’s expiry must be in the future',
      GRANT_ERROR_CODES.expiryPast
    )
  }

  // Every refusal before the first row: a request for two environments is all or nothing.
  for (const environment of input.environments) {
    if (!(await activeVersion(db, tenantId, resource.id, environment))) {
      throw new ConflictError(
        `${resource.displayName} has no values for ${environment} yet`,
        GRANT_ERROR_CODES.valuesNotSet
      )
    }
  }
  const live = await db
    .select({ environment: appGrants.environment })
    .from(appGrants)
    .where(
      and(
        eq(appGrants.tenantId, tenantId),
        eq(appGrants.appId, app.id),
        eq(appGrants.resourceId, resource.id),
        inArray(appGrants.environment, input.environments),
        inArray(appGrants.status, [...LIVE_GRANT_STATUSES])
      )
    )
  const held = live[0]
  if (held) throw alreadyHeld(resource, held.environment)

  const declaredBy = await declaredByFor(db, tenantId, app.id, resource)
  const items = resource.items.map(i => ({ key: i.key, kind: i.kind }))
  const out: RequestGrantResponse['grants'] = []

  for (const environment of input.environments) {
    const [grant] = await db
      .insert(appGrants)
      .values({
        tenantId,
        appId: app.id,
        resourceId: resource.id,
        environment,
        status: 'requested',
        requestedByUserId: viewer.userId,
        reason: input.reason,
        expiresAt: input.expiresAt ?? null,
      })
      .onConflictDoNothing()
      .returning()
    // Another request won the live index between the check and the insert.
    if (!grant) throw alreadyHeld(resource, environment)
    const own = resource.policies[environment]
    const policy = own
      ? approvalPolicySchema.parse(own)
      : await resolvePolicy(db, tenantId, 'grant.request', app.id)
    let approvalId: string
    try {
      const opened = await openApproval(deps, {
        tenantId,
        kind: 'grant.request',
        subject: { type: 'grant', id: grant.id },
        appId: app.id,
        requester: { userId: viewer.userId, email: viewer.email, role: viewer.role },
        reason: input.reason,
        context: {
          kind: 'grant.request',
          resourceId: resource.id,
          resourceName: resource.displayName,
          environment,
          items,
          declaredBy,
          appSlug: app.slug,
          expiresAt: grant.expiresAt?.toISOString() ?? null,
        },
        policy,
        actor,
      })
      approvalId = opened.request.id
    } catch (err) {
      // No approval, no grant: a `requested` row nobody can decide would hold the live index.
      await db
        .delete(appGrants)
        .where(and(eq(appGrants.tenantId, tenantId), eq(appGrants.id, grant.id)))
      throw err
    }
    // Audited once the approval exists, so the row carries its id like every later grant row.
    await recordAudit(db, {
      tenantId,
      ...actor,
      action: 'grant.requested',
      targetType: 'grant',
      targetId: grant.id,
      appId: app.id,
      approvalId,
      summary: {
        after: {
          resourceId: resource.id,
          resource: resource.slug,
          environment,
          keys: items.map(i => i.key),
          expiresAt: grant.expiresAt?.toISOString() ?? null,
        },
      },
    })

    // An auto-approve already set it (in `applyInTx`); the ordinary path links it here.
    const [linked] = await db
      .update(appGrants)
      .set({ approvalId })
      .where(and(eq(appGrants.tenantId, tenantId), eq(appGrants.id, grant.id)))
      .returning()
    out.push({
      id: grant.id,
      environment,
      approvalId,
      status: linked?.status ?? grant.status,
    })
  }
  nudgeAppConfig(deps.realtime, tenantId, app.id)
  return { grants: out }
}

// ---- re-pushing --------------------------------------------------------------------------------

export async function repushGrant(
  deps: GrantDeps,
  viewer: GrantViewer,
  appId: string,
  grantId: string,
  actor: AuditActor
): Promise<GrantActionResponse> {
  requireGrantPushWorkflow(deps.env)
  const { db } = deps
  const { tenantId } = viewer
  const app = await getAppRow(db, tenantId, appId)
  const grant = await findGrant(db, tenantId, app.id, grantId)
  if (!grant) throw new NotFoundError('Grant not found', 'grant_not_found')
  const resource = await loadResource(db, tenantId, grant.resourceId)
  if (!(ownsResource(viewer, resource) || (await mayRequestFor(db, viewer, app)))) {
    throw new ForbiddenError(
      'Only the app’s owners, the resource’s owners and admins re-push a grant',
      'forbidden'
    )
  }
  if (grant.status !== 'active') {
    throw new ConflictError(
      `The grant is ${grant.status}; only an active grant is re-pushed`,
      GRANT_ERROR_CODES.grantNotActive
    )
  }
  const version = await activeVersion(db, tenantId, grant.resourceId, grant.environment)
  if (!version) {
    throw new ConflictError(
      `${resource.displayName} has no values for ${grant.environment}`,
      GRANT_ERROR_CODES.valuesNotSet
    )
  }
  const { pushId } = await startPush(deps, {
    tenantId,
    resourceId: grant.resourceId,
    environment: grant.environment,
    reason: 'repair',
    grantId: grant.id,
    versionId: version.id,
    startedByUserId: viewer.userId,
  })
  await recordAudit(db, {
    tenantId,
    ...actor,
    action: 'grant.repushed',
    targetType: 'grant',
    targetId: grant.id,
    appId: app.id,
    approvalId: grant.approvalId,
    summary: { after: { pushId, environment: grant.environment, version: version.version } },
  })
  nudgeAppConfig(deps.realtime, tenantId, app.id)
  return { grant: await appGrantView(db, tenantId, app.id, grant.id), pushId }
}
