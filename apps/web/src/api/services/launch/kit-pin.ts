/**
 * The kit pin (`launch_settings.template_pin`) as Platform → Kit's Kit version card edits it. The
 * pin has ONE source of truth — the setting, else `DEFAULT_TEMPLATE_PIN` — and this module is the
 * only writer besides a hand-edited row:
 *
 * - `templatePinStatus` — the pin new apps get, whether it is the code default, and the last
 *   newest-release lookup (`template_pin_check`).
 * - `resolveTemplatePinRequest` — the admin's choice (`templatePinRequestSchema`) → a full pin, looked up
 *   in the kit repo through GitHub: a release TAG is resolved to its commit (an annotated tag is
 *   dereferenced through `GET …/git/tags/{sha}`), a COMMIT — a SHA, short or full, or a branch
 *   (`main` = "latest main") — to its full SHA through `GET …/commits/{ref}`, which also proves the
 *   commit exists in that repo, and FOLLOW LATEST to the newest release tag (`latestKitTag` over
 *   `GET …/tags`), resolved as a tag. Nothing the admin typed is stored unresolved.
 * - `refreshFollowLatest` — a Follow latest pin moved to the newest release when one appeared:
 *   compare-and-set on the row it read, audited `setting.changed` with `after.by`. Nothing else moves —
 *   apps are not upgraded, they show as behind (`services/launch/upgrades.ts`). Run by the five-minute
 *   cron (`kitFollowLatest`, at most hourly unless the last lookup failed) and by Check now.
 * - `listKitTags` — the repo's tags for the card's picker, newest release first.
 *
 * GitHub is reached as the connected GitHub App: an installation token narrowed to `contents:
 * read`, revoked when the lookup is done. The kit repo is public, so it need not be one the App is
 * installed on. No App connected → 409 `github_app_not_configured` (resetting to the default
 * needs no GitHub at all).
 */
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
import { compareAndSetSetting, getCredential, getSetting, putSetting } from './credentials'
import {
  GitHubApiError,
  type GitHubOptions,
  githubJson,
  installationToken,
  listInstallations,
  revokeInstallationToken,
} from './github-app'

/** The pin new apps are cut from, and whether it is the code default (no valid setting row). */
export async function templatePinStatus(db: Database): Promise<TemplatePinStatus> {
  const [stored, check] = await Promise.all([
    getSetting(db, 'template_pin'),
    getSetting(db, 'template_pin_check'),
  ])
  const parsed = templatePinSchema.safeParse(stored)
  return {
    pin: parsed.success ? parsed.data : DEFAULT_TEMPLATE_PIN,
    isDefault: !parsed.success,
    default: DEFAULT_TEMPLATE_PIN,
    latestCheck: latestCheckOf(check),
  }
}

function latestCheckOf(value: unknown): KitLatestCheck | null {
  const parsed = kitLatestCheckSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export type KitLookupOptions = Pick<GitHubOptions, 'fetch' | 'apiBase'>

function kitRefNotFound(message: string, details: Record<string, unknown>): ApiError {
  return new ApiError(422, message, 'kit_ref_not_found', details)
}

function githubFailed(err: unknown): ApiError {
  const reason = err instanceof Error ? err.message : String(err)
  return new ApiError(502, `GitHub could not answer: ${reason}`, 'github_lookup_failed')
}

/** A read-only installation token for the lookup, and its revocation. */
async function withKitToken<T>(
  db: Database,
  cfg: AppConfig,
  opts: KitLookupOptions,
  fn: (token: string) => Promise<T>
): Promise<T> {
  const stored = await getCredential(db, cfg, 'github_app')
  if (!stored) {
    throw new ConflictError(
      'Connect the GitHub App in Setup first: Launch looks the kit up through it',
      'github_app_not_configured'
    )
  }
  const raw = stored.metadata.installationId ?? stored.metadata.installation_id ?? null
  let token: string
  try {
    let installationId = typeof raw === 'number' || typeof raw === 'string' ? raw : null
    if (installationId === null) {
      const [first] = await listInstallations(stored.secret, opts)
      if (!first) throw new Error('The GitHub App is not installed anywhere')
      installationId = first.id
    }
    const minted = await installationToken(
      stored.secret,
      installationId,
      { permissions: { contents: 'read' } },
      opts
    )
    token = minted.token
  } catch (err) {
    throw githubFailed(err)
  }
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

/** Tags GitHub lists per page, and the most pages read (1000 tags: far more than the kit has). */
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

/** The admin's choice → a full pin, looked up in the kit repo. */
export async function resolveTemplatePinRequest(
  db: Database,
  cfg: AppConfig,
  request: TemplatePinRequest,
  opts: KitLookupOptions = {}
): Promise<TemplatePin> {
  const repo = request.repo ?? (await templatePinStatus(db)).pin.repo
  return withKitToken(db, cfg, opts, async token => {
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
  })
}

/** Record a newest-release lookup (`template_pin_check`) — what the card's "Checked …" reads. */
export async function recordLatestCheck(
  db: Database,
  check: { repo: string; latest: string | null; error: string | null },
  now: Date = new Date()
): Promise<void> {
  await putSetting(db, 'template_pin_check', { ...check, checkedAt: now.toISOString() }, null)
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
 * Move a Follow latest pin to the kit's newest release when that is not the pinned tag. A pin
 * that does not follow is left alone without a GitHub call. The lookup is recorded either way
 * (`template_pin_check`; a failure keeps the last known `latest` and records the error, then
 * rethrows — the 502 `github_lookup_failed` / 422 `kit_ref_not_found` the route answers). The write
 * is compare-and-set on the exact row read, so a second run (or a concurrent re-pin) writes
 * nothing; only a write is audited.
 */
export async function refreshFollowLatest(
  db: Database,
  cfg: AppConfig,
  options: FollowLatestOptions
): Promise<FollowLatestResult> {
  const now = options.now ?? new Date()
  // Only the GitHub half reaches GitHub (its own `now` is a clock, not this run's date).
  const lookup: KitLookupOptions = { fetch: options.fetch, apiBase: options.apiBase }
  const stored = await getSetting(db, 'template_pin')
  const parsed = templatePinSchema.safeParse(stored)
  if (!parsed.success || !isFollowLatestPin(parsed.data)) return { status: 'not_following' }
  const pin = parsed.data
  const previous = latestCheckOf(await getSetting(db, 'template_pin_check'))

  let latest: { tag: string; commit: string }
  try {
    latest = await withKitToken(db, cfg, lookup, async token => {
      const tag = latestKitTag((await fetchKitTags(token, pin.repo, lookup)).map(t => t.name))
      if (!tag) throw kitRefNotFound(`${pin.repo} has no release tag (X.Y.Z)`, { repo: pin.repo })
      // The same tag: no second lookup, and nothing to write.
      if (tag === pin.tag) return { tag, commit: pin.commit }
      return { tag, commit: await tagCommit(token, pin.repo, tag, lookup) }
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    const kept = previous?.repo === pin.repo ? previous.latest : null
    await recordLatestCheck(db, { repo: pin.repo, latest: kept, error }, now)
    throw err
  }
  await recordLatestCheck(db, { repo: pin.repo, latest: latest.tag, error: null }, now)
  if (latest.tag === pin.tag) return { status: 'unchanged', pin }

  const next = templatePinSchema.parse({
    repo: pin.repo,
    tag: latest.tag,
    commit: latest.commit,
    follow: 'latest',
  })
  const actor = options.actor ?? SYSTEM_ACTOR
  if (!(await compareAndSetSetting(db, 'template_pin', stored, next, actor.actorUserId))) {
    return { status: 'conflict' }
  }
  await recordAudit(db, {
    tenantId: options.auditTenantId,
    ...actor,
    action: 'setting.changed',
    targetType: 'Setting',
    targetId: 'template_pin',
    summary: {
      before: { template_pin: stored },
      // Who moved it: the cron, or an admin's Check now (the summary has no third key).
      after: { template_pin: next, by: options.by },
    },
  })
  return { status: 'updated', before: pin, pin: next }
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
 * The five-minute cron's Follow latest refresh. Skips without a GitHub call when the pin does not follow,
 * or when the last lookup for this repo succeeded under `minIntervalMs` ago. Never throws: a
 * GitHub failure is logged (and recorded on the check) and retried on the next tick.
 */
export function kitFollowLatestTask(opts: FollowLatestTaskOptions = {}): ScheduledTask {
  return {
    name: 'kit.followLatest',
    async run({ db, config, logger }) {
      const now = opts.clock?.() ?? new Date()
      const parsed = templatePinSchema.safeParse(await getSetting(db, 'template_pin'))
      if (!parsed.success || !isFollowLatestPin(parsed.data)) return
      const last = latestCheckOf(await getSetting(db, 'template_pin_check'))
      const interval = opts.minIntervalMs ?? FOLLOW_LATEST_INTERVAL_MS
      if (
        last &&
        last.repo === parsed.data.repo &&
        last.error === null &&
        now.getTime() - last.checkedAt.getTime() < interval
      ) {
        return
      }
      const auditTenantId = opts.auditTenantId ?? (await getSingleTenant(db))?.id
      if (!auditTenantId) {
        // A change Launch cannot record is never made (the pin routes refuse the same way).
        logger.warn({}, 'kit.followLatest: no organisation to audit in; the pin is left as is')
        return
      }
      try {
        const result = await refreshFollowLatest(db, config, {
          fetch: opts.fetch,
          apiBase: opts.apiBase,
          auditTenantId,
          by: 'cron',
          now,
        })
        if (result.status === 'updated') {
          logger.info(
            { from: result.before.tag, to: result.pin.tag },
            'kit.followLatest: the kit pin moved to the newest release'
          )
        }
      } catch (err) {
        logger.warn({ err }, 'kit.followLatest: the newest release could not be looked up')
      }
    },
  }
}

export const kitFollowLatest: ScheduledTask = kitFollowLatestTask()

/** The kit repo's tags, newest release first, each with its commit; and which is the latest. */
export async function listKitTags(
  db: Database,
  cfg: AppConfig,
  repoParam: string | undefined,
  opts: KitLookupOptions = {}
): Promise<KitTagsResponse> {
  const repo = repoParam ?? (await templatePinStatus(db)).pin.repo
  return withKitToken(db, cfg, opts, async token => {
    const tags = sortKitTagsNewestFirst(await fetchKitTags(token, repo, opts))
    return { repo, tags, latest: latestKitTag(tags.map(t => t.name)) }
  })
}
