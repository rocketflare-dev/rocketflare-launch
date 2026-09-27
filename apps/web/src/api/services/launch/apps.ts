/**
 * The app registry's reads and edits (spec/06): the catalogue, one app's detail, its health
 * history and operations log, and the admin edit. Import lives in `import.ts`, the poller in
 * `health.ts`, the OIDC client in `oidc-clients.ts` — this module is what they all serialise
 * through, so the wire shape of an environment is written once.
 *
 * Every query names the caller's tenant. The slug is globally unique (hostnames are global), but
 * a lookup BY slug is still tenant-first: another tenant's app is a 404, never a leak.
 */
import type {
  AppDetail,
  AppEnvironment,
  AppEnvironmentName,
  AppEnvironmentSummary,
  AppHealthResponse,
  AppOperation,
  AppOwnerGroup,
  AppSummary,
  UpdateAppRequest,
} from '@launch/shared/launch-apps'
import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  type AppEnvironmentRow,
  type AppRow,
  appEnvironments,
  appHealthChecks,
  appOperations,
  apps,
  groups,
} from '../../../db/schema'
import { BadRequestError, NotFoundError } from '../../utils/core/errors'
import { type AuditActor, recordAudit } from './audit'

/** Staging before production, everywhere an app's environments are listed. */
const ENVIRONMENT_ORDER: Record<AppEnvironmentName, number> = { staging: 0, production: 1 }

export function byEnvironmentOrder(
  a: { name: AppEnvironmentName },
  b: { name: AppEnvironmentName }
) {
  return ENVIRONMENT_ORDER[a.name] - ENVIRONMENT_ORDER[b.name]
}

export function toEnvironmentSummary(row: AppEnvironmentRow): AppEnvironmentSummary {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    healthStatus: row.healthStatus,
    healthCheckedAt: row.healthCheckedAt,
    healthChangedAt: row.healthChangedAt,
    healthVersion: row.healthVersion,
    healthLatencyMs: row.healthLatencyMs,
    healthError: row.healthError,
  }
}

export function toEnvironment(row: AppEnvironmentRow): AppEnvironment {
  return {
    ...toEnvironmentSummary(row),
    workerName: row.workerName,
    resources: row.resources ?? {},
    lastDeployVersion: row.lastDeployVersion,
    lastDeployAt: row.lastDeployAt,
    lastDeployBy: row.lastDeployBy,
  }
}

function toSummary(
  app: AppRow,
  ownerGroup: AppOwnerGroup | null,
  environments: AppEnvironmentRow[]
): AppSummary {
  return {
    id: app.id,
    slug: app.slug,
    displayName: app.displayName,
    description: app.description,
    status: app.status,
    source: app.source,
    template: app.template,
    templateVersion: app.templateVersion,
    repoOwner: app.repoOwner,
    repoName: app.repoName,
    ownerGroup,
    environments: [...environments].sort(byEnvironmentOrder).map(toEnvironmentSummary),
    createdAt: app.createdAt,
  }
}

async function environmentsOf(
  db: Database,
  tenantId: string,
  appIds: string[]
): Promise<Map<string, AppEnvironmentRow[]>> {
  const byApp = new Map<string, AppEnvironmentRow[]>()
  if (appIds.length === 0) return byApp
  const rows = await db
    .select()
    .from(appEnvironments)
    .where(and(eq(appEnvironments.tenantId, tenantId), inArray(appEnvironments.appId, appIds)))
  for (const row of rows) byApp.set(row.appId, [...(byApp.get(row.appId) ?? []), row])
  return byApp
}

/** The group's `{ id, name }` when it is ours; a join, so the tenant predicate sits on both. */
function ownerGroupOf(row: { groupId: string | null; groupName: string | null }) {
  return row.groupId && row.groupName ? { id: row.groupId, name: row.groupName } : null
}

/** The whole catalogue, by display name. */
export async function listApps(db: Database, tenantId: string): Promise<AppSummary[]> {
  const rows = await db
    .select({ app: apps, groupId: groups.id, groupName: groups.name })
    .from(apps)
    .leftJoin(groups, and(eq(groups.id, apps.ownerGroupId), eq(groups.tenantId, tenantId)))
    .where(eq(apps.tenantId, tenantId))
    .orderBy(asc(apps.displayName), asc(apps.slug))
  const envs = await environmentsOf(
    db,
    tenantId,
    rows.map(r => r.app.id)
  )
  return rows.map(r => toSummary(r.app, ownerGroupOf(r), envs.get(r.app.id) ?? []))
}

/** One app by slug, with its environments in full. 404 when it is not this tenant's. */
export async function getAppDetail(
  db: Database,
  tenantId: string,
  slug: string
): Promise<AppDetail> {
  const [row] = await db
    .select({ app: apps, groupId: groups.id, groupName: groups.name })
    .from(apps)
    .leftJoin(groups, and(eq(groups.id, apps.ownerGroupId), eq(groups.tenantId, tenantId)))
    .where(and(eq(apps.tenantId, tenantId), eq(apps.slug, slug)))
  if (!row) throw new NotFoundError('App not found', 'app_not_found')
  const envs = (await environmentsOf(db, tenantId, [row.app.id])).get(row.app.id) ?? []
  const sorted = [...envs].sort(byEnvironmentOrder)
  return {
    ...toSummary(row.app, ownerGroupOf(row), sorted),
    templateContractVersion: row.app.templateContractVersion,
    defaultBranch: row.app.defaultBranch,
    environments: sorted.map(toEnvironment),
    updatedAt: row.app.updatedAt,
  }
}

/** The app row by id, tenant-first; 404 otherwise. What every `/:id/…` route starts with. */
export async function getAppRow(db: Database, tenantId: string, appId: string): Promise<AppRow> {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
  if (!row) throw new NotFoundError('App not found', 'app_not_found')
  return row
}

/** An owner group must be one of this tenant's groups — a 400, not a foreign-key error. */
export async function assertGroupInTenant(
  db: Database,
  tenantId: string,
  groupId: string
): Promise<void> {
  const [row] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.tenantId, tenantId), eq(groups.id, groupId)))
  if (!row) throw new BadRequestError('No such team in this organisation', 'unknown_group')
}

/** `PATCH /api/apps/:id`: name, description, owner team. Audited as `app.updated`. */
export async function updateApp(
  db: Database,
  tenantId: string,
  appId: string,
  patch: UpdateAppRequest,
  actor: AuditActor
): Promise<AppRow> {
  const before = await getAppRow(db, tenantId, appId)
  if (patch.ownerGroupId) await assertGroupInTenant(db, tenantId, patch.ownerGroupId)
  const set: Partial<AppRow> = { updatedAt: new Date() }
  if (patch.displayName !== undefined) set.displayName = patch.displayName
  if (patch.description !== undefined) set.description = patch.description || null
  if (patch.ownerGroupId !== undefined) set.ownerGroupId = patch.ownerGroupId
  return db.transaction(async tx => {
    const [after] = await tx
      .update(apps)
      .set(set)
      .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
      .returning()
    if (!after) throw new NotFoundError('App not found', 'app_not_found')
    const changed = (['displayName', 'description', 'ownerGroupId'] as const).filter(
      key => patch[key] !== undefined && before[key] !== after[key]
    )
    await recordAudit(tx, {
      tenantId,
      ...actor,
      action: 'app.updated',
      targetType: 'App',
      targetId: appId,
      appId,
      summary: {
        before: Object.fromEntries(changed.map(key => [key, before[key]])),
        after: Object.fromEntries(changed.map(key => [key, after[key]])),
      },
    })
    return after
  })
}

/** Every environment's checks within `hours` of `now`, oldest first. */
export async function listHealthHistory(
  db: Database,
  tenantId: string,
  appId: string,
  hours: number,
  now = new Date()
): Promise<AppHealthResponse> {
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000)
  const rows = await db
    .select({ check: appHealthChecks, environmentName: appEnvironments.name })
    .from(appHealthChecks)
    .innerJoin(
      appEnvironments,
      and(
        eq(appEnvironments.id, appHealthChecks.environmentId),
        eq(appEnvironments.tenantId, tenantId)
      )
    )
    .where(
      and(
        eq(appHealthChecks.tenantId, tenantId),
        eq(appEnvironments.appId, appId),
        gte(appHealthChecks.checkedAt, since)
      )
    )
    .orderBy(asc(appHealthChecks.checkedAt))
  return {
    since,
    items: rows.map(({ check, environmentName }) => ({
      id: check.id,
      environmentId: check.environmentId,
      environmentName,
      checkedAt: check.checkedAt,
      status: check.status,
      httpStatus: check.httpStatus,
      readyStatus: check.readyStatus,
      latencyMs: check.latencyMs,
      version: check.version,
      error: check.error,
    })),
  }
}

/** The operations log, newest first. */
export async function listOperations(
  db: Database,
  tenantId: string,
  appId: string,
  limit = 100
): Promise<AppOperation[]> {
  const rows = await db
    .select()
    .from(appOperations)
    .where(and(eq(appOperations.tenantId, tenantId), eq(appOperations.appId, appId)))
    .orderBy(desc(appOperations.createdAt), desc(appOperations.id))
    .limit(limit)
  return rows.map(row => ({
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    step: row.step,
    status: row.status,
    attempt: row.attempt,
    error: row.error,
    externalIds: row.externalIds ?? {},
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  }))
}
