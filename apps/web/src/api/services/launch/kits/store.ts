/**
 * The one module that touches the `kits` table (D36 K1). Like `credentials.ts` for
 * `admin_credentials` / `launch_settings`, it is the seam a test MOCKS (`tests/helpers/kit-store.ts`)
 * when it changes a platform-wide row the shared run reads — the default kit and its pin — so
 * no other file sees the change mid-assertion.
 *
 * - **The built-in Rocketflare row** is created by migration 0049 and, when it is missing (a fresh
 *   database, a truncated test database), by {@link ensureDefaultKit}: slug `rocketflare`, the
 *   kit's repo, NO pin (it follows `DEFAULT_TEMPLATE_PIN`), the default.
 * - **At most one default** is the partial unique index `kits_one_default_idx`; {@link setDefaultKit}
 *   swaps it in one transaction (clear, then set — never two defaults, even for a moment).
 * - **A pin moves by compare-and-set** ({@link compareAndSetKitPin}) on the exact jsonb read, so a
 *   cron tick and an admin's re-pin cannot both win.
 */

import type { KitStoredPin } from '@launch/shared/kits'
import { DEFAULT_TEMPLATE_PIN } from '@launch/shared/launch-setup'
import { and, asc, desc, eq, isNotNull, ne, sql } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { apps, type KitRow, kits, type NewKitRow } from '../../../../db/schema'
import { ConflictError, isUniqueViolation } from '../../../utils/core/errors'
import { ROCKETFLARE_KIT_ID, rocketflareFallbackManifest } from './rocketflare-fallback'

export type { KitRow }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Every kit, the default first, then by name. */
export async function listKits(db: Database): Promise<KitRow[]> {
  return db.select().from(kits).orderBy(desc(kits.isDefault), asc(kits.name), asc(kits.slug))
}

/** A kit by its uuid or its slug. */
export async function getKit(db: Database, idOrSlug: string): Promise<KitRow | null> {
  const [row] = await db
    .select()
    .from(kits)
    .where(UUID.test(idOrSlug) ? eq(kits.id, idOrSlug) : eq(kits.slug, idOrSlug))
  return row ?? null
}

/** The default kit, or null when there is none yet (see {@link ensureDefaultKit}). */
export async function getDefaultKit(db: Database): Promise<KitRow | null> {
  const [row] = await db.select().from(kits).where(eq(kits.isDefault, true))
  return row ?? null
}

/** The built-in Rocketflare row as {@link ensureDefaultKit} creates it. */
function builtInRow(): NewKitRow {
  const manifest = rocketflareFallbackManifest()
  return {
    slug: ROCKETFLARE_KIT_ID,
    name: manifest.kit.name,
    description: manifest.kit.description ?? null,
    repo: DEFAULT_TEMPLATE_PIN.repo,
    pin: null,
    isDefault: true,
  }
}

/**
 * The default kit, created when there is none: the built-in Rocketflare row (or, when that row
 * exists but another default was removed by hand, it is made the default again). Safe under
 * concurrency — the slug and the one-default index are what decide, and the loser re-reads.
 */
export async function ensureDefaultKit(db: Database): Promise<KitRow> {
  const existing = await getDefaultKit(db)
  if (existing) return existing
  try {
    await db.insert(kits).values(builtInRow()).onConflictDoNothing()
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
  }
  const inserted = await getDefaultKit(db)
  if (inserted) return inserted
  try {
    await db
      .update(kits)
      .set({ isDefault: true })
      .where(
        and(
          eq(kits.slug, ROCKETFLARE_KIT_ID),
          sql`NOT EXISTS (SELECT 1 FROM ${kits} AS d WHERE d.is_default)`
        )
      )
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
  }
  const row = await getDefaultKit(db)
  if (!row) throw new Error('No default kit could be established')
  return row
}

/** Register a kit. 409 `kit_slug_taken` when the slug is in use. */
export async function insertKit(db: Database, values: NewKitRow): Promise<KitRow> {
  try {
    const [row] = await db.insert(kits).values(values).returning()
    if (!row) throw new Error('kits insert returned no row')
    return row
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(
        `A kit named ${values.slug} is already registered`,
        'kit_slug_taken',
        {
          slug: values.slug,
        }
      )
    }
    throw err
  }
}

/** Patch a kit's columns; the row after, or null when it is gone. */
export async function updateKit(
  db: Database,
  id: string,
  patch: Partial<Omit<NewKitRow, 'id' | 'isDefault' | 'createdAt'>>
): Promise<KitRow | null> {
  const [row] = await db
    .update(kits)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(kits.id, id))
    .returning()
  return row ?? null
}

/**
 * Move a kit's pin only if it is still exactly `expected` (null: still no stored pin), with any
 * other columns in `patch` written in the same statement. False when someone moved it first.
 */
export async function compareAndSetKitPin(
  db: Database,
  id: string,
  expected: KitStoredPin | null,
  next: KitStoredPin | null,
  patch: Partial<Omit<NewKitRow, 'id' | 'pin' | 'isDefault' | 'createdAt'>> = {}
): Promise<boolean> {
  const same =
    expected === null
      ? sql`${kits.pin} IS NULL`
      : sql`${kits.pin} = ${JSON.stringify(expected)}::jsonb`
  const rows = await db
    .update(kits)
    .set({ ...patch, pin: next, updatedAt: new Date() })
    .where(and(eq(kits.id, id), same))
    .returning({ id: kits.id })
  return rows.length === 1
}

/** Make `id` the one default kit (one transaction); the row after, or null when it is gone. */
export async function setDefaultKit(db: Database, id: string): Promise<KitRow | null> {
  return db.transaction(async tx => {
    const [target] = await tx.select({ id: kits.id }).from(kits).where(eq(kits.id, id))
    if (!target) return null
    await tx
      .update(kits)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(kits.isDefault, true), ne(kits.id, id)))
    const [row] = await tx
      .update(kits)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(kits.id, id))
      .returning()
    return row ?? null
  })
}

/** Delete a kit row. The caller has refused the default and a kit with apps. */
export async function deleteKit(db: Database, id: string): Promise<boolean> {
  const rows = await db.delete(kits).where(eq(kits.id, id)).returning({ id: kits.id })
  return rows.length === 1
}

/**
 * How many apps each kit has, across every organisation — a platform admin's catalogue view
 * (the kit row has no tenant), and the guard on removing a kit. Counts, never rows.
 */
export async function kitAppCounts(db: Database): Promise<Map<string, number>> {
  const rows = await db
    .select({ kitId: apps.kitId, count: sql<number>`count(*)::int` })
    .from(apps)
    .where(isNotNull(apps.kitId))
    .groupBy(apps.kitId)
  return new Map(rows.map(r => [r.kitId as string, Number(r.count)]))
}
