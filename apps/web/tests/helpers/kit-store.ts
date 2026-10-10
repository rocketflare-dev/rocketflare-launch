/**
 * An in-memory kit catalogue (D36 K1), for suites that CHANGE the default kit or its pin —
 * `/api/platform/setup/template-pin`, `/api/platform/kits`, the Follow latest cron. The `kits`
 * table is platform-wide, and every file that creates an app or plans a scaffold reads the default
 * kit's pin from it; writing it from a suite in the shared database would change their kit
 * mid-assertion. So such a suite MOCKS the one module that touches it, beside the credential store
 * (`credential-store.ts`, which owns the mirrored `template_pin` setting):
 *
 * ```ts
 * // @vitest-isolate
 * const kitStore = vi.hoisted(() => ({ kits: new Map(), appCounts: new Map() }))
 * vi.mock('@/api/services/launch/kits/store', async importOriginal =>
 *   (await import('../helpers/kit-store')).mockKitStoreModule(await importOriginal(), kitStore)
 * )
 * ```
 *
 * Every function keeps the real one's contract — the one-default rule, the slug's uniqueness
 * (409 `kit_slug_taken`), the jsonb compare-and-set — so a test asserts behaviour, not the fake.
 * `appCounts` stands in for `apps.kit_id` (kit id → apps), since a fake kit has no real row for an
 * app to reference.
 */
import { isDeepStrictEqual } from 'node:util'
import { DEFAULT_TEMPLATE_PIN } from '@launch/shared/launch-setup'
import type * as KitStore from '@/api/services/launch/kits/store'
import { ConflictError } from '@/api/utils/core/errors'
import type { KitRow, NewKitRow } from '@/db/schema'

export interface KitStoreState {
  kits: Map<string, KitRow>
  appCounts: Map<string, number>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** jsonb equality: an `undefined` member is absent, as it would be in Postgres. */
const normal = (v: unknown) => (v === undefined ? null : (JSON.parse(JSON.stringify(v)) as unknown))

function rowOf(values: NewKitRow): KitRow {
  const now = new Date()
  return {
    id: values.id ?? crypto.randomUUID(),
    slug: values.slug,
    name: values.name,
    description: values.description ?? null,
    repo: values.repo,
    pin: values.pin ?? null,
    manifest: values.manifest ?? null,
    manifestSource: values.manifestSource ?? null,
    contractVersion: values.contractVersion ?? null,
    isDefault: values.isDefault ?? false,
    status: values.status ?? 'unchecked',
    problems: values.problems ?? [],
    checkedAt: values.checkedAt ?? null,
    latestCheck: values.latestCheck ?? null,
    createdByUserId: values.createdByUserId ?? null,
    createdAt: now,
    updatedAt: now,
  }
}

/** The module's replacement: the real one's signatures over `state`. */
export function mockKitStoreModule(_real: typeof KitStore, state: KitStoreState): typeof KitStore {
  const all = () => [...state.kits.values()]
  const byIdOrSlug = (key: string) =>
    UUID.test(key) ? state.kits.get(key) : all().find(k => k.slug === key)
  const getDefault = () => all().find(k => k.isDefault) ?? null
  const copy = (row: KitRow | null | undefined) => (row ? structuredClone(row) : null)
  return {
    listKits: async () =>
      all()
        .sort(
          (a, b) =>
            Number(b.isDefault) - Number(a.isDefault) ||
            a.name.localeCompare(b.name) ||
            a.slug.localeCompare(b.slug)
        )
        .map(k => structuredClone(k)),
    getKit: async (_db, idOrSlug) => copy(byIdOrSlug(idOrSlug)),
    getDefaultKit: async () => copy(getDefault()),
    ensureDefaultKit: async () => {
      const existing = getDefault()
      if (existing) return structuredClone(existing)
      const builtIn = all().find(k => k.slug === 'rocketflare')
      if (builtIn) {
        builtIn.isDefault = true
        return structuredClone(builtIn)
      }
      const row = rowOf({
        slug: 'rocketflare',
        name: 'Rocketflare',
        description: 'Multi-tenant SaaS starter for internal tools and B2B products',
        repo: DEFAULT_TEMPLATE_PIN.repo,
        pin: null,
        isDefault: true,
      })
      state.kits.set(row.id, row)
      return structuredClone(row)
    },
    insertKit: async (_db, values) => {
      if (all().some(k => k.slug === values.slug)) {
        throw new ConflictError(
          `A kit named ${values.slug} is already registered`,
          'kit_slug_taken',
          {
            slug: values.slug,
          }
        )
      }
      const row = rowOf(values)
      state.kits.set(row.id, row)
      return structuredClone(row)
    },
    updateKit: async (_db, id, patch) => {
      const row = state.kits.get(id)
      if (!row) return null
      Object.assign(row, JSON.parse(JSON.stringify(patch)), {
        // Dates survive the JSON round trip as strings; keep them Dates as Postgres would.
        ...(patch.checkedAt !== undefined ? { checkedAt: patch.checkedAt } : {}),
        updatedAt: new Date(),
      })
      return structuredClone(row)
    },
    compareAndSetKitPin: async (_db, id, expected, next, patch = {}) => {
      const row = state.kits.get(id)
      if (!row || !isDeepStrictEqual(normal(row.pin), normal(expected))) return false
      Object.assign(row, JSON.parse(JSON.stringify(patch)), {
        ...(patch.checkedAt !== undefined ? { checkedAt: patch.checkedAt } : {}),
        pin: next,
        updatedAt: new Date(),
      })
      return true
    },
    setDefaultKit: async (_db, id) => {
      const target = state.kits.get(id)
      if (!target) return null
      for (const k of all()) k.isDefault = k.id === id
      return structuredClone(target)
    },
    deleteKit: async (_db, id) => state.kits.delete(id),
    kitAppCounts: async () => new Map(state.appCounts),
  }
}
