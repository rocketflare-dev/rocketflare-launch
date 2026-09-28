/**
 * Shared resources (Launch P5, plan §1.1, §1.3, §4 5b) — the bundle, its owner group and its
 * policies, behind `/api/shared-resources`:
 *
 * - `listResources`: every resource of the tenant (members read — they need the names to ask),
 *   each environment's value status, never a value;
 * - `getResource`: the detail — `holders`, the running pushes and the var values only for owners
 *   and admins (`access.ts`), `canManage` / `canSetValues` for this viewer;
 * - `createResource` (admins), `patchResource` (owners: name, description, items; admins also the
 *   owner group and the policies — 403 `not_resource_admin`), `archiveResource` (admins; 409
 *   `resource_has_holders` while a live grant exists — archiving refuses, it never cascades a
 *   revoke, because a revoke is a push the resource's owners should see happen grant by grant);
 * - `loadResource`: the row by id in the tenant, 404 otherwise — for the other slices.
 *
 * An archived resource takes no new values, items or policies (409 `shared_resource_archived`);
 * the one edit it still takes is an admin moving its OWNER GROUP, because the row keeps that group
 * from being deleted (`groups.ts`' 409 `group_owns_shared_config`) and moving it is the way out.
 *
 * Reading which keys a version carries means opening it: the sealed blob is the only record of
 * them. That happens here, server-side; a var's VALUE leaves only in `vars`, for owners and admins.
 * A secret's value never leaves this module in any form.
 *
 * Audited `shared_resource.created|updated|archived`, in the same transaction as the write. Every
 * query names the tenant.
 *
 * **Slice 5b owns this file.**
 */
import { APP_ENVIRONMENT_NAMES, type AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  ACTIVE_GRANT_PUSH_STATUSES,
  type CreateSharedResourceRequest,
  GRANT_ERROR_CODES,
  type GrantPushSummary,
  LIVE_GRANT_STATUSES,
  type PatchSharedResourceRequest,
  type SharedResource,
  type SharedResourceDetail,
  type SharedResourceEnvironment,
  type SharedResourceHolder,
  type SharedResourceItem,
  type SharedResourceListQuery,
  type SharedResourceListResponse,
} from '@launch/shared/launch-grants'
import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import {
  appGrants,
  apps,
  grantPushes,
  groups,
  type SharedResourceRow,
  sharedResources,
  sharedResourceValues,
  users,
} from '../../../db/schema'
import {
  ConflictError,
  ForbiddenError,
  isUniqueViolation,
  NotFoundError,
} from '../../utils/core/errors'
import { assertGroupsInTenant } from '../groups'
import { type AuditActor, recordAudit } from '../launch/audit'
import { canManageResource, canSeeHolders, isResourceOwner } from './access'
import { openValues } from './sealed'
import type { GrantViewer } from './types'

const DAY_MS = 24 * 60 * 60 * 1000

/** The transaction as the `Database` every helper takes (the kit's cast). */
function inTransaction<T>(db: Database, fn: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async tx => fn(tx as unknown as Database))
}

// ---- reading -----------------------------------------------------------------------------------

export async function listResources(
  db: Database,
  cfg: AppConfig,
  viewer: GrantViewer,
  query: SharedResourceListQuery
): Promise<SharedResourceListResponse> {
  const rows = await db
    .select({ resource: sharedResources, ownerGroupName: groups.name })
    .from(sharedResources)
    .innerJoin(
      groups,
      and(eq(groups.id, sharedResources.ownerGroupId), eq(groups.tenantId, viewer.tenantId))
    )
    .where(
      and(
        eq(sharedResources.tenantId, viewer.tenantId),
        query.archived ? undefined : isNull(sharedResources.archivedAt)
      )
    )
    .orderBy(asc(sharedResources.displayName), asc(sharedResources.slug))
  // The list carries no values at all, not even to owners: `vars` is the detail's.
  const environments = await environmentStatuses(
    db,
    cfg,
    viewer.tenantId,
    rows.map(r => r.resource),
    new Set()
  )
  return {
    items: rows.map(({ resource, ownerGroupName }) =>
      toSummary(resource, ownerGroupName, environments.get(resource.id) ?? [])
    ),
  }
}

export async function getResource(
  db: Database,
  cfg: AppConfig,
  viewer: GrantViewer,
  id: string
): Promise<SharedResourceDetail> {
  const resource = await loadResource(db, viewer.tenantId, id)
  const [group] = await db
    .select({ name: groups.name })
    .from(groups)
    .where(and(eq(groups.tenantId, viewer.tenantId), eq(groups.id, resource.ownerGroupId)))
  const insider = canSeeHolders(viewer, resource)
  const environments = await environmentStatuses(
    db,
    cfg,
    viewer.tenantId,
    [resource],
    insider ? new Set([resource.id]) : new Set()
  )
  const detail: SharedResourceDetail = {
    ...toSummary(resource, group?.name ?? '', environments.get(resource.id) ?? []),
    policies: resource.policies ?? {},
    createdByUserId: resource.createdByUserId,
    activePushes: insider ? await activePushesOf(db, resource) : [],
    canManage: canManageResource(viewer, resource),
    canSetValues: insider && resource.archivedAt === null,
  }
  if (insider) detail.holders = await holdersOf(db, resource)
  return detail
}

export async function loadResource(
  db: Database,
  tenantId: string,
  id: string
): Promise<SharedResourceRow> {
  const [row] = await db
    .select()
    .from(sharedResources)
    .where(and(eq(sharedResources.tenantId, tenantId), eq(sharedResources.id, id)))
  if (!row) throw new NotFoundError('Shared resource not found')
  return row
}

function toSummary(
  resource: SharedResourceRow,
  ownerGroupName: string,
  environments: SharedResourceEnvironment[]
): SharedResource {
  return {
    id: resource.id,
    slug: resource.slug,
    displayName: resource.displayName,
    description: resource.description,
    ownerGroup: { id: resource.ownerGroupId, name: ownerGroupName },
    items: resource.items,
    environments,
    archivedAt: resource.archivedAt,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  }
}

/**
 * Each resource's value status per environment: the active version (who set it, when, which keys,
 * which secrets are past their `rotationDays`), the versions still `retiring`, and how many apps
 * hold it (`active` grants). `withVars` names the resources whose VAR values this viewer may see.
 */
async function environmentStatuses(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  resources: readonly SharedResourceRow[],
  withVars: ReadonlySet<string>
): Promise<Map<string, SharedResourceEnvironment[]>> {
  const out = new Map<string, SharedResourceEnvironment[]>()
  if (resources.length === 0) return out
  const ids = resources.map(r => r.id)
  const versions = await db
    .select({
      value: sharedResourceValues,
      setBy: { id: users.id, name: users.name, email: users.email },
    })
    .from(sharedResourceValues)
    .leftJoin(users, eq(users.id, sharedResourceValues.setByUserId))
    .where(
      and(
        eq(sharedResourceValues.tenantId, tenantId),
        inArray(sharedResourceValues.resourceId, ids),
        inArray(sharedResourceValues.status, ['active', 'retiring'])
      )
    )
    .orderBy(asc(sharedResourceValues.version))
  const holders = await db
    .select({
      resourceId: appGrants.resourceId,
      environment: appGrants.environment,
      n: count(),
    })
    .from(appGrants)
    .where(
      and(
        eq(appGrants.tenantId, tenantId),
        inArray(appGrants.resourceId, ids),
        eq(appGrants.status, 'active')
      )
    )
    .groupBy(appGrants.resourceId, appGrants.environment)
  const now = Date.now()
  for (const resource of resources) {
    const envs: SharedResourceEnvironment[] = []
    for (const environment of APP_ENVIRONMENT_NAMES) {
      const mine = versions.filter(
        v => v.value.resourceId === resource.id && v.value.environment === environment
      )
      const active = mine.find(v => v.value.status === 'active')
      const holderCount =
        holders.find(h => h.resourceId === resource.id && h.environment === environment)?.n ?? 0
      const status: SharedResourceEnvironment = {
        environment,
        version: active?.value.version ?? null,
        versionId: active?.value.id ?? null,
        setAt: active?.value.setAt ?? null,
        setBy: active?.setBy ? { ...active.setBy } : null,
        keysSet: [],
        retiringVersions: mine.filter(v => v.value.status === 'retiring').map(v => v.value.version),
        rotationDue: [],
        holderCount: Number(holderCount),
      }
      if (active) {
        const values = await openValues(cfg, active.value.sealed)
        status.keysSet = resource.items.map(i => i.key).filter(key => key in values)
        const age = now - active.value.setAt.getTime()
        status.rotationDue = resource.items
          .filter(
            i =>
              i.kind === 'secret' &&
              i.rotationDays !== undefined &&
              i.key in values &&
              age >= i.rotationDays * DAY_MS
          )
          .map(i => i.key)
        if (withVars.has(resource.id)) {
          status.vars = Object.fromEntries(
            resource.items
              .filter(i => i.kind === 'var' && i.key in values)
              .map(i => [i.key, values[i.key] as string])
          )
        }
      }
      envs.push(status)
    }
    out.set(resource.id, envs)
  }
  return out
}

/** The apps holding (or asking for, or losing) the resource — owners and admins only. */
async function holdersOf(
  db: Database,
  resource: SharedResourceRow
): Promise<SharedResourceHolder[]> {
  const rows = await db
    .select({
      grant: appGrants,
      app: { id: apps.id, slug: apps.slug, displayName: apps.displayName },
      pushedVersion: sharedResourceValues.version,
    })
    .from(appGrants)
    .innerJoin(apps, and(eq(apps.id, appGrants.appId), eq(apps.tenantId, resource.tenantId)))
    .leftJoin(
      sharedResourceValues,
      and(
        eq(sharedResourceValues.id, appGrants.pushedVersionId),
        eq(sharedResourceValues.tenantId, resource.tenantId)
      )
    )
    .where(
      and(
        eq(appGrants.tenantId, resource.tenantId),
        eq(appGrants.resourceId, resource.id),
        inArray(appGrants.status, [...LIVE_GRANT_STATUSES])
      )
    )
    .orderBy(asc(apps.slug), asc(appGrants.environment))
  return rows.map(({ grant, app, pushedVersion }) => ({
    grantId: grant.id,
    app,
    environment: grant.environment,
    status: grant.status,
    pushedVersion: pushedVersion ?? null,
    pushedAt: grant.pushedAt,
    pushError: grant.pushError,
    expiresAt: grant.expiresAt,
  }))
}

/** The push running now per environment (queued or running), for the progress bar. */
async function activePushesOf(
  db: Database,
  resource: SharedResourceRow
): Promise<GrantPushSummary[]> {
  const rows = await db
    .select({ push: grantPushes, version: sharedResourceValues.version })
    .from(grantPushes)
    .leftJoin(
      sharedResourceValues,
      and(
        eq(sharedResourceValues.id, grantPushes.versionId),
        eq(sharedResourceValues.tenantId, resource.tenantId)
      )
    )
    .where(
      and(
        eq(grantPushes.tenantId, resource.tenantId),
        eq(grantPushes.resourceId, resource.id),
        inArray(grantPushes.status, [...ACTIVE_GRANT_PUSH_STATUSES])
      )
    )
    .orderBy(desc(grantPushes.createdAt))
  return rows.map(({ push, version }) => ({
    id: push.id,
    resourceId: push.resourceId,
    environment: push.environment,
    reason: push.reason,
    grantId: push.grantId,
    versionId: push.versionId,
    version: version ?? null,
    approvalId: push.approvalId,
    status: push.status,
    total: push.total,
    succeeded: push.succeeded,
    failed: push.failed,
    startedByUserId: push.startedByUserId,
    createdAt: push.createdAt,
    updatedAt: push.updatedAt,
    finishedAt: push.finishedAt,
  }))
}

// ---- writing -----------------------------------------------------------------------------------

function refuseUnlessAdmin(
  viewer: GrantViewer,
  resource: Pick<SharedResourceRow, 'tenantId' | 'ownerGroupId'>
): void {
  if (!canManageResource(viewer, resource)) {
    throw new ForbiddenError(
      'Only an organisation admin can do this to shared config',
      GRANT_ERROR_CODES.notResourceAdmin
    )
  }
}

/** The facts of an item list an audit row keeps: keys, kinds and rotation, never a value. */
function itemFacts(items: readonly SharedResourceItem[]) {
  return items.map(i => ({
    key: i.key,
    kind: i.kind,
    ...(i.rotationDays !== undefined ? { rotationDays: i.rotationDays } : {}),
  }))
}

export async function createResource(
  db: Database,
  cfg: AppConfig,
  viewer: GrantViewer,
  input: CreateSharedResourceRequest,
  actor: AuditActor
): Promise<SharedResourceDetail> {
  refuseUnlessAdmin(viewer, { tenantId: viewer.tenantId, ownerGroupId: input.ownerGroupId })
  await assertGroupsInTenant(db, viewer.tenantId, [input.ownerGroupId])
  let created: SharedResourceRow
  try {
    created = await inTransaction(db, async tx => {
      const [row] = await tx
        .insert(sharedResources)
        .values({
          tenantId: viewer.tenantId,
          slug: input.slug,
          displayName: input.displayName,
          description: input.description || null,
          ownerGroupId: input.ownerGroupId,
          items: input.items,
          policies: input.policies ?? {},
          createdByUserId: viewer.userId,
        })
        .returning()
      if (!row) throw new Error('shared_resources insert returned no row')
      await recordAudit(tx, {
        tenantId: viewer.tenantId,
        ...actor,
        action: 'shared_resource.created',
        targetType: 'shared_resource',
        targetId: row.id,
        summary: {
          after: {
            slug: row.slug,
            displayName: row.displayName,
            ownerGroupId: row.ownerGroupId,
            items: itemFacts(row.items),
            policies: row.policies ?? {},
          },
        },
      })
      return row
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(
        `A shared resource called "${input.slug}" already exists`,
        GRANT_ERROR_CODES.slugTaken
      )
    }
    throw err
  }
  return getResource(db, cfg, viewer, created.id)
}

export async function patchResource(
  db: Database,
  cfg: AppConfig,
  viewer: GrantViewer,
  id: string,
  patch: PatchSharedResourceRequest,
  actor: AuditActor
): Promise<SharedResourceDetail> {
  const resource = await loadResource(db, viewer.tenantId, id)
  const admin = canManageResource(viewer, resource)
  if (!admin && !isResourceOwner(viewer, resource)) {
    throw new ForbiddenError(
      "Only the resource's owner group or an admin can edit it",
      GRANT_ERROR_CODES.notResourceOwner
    )
  }
  if ((patch.ownerGroupId !== undefined || patch.policies !== undefined) && !admin) {
    throw new ForbiddenError(
      'Only an organisation admin can change the owner group or the approval policies',
      GRANT_ERROR_CODES.notResourceAdmin
    )
  }
  const onlyOwnerGroup = Object.entries(patch).every(
    ([field, value]) => field === 'ownerGroupId' || value === undefined
  )
  if (resource.archivedAt && !onlyOwnerGroup) {
    throw new ConflictError(
      'This shared resource is archived; only its owner group can still change',
      GRANT_ERROR_CODES.resourceArchived
    )
  }
  if (patch.ownerGroupId !== undefined) {
    await assertGroupsInTenant(db, viewer.tenantId, [patch.ownerGroupId])
  }

  const set: Partial<typeof sharedResources.$inferInsert> = {}
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const change = <K extends keyof typeof set>(field: K, next: (typeof set)[K], prev: unknown) => {
    if (JSON.stringify(next) === JSON.stringify(prev)) return
    set[field] = next
    const fact = field === 'items' ? itemFacts : (v: unknown) => v
    before[field] = fact(prev as never)
    after[field] = fact(next as never)
  }
  if (patch.displayName !== undefined) {
    change('displayName', patch.displayName, resource.displayName)
  }
  if (patch.description !== undefined) {
    change('description', patch.description || null, resource.description)
  }
  if (patch.items !== undefined) change('items', patch.items, resource.items)
  if (patch.ownerGroupId !== undefined) {
    change('ownerGroupId', patch.ownerGroupId, resource.ownerGroupId)
  }
  if (patch.policies !== undefined) change('policies', patch.policies, resource.policies)

  if (Object.keys(set).length > 0) {
    await inTransaction(db, async tx => {
      await tx
        .update(sharedResources)
        .set({ ...set, updatedAt: new Date() })
        .where(and(eq(sharedResources.tenantId, viewer.tenantId), eq(sharedResources.id, id)))
      await recordAudit(tx, {
        tenantId: viewer.tenantId,
        ...actor,
        action: 'shared_resource.updated',
        targetType: 'shared_resource',
        targetId: id,
        summary: { before: { slug: resource.slug, ...before }, after },
      })
    })
  }
  return getResource(db, cfg, viewer, id)
}

export async function archiveResource(
  db: Database,
  viewer: GrantViewer,
  id: string,
  actor: AuditActor
): Promise<void> {
  const resource = await loadResource(db, viewer.tenantId, id)
  refuseUnlessAdmin(viewer, resource)
  if (resource.archivedAt) return
  await inTransaction(db, async tx => {
    // Lock the row so a grant opened meanwhile is seen, or waits for the archive and is refused.
    await tx
      .select({ id: sharedResources.id })
      .from(sharedResources)
      .where(and(eq(sharedResources.tenantId, viewer.tenantId), eq(sharedResources.id, id)))
      .for('update')
    const live = await tx
      .select({ environment: appGrants.environment, n: count() })
      .from(appGrants)
      .where(
        and(
          eq(appGrants.tenantId, viewer.tenantId),
          eq(appGrants.resourceId, id),
          inArray(appGrants.status, [...LIVE_GRANT_STATUSES])
        )
      )
      .groupBy(appGrants.environment)
    const total = live.reduce((sum, r) => sum + Number(r.n), 0)
    if (total > 0) {
      const byEnv = Object.fromEntries(live.map(r => [r.environment, Number(r.n)])) as Partial<
        Record<AppEnvironmentName, number>
      >
      throw new ConflictError(
        `${total} app grant${total === 1 ? '' : 's'} still hold or await this resource; revoke them first`,
        GRANT_ERROR_CODES.resourceHasHolders,
        { holders: byEnv }
      )
    }
    const now = new Date()
    await tx
      .update(sharedResources)
      .set({ archivedAt: now, updatedAt: now })
      .where(and(eq(sharedResources.tenantId, viewer.tenantId), eq(sharedResources.id, id)))
    await recordAudit(tx, {
      tenantId: viewer.tenantId,
      ...actor,
      action: 'shared_resource.archived',
      targetType: 'shared_resource',
      targetId: id,
      summary: { before: { slug: resource.slug, archivedAt: null }, after: { archivedAt: now } },
    })
  })
}
