/**
 * `grants.sweep` — the five-minute cron task (Launch P5, plan §1.13, §4 5c):
 *
 * 1. remind the app's owners 7 days before a grant expires (`grant_expiring`, once — stamped on
 *    `expiry_reminded_at` by a compare-and-set, so two overlapping sweeps send one reminder);
 * 2. expire the grants past `expires_at` with an `expire` push: the grant goes `active →
 *    revoking` first (so the next sweep does not pick it again), the push removes the names, and
 *    its target settles the grant `expired`. A push that cannot start (another push of the
 *    environment running, no binding) puts the grant back to `active` for the next sweep;
 * 3. remind the resource's owners when a secret's active version is older than its item's
 *    `rotationDays` (`grant_rotation_due`), once per version — the reminder's `data.versionId` is
 *    the stamp (a notification already carrying it means "sent").
 *
 * Cross-tenant by design, like every cron (allow-listed in `unscoped-allowlist.test.ts`): the
 * scans below read every tenant's due rows, and every write after them names the row's own
 * `tenant_id`. One row failing is logged and never stops the rest. 5c's `sweepGrants` is `run`.
 */
import {
  appConfigPath,
  GRANT_EXPIRY_REMINDER_DAYS,
  GRANT_NOTIFICATION_TYPES,
} from '@launch/shared/launch-grants'
import { and, asc, eq, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  type AppGrantRow,
  appGrants,
  appOwners,
  apps,
  groupMembers,
  notifications,
  type SharedResourceRow,
  type SharedResourceValueRow,
  sharedResources,
  sharedResourceValues,
} from '../../../db/schema'
import type { ScheduledTask } from '../../scheduled'
import { notifyMany } from '../notifications'
import { startPush } from './push'
import type { GrantDeps } from './types'

/** Rows handled per sweep and per pass; the rest wait five minutes. */
export const GRANT_SWEEP_BATCH = 200

const DAY_MS = 24 * 60 * 60 * 1000

/** Active grants whose `expires_at` has passed, oldest deadline first, across every tenant. */
export async function dueForExpiry(
  db: Database,
  now: Date,
  limit = GRANT_SWEEP_BATCH
): Promise<AppGrantRow[]> {
  return db
    .select()
    .from(appGrants)
    .where(
      and(
        eq(appGrants.status, 'active'),
        isNotNull(appGrants.expiresAt),
        lte(appGrants.expiresAt, now)
      )
    )
    .orderBy(asc(appGrants.expiresAt))
    .limit(limit)
}

/**
 * Active grants expiring within `GRANT_EXPIRY_REMINDER_DAYS` that have not been reminded, across
 * every tenant.
 */
export async function dueForExpiryReminder(
  db: Database,
  now: Date,
  limit = GRANT_SWEEP_BATCH
): Promise<AppGrantRow[]> {
  const horizon = new Date(now.getTime() + GRANT_EXPIRY_REMINDER_DAYS * DAY_MS)
  return db
    .select()
    .from(appGrants)
    .where(
      and(
        eq(appGrants.status, 'active'),
        isNull(appGrants.expiryRemindedAt),
        gt(appGrants.expiresAt, now),
        lte(appGrants.expiresAt, horizon)
      )
    )
    .orderBy(asc(appGrants.expiresAt))
    .limit(limit)
}

/**
 * Every ACTIVE version of a live (not archived) resource, oldest first, with its resource — the
 * candidates for "rotation due". Which items are due is decided in code from each item's
 * `rotationDays` and the version's `set_at`.
 */
export async function rotationCandidates(
  db: Database,
  limit = GRANT_SWEEP_BATCH
): Promise<{ value: SharedResourceValueRow; resource: SharedResourceRow }[]> {
  return db
    .select({ value: sharedResourceValues, resource: sharedResources })
    .from(sharedResourceValues)
    .innerJoin(sharedResources, eq(sharedResources.id, sharedResourceValues.resourceId))
    .where(and(eq(sharedResourceValues.status, 'active'), isNull(sharedResources.archivedAt)))
    .orderBy(asc(sharedResourceValues.setAt))
    .limit(limit)
}

export interface GrantSweepReport {
  reminded: number
  expired: number
  rotationDue: number
  errors: number
}

/** The app's named owners and its owner group's members. */
async function appOwnerIds(db: Database, grant: AppGrantRow): Promise<string[]> {
  const [app] = await db
    .select({ ownerGroupId: apps.ownerGroupId })
    .from(apps)
    .where(and(eq(apps.tenantId, grant.tenantId), eq(apps.id, grant.appId)))
  if (!app) return []
  const named = await db
    .select({ userId: appOwners.userId })
    .from(appOwners)
    .where(and(eq(appOwners.tenantId, grant.tenantId), eq(appOwners.appId, grant.appId)))
  const viaGroup = app.ownerGroupId
    ? await db
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(
          and(eq(groupMembers.tenantId, grant.tenantId), eq(groupMembers.groupId, app.ownerGroupId))
        )
    : []
  return [...named, ...viaGroup].map(r => r.userId)
}

async function remindExpiry(deps: GrantDeps, grant: AppGrantRow, now: Date): Promise<boolean> {
  const { db } = deps
  const [claimed] = await db
    .update(appGrants)
    .set({ expiryRemindedAt: now })
    .where(
      and(
        eq(appGrants.tenantId, grant.tenantId),
        eq(appGrants.id, grant.id),
        isNull(appGrants.expiryRemindedAt)
      )
    )
    .returning({ id: appGrants.id })
  if (!claimed) return false
  const [app] = await db
    .select({ slug: apps.slug, displayName: apps.displayName })
    .from(apps)
    .where(and(eq(apps.tenantId, grant.tenantId), eq(apps.id, grant.appId)))
  const [resource] = await db
    .select({ displayName: sharedResources.displayName })
    .from(sharedResources)
    .where(
      and(eq(sharedResources.tenantId, grant.tenantId), eq(sharedResources.id, grant.resourceId))
    )
  const day = grant.expiresAt?.toISOString().slice(0, 10) ?? 'soon'
  await notifyMany(
    db,
    await appOwnerIds(db, grant),
    {
      tenantId: grant.tenantId,
      type: GRANT_NOTIFICATION_TYPES.expiring,
      title: `${app?.displayName ?? 'An app'} loses ${resource?.displayName ?? 'a secret'} (${grant.environment}) on ${day}`,
      body: `Request it again from ${app ? appConfigPath(app.slug) : "the app's config page"} if the app still needs it.`,
      data: { appId: grant.appId, appSlug: app?.slug ?? null, grantId: grant.id },
    },
    deps.realtime
  )
  return true
}

async function expireGrant(deps: GrantDeps, grant: AppGrantRow, now: Date): Promise<boolean> {
  const { db } = deps
  const [claimed] = await db
    .update(appGrants)
    .set({ status: 'revoking', updatedAt: now })
    .where(
      and(
        eq(appGrants.tenantId, grant.tenantId),
        eq(appGrants.id, grant.id),
        eq(appGrants.status, 'active')
      )
    )
    .returning({ id: appGrants.id })
  if (!claimed) return false
  try {
    await startPush(deps, {
      tenantId: grant.tenantId,
      resourceId: grant.resourceId,
      environment: grant.environment,
      reason: 'expire',
      grantId: grant.id,
      versionId: null,
    })
  } catch (err) {
    // Back to `active`, so the next sweep tries again.
    await db
      .update(appGrants)
      .set({ status: 'active', updatedAt: now })
      .where(
        and(
          eq(appGrants.tenantId, grant.tenantId),
          eq(appGrants.id, grant.id),
          eq(appGrants.status, 'revoking')
        )
      )
    throw err
  }
  return true
}

/** The secret items of `resource` whose `rotationDays` the version has outlived. */
export function rotationDueKeys(
  resource: Pick<SharedResourceRow, 'items'>,
  value: Pick<SharedResourceValueRow, 'setAt'>,
  now: Date
): string[] {
  const age = now.getTime() - value.setAt.getTime()
  return resource.items
    .filter(i => i.kind === 'secret' && i.rotationDays && age >= i.rotationDays * DAY_MS)
    .map(i => i.key)
}

async function remindRotation(
  deps: GrantDeps,
  value: SharedResourceValueRow,
  resource: SharedResourceRow,
  keys: string[]
): Promise<boolean> {
  const { db } = deps
  const [sent] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.tenantId, value.tenantId),
        eq(notifications.type, GRANT_NOTIFICATION_TYPES.rotationDue),
        sql`${notifications.data}->>'versionId' = ${value.id}`
      )
    )
    .limit(1)
  if (sent) return false
  const owners = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.tenantId, value.tenantId),
        eq(groupMembers.groupId, resource.ownerGroupId)
      )
    )
  if (owners.length === 0) return false
  await notifyMany(
    db,
    owners.map(o => o.userId),
    {
      tenantId: value.tenantId,
      type: GRANT_NOTIFICATION_TYPES.rotationDue,
      title: `${resource.displayName} (${value.environment}): ${keys.join(', ')} due for rotation`,
      body: `Version ${value.version} was set on ${value.setAt.toISOString().slice(0, 10)}. Mint a new credential at the vendor and set it here; every app that holds it gets it.`,
      data: { resourceId: resource.id, environment: value.environment, keys, versionId: value.id },
    },
    deps.realtime
  )
  return true
}

/** One pass: reminders first (a grant expiring now is not reminded), then expiries, then rotation. */
export async function sweepGrants(deps: GrantDeps): Promise<GrantSweepReport> {
  const now = deps.now?.() ?? new Date()
  const report: GrantSweepReport = { reminded: 0, expired: 0, rotationDue: 0, errors: 0 }
  for (const grant of await dueForExpiryReminder(deps.db, now)) {
    try {
      if (await remindExpiry(deps, grant, now)) report.reminded++
    } catch (err) {
      report.errors++
      deps.logger.error({ err, grantId: grant.id }, 'grants.sweep: expiry reminder failed')
    }
  }
  for (const grant of await dueForExpiry(deps.db, now)) {
    try {
      if (await expireGrant(deps, grant, now)) report.expired++
    } catch (err) {
      report.errors++
      deps.logger.error({ err, grantId: grant.id }, 'grants.sweep: expiry failed')
    }
  }
  for (const { value, resource } of await rotationCandidates(deps.db)) {
    const keys = rotationDueKeys(resource, value, now)
    if (keys.length === 0) continue
    try {
      if (await remindRotation(deps, value, resource, keys)) report.rotationDue++
    } catch (err) {
      report.errors++
      deps.logger.error({ err, versionId: value.id }, 'grants.sweep: rotation reminder failed')
    }
  }
  return report
}

/** Registered on `*` + `/5` in `api/scheduled.ts`. Nudges go out through the cron's `waitUntil`. */
export const grantsSweep: ScheduledTask = {
  name: 'grants.sweep',
  async run({ db, env, config, logger, waitUntil }) {
    const report = await sweepGrants({
      db,
      env,
      cfg: config,
      logger,
      realtime: {
        env,
        defer: fn =>
          waitUntil(fn().catch(err => logger.warn({ err }, 'grants.sweep: a nudge failed'))),
      },
    })
    if (report.reminded + report.expired + report.rotationDue + report.errors > 0) {
      logger.info(report, 'grants.sweep: done')
    }
  },
}
