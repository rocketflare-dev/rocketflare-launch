/**
 * Kit pins (D36 K1): each kit in the catalogue (`kits`, `kits/store.ts`) is a repo pinned to a
 * release tag, a commit or Follow latest. The DEFAULT kit's pin is what Settings → Kit version
 * edits (`/api/platform/setup/template-pin`, kept for compatibility) and what new apps are cut
 * from; `/api/platform/kits/:id/pin` moves any kit's.
 *
 * - **Where a pin lives.** On the kit row (`kits.pin`, `{ tag?, commit, follow? }` — the repo is the
 *   row's). The built-in Rocketflare row may have NONE: it then follows `DEFAULT_TEMPLATE_PIN`, as
 *   an unset `template_pin` setting did. **The `template_pin` setting is a fallback read for one
 *   release** (the default kit with no stored pin reads it before the code default), and **is
 *   mirrored** on every write of the default kit's pin (as `template_pin_check` mirrors its last
 *   lookup), so rolling Launch back one release reads the same pin. Both go in the release after.
 * - `templatePinStatus` — the default kit's pin, whether it is the code default, the last lookup.
 * - `resolveKitPinRequest` — an admin's choice → a full pin, looked up in the kit repo through
 *   GitHub: a release TAG is resolved to its commit (an annotated tag is dereferenced through
 *   `GET …/git/tags/{sha}`), a COMMIT — a SHA, short or full, or a branch (`main` = "latest main") —
 *   to its full SHA through `GET …/commits/{ref}`, which also proves the commit exists in that repo,
 *   and FOLLOW LATEST to the newest release tag (`latestKitTag` over `GET …/tags`), resolved as a
 *   tag. Nothing the admin typed is stored unresolved.
 * - `refreshKitFollowLatest` — a Follow latest pin moved to the newest release when one appeared:
 *   compare-and-set on the row it read, audited. Nothing else moves — apps are not upgraded, they
 *   show as behind (`services/launch/upgrades.ts`). Run per kit by the five-minute cron
 *   (`kitFollowLatest`, at most hourly per kit unless its last lookup failed) and by Check now.
 * - `listKitTags` — a repo's tags for the card's picker, newest release first.
 *
 * GitHub is reached as the connected GitHub App, with an installation token narrowed to `contents:
 * read` and revoked when the lookup is done. **A private kit repo** is read through the App's
 * installation on the repo's OWNER (found by login in `GET /app/installations`, the token narrowed
 * to that one repo); a public kit repo the App is not installed on is read with the stored
 * installation, as before. No App connected → 409 `github_app_not_configured` (resetting to the
 * default needs no GitHub at all).
 */
import type { KitPinRequest, KitStoredPin } from '@launch/shared/kits'
import {
  DEFAULT_TEMPLATE_PIN,
  isFollowLatestPin,
  type KitLatestCheck,
  type KitTagsResponse,
  kitLatestCheckSchema,
  latestKitTag,
  sortKitTagsNewestFirst,
  type TemplatePin,
  type TemplatePinRequest,
  type TemplatePinStatus,
  templatePinSchema,
} from '@launch/shared/launch-setup'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { ScheduledTask } from '../../scheduled'
import { ApiError, ConflictError } from '../../utils/core/errors'
import { getSingleTenant } from '../../utils/db/tenant-helpers'
import { type AuditActor, recordAudit, SYSTEM_ACTOR } from './audit'
import { getCredential, getSetting, putSetting } from './credentials'
import {
  GitHubApiError,
  type GitHubOptions,
  githubJson,
  installationToken,
  listInstallations,
  revokeInstallationToken,
} from './github-app'
import { ROCKETFLARE_KIT_ID } from './kits/rocketflare-fallback'
import {
  compareAndSetKitPin,
  ensureDefaultKit,
  getDefaultKit,
  getKit,
  type KitRow,
  listKits,
  updateKit,
} from './kits/store'

// ---- the effective pin ----------------------------------------------------------------------------

export interface EffectiveKitPin {
  /** What the kit is cut from now. */
  pin: TemplatePin
  /** As stored: the row's, else (default kit only) the legacy setting's; null = the code default. */
  stored: TemplatePin | null
  /** No pin stored anywhere: `DEFAULT_TEMPLATE_PIN` applies (and moves with Launch). */
  isCodeDefault: boolean
}

/** A `TemplatePin` without its repo — the shape a kit row stores. */
export function storedPinOf(pin: TemplatePin): KitStoredPin {
  const { repo: _repo, ...rest } = pin
  return rest
}

/**
 * A kit row's effective pin. `legacy` is the `template_pin` setting, consulted only for the
 * default kit with no stored pin (see the header).
 */
export function effectiveKitPin(row: KitRow | null, legacy: unknown): EffectiveKitPin {
  if (row?.pin) {
    const parsed = templatePinSchema.safeParse({ repo: row.repo, ...row.pin })
    if (parsed.success) return { pin: parsed.data, stored: parsed.data, isCodeDefault: false }
  }
  if (!row || row.isDefault) {
    const parsed = templatePinSchema.safeParse(legacy)
    if (parsed.success) return { pin: parsed.data, stored: parsed.data, isCodeDefault: false }
  }
  return { pin: DEFAULT_TEMPLATE_PIN, stored: null, isCodeDefault: true }
}

function latestCheckOf(value: unknown): KitLatestCheck | null {
  const parsed = kitLatestCheckSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** A kit's last newest-release lookup (the default kit falls back to `template_pin_check`). */
export async function kitLatestCheck(
  db: Database,
  row: KitRow | null
): Promise<KitLatestCheck | null> {
  const own = latestCheckOf(row?.latestCheck)
  if (own || (row && !row.isDefault)) return own
  return latestCheckOf(await getSetting(db, 'template_pin_check'))
}

/** The default kit's effective pin (no write: a missing row reads as the built-in one). */
export async function defaultKitPin(
  db: Database
): Promise<EffectiveKitPin & { kit: KitRow | null }> {
  const [kit, legacy] = await Promise.all([getDefaultKit(db), getSetting(db, 'template_pin')])
  return { ...effectiveKitPin(kit, legacy), kit }
}

/** The effective pin of any kit row (the legacy setting read only for the default). */
export async function kitPin(db: Database, row: KitRow): Promise<EffectiveKitPin> {
  const legacy = row.isDefault && !row.pin ? await getSetting(db, 'template_pin') : null
  return effectiveKitPin(row, legacy)
}

/**
 * The effective pin of an APP's kit (D36 K4): its kit row's (`apps.kit_id`), else — an app with no
 * kit row, or a row since deleted — the default kit's. What a kit upgrade session fetches.
 */
export async function appKitPin(
  db: Database,
  app: { kitId: string | null }
): Promise<{ pin: TemplatePin; kit: KitRow | null }> {
  const kit = app.kitId ? await getKit(db, app.kitId) : null
  if (kit) return { pin: (await kitPin(db, kit)).pin, kit }
  const fallback = await defaultKitPin(db)
  return { pin: fallback.pin, kit: fallback.kit }
}

/**
 * The pin an app is (re-)scaffolded at (D36 K3): {@link appKitPin} — its OWN kit's — except that
 * the DEFAULT kit's (an app of the default kit, or of none) is `defaultPin` when the caller has it
 * resolved already (the pipeline's settings, which its tests hand in).
 */
export async function appScaffoldPin(
  db: Database,
  app: { kitId: string | null },
  defaultPin?: TemplatePin
): Promise<TemplatePin> {
  if (!defaultPin) return (await appKitPin(db, app)).pin
  const row = app.kitId ? await getKit(db, app.kitId) : null
  if (!row || row.isDefault) return defaultPin
  return (await kitPin(db, row)).pin
}

/** The pin new apps are cut from, and whether it is the code default. */
export async function templatePinStatus(db: Database): Promise<TemplatePinStatus> {
  const { pin, isCodeDefault, kit } = await defaultKitPin(db)
  return {
    pin,
    isDefault: isCodeDefault,
    default: DEFAULT_TEMPLATE_PIN,
    latestCheck: await kitLatestCheck(db, kit),
  }
}

/** What a pin move resets: the manifest at the new pin is unknown until it is checked. */
export const UNCHECKED_KIT = {
  status: 'unchecked' as const,
  problems: [],
  manifest: null,
  manifestSource: null,
  contractVersion: null,
  checkedAt: null,
  // A dynamic check ran (or runs) at the OLD pin: cleared, so its phases only clean up (D36 K3).
  dynamicCheck: null,
}

/**
 * Set the DEFAULT kit's pin (a resolved pin), or reset it to the code default (`null` — the
 * built-in Rocketflare kit only: 409 `default_kit_not_builtin` otherwise). The legacy setting is
 * mirrored. Returns the stored pin before (null: none) and the kit row after.
 */
export async function setDefaultKitPin(
  db: Database,
  pin: TemplatePin | null,
  userId: string | null
): Promise<{ before: TemplatePin | null; kit: KitRow }> {
  const kit = await ensureDefaultKit(db)
  const { stored: before } = await kitPin(db, kit)
  if (pin === null && kit.slug !== ROCKETFLARE_KIT_ID) {
    throw new ConflictError(
      `The default kit is ${kit.name}, which has no code default: pin it on Platform → Kits instead`,
      'default_kit_not_builtin'
    )
  }
  const next = pin
    ? { repo: pin.repo, pin: storedPinOf(pin) }
    : { repo: DEFAULT_TEMPLATE_PIN.repo, pin: null }
  const after = (await updateKit(db, kit.id, { ...next, ...UNCHECKED_KIT })) ?? kit
  await putSetting(db, 'template_pin', pin, userId)
  return { before, kit: after }
}

// ---- GitHub ---------------------------------------------------------------------------------------

export type KitLookupOptions = Pick<GitHubOptions, 'fetch' | 'apiBase'>

function kitRefNotFound(message: string, details: Record<string, unknown>): ApiError {
  return new ApiError(422, message, 'kit_ref_not_found', details)
}

export function githubFailed(err: unknown): ApiError {
  const reason = err instanceof Error ? err.message : String(err)
  return new ApiError(502, `GitHub could not answer: ${reason}`, 'github_lookup_failed')
}

/**
 * A read-only (`contents: read`) installation token for `repo`, NOT revoked — {@link withKitToken}
 * revokes its own; a kit upgrade session's git proxy (`sessions/egress/github.ts`, D36 K4) holds one
 * for the fetch of a PRIVATE kit, which outlives any one call, and lets it expire (an hour). The
 * App's installation on the repo's owner when there is one (the token narrowed to the repo); else
 * the stored installation. Throws `github_app_not_configured` (409) or `github_lookup_failed` (502).
 */
export async function mintKitToken(
  db: Database,
  cfg: AppConfig,
  repo: string,
  opts: KitLookupOptions = {}
): Promise<{ token: string; expiresAt: Date }> {
  const stored = await getCredential(db, cfg, 'github_app')
  if (!stored) {
    throw new ConflictError(
      'Connect the GitHub App in Setup first: Launch looks the kit up through it',
      'github_app_not_configured'
    )
  }
  const raw = stored.metadata.installationId ?? stored.metadata.installation_id ?? null
  const [owner = '', name = ''] = repo.split('/')
  try {
    const installations = await listInstallations(stored.secret, opts)
    const own = installations.find(i => i.account?.login.toLowerCase() === owner.toLowerCase())
    let installationId: number | string | null = own?.id ?? null
    if (installationId === null) {
      installationId = typeof raw === 'number' || typeof raw === 'string' ? raw : null
    }
    if (installationId === null) {
      const [first] = installations
      if (!first) throw new Error('The GitHub App is not installed anywhere')
      installationId = first.id
    }
    const minted = await installationToken(
      stored.secret,
      installationId,
      { permissions: { contents: 'read' }, ...(own ? { repositories: [name] } : {}) },
      opts
    )
    const expiresAt = minted.expires_at ? new Date(minted.expires_at) : null
    return {
      token: minted.token,
      // GitHub's installation tokens live an hour; a missing or unreadable expiry is taken as that.
      expiresAt:
        expiresAt && !Number.isNaN(expiresAt.getTime())
          ? expiresAt
          : new Date(Date.now() + 60 * 60 * 1000),
    }
  } catch (err) {
    throw githubFailed(err)
  }
}

/**
 * A read-only installation token for a lookup in `repo`, and its revocation. The App's
 * installation on the repo's owner when there is one (a private kit — the token narrowed to the
 * repo); else the stored installation (a public kit anywhere).
 */
export async function withKitToken<T>(
  db: Database,
  cfg: AppConfig,
  repo: string,
  opts: KitLookupOptions,
  fn: (token: string) => Promise<T>
): Promise<T> {
  const { token } = await mintKitToken(db, cfg, repo, opts)
  try {
    return await fn(token)
  } finally {
    await revokeInstallationToken(token, opts).catch(() => undefined)
  }
}

function repoPath(repo: string): string {
  const [owner = '', name = ''] = repo.split('/')
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

interface GitObject {
  sha: string
  type: string
}

/** A release tag → its commit, dereferencing annotated tag objects. */
async function tagCommit(
  token: string,
  repo: string,
  tag: string,
  opts: KitLookupOptions
): Promise<string> {
  let object: GitObject
  try {
    const ref = await githubJson<{ object: GitObject }>(
      `${repoPath(repo)}/git/ref/tags/${tag}`,
      { token },
      opts
    )
    object = ref.object
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      throw kitRefNotFound(`${repo} has no tag ${tag}`, { repo, tag })
    }
    throw githubFailed(err)
  }
  // An annotated tag points at a tag object; follow it (a tag of a tag, rarely) to the commit.
  for (let hops = 0; object.type === 'tag' && hops < 5; hops++) {
    try {
      const tagObject = await githubJson<{ object: GitObject }>(
        `${repoPath(repo)}/git/tags/${object.sha}`,
        { token },
        opts
      )
      object = tagObject.object
    } catch (err) {
      throw githubFailed(err)
    }
  }
  if (object.type !== 'commit') {
    throw kitRefNotFound(`The tag ${tag} in ${repo} does not point at a commit`, { repo, tag })
  }
  return object.sha
}

/** A SHA (short or full) or a branch → the full commit SHA; proof the commit is in the repo. */
async function commitSha(
  token: string,
  repo: string,
  ref: string,
  opts: KitLookupOptions
): Promise<string> {
  try {
    const commit = await githubJson<{ sha: string }>(
      `${repoPath(repo)}/commits/${encodeURIComponent(ref)}`,
      { token },
      opts
    )
    return commit.sha
  } catch (err) {
    // GitHub answers 422 "No commit found for SHA" as well as 404.
    if (err instanceof GitHubApiError && (err.status === 404 || err.status === 422)) {
      throw kitRefNotFound(`${repo} has no commit or branch ${ref}`, { repo, ref })
    }
    throw githubFailed(err)
  }
}

/** Tags GitHub lists per page, and the most pages read (1000 tags: far more than a kit has). */
const TAGS_PER_PAGE = 100
const TAGS_MAX_PAGES = 10

/** Every tag in the repo with the commit it names, as GitHub lists them (`GET …/tags`, paged). */
async function fetchKitTags(
  token: string,
  repo: string,
  opts: KitLookupOptions
): Promise<{ name: string; commit: string }[]> {
  const tags: { name: string; commit: string }[] = []
  for (let page = 1; page <= TAGS_MAX_PAGES; page++) {
    let batch: { name: string; commit: { sha: string } }[]
    try {
      batch = await githubJson<{ name: string; commit: { sha: string } }[]>(
        `${repoPath(repo)}/tags?per_page=${TAGS_PER_PAGE}&page=${page}`,
        { token },
        opts
      )
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) {
        throw kitRefNotFound(`No repository ${repo}`, { repo })
      }
      throw githubFailed(err)
    }
    tags.push(...batch.map(t => ({ name: t.name, commit: t.commit.sha })))
    if (batch.length < TAGS_PER_PAGE) break
  }
  return tags
}

/** The repo's newest release tag and its commit (an annotated tag dereferenced). */
async function latestRelease(
  token: string,
  repo: string,
  opts: KitLookupOptions
): Promise<{ tag: string; commit: string }> {
  const tag = latestKitTag((await fetchKitTags(token, repo, opts)).map(t => t.name))
  if (!tag) throw kitRefNotFound(`${repo} has no release tag (X.Y.Z)`, { repo })
  return { tag, commit: await tagCommit(token, repo, tag, opts) }
}

/** An admin's choice for `repo` → a full pin, looked up in the repo with an open token. */
export async function resolvePinWithToken(
  token: string,
  repo: string,
  request: KitPinRequest,
  opts: KitLookupOptions = {}
): Promise<TemplatePin> {
  if (request.kind === 'tag') {
    const commit = await tagCommit(token, repo, request.tag, opts)
    return templatePinSchema.parse({ repo, tag: request.tag, commit })
  }
  if (request.kind === 'latest') {
    const { tag, commit } = await latestRelease(token, repo, opts)
    return templatePinSchema.parse({ repo, tag, commit, follow: 'latest' })
  }
  const commit = await commitSha(token, repo, request.ref, opts)
  return templatePinSchema.parse({ repo, commit })
}

/** An admin's choice for `repo` → a full pin, looked up in the repo. */
export async function resolveKitPinRequest(
  db: Database,
  cfg: AppConfig,
  repo: string,
  request: KitPinRequest,
  opts: KitLookupOptions = {}
): Promise<TemplatePin> {
  return withKitToken(db, cfg, repo, opts, token => resolvePinWithToken(token, repo, request, opts))
}

/** The Kit version card's choice → a full pin (`repo` defaults to the default kit's). */
export async function resolveTemplatePinRequest(
  db: Database,
  cfg: AppConfig,
  request: TemplatePinRequest,
  opts: KitLookupOptions = {}
): Promise<TemplatePin> {
  const repo = request.repo ?? (await defaultKitPin(db)).pin.repo
  return resolveKitPinRequest(db, cfg, repo, request, opts)
}

// ---- Follow latest ------------------------------------------------------------------------------

/**
 * Record a kit's newest-release lookup (what the card's "Checked …" reads); for the default kit
 * also into `template_pin_check`, the mirror (see the header).
 */
export async function recordKitLatestCheck(
  db: Database,
  kit: KitRow,
  check: { repo: string; latest: string | null; error: string | null },
  now: Date = new Date()
): Promise<void> {
  const value = { ...check, checkedAt: now.toISOString() }
  // Stored as JSON (the date a string); read back through `kitLatestCheckSchema`.
  await updateKit(db, kit.id, { latestCheck: value as unknown as KitLatestCheck })
  if (kit.isDefault) await putSetting(db, 'template_pin_check', value, null)
}

/** Record the DEFAULT kit's newest-release lookup (the Kit version card's Follow latest). */
export async function recordLatestCheck(
  db: Database,
  check: { repo: string; latest: string | null; error: string | null },
  now: Date = new Date()
): Promise<void> {
  await recordKitLatestCheck(db, await ensureDefaultKit(db), check, now)
}

export type FollowLatestResult =
  | { status: 'not_following' }
  | { status: 'unchanged'; pin: TemplatePin }
  /** The row changed between the read and the write (an admin re-pinned): nothing written. */
  | { status: 'conflict' }
  | { status: 'updated'; before: TemplatePin; pin: TemplatePin }

export interface FollowLatestOptions extends KitLookupOptions {
  /** The organisation the audit row goes to (the platform's: the session's, else the one). */
  auditTenantId: string
  /** Who moved it: Launch itself for the cron, the admin for Check now. */
  actor?: AuditActor
  /** Recorded in the audit summary: the cron tick, or an admin's Check now. */
  by: 'cron' | 'check_now'
  now?: Date
}

/**
 * Move a kit's Follow latest pin to its newest release when that is not the pinned tag. A pin
 * that does not follow is left alone without a GitHub call. The lookup is recorded either way (a
 * failure keeps the last known `latest` and records the error, then rethrows — the 502
 * `github_lookup_failed` / 422 `kit_ref_not_found` the route answers). The write is
 * compare-and-set on the exact row read, so a second run (or a concurrent re-pin) writes nothing;
 * only a write is audited — `setting.changed` on `template_pin` for the default kit (as before
 * D36), `kit.pinned` for any other.
 */
export async function refreshKitFollowLatest(
  db: Database,
  cfg: AppConfig,
  kit: KitRow,
  options: FollowLatestOptions
): Promise<FollowLatestResult> {
  const now = options.now ?? new Date()
  // Only the GitHub half reaches GitHub (its own `now` is a clock, not this run's date).
  const lookup: KitLookupOptions = { fetch: options.fetch, apiBase: options.apiBase }
  const { stored } = await kitPin(db, kit)
  if (!stored || !isFollowLatestPin(stored)) return { status: 'not_following' }
  const pin = stored
  const previous = await kitLatestCheck(db, kit)

  let latest: { tag: string; commit: string }
  try {
    latest = await withKitToken(db, cfg, pin.repo, lookup, async token => {
      const tag = latestKitTag((await fetchKitTags(token, pin.repo, lookup)).map(t => t.name))
      if (!tag) throw kitRefNotFound(`${pin.repo} has no release tag (X.Y.Z)`, { repo: pin.repo })
      // The same tag: no second lookup, and nothing to write.
      if (tag === pin.tag) return { tag, commit: pin.commit }
      return { tag, commit: await tagCommit(token, pin.repo, tag, lookup) }
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    const kept = previous?.repo === pin.repo ? previous.latest : null
    await recordKitLatestCheck(db, kit, { repo: pin.repo, latest: kept, error }, now)
    throw err
  }
  await recordKitLatestCheck(db, kit, { repo: pin.repo, latest: latest.tag, error: null }, now)
  if (latest.tag === pin.tag) return { status: 'unchanged', pin }

  const next = templatePinSchema.parse({
    repo: pin.repo,
    tag: latest.tag,
    commit: latest.commit,
    follow: 'latest',
  })
  const actor = options.actor ?? SYSTEM_ACTOR
  // The row's pin as read (null: the default kit still on the legacy setting).
  const moved = await compareAndSetKitPin(
    db,
    kit.id,
    kit.pin ?? null,
    storedPinOf(next),
    UNCHECKED_KIT
  )
  if (!moved) return { status: 'conflict' }
  if (kit.isDefault) await putSetting(db, 'template_pin', next, actor.actorUserId)
  await recordAudit(db, {
    tenantId: options.auditTenantId,
    ...actor,
    ...(kit.isDefault
      ? {
          action: 'setting.changed',
          targetType: 'Setting',
          targetId: 'template_pin',
          // Who moved it: the cron, or an admin's Check now (the summary has no third key).
          summary: {
            before: { template_pin: stored },
            after: { template_pin: next, by: options.by },
          },
        }
      : {
          action: 'kit.pinned',
          targetType: 'Kit',
          targetId: kit.id,
          summary: { before: { pin: stored }, after: { pin: next, by: options.by } },
        }),
  })
  return { status: 'updated', before: pin, pin: next }
}

/** The DEFAULT kit's Follow latest refresh (the Kit version card's Check now). */
export async function refreshFollowLatest(
  db: Database,
  cfg: AppConfig,
  options: FollowLatestOptions
): Promise<FollowLatestResult> {
  return refreshKitFollowLatest(db, cfg, await ensureDefaultKit(db), options)
}

/** A good lookup is repeated after an hour; a failed one on the next tick. */
export const FOLLOW_LATEST_INTERVAL_MS = 60 * 60 * 1000

export interface FollowLatestTaskOptions extends KitLookupOptions {
  /** Defaults to the deployment's one organisation (`getSingleTenant`), as the pin routes do. */
  auditTenantId?: string
  minIntervalMs?: number
  clock?: () => Date
}

/**
 * The five-minute cron's Follow latest refresh, over EVERY kit. A kit is skipped without a GitHub
 * call when its pin does not follow, or when its last lookup for this repo succeeded under
 * `minIntervalMs` ago. Never throws: a GitHub failure is logged (and recorded on the kit's check)
 * and retried on the next tick; one kit's failure never stops the next.
 */
export function kitFollowLatestTask(opts: FollowLatestTaskOptions = {}): ScheduledTask {
  return {
    name: 'kit.followLatest',
    async run({ db, config, logger }) {
      const now = opts.clock?.() ?? new Date()
      const interval = opts.minIntervalMs ?? FOLLOW_LATEST_INTERVAL_MS
      let rows = await listKits(db)
      // No catalogue row yet: the default kit may still follow through the legacy setting.
      if (
        rows.length === 0 &&
        templatePinSchema.safeParse(await getSetting(db, 'template_pin')).success
      ) {
        rows = [await ensureDefaultKit(db)]
      }
      let auditTenantId: string | null = opts.auditTenantId ?? null
      for (const kit of rows) {
        const { stored } = await kitPin(db, kit)
        if (!stored || !isFollowLatestPin(stored)) continue
        const last = await kitLatestCheck(db, kit)
        if (
          last &&
          last.repo === stored.repo &&
          last.error === null &&
          now.getTime() - last.checkedAt.getTime() < interval
        ) {
          continue
        }
        auditTenantId ??= (await getSingleTenant(db))?.id ?? null
        if (!auditTenantId) {
          // A change Launch cannot record is never made (the pin routes refuse the same way).
          logger.warn({}, 'kit.followLatest: no organisation to audit in; the pin is left as is')
          return
        }
        try {
          const result = await refreshKitFollowLatest(db, config, kit, {
            fetch: opts.fetch,
            apiBase: opts.apiBase,
            auditTenantId,
            by: 'cron',
            now,
          })
          if (result.status === 'updated') {
            logger.info(
              { kit: kit.slug, from: result.before.tag, to: result.pin.tag },
              'kit.followLatest: the kit pin moved to the newest release'
            )
          }
        } catch (err) {
          logger.warn(
            { err, kit: kit.slug },
            'kit.followLatest: the newest release could not be looked up'
          )
        }
      }
    },
  }
}

export const kitFollowLatest: ScheduledTask = kitFollowLatestTask()

/** A kit repo's tags, newest release first, each with its commit; and which is the latest. */
export async function listKitTags(
  db: Database,
  cfg: AppConfig,
  repoParam: string | undefined,
  opts: KitLookupOptions = {}
): Promise<KitTagsResponse> {
  const repo = repoParam ?? (await defaultKitPin(db)).pin.repo
  return withKitToken(db, cfg, repo, opts, async token => {
    const tags = sortKitTagsNewestFirst(await fetchKitTags(token, repo, opts))
    return { repo, tags, latest: latestKitTag(tags.map(t => t.name)) }
  })
}
