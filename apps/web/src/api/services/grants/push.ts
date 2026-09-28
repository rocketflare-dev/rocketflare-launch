/**
 * `GRANT_PUSH` — starting, retrying and reading pushes (Launch P5, plan §1.10, §1.12, §4 5c). The
 * Workflow's step bodies are in `push-steps.ts` (`workflows/grant-push.ts` is the thin class):
 *
 * - `startPush`: `requireGrantPushWorkflow` first, then one `grant_pushes` row (409
 *   `push_in_progress` on the active index; an `approvalId` that already has a push returns it,
 *   `created: false`), then `GRANT_PUSH_WORKFLOW.create({ id: pushId, params: { tenantId, pushId } })`.
 *   Audited `grant.push.started`;
 * - `retryPush`: a `partial` / `failed` push starts again as `<pushId>-rN` — succeeded targets and
 *   grants already holding a newer version are skipped (`POST …/pushes/:pushId/retry`). 409
 *   `push_in_progress` while another push of the environment runs, 409 `push_not_retryable` for a
 *   push that is running or succeeded. Audited `grant.push.retried`;
 * - `listPushes`, `getPush`: `GET /api/shared-resources/:id/pushes[/:pushId]`.
 *
 * Reading and retrying is for the resource's OWNERS (its owner group's members) and admins; anyone
 * else gets the same 404 as a push that does not exist (plan §1.3 — members may not see who holds a
 * resource, and a push's targets are exactly that).
 *
 * Values are decrypted INSIDE a step (`sealed.openValues`), registered for redaction, never
 * returned. The script is `app_environments.worker_name` (missing → a failed target,
 * `app_has_no_worker`). Each settled target nudges `entity.changed { entity: 'grant_push' }`.
 *
 * **Slice 5c owns this file.**
 */
import {
  GRANT_ERROR_CODES,
  GRANT_PUSH_REALTIME_ENTITY,
  type GrantPush,
  type GrantPushListQuery,
  type GrantPushListResponse,
  type GrantPushSummary,
  type GrantPushTarget,
  SHARED_RESOURCE_REALTIME_ENTITY,
} from '@launch/shared/launch-grants'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  apps,
  type GrantPushRow,
  grantPushes,
  grantPushTargets,
  type SharedResourceRow,
  sharedResourceValues,
} from '../../../db/schema'
import { ConflictError, isUniqueViolation, NotFoundError } from '../../utils/core/errors'
import { type AuditActor, recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import { nudge, type Realtime, realtimeEvent } from '../realtime'
import { canSeeHolders } from './access'
import { loadResource } from './resources'
import {
  type GrantDeps,
  type GrantPushStarter,
  type GrantViewer,
  requireGrantPushWorkflow,
  type StartPushInput,
  type StartPushResult,
} from './types'

/** How many `-rN` suffixes a push may use before a retry is refused. */
const MAX_RETRY_SUFFIX = 50

/** The resource, when the viewer may see its pushes; the same 404 otherwise. */
async function resourceForPushes(
  db: Database,
  viewer: GrantViewer,
  resourceId: string
): Promise<SharedResourceRow> {
  const resource = await loadResource(db, viewer.tenantId, resourceId)
  if (!canSeeHolders(viewer, resource)) throw new NotFoundError('Shared resource not found')
  return resource
}

// ---- nudges ------------------------------------------------------------------------------------

/** `entity.changed { entity: 'grant_push' }` and the resource's own — the progress bar refreshes. */
export function nudgePush(
  realtime: Realtime | undefined,
  push: Pick<GrantPushRow, 'id' | 'tenantId' | 'resourceId'>
): void {
  nudge(
    realtime,
    realtimeEvent('entity.changed', push.tenantId, {
      entity: GRANT_PUSH_REALTIME_ENTITY,
      id: push.id,
      resourceId: push.resourceId,
    })
  )
  nudge(
    realtime,
    realtimeEvent('entity.changed', push.tenantId, {
      entity: SHARED_RESOURCE_REALTIME_ENTITY,
      id: push.resourceId,
    })
  )
}

// ---- starting ----------------------------------------------------------------------------------

async function pushByApproval(
  db: Database,
  tenantId: string,
  approvalId: string
): Promise<GrantPushRow | null> {
  const [row] = await db
    .select()
    .from(grantPushes)
    .where(and(eq(grantPushes.tenantId, tenantId), eq(grantPushes.approvalId, approvalId)))
  return row ?? null
}

function startActor(userId: string | null | undefined): AuditActor {
  return userId ? { ...SYSTEM_ACTOR, actorType: 'user', actorUserId: userId } : SYSTEM_ACTOR
}

async function markStartFailed(db: Database, push: GrantPushRow): Promise<void> {
  await db
    .update(grantPushes)
    .set({ status: 'failed', finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(grantPushes.tenantId, push.tenantId), eq(grantPushes.id, push.id)))
}

export async function startPush(deps: GrantDeps, input: StartPushInput): Promise<StartPushResult> {
  const workflow = requireGrantPushWorkflow(deps.env)
  const { db } = deps
  if (input.approvalId) {
    const existing = await pushByApproval(db, input.tenantId, input.approvalId)
    if (existing) return { pushId: existing.id, created: false }
  }
  let push: GrantPushRow | undefined
  try {
    ;[push] = await db
      .insert(grantPushes)
      .values({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        environment: input.environment,
        reason: input.reason,
        grantId: input.grantId ?? null,
        versionId: input.versionId,
        approvalId: input.approvalId ?? null,
        status: 'queued',
        startedByUserId: input.startedByUserId ?? null,
      })
      .returning()
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // A retried `applyAfter` racing its first attempt finds the push that attempt made.
    if (input.approvalId) {
      const existing = await pushByApproval(db, input.tenantId, input.approvalId)
      if (existing) return { pushId: existing.id, created: false }
    }
    throw new ConflictError(
      `A push of this resource's ${input.environment} values is already running`,
      GRANT_ERROR_CODES.pushInProgress
    )
  }
  if (!push) throw new Error('grant_pushes insert returned no row')

  try {
    await workflow.create({ id: push.id, params: { tenantId: push.tenantId, pushId: push.id } })
  } catch (err) {
    // The row must not hold the environment's one active slot for a push that never started.
    await markStartFailed(db, push)
    throw err
  }
  await db
    .update(grantPushes)
    .set({ instanceId: push.id, updatedAt: new Date() })
    .where(and(eq(grantPushes.tenantId, push.tenantId), eq(grantPushes.id, push.id)))
  await recordAudit(db, {
    ...startActor(input.startedByUserId),
    tenantId: push.tenantId,
    action: 'grant.push.started',
    targetType: 'grant_push',
    targetId: push.id,
    approvalId: push.approvalId,
    summary: {
      after: {
        resourceId: push.resourceId,
        environment: push.environment,
        reason: push.reason,
        grantId: push.grantId,
        versionId: push.versionId,
      },
    },
  })
  nudgePush(deps.realtime, push)
  return { pushId: push.id, created: true }
}

// ---- retrying ----------------------------------------------------------------------------------

async function createNextInstance(starter: GrantPushStarter, push: GrantPushRow): Promise<string> {
  for (let n = 1; n <= MAX_RETRY_SUFFIX; n++) {
    const id = `${push.id}-r${n}`
    try {
      await starter.create({ id, params: { tenantId: push.tenantId, pushId: push.id } })
      return id
    } catch (err) {
      if (err instanceof Error && /already.?exists/i.test(err.message)) continue
      throw err
    }
  }
  throw new ConflictError('This push has been retried too many times', 'retry_limit')
}

export async function retryPush(
  deps: GrantDeps,
  viewer: GrantViewer,
  resourceId: string,
  pushId: string,
  actor: AuditActor
): Promise<GrantPush> {
  const { db } = deps
  const workflow = requireGrantPushWorkflow(deps.env)
  await resourceForPushes(db, viewer, resourceId)
  const push = await loadPush(db, viewer.tenantId, resourceId, pushId)
  if (push.status !== 'partial' && push.status !== 'failed') {
    throw new ConflictError(
      push.status === 'succeeded'
        ? 'This push reached every holder; there is nothing to retry'
        : 'This push is still running',
      push.status === 'succeeded'
        ? GRANT_ERROR_CODES.pushNotRetryable
        : GRANT_ERROR_CODES.pushInProgress
    )
  }
  let claimed: GrantPushRow | undefined
  try {
    ;[claimed] = await db
      .update(grantPushes)
      .set({ status: 'queued', finishedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(grantPushes.tenantId, push.tenantId),
          eq(grantPushes.id, push.id),
          inArray(grantPushes.status, ['partial', 'failed'])
        )
      )
      .returning()
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    throw new ConflictError(
      `Another push of this resource's ${push.environment} values is running`,
      GRANT_ERROR_CODES.pushInProgress
    )
  }
  if (!claimed) {
    throw new ConflictError('This push is already being retried', GRANT_ERROR_CODES.pushInProgress)
  }
  let instanceId: string
  try {
    instanceId = await createNextInstance(workflow, claimed)
  } catch (err) {
    await db
      .update(grantPushes)
      .set({ status: push.status, finishedAt: push.finishedAt, updatedAt: new Date() })
      .where(and(eq(grantPushes.tenantId, push.tenantId), eq(grantPushes.id, push.id)))
    throw err
  }
  await db
    .update(grantPushes)
    .set({ instanceId, updatedAt: new Date() })
    .where(and(eq(grantPushes.tenantId, push.tenantId), eq(grantPushes.id, push.id)))
  await recordAudit(db, {
    ...actor,
    tenantId: push.tenantId,
    action: 'grant.push.retried',
    targetType: 'grant_push',
    targetId: push.id,
    approvalId: push.approvalId,
    summary: {
      before: { status: push.status, failed: push.failed },
      after: { status: 'queued', instanceId },
    },
  })
  nudgePush(deps.realtime, push)
  return getPush(db, viewer, resourceId, pushId)
}

// ---- reading -----------------------------------------------------------------------------------

export async function loadPush(
  db: Database,
  tenantId: string,
  resourceId: string,
  pushId: string
): Promise<GrantPushRow> {
  const [row] = await db
    .select()
    .from(grantPushes)
    .where(
      and(
        eq(grantPushes.tenantId, tenantId),
        eq(grantPushes.resourceId, resourceId),
        eq(grantPushes.id, pushId)
      )
    )
  if (!row) throw new NotFoundError('Push not found')
  return row
}

async function versionNumbers(
  db: Database,
  tenantId: string,
  ids: readonly (string | null)[]
): Promise<Map<string, number>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (wanted.length === 0) return new Map()
  const rows = await db
    .select({ id: sharedResourceValues.id, version: sharedResourceValues.version })
    .from(sharedResourceValues)
    .where(
      and(eq(sharedResourceValues.tenantId, tenantId), inArray(sharedResourceValues.id, wanted))
    )
  return new Map(rows.map(r => [r.id, r.version]))
}

export function toPushSummary(row: GrantPushRow, version: number | null): GrantPushSummary {
  return {
    id: row.id,
    resourceId: row.resourceId,
    environment: row.environment,
    reason: row.reason,
    grantId: row.grantId,
    versionId: row.versionId,
    version,
    approvalId: row.approvalId,
    status: row.status,
    total: row.total,
    succeeded: row.succeeded,
    failed: row.failed,
    startedByUserId: row.startedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  }
}

export async function listPushes(
  db: Database,
  viewer: GrantViewer,
  resourceId: string,
  query: GrantPushListQuery
): Promise<GrantPushListResponse> {
  await resourceForPushes(db, viewer, resourceId)
  const rows = await db
    .select()
    .from(grantPushes)
    .where(
      and(
        eq(grantPushes.tenantId, viewer.tenantId),
        eq(grantPushes.resourceId, resourceId),
        query.environment ? eq(grantPushes.environment, query.environment) : undefined
      )
    )
    .orderBy(desc(grantPushes.createdAt), desc(grantPushes.id))
    .limit(query.limit)
  const versions = await versionNumbers(
    db,
    viewer.tenantId,
    rows.map(r => r.versionId)
  )
  return {
    items: rows.map(r =>
      toPushSummary(r, r.versionId ? (versions.get(r.versionId) ?? null) : null)
    ),
  }
}

export async function getPush(
  db: Database,
  viewer: GrantViewer,
  resourceId: string,
  pushId: string
): Promise<GrantPush> {
  await resourceForPushes(db, viewer, resourceId)
  const push = await loadPush(db, viewer.tenantId, resourceId, pushId)
  const versions = await versionNumbers(db, viewer.tenantId, [push.versionId])
  const rows = await db
    .select({
      target: grantPushTargets,
      app: { id: apps.id, slug: apps.slug, displayName: apps.displayName },
    })
    .from(grantPushTargets)
    .innerJoin(apps, and(eq(apps.id, grantPushTargets.appId), eq(apps.tenantId, viewer.tenantId)))
    .where(
      and(eq(grantPushTargets.tenantId, viewer.tenantId), eq(grantPushTargets.pushId, push.id))
    )
    .orderBy(asc(apps.slug), asc(grantPushTargets.id))
  const targets: GrantPushTarget[] = rows.map(({ target, app }) => ({
    id: target.id,
    grantId: target.grantId,
    app,
    status: target.status,
    attempts: target.attempts,
    error: target.error,
    names: target.names,
    shadowedVars: target.shadowedVars,
    finishedAt: target.finishedAt,
  }))
  return {
    ...toPushSummary(push, push.versionId ? (versions.get(push.versionId) ?? null) : null),
    targets,
  }
}
