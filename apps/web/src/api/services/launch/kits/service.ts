/**
 * The kit catalogue's operations (D36 K1) — what `/api/platform/kits` and `launch kits …` do:
 * register a kit, re-check it, re-pin it, make it the default, remove it. Each resolves the pin
 * through GitHub (`kit-pin.ts`), reads the manifest at the pinned commit (`manifest.ts`) and runs
 * the static conformance check (`conformance.ts`) over the same installation token, then writes
 * the row (`store.ts`) and one audit event.
 *
 * - **Add**: nothing is stored unless the pin resolves (422 `kit_ref_not_found`, 502
 *   `github_lookup_failed`). A kit that FAILS conformance is still stored, `failed` with its
 *   problems — an admin fixes the kit and runs Check, rather than retyping it. The slug and name
 *   default to the manifest's `kit.id` / `kit.name` (else the repo's name).
 * - **Check**: re-reads at the current pin. A GitHub failure is 502 and changes nothing.
 * - **Pin**: resolves, checks at the NEW pin, then compare-and-sets the pin with the result. The
 *   default kit's pin is mirrored into `template_pin` (`kit-pin.ts` header).
 * - **Default**: one transaction; the mirror follows the new default's pin.
 * - **Remove**: never the default (409 `kit_is_default`), never a kit with apps (409
 *   `kit_has_apps`).
 *
 * Audit: `kit.added`, `kit.checked`, `kit.pinned`, `kit.default_set`, `kit.removed` — target `Kit`,
 * id the row's; a pin is never a secret, so before and after are recorded whole.
 */
import type { KitManifest } from '@launch/shared/kit-manifest'
import type {
  Kit,
  KitAddRequest,
  KitCheckStatus,
  KitDetail,
  KitManifestSource,
  KitPinRequest,
} from '@launch/shared/kits'
import type { TemplatePin } from '@launch/shared/launch-setup'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { ConflictError, NotFoundError } from '../../../utils/core/errors'
import { type AuditActor, recordAudit } from '../audit'
import { putSetting } from '../credentials'
import {
  effectiveKitPin,
  type KitLookupOptions,
  kitLatestCheck,
  kitPin,
  resolvePinWithToken,
  storedPinOf,
  withKitToken,
} from '../kit-pin'
import { checkKitConformance } from './conformance'
import { kitFileReader } from './manifest'
import {
  compareAndSetKitPin,
  deleteKit,
  ensureDefaultKit,
  getKit,
  insertKit,
  type KitRow,
  kitAppCounts,
  listKits,
  setDefaultKit,
  updateKit,
} from './store'

/** What a check found at one commit — the columns it writes. */
export interface KitInspection {
  status: KitCheckStatus
  problems: string[]
  manifest: KitManifest | null
  manifestSource: KitManifestSource | null
  contractVersion: string | null
  checkedAt: Date
}

/** Read the manifest and run the static checks at `commit`, with an open token. */
export async function inspectWithToken(
  token: string,
  repo: string,
  commit: string,
  opts: KitLookupOptions = {}
): Promise<KitInspection> {
  const result = await checkKitConformance(kitFileReader(token, repo, commit, opts))
  return {
    status: result.ok ? 'verified' : 'failed',
    problems: result.problems,
    manifest: result.manifest,
    manifestSource: result.manifestSource,
    contractVersion: result.manifest ? String(result.manifest.schema) : null,
    checkedAt: new Date(),
  }
}

/** The kit as the API answers it. */
export async function toKit(db: Database, row: KitRow, appCount: number): Promise<Kit> {
  const { pin, isCodeDefault } = await kitPin(db, row)
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    repo: row.repo,
    pin,
    pinIsCodeDefault: isCodeDefault,
    isDefault: row.isDefault,
    status: row.status,
    problems: row.problems ?? [],
    contractVersion: row.contractVersion,
    manifestSource: row.manifestSource,
    checkedAt: row.checkedAt,
    latestCheck: await kitLatestCheck(db, row),
    appCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function toDetail(db: Database, row: KitRow): Promise<KitDetail> {
  const counts = await kitAppCounts(db)
  return { ...(await toKit(db, row, counts.get(row.id) ?? 0)), manifest: row.manifest ?? null }
}

/** Every kit; the built-in default is created first when the catalogue is empty. */
export async function listCatalogue(db: Database): Promise<Kit[]> {
  await ensureDefaultKit(db)
  const [rows, counts] = await Promise.all([listKits(db), kitAppCounts(db)])
  return Promise.all(rows.map(row => toKit(db, row, counts.get(row.id) ?? 0)))
}

async function requireKit(db: Database, idOrSlug: string): Promise<KitRow> {
  const row = await getKit(db, idOrSlug)
  if (!row) throw new NotFoundError(`No kit ${idOrSlug}`, 'kit_not_found')
  return row
}

export async function showKit(db: Database, idOrSlug: string): Promise<KitDetail> {
  await ensureDefaultKit(db)
  return toDetail(db, await requireKit(db, idOrSlug))
}

/** The `kitSlugSchema` form of a name: lowercase, dashes, 3-40. */
function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(slug) ? slug : `kit-${slug}`.slice(0, 40)
}

export interface KitActionContext {
  db: Database
  cfg: AppConfig
  actor: AuditActor
  auditTenantId: string
  opts?: KitLookupOptions
}

async function auditKit(
  ctx: KitActionContext,
  action: string,
  row: KitRow,
  summary: Record<string, unknown>
): Promise<void> {
  await recordAudit(ctx.db, {
    tenantId: ctx.auditTenantId,
    ...ctx.actor,
    action,
    targetType: 'Kit',
    targetId: row.id,
    summary,
  })
}

/** Register a kit (see the header). */
export async function addKit(ctx: KitActionContext, input: KitAddRequest): Promise<KitDetail> {
  const { db, cfg, opts = {} } = ctx
  await ensureDefaultKit(db)
  const { pin, inspection } = await withKitToken(db, cfg, input.repo, opts, async token => {
    const pin = await resolvePinWithToken(token, input.repo, input.pin, opts)
    return { pin, inspection: await inspectWithToken(token, input.repo, pin.commit, opts) }
  })
  const repoName = input.repo.split('/')[1] ?? input.repo
  const row = await insertKit(db, {
    slug: input.slug ?? slugOf(inspection.manifest?.kit.id ?? repoName),
    name: input.name ?? inspection.manifest?.kit.name ?? repoName,
    description: input.description ?? inspection.manifest?.kit.description ?? null,
    repo: input.repo,
    pin: storedPinOf(pin),
    ...inspection,
    ...(pin.follow === 'latest'
      ? {
          latestCheck: {
            repo: pin.repo,
            latest: pin.tag ?? null,
            error: null,
            checkedAt: inspection.checkedAt,
          },
        }
      : {}),
    isDefault: false,
    createdByUserId: ctx.actor.actorUserId,
  })
  await auditKit(ctx, 'kit.added', row, {
    after: { slug: row.slug, repo: row.repo, pin, status: row.status },
  })
  return toDetail(db, row)
}

/** Re-read the manifest and re-run the checks at the kit's current pin. */
export async function checkKit(ctx: KitActionContext, idOrSlug: string): Promise<KitDetail> {
  const { db, cfg, opts = {} } = ctx
  await ensureDefaultKit(db)
  const row = await requireKit(db, idOrSlug)
  const { pin } = await kitPin(db, row)
  const inspection = await withKitToken(db, cfg, pin.repo, opts, token =>
    inspectWithToken(token, pin.repo, pin.commit, opts)
  )
  const after = (await updateKit(db, row.id, inspection)) ?? row
  await auditKit(ctx, 'kit.checked', after, {
    after: { pin, status: after.status, problems: after.problems },
  })
  return toDetail(db, after)
}

/** Re-pin a kit: resolve, check at the new pin, compare-and-set (409 `kit_pin_conflict`). */
export async function pinKit(
  ctx: KitActionContext,
  idOrSlug: string,
  request: KitPinRequest
): Promise<KitDetail> {
  const { db, cfg, opts = {} } = ctx
  await ensureDefaultKit(db)
  const row = await requireKit(db, idOrSlug)
  const { stored: before, pin: current } = await kitPin(db, row)
  const repo = current.repo
  const { pin, inspection } = await withKitToken(db, cfg, repo, opts, async token => {
    const pin = await resolvePinWithToken(token, repo, request, opts)
    return { pin, inspection: await inspectWithToken(token, repo, pin.commit, opts) }
  })
  const moved = await compareAndSetKitPin(db, row.id, row.pin ?? null, storedPinOf(pin), {
    repo,
    ...inspection,
    ...(pin.follow === 'latest'
      ? {
          latestCheck: {
            repo,
            latest: pin.tag ?? null,
            error: null,
            checkedAt: inspection.checkedAt,
          },
        }
      : {}),
  })
  if (!moved) {
    throw new ConflictError(
      'The kit was re-pinned while this one was resolved; look again and retry',
      'kit_pin_conflict'
    )
  }
  const after = await requireKit(db, row.id)
  if (after.isDefault) await putSetting(db, 'template_pin', pin, ctx.actor.actorUserId)
  await auditKit(ctx, 'kit.pinned', after, {
    before: { pin: before },
    after: { pin, status: after.status },
  })
  return toDetail(db, after)
}

/** Make a kit the one new apps are cut from. */
export async function makeDefaultKit(ctx: KitActionContext, idOrSlug: string): Promise<KitDetail> {
  const { db } = ctx
  const previous = await ensureDefaultKit(db)
  const row = await requireKit(db, idOrSlug)
  if (row.isDefault) return toDetail(db, row)
  const after = await setDefaultKit(db, row.id)
  if (!after) throw new NotFoundError(`No kit ${idOrSlug}`, 'kit_not_found')
  // The rollback mirror follows the default: the ROW's pin, or none (the code default) — never
  // the mirror itself, which still holds the previous default's pin.
  const { stored } = effectiveKitPin(after, null)
  await putSetting(db, 'template_pin', stored, ctx.actor.actorUserId)
  await auditKit(ctx, 'kit.default_set', after, {
    before: { default: previous.slug },
    after: { default: after.slug },
  })
  return toDetail(db, after)
}

/** Remove a kit nothing depends on. */
export async function removeKit(ctx: KitActionContext, idOrSlug: string): Promise<void> {
  const { db } = ctx
  await ensureDefaultKit(db)
  const row = await requireKit(db, idOrSlug)
  if (row.isDefault) {
    throw new ConflictError(
      `${row.name} is the default kit: make another kit the default first`,
      'kit_is_default'
    )
  }
  const apps = (await kitAppCounts(db)).get(row.id) ?? 0
  if (apps > 0) {
    throw new ConflictError(
      `${apps} app${apps === 1 ? ' was' : 's were'} created from ${row.name}; an app keeps its kit for life`,
      'kit_has_apps',
      { apps }
    )
  }
  await deleteKit(db, row.id)
  const { stored } = await kitPin(db, row)
  await auditKit(ctx, 'kit.removed', row, {
    before: { slug: row.slug, repo: row.repo, pin: stored as TemplatePin | null },
  })
}
