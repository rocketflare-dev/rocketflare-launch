/**
 * Choosing a kit for a new app (D36 K5): what Create app's picker offers (`GET /api/kits`), and
 * which kit a create request names (`POST /api/apps` `kitId`).
 *
 * - **Offered** = every `verified` kit, plus the DEFAULT whatever its status — a request with no
 *   `kitId` is cut from the default anyway (the built-in Rocketflare row is `unchecked` until an
 *   admin runs Check), so offering it widens nothing. The default first, then by name.
 * - **Chosen**: no `kitId` → the default kit (created when the catalogue is empty); an id or slug
 *   the catalogue does not have → 422 `kit_not_found`; one that is neither verified nor the
 *   default → 409 `kit_not_verified`. Checked BEFORE any write, like every other refusal.
 *
 * A member sees name, description, icon and the pinned tag — never the problems, the repo or the
 * manifest, which stay behind `/api/platform/kits`.
 */
import { KIT_NOT_FOUND, KIT_NOT_VERIFIED, type KitOption } from '@launch/shared/kits'
import type { Database } from '../../../../db/client'
import { ApiError, ConflictError } from '../../../utils/core/errors'
import { defaultKitPin, type EffectiveKitPin, kitPin } from '../kit-pin'
import { ensureDefaultKit, getKit, type KitRow, listKits } from './store'

/** May a new app be cut from `kit`? */
export function isOfferedKit(kit: Pick<KitRow, 'status' | 'isDefault'>): boolean {
  return kit.status === 'verified' || kit.isDefault
}

export async function toKitOption(db: Database, kit: KitRow): Promise<KitOption> {
  return {
    id: kit.id,
    slug: kit.slug,
    name: kit.name,
    description: kit.description,
    icon: kit.manifest?.kit.icon ?? null,
    // The effective pin's tag: the built-in row with none stored follows Launch's default.
    version: (await kitPin(db, kit)).pin.tag ?? null,
    isDefault: kit.isDefault,
  }
}

/** The kits a new app may be cut from (see the header). */
export async function listKitOptions(db: Database): Promise<KitOption[]> {
  await ensureDefaultKit(db)
  const offered = (await listKits(db)).filter(isOfferedKit)
  return Promise.all(offered.map(kit => toKitOption(db, kit)))
}

/** The kit a create request names, or the default (see the header). */
export async function kitForNewApp(db: Database, kitId: string | undefined): Promise<KitRow> {
  if (!kitId) return ensureDefaultKit(db)
  const kit = await getKit(db, kitId)
  if (!kit) {
    throw new ApiError(422, `There is no kit ${kitId}`, KIT_NOT_FOUND, { kitId })
  }
  if (!isOfferedKit(kit)) {
    throw new ConflictError(
      kit.status === 'failed'
        ? `${kit.name} failed its last check, so apps cannot be created from it yet`
        : `${kit.name} has not been checked yet, so apps cannot be created from it`,
      KIT_NOT_VERIFIED,
      { kitId: kit.id, status: kit.status }
    )
  }
  return kit
}

/**
 * The pin an app's scaffold (and re-scaffold) is cut at: its OWN kit's effective pin, else — no
 * kit row (a pre-K1 app, or a removed kit) — the default kit's. The create path stores the chosen
 * kit on the app; this is how the pipeline reads it back (D36 K5, for K3's scaffold).
 */
export async function pinForApp(
  db: Database,
  app: { kitId: string | null }
): Promise<EffectiveKitPin & { kit: KitRow | null }> {
  const kit = app.kitId ? await getKit(db, app.kitId) : null
  if (kit) return { ...(await kitPin(db, kit)), kit }
  return defaultKitPin(db)
}
