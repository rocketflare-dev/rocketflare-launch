/**
 * The bodies of `GrantPushWorkflow`'s steps (Launch P5, plan §1.10–§1.13) — plain functions over a
 * `PushStepDeps`, so the Workflow class only wires names and DB clients and a test calls them with
 * a database and a backing:
 *
 *   planPush     → the push `running`; one `grant_push_targets` row per grant in scope (an
 *                  idempotent insert — unique `(push_id, grant_id)`); `total`. A push that is no
 *                  longer queued or running (a stray duplicate instance) does nothing.
 *   pushBatch(n) → targets `n*GRANT_PUSH_BATCH …` in id order. A `succeeded` / `skipped` target is
 *                  not touched again (that is what makes a retry resume); a put onto a grant that
 *                  already holds a NEWER version, or a grant that is no longer in the state the
 *                  push is for, is `skipped`. Otherwise it puts (or removes) the names through the
 *                  backing, records the outcome on the target and the grant, audits it and nudges.
 *   finishPush   → the counts and the status (`succeeded` | `partial` | `failed`). A rotation that
 *                  reached every holder retires the versions it replaced and tells the resource's
 *                  owners to revoke the old credential at the vendor (Launch cannot, §1.12); one
 *                  that did not leaves them `retiring` and tells the owners which apps failed.
 *   failPush     → the backstop when a step threw past its retries: the push `failed`, so the
 *                  environment's one active slot is released and Retry is offered.
 *
 * Which grants a push is for, by reason: `grant` / `repair` — the one grant, `active`; `rotate` —
 * every `active` grant of the resource environment; `revoke` / `expire` — the one grant, `revoking`
 * (`revokeGrant` and the sweep move it there first), and a removed target ends the grant `revoked`
 * or `expired`.
 *
 * **No value leaves a step.** Values are opened inside `pushBatch`, handed to the backing's redaction
 * and to `scrub` for every error text, and a step returns counts only. A target's `names` and every
 * audit summary carry KEYS.
 *
 * Slice 5c owns this file.
 */
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  APP_CONFIG_REALTIME_ENTITY,
  GRANT_ERROR_CODES,
  GRANT_NOTIFICATION_TYPES,
  GRANT_PUSH_BATCH,
  type GrantPushParams,
  type GrantPushReason,
  type GrantPushStatus,
} from '@launch/shared/launch-grants'
import { and, asc, eq, inArray, lt } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  type AppGrantRow,
  appEnvironments,
  appGrants,
  type GrantPushRow,
  type GrantPushTargetRow,
  grantPushes,
  grantPushTargets,
  groupMembers,
  type SharedResourceRow,
  type SharedResourceValueRow,
  sharedResources,
  sharedResourceValues,
} from '../../../db/schema'
import { recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import { scrub } from '../launch/setup'
import { notifyMany } from '../notifications'
import { nudge, realtimeEvent } from '../realtime'
import { grantBackingFor } from './backing'
import { nudgePush } from './push'
import { openValues } from './sealed'
import type { GrantBacking, GrantDeps } from './types'

/** What a step runs with: the service deps, plus the backing a test hands in. */
export interface PushStepDeps extends GrantDeps {
  backing?: GrantBacking
}

const PUT_REASONS: readonly GrantPushReason[] = ['grant', 'rotate', 'repair']

function isPut(reason: GrantPushReason): boolean {
  return PUT_REASONS.includes(reason)
}

function now(deps: Pick<GrantDeps, 'now'>): Date {
  return deps.now?.() ?? new Date()
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function readPush(db: Database, params: GrantPushParams): Promise<GrantPushRow | null> {
  const [row] = await db
    .select()
    .from(grantPushes)
    .where(and(eq(grantPushes.tenantId, params.tenantId), eq(grantPushes.id, params.pushId)))
  return row ?? null
}

async function readResource(db: Database, push: GrantPushRow): Promise<SharedResourceRow> {
  const [row] = await db
    .select()
    .from(sharedResources)
    .where(
      and(eq(sharedResources.tenantId, push.tenantId), eq(sharedResources.id, push.resourceId))
    )
  if (!row) throw new Error(`grant push ${push.id}: its resource is gone`)
  return row
}

async function readVersion(
  db: Database,
  tenantId: string,
  id: string | null
): Promise<SharedResourceValueRow | null> {
  if (!id) return null
  const [row] = await db
    .select()
    .from(sharedResourceValues)
    .where(and(eq(sharedResourceValues.tenantId, tenantId), eq(sharedResourceValues.id, id)))
  return row ?? null
}

/** The grant status a push of `reason` acts on. */
function scopeStatus(reason: GrantPushReason): AppGrantRow['status'] {
  return isPut(reason) ? 'active' : 'revoking'
}

// ---- plan --------------------------------------------------------------------------------------

export interface PlanOutcome {
  /** False when the push is no longer queued or running — the instance stops. */
  go: boolean
  total: number
}

export async function planPush(deps: PushStepDeps, params: GrantPushParams): Promise<PlanOutcome> {
  const { db } = deps
  const push = await readPush(db, params)
  if (!push || (push.status !== 'queued' && push.status !== 'running')) {
    return { go: false, total: 0 }
  }
  await db
    .update(grantPushes)
    .set({ status: 'running', updatedAt: now(deps) })
    .where(and(eq(grantPushes.tenantId, push.tenantId), eq(grantPushes.id, push.id)))

  const grants = await db
    .select({ id: appGrants.id, appId: appGrants.appId })
    .from(appGrants)
    .where(
      and(
        eq(appGrants.tenantId, push.tenantId),
        eq(appGrants.resourceId, push.resourceId),
        eq(appGrants.environment, push.environment),
        eq(appGrants.status, scopeStatus(push.reason)),
        push.grantId ? eq(appGrants.id, push.grantId) : undefined
      )
    )
  if (grants.length > 0) {
    await db
      .insert(grantPushTargets)
      .values(
        grants.map(g => ({
          tenantId: push.tenantId,
          pushId: push.id,
          grantId: g.id,
          appId: g.appId,
        }))
      )
      .onConflictDoNothing({ target: [grantPushTargets.pushId, grantPushTargets.grantId] })
  }
  const total = (
    await db
      .select({ id: grantPushTargets.id })
      .from(grantPushTargets)
      .where(
        and(eq(grantPushTargets.tenantId, push.tenantId), eq(grantPushTargets.pushId, push.id))
      )
  ).length
  await db
    .update(grantPushes)
    .set({ total, updatedAt: now(deps) })
    .where(and(eq(grantPushes.tenantId, push.tenantId), eq(grantPushes.id, push.id)))
  nudgePush(deps.realtime, push)
  return { go: true, total }
}

/** How many `push#N` steps a plan of `total` targets needs. */
export function batchCount(total: number): number {
  return Math.ceil(total / GRANT_PUSH_BATCH)
}

// ---- push#N ------------------------------------------------------------------------------------

export interface BatchOutcome {
  succeeded: number
  failed: number
  skipped: number
}

async function workerName(
  db: Database,
  tenantId: string,
  appId: string,
  environment: AppEnvironmentName
): Promise<string | null> {
  const [row] = await db
    .select({ workerName: appEnvironments.workerName })
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, tenantId),
        eq(appEnvironments.appId, appId),
        eq(appEnvironments.name, environment)
      )
    )
  return row?.workerName ?? null
}

/** Whether `grant` already holds a version newer than `version` (a later push landed first). */
async function holdsNewer(
  db: Database,
  grant: AppGrantRow,
  version: SharedResourceValueRow
): Promise<boolean> {
  if (!grant.pushedVersionId || grant.pushedVersionId === version.id) return false
  const held = await readVersion(db, grant.tenantId, grant.pushedVersionId)
  return Boolean(held && held.version > version.version)
}

export async function pushBatch(
  deps: PushStepDeps,
  params: GrantPushParams,
  index: number
): Promise<BatchOutcome> {
  const { db, cfg } = deps
  const outcome: BatchOutcome = { succeeded: 0, failed: 0, skipped: 0 }
  const push = await readPush(db, params)
  if (!push || push.status !== 'running') return outcome
  const targets = await db
    .select()
    .from(grantPushTargets)
    .where(and(eq(grantPushTargets.tenantId, push.tenantId), eq(grantPushTargets.pushId, push.id)))
    .orderBy(asc(grantPushTargets.id))
    .limit(GRANT_PUSH_BATCH)
    .offset(index * GRANT_PUSH_BATCH)
  const open = targets.filter(t => t.status === 'pending' || t.status === 'failed')
  if (open.length === 0) return outcome

  const resource = await readResource(db, push)
  const secrets: string[] = []
  const redact = (...values: string[]) => {
    for (const v of values) if (v) secrets.push(v)
  }
  const version = await readVersion(db, push.tenantId, push.versionId)
  let entries: Record<string, string> = {}
  if (isPut(push.reason)) {
    if (!version) throw new Error(`grant push ${push.id}: its version is gone`)
    entries = await openValues(cfg, version.sealed)
    redact(...Object.values(entries))
  }
  const backing = deps.backing ?? (await grantBackingFor(deps, redact))

  for (const target of open) {
    const settled = await pushTarget(
      deps,
      { push, resource, version, entries, backing, redact },
      target
    )
    outcome[settled] += 1
    nudgePush(deps.realtime, push)
    nudge(
      deps.realtime,
      realtimeEvent('entity.changed', push.tenantId, {
        entity: APP_CONFIG_REALTIME_ENTITY,
        id: target.appId,
      })
    )
  }
  // `secrets` is read by the closures above; clear it so nothing outlives the step.
  secrets.length = 0
  return outcome

  // ---- one target (a closure over the step's secrets, for `scrub`)
  async function pushTarget(
    d: PushStepDeps,
    ctx: {
      push: GrantPushRow
      resource: SharedResourceRow
      version: SharedResourceValueRow | null
      entries: Record<string, string>
      backing: GrantBacking
      redact: (...values: string[]) => void
    },
    target: GrantPushTargetRow
  ): Promise<keyof BatchOutcome> {
    const at = now(d)
    const { push: p } = ctx
    const [grant] = await d.db
      .select()
      .from(appGrants)
      .where(and(eq(appGrants.tenantId, p.tenantId), eq(appGrants.id, target.grantId)))
    const skip = async (why: string) => {
      await d.db
        .update(grantPushTargets)
        .set({ status: 'skipped', error: why, finishedAt: at })
        .where(and(eq(grantPushTargets.tenantId, p.tenantId), eq(grantPushTargets.id, target.id)))
      return 'skipped' as const
    }
    if (!grant || grant.status !== scopeStatus(p.reason)) {
      return skip('The grant is no longer in a state this push is for')
    }
    if (isPut(p.reason) && ctx.version && (await holdsNewer(d.db, grant, ctx.version))) {
      return skip('The app already holds a newer version')
    }
    const script = await workerName(d.db, p.tenantId, grant.appId, p.environment)
    const fail = async (message: string) => {
      const error = scrub(message, secrets)
      await d.db
        .update(grantPushTargets)
        .set({ status: 'failed', attempts: target.attempts + 1, error, finishedAt: at })
        .where(and(eq(grantPushTargets.tenantId, p.tenantId), eq(grantPushTargets.id, target.id)))
      await d.db
        .update(appGrants)
        .set({ pushError: error, updatedAt: at })
        .where(and(eq(appGrants.tenantId, p.tenantId), eq(appGrants.id, grant.id)))
      await recordAudit(d.db, {
        ...SYSTEM_ACTOR,
        tenantId: p.tenantId,
        action: 'grant.push_failed',
        targetType: 'grant',
        targetId: grant.id,
        appId: grant.appId,
        approvalId: grant.approvalId,
        summary: {
          after: {
            pushId: p.id,
            reason: p.reason,
            resourceId: p.resourceId,
            environment: p.environment,
            error,
          },
        },
      })
      return 'failed' as const
    }
    if (!script) {
      return fail(
        `${GRANT_ERROR_CODES.appHasNoWorker}: the app's ${p.environment} Worker is not recorded`
      )
    }

    let names: string[]
    let shadowedVars: string[] = []
    try {
      if (isPut(p.reason)) {
        const done = await ctx.backing.putDetailed(script, ctx.entries)
        names = done.names
        shadowedVars = done.shadowedVars
      } else {
        names = await ctx.backing.remove(script, await namesToRemove(d, ctx.resource, grant))
      }
    } catch (err) {
      return fail(errorMessage(err))
    }

    await d.db
      .update(grantPushTargets)
      .set({
        status: 'succeeded',
        attempts: target.attempts + 1,
        error: null,
        names,
        shadowedVars,
        finishedAt: at,
      })
      .where(and(eq(grantPushTargets.tenantId, p.tenantId), eq(grantPushTargets.id, target.id)))
    const grantUpdate = isPut(p.reason)
      ? { pushedVersionId: p.versionId, pushedAt: at, pushError: null, updatedAt: at }
      : p.reason === 'revoke'
        ? {
            status: 'revoked' as const,
            revokedAt: at,
            pushedVersionId: null,
            pushError: null,
            updatedAt: at,
          }
        : { status: 'expired' as const, pushedVersionId: null, pushError: null, updatedAt: at }
    await d.db
      .update(appGrants)
      .set(grantUpdate)
      .where(and(eq(appGrants.tenantId, p.tenantId), eq(appGrants.id, grant.id)))
    const common = {
      ...SYSTEM_ACTOR,
      tenantId: p.tenantId,
      targetType: 'grant',
      targetId: grant.id,
      appId: grant.appId,
      approvalId: grant.approvalId,
    }
    if (shadowedVars.length > 0) {
      await recordAudit(d.db, {
        ...common,
        action: 'grant.var_shadowed',
        summary: {
          after: {
            pushId: p.id,
            script,
            environment: p.environment,
            shadowedVars,
            via: 'new_version',
          },
        },
      })
    }
    await recordAudit(d.db, {
      ...common,
      action: isPut(p.reason)
        ? 'grant.pushed'
        : p.reason === 'revoke'
          ? 'grant.revoked'
          : 'grant.expired',
      summary: {
        after: {
          pushId: p.id,
          reason: p.reason,
          resourceId: p.resourceId,
          environment: p.environment,
          script,
          names,
          ...(isPut(p.reason) ? { version: ctx.version?.version ?? null } : {}),
          ...(shadowedVars.length > 0 ? { shadowedVars } : {}),
        },
      },
    })
    return 'succeeded'
  }

  /** A removal takes the resource's item keys and whatever the grant's pushed version carried. */
  async function namesToRemove(
    d: PushStepDeps,
    res: SharedResourceRow,
    grant: AppGrantRow
  ): Promise<string[]> {
    const names = new Set(res.items.map(i => i.key))
    const held = await readVersion(d.db, grant.tenantId, grant.pushedVersionId)
    if (held) {
      const values = await openValues(d.cfg, held.sealed)
      redact(...Object.values(values))
      for (const key of Object.keys(values)) names.add(key)
    }
    return [...names]
  }
}

// ---- finish ------------------------------------------------------------------------------------

export interface FinishOutcome {
  status: GrantPushStatus
  total: number
  succeeded: number
  failed: number
  retiredVersions: number[]
}

async function ownerIds(db: Database, resource: SharedResourceRow): Promise<string[]> {
  const rows = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.tenantId, resource.tenantId),
        eq(groupMembers.groupId, resource.ownerGroupId)
      )
    )
  return rows.map(r => r.userId)
}

/**
 * Settle the push. `succeeded` counts the targets that are done — pushed, or skipped because there
 * was nothing left to do for them — so the progress bar fills; `failed` is what Retry would redo.
 */
export async function finishPush(
  deps: PushStepDeps,
  params: GrantPushParams
): Promise<FinishOutcome> {
  const { db } = deps
  const at = now(deps)
  const push = await readPush(db, params)
  if (!push) throw new Error(`grant push ${params.pushId} is gone`)
  const targets = await db
    .select({ status: grantPushTargets.status })
    .from(grantPushTargets)
    .where(and(eq(grantPushTargets.tenantId, push.tenantId), eq(grantPushTargets.pushId, push.id)))
  const total = targets.length
  const failed = targets.filter(t => t.status === 'failed' || t.status === 'pending').length
  const succeeded = total - failed
  const status: GrantPushStatus = failed === 0 ? 'succeeded' : succeeded > 0 ? 'partial' : 'failed'

  const resource = await readResource(db, push)
  const version = await readVersion(db, push.tenantId, push.versionId)
  let retiredVersions: number[] = []
  if (push.reason === 'rotate' && status === 'succeeded' && version) {
    const retired = await db
      .update(sharedResourceValues)
      .set({ status: 'retired', retiredAt: at })
      .where(
        and(
          eq(sharedResourceValues.tenantId, push.tenantId),
          eq(sharedResourceValues.resourceId, push.resourceId),
          eq(sharedResourceValues.environment, push.environment),
          eq(sharedResourceValues.status, 'retiring'),
          lt(sharedResourceValues.version, version.version)
        )
      )
      .returning({ version: sharedResourceValues.version })
    retiredVersions = retired.map(r => r.version).sort((a, b) => a - b)
  }

  await db
    .update(grantPushes)
    .set({ status, total, succeeded, failed, finishedAt: at, updatedAt: at })
    .where(
      and(
        eq(grantPushes.tenantId, push.tenantId),
        eq(grantPushes.id, push.id),
        inArray(grantPushes.status, ['queued', 'running'])
      )
    )
  await recordAudit(db, {
    ...SYSTEM_ACTOR,
    tenantId: push.tenantId,
    action: 'grant.push.finished',
    targetType: 'grant_push',
    targetId: push.id,
    approvalId: push.approvalId,
    summary: {
      after: {
        resourceId: push.resourceId,
        environment: push.environment,
        reason: push.reason,
        status,
        total,
        succeeded,
        failed,
      },
    },
  })
  if (retiredVersions.length > 0) {
    await recordAudit(db, {
      ...SYSTEM_ACTOR,
      tenantId: push.tenantId,
      action: 'shared_resource.values.retired',
      targetType: 'shared_resource',
      targetId: push.resourceId,
      summary: {
        after: {
          environment: push.environment,
          retiredVersions,
          activeVersion: version?.version ?? null,
          pushId: push.id,
        },
      },
    })
  }

  const owners = await ownerIds(db, resource)
  if (status !== 'succeeded') {
    await notifyMany(
      db,
      [...owners, ...(push.startedByUserId ? [push.startedByUserId] : [])],
      {
        tenantId: push.tenantId,
        type: GRANT_NOTIFICATION_TYPES.pushFailed,
        title: `${resource.displayName}: ${failed} of ${total} apps did not get the ${push.environment} ${isPut(push.reason) ? 'values' : 'removal'}`,
        body:
          push.reason === 'rotate'
            ? 'The previous version stays in use until every holder has the new one. Retry from the resource page.'
            : 'Retry from the resource page.',
        data: { resourceId: push.resourceId, pushId: push.id },
      },
      deps.realtime
    )
  } else if (retiredVersions.length > 0) {
    await notifyMany(
      db,
      owners,
      {
        tenantId: push.tenantId,
        type: GRANT_NOTIFICATION_TYPES.rotated,
        title: `${resource.displayName}: every app has the new ${push.environment} values`,
        body: `Version ${retiredVersions.join(', ')} is retired. Revoke the old credential at the vendor now; Launch cannot do that for you.`,
        data: { resourceId: push.resourceId, pushId: push.id },
      },
      deps.realtime
    )
  }
  nudgePush(deps.realtime, push)
  return { status, total, succeeded, failed, retiredVersions }
}

/** The backstop: a step threw past its retries. The push is `failed`, and Retry is offered. */
export async function failPush(
  deps: PushStepDeps,
  params: GrantPushParams
): Promise<{ status: 'failed' }> {
  const { db } = deps
  const at = now(deps)
  const push = await readPush(db, params)
  if (!push) return { status: 'failed' }
  const [row] = await db
    .update(grantPushes)
    .set({ status: 'failed', finishedAt: at, updatedAt: at })
    .where(
      and(
        eq(grantPushes.tenantId, push.tenantId),
        eq(grantPushes.id, push.id),
        inArray(grantPushes.status, ['queued', 'running'])
      )
    )
    .returning()
  if (row) {
    await recordAudit(db, {
      ...SYSTEM_ACTOR,
      tenantId: push.tenantId,
      action: 'grant.push.finished',
      targetType: 'grant_push',
      targetId: push.id,
      approvalId: push.approvalId,
      summary: {
        after: {
          resourceId: push.resourceId,
          environment: push.environment,
          reason: push.reason,
          status: 'failed',
          error: 'A step failed past its retries; see the Workflow instance',
        },
      },
    })
  }
  nudgePush(deps.realtime, push)
  return { status: 'failed' }
}
