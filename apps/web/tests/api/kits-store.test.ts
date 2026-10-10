/**
 * The kit catalogue's SQL (D36 K1, `services/launch/kits/store.ts`) and migration 0049's data
 * step, against the real database. `kits` is platform-wide and every file that creates an app
 * reads its default row, so each case runs inside a transaction that is ROLLED BACK: the shared
 * run never sees a change (route-level behaviour is `kits-routes.test.ts`, over the in-memory
 * store).
 */
import { readFileSync } from 'node:fs'
import { DEFAULT_TEMPLATE_PIN } from '@launch/shared/launch-setup'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  compareAndSetKitPin,
  deleteKit,
  ensureDefaultKit,
  getDefaultKit,
  getKit,
  insertKit,
  listKits,
  setDefaultKit,
} from '@/api/services/launch/kits/store'
import type { Database } from '@/db/client'
import { kits, launchSettings } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'

const db = setupTestDatabase()

class Rollback extends Error {}

/** Run `fn` in a transaction that never commits; the catalogue emptied inside it first. */
async function isolated(fn: (tx: Database) => Promise<void>): Promise<void> {
  await db
    .transaction(async tx => {
      // Rename every committed row out of the way and drop its default, inside the transaction.
      await tx.execute(sql`UPDATE kits SET is_default = false, slug = 'committed-' || id`)
      await fn(tx as unknown as Database)
      throw new Rollback()
    })
    .catch(err => {
      if (!(err instanceof Rollback)) throw err
    })
}

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

describe('the kit store', () => {
  it('ensureDefaultKit creates the built-in Rocketflare row once, as the default', async () => {
    await isolated(async tx => {
      expect(await getDefaultKit(tx)).toBeNull()
      const first = await ensureDefaultKit(tx)
      expect(first).toMatchObject({
        slug: 'rocketflare',
        name: 'Rocketflare',
        repo: DEFAULT_TEMPLATE_PIN.repo,
        pin: null,
        isDefault: true,
        status: 'unchecked',
        problems: [],
      })
      expect((await ensureDefaultKit(tx)).id).toBe(first.id)
      expect((await getKit(tx, 'rocketflare'))?.id).toBe(first.id)
      expect((await getKit(tx, first.id))?.slug).toBe('rocketflare')
    })
  })

  it('keeps one default: a second is refused by the index, setDefaultKit swaps them', async () => {
    await isolated(async tx => {
      const builtIn = await ensureDefaultKit(tx)
      const other = await insertKit(tx, {
        slug: 'acme-kit',
        name: 'Acme kit',
        repo: 'acme/kit',
        pin: { tag: '1.0.0', commit: SHA },
      })
      // A savepoint, so the refused statement does not abort the transaction.
      await expect(
        tx.transaction(sp =>
          sp.execute(sql`UPDATE kits SET is_default = true WHERE id = ${other.id}`)
        )
      ).rejects.toThrow()
      const after = await setDefaultKit(tx, other.id)
      expect(after?.isDefault).toBe(true)
      expect((await getKit(tx, builtIn.id))?.isDefault).toBe(false)
      const listed = await listKits(tx)
      expect(listed.filter(k => k.isDefault).map(k => k.slug)).toEqual(['acme-kit'])
      expect(listed[0]?.slug).toBe('acme-kit')
      // The default gone (by hand), ensureDefaultKit makes the built-in row the default again.
      await tx.update(kits).set({ isDefault: false }).where(eq(kits.id, other.id))
      expect((await ensureDefaultKit(tx)).id).toBe(builtIn.id)
    })
  })

  it('refuses a taken slug with kit_slug_taken', async () => {
    await isolated(async tx => {
      await insertKit(tx, { slug: 'acme-kit', name: 'A', repo: 'acme/kit' })
      await expect(
        tx.transaction(sp =>
          insertKit(sp as unknown as Database, { slug: 'acme-kit', name: 'B', repo: 'acme/other' })
        )
      ).rejects.toMatchObject({ statusCode: 409, code: 'kit_slug_taken' })
    })
  })

  it('moves a pin only from the exact jsonb it was read at', async () => {
    await isolated(async tx => {
      const kit = await insertKit(tx, { slug: 'acme-kit', name: 'A', repo: 'acme/kit', pin: null })
      const v1 = { tag: '1.0.0', commit: SHA }
      expect(await compareAndSetKitPin(tx, kit.id, null, v1)).toBe(true)
      // Stale: it is no longer null.
      expect(await compareAndSetKitPin(tx, kit.id, null, { commit: OTHER })).toBe(false)
      // Key order does not matter (jsonb equality); the patch lands in the same statement.
      expect(
        await compareAndSetKitPin(
          tx,
          kit.id,
          { commit: SHA, tag: '1.0.0' },
          { commit: OTHER },
          {
            status: 'verified',
          }
        )
      ).toBe(true)
      expect(await getKit(tx, kit.id)).toMatchObject({ pin: { commit: OTHER }, status: 'verified' })
      expect(await deleteKit(tx, kit.id)).toBe(true)
      expect(await getKit(tx, kit.id)).toBeNull()
    })
  })
})

describe('migration 0049', () => {
  const migration = readFileSync(
    new URL('../../migrations/0049_launch-kits.sql', import.meta.url),
    'utf8'
  )
  // The data step: the INSERT of the built-in row (the UPDATE of apps is not re-run here).
  const insert = migration
    .split('--> statement-breakpoint')
    .map(s => s.trim())
    .find(s => s.includes('INSERT INTO "kits"')) as string

  it('copies a stored template_pin into the default Rocketflare row', async () => {
    await isolated(async tx => {
      await tx
        .insert(launchSettings)
        .values({
          key: 'template_pin',
          value: { repo: 'acme/rocketflare-fork', tag: '0.16.0', commit: SHA, follow: 'latest' },
        })
        .onConflictDoUpdate({
          target: launchSettings.key,
          set: {
            value: { repo: 'acme/rocketflare-fork', tag: '0.16.0', commit: SHA, follow: 'latest' },
          },
        })
      await tx.execute(sql.raw(insert))
      expect(await getDefaultKit(tx)).toMatchObject({
        slug: 'rocketflare',
        repo: 'acme/rocketflare-fork',
        pin: { tag: '0.16.0', commit: SHA, follow: 'latest' },
        isDefault: true,
      })
    })
  })

  it('leaves the pin to the code default when no valid template_pin is stored', async () => {
    await isolated(async tx => {
      await tx
        .insert(launchSettings)
        .values({ key: 'template_pin', value: { repo: 'x', commit: 'short' } })
        .onConflictDoUpdate({
          target: launchSettings.key,
          set: { value: { repo: 'x', commit: 'short' } },
        })
      await tx.execute(sql.raw(insert))
      expect(await getDefaultKit(tx)).toMatchObject({
        slug: 'rocketflare',
        repo: DEFAULT_TEMPLATE_PIN.repo,
        pin: null,
      })
    })
  })
})
