/**
 * `grants.sweep` — the five-minute cron task (Launch P5, plan §1.13, §4 5c):
 *
 * 1. remind the app's owners 7 days before a grant expires (`grant_expiring`, once — stamped on
 *    `expiry_reminded_at`);
 * 2. expire the grants past `expires_at` with an `expire` push;
 * 3. remind the resource's owners when a secret's active version is older than its item's
 *    `rotationDays` (`grant_rotation_due`).
 *
 * Slice 5c fills `run`. Cross-tenant by design, like every cron (allow-listed in
 * `unscoped-allowlist.test.ts`): the scans below read every tenant's due rows, and every write
 * after them names the row's own `tenant_id`. They are the real queries 5c builds on — keep them
 * (or the allow-list entry goes stale and its test fails).
 */
import { GRANT_EXPIRY_REMINDER_DAYS } from '@launch/shared/launch-grants'
import { and, asc, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  type AppGrantRow,
  appGrants,
  type SharedResourceRow,
  type SharedResourceValueRow,
  sharedResources,
  sharedResourceValues,
} from '../../../db/schema'
import type { ScheduledTask } from '../../scheduled'

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

/** Registered on `*` + `/5` in `api/scheduled.ts`. A no-op until slice 5c. */
export const grantsSweep: ScheduledTask = {
  name: 'grants.sweep',
  async run({ logger }) {
    logger.debug('grants.sweep: not wired yet (P5 slice 5c)')
  },
}
