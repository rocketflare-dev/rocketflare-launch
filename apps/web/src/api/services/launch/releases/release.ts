/**
 * Release (Launch P4, plan §1.8 / §4d). `POST /api/apps/:id/releases {bump}` (the app's owners and
 * admins) does the kit's release dance with no clone, under an installation token narrowed to the
 * one repo and revoked afterwards (`withRepoToken`):
 *
 * 1. read the root `package.json` on the default branch (`getRepoFile` at the head commit);
 * 2. `commitFiles` the bump (`bumpVersion`) — only the `"version"` value changes, so the file's
 *    own formatting survives; the job refuses a tag that does not equal the version;
 * 3. `createRef refs/tags/X.Y.Z` on the bump commit (which starts `deploy.yml` staging);
 * 4. the PRs since the previous tag (`prs.ts`) → `app_releases.prs`, each matched to the Launch
 *    session that shipped it; with no earlier tag at all, the app's shipped session PRs that are
 *    merged (read live) instead;
 * 5. audit `pr.merged` for any PR not recorded yet, then `release.created`.
 *
 * **Idempotent by the tag.** A Release that died after committing the bump and before tagging is
 * recognised on the next click — the head commit is our bump commit and its tag does not exist —
 * and resumes at step 3 rather than bumping twice; the row is `ON CONFLICT (app_id, tag) DO
 * NOTHING`, so a retry after the insert gets the same release back. A version whose tag already
 * exists (someone tagged by hand) is 409 `release_tag_exists`.
 */
import {
  bumpVersion,
  parseReleaseVersion,
  RELEASE_REALTIME_ENTITY,
  type ReleaseBump,
  type ReleasePr,
  releaseTagRef,
} from '@launch/shared/launch-releases'
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppReleaseRow, type AppRow, appReleases, sessions } from '../../../../db/schema'
import { ApiError, ConflictError, isApiError, NotFoundError } from '../../../utils/core/errors'
import type { ApprovalDeps } from '../../approvals/types'
import { nudge, realtimeEvent } from '../../realtime'
import { type AuditActor, recordAudit } from '../audit'
import {
  commitFiles,
  createRef,
  GitHubApiError,
  type GitHubOptions,
  getCommit,
  getPullRequest,
  getRef,
  getRepoFile,
  isGitHubNotFound,
} from '../github-app'
import { withRepoToken } from './github'
import { recordedPrNumbers, recordPrMerged } from './pr-audit'
import { releasePullRequests } from './prs'

export interface CreateReleaseInput {
  tenantId: string
  app: AppRow
  bump: ReleaseBump
  userId: string
  actor: AuditActor
}

/** The bump commit's message — also how a resumed Release recognises its own half-done bump. */
export function bumpCommitMessage(version: string): string {
  return `release: ${version}`
}

/** Shipped session PRs read on an app's FIRST release (no earlier tag to compare against). */
const FIRST_RELEASE_SESSION_PRS = 100

/** The `"version"` of a root `package.json`, or 409 when it has none Launch can bump. */
function readVersion(raw: string | null): string {
  let version: unknown
  try {
    version = raw ? (JSON.parse(raw) as { version?: unknown }).version : undefined
  } catch {
    version = undefined
  }
  if (typeof version !== 'string' || !parseReleaseVersion(version)) {
    throw new ConflictError(
      'The root package.json has no X.Y.Z version to bump',
      'release_version_unreadable'
    )
  }
  return version.trim()
}

/** `raw` with its top-level `"version"` value replaced — nothing else in the file moves. */
function withVersion(raw: string, version: string): string {
  const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`)
  if (next === raw && !raw.includes(`"${version}"`)) {
    throw new ConflictError(
      'Could not rewrite the package.json version',
      'release_version_unreadable'
    )
  }
  return next
}

/** A GitHub failure as the route answers it: 502 with GitHub's own message (never a token). */
function vendorError(err: unknown): never {
  if (isApiError(err)) throw err
  const message = err instanceof Error ? err.message : String(err)
  throw new ApiError(502, `GitHub refused the release: ${message}`, 'release_github_failed')
}

/** The newest release of the app, or null. */
async function latestRelease(
  db: Database,
  tenantId: string,
  appId: string
): Promise<AppReleaseRow | null> {
  const [row] = await db
    .select()
    .from(appReleases)
    .where(and(eq(appReleases.tenantId, tenantId), eq(appReleases.appId, appId)))
    .orderBy(desc(appReleases.createdAt))
    .limit(1)
  return row ?? null
}

/** Each PR number's Launch session (the newest one that shipped it), for the app. */
async function sessionsByPr(
  db: Database,
  tenantId: string,
  appId: string,
  numbers: readonly number[]
): Promise<Map<number, { id: string; createdByUserId: string | null }>> {
  const out = new Map<number, { id: string; createdByUserId: string | null }>()
  if (numbers.length === 0) return out
  const rows = await db
    .select({
      id: sessions.id,
      prNumber: sessions.prNumber,
      createdByUserId: sessions.createdByUserId,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.tenantId, tenantId),
        eq(sessions.appId, appId),
        inArray(sessions.prNumber, [...numbers])
      )
    )
    .orderBy(desc(sessions.createdAt))
  for (const row of rows) {
    if (row.prNumber !== null && !out.has(row.prNumber)) {
      out.set(row.prNumber, { id: row.id, createdByUserId: row.createdByUserId })
    }
  }
  return out
}

/** The app's shipped session PR numbers (newest first) — the first release's PR source. */
async function shippedSessionPrs(db: Database, tenantId: string, appId: string): Promise<number[]> {
  const rows = await db
    .select({ prNumber: sessions.prNumber })
    .from(sessions)
    .where(
      and(eq(sessions.tenantId, tenantId), eq(sessions.appId, appId), isNotNull(sessions.prNumber))
    )
    .orderBy(desc(sessions.createdAt))
    .limit(FIRST_RELEASE_SESSION_PRS)
  return [...new Set(rows.map(r => r.prNumber as number))]
}

async function tagExists(
  token: string,
  owner: string,
  repo: string,
  tag: string,
  gh: GitHubOptions
): Promise<boolean> {
  try {
    await getRef(token, owner, repo, `tags/${tag}`, gh)
    return true
  } catch (err) {
    if (isGitHubNotFound(err)) return false
    throw err
  }
}

interface TaggedRelease {
  version: string
  sha: string
  previousTag: string | null
  prs: ReleasePr[]
}

/** Steps 1–4 against GitHub; nothing is written to the database here. */
async function tagRelease(
  deps: ApprovalDeps,
  input: CreateReleaseInput,
  previous: AppReleaseRow | null
): Promise<TaggedRelease> {
  const gh: GitHubOptions = { fetch: deps.fetch }
  const { tenantId, app } = input
  return withRepoToken(
    deps.db,
    deps.cfg,
    app,
    { contents: 'write', pull_requests: 'read' },
    async (token, { owner, repo, branch }) => {
      const head = await getRef(token, owner, repo, `heads/${branch}`, gh)
      const headCommit = await getCommit(token, owner, repo, head.object.sha, gh)
      const raw = await getRepoFile(token, owner, repo, 'package.json', head.object.sha, gh)
      const current = readVersion(raw)

      let version: string
      let sha: string
      const resumable =
        headCommit.message?.trim() === bumpCommitMessage(current) &&
        !(await tagExists(token, owner, repo, current, gh))
      if (resumable) {
        // A previous Release committed this bump and died before its tag: finish that one.
        version = current
        sha = head.object.sha
      } else {
        version = bumpVersion(current, input.bump)
        if (await tagExists(token, owner, repo, version, gh)) {
          throw new ConflictError(
            `The tag ${version} already exists in the repository`,
            'release_tag_exists'
          )
        }
        const committed = await commitFiles(
          token,
          owner,
          repo,
          branch,
          [{ path: 'package.json', content: withVersion(raw as string, version) }],
          bumpCommitMessage(version),
          gh
        )
        sha = committed.sha
      }
      await createRef(token, owner, repo, releaseTagRef(version), sha, gh)

      // The compare's base: the last release Launch cut, else the version this bump started from
      // when the repo tagged it (a kit app released by hand before Launch took over).
      const previousTag =
        previous?.tag ??
        (current !== version && (await tagExists(token, owner, repo, current, gh)) ? current : null)
      let prs = await releasePullRequests({ token, owner, repo, base: previousTag, head: sha }, gh)
      if (!previousTag) {
        // An app's first release has nothing to compare against: its merged session PRs, live.
        prs = []
        for (const number of await shippedSessionPrs(deps.db, tenantId, app.id)) {
          const pull = await getPullRequest(token, owner, repo, number, gh)
          if (!pull?.merged_at) continue
          prs.push({
            number,
            title: pull.title ?? `#${number}`,
            author: pull.user?.login ?? null,
            mergedAt: new Date(pull.merged_at).toISOString(),
            mergeSha: pull.merge_commit_sha ?? null,
            url: pull.html_url ?? null,
            sessionId: null,
          })
        }
        prs.sort((a, b) => (a.mergedAt ?? '').localeCompare(b.mergedAt ?? ''))
      }
      return { version, sha, previousTag, prs }
    },
    gh
  )
}

export async function createRelease(
  deps: ApprovalDeps,
  input: CreateReleaseInput
): Promise<AppReleaseRow> {
  const { db } = deps
  const { tenantId, app } = input
  const previous = await latestRelease(db, tenantId, app.id)

  let tagged: TaggedRelease
  try {
    tagged = await tagRelease(deps, input, previous)
  } catch (err) {
    if (err instanceof GitHubApiError || !isApiError(err)) vendorError(err)
    throw err
  }

  // Each PR's session, when a Launch session shipped it.
  const bySession = await sessionsByPr(
    db,
    tenantId,
    app.id,
    tagged.prs.map(p => p.number)
  )
  const prs = tagged.prs.map(p => ({ ...p, sessionId: bySession.get(p.number)?.id ?? null }))
  const tag = tagged.version

  const [inserted] = await db
    .insert(appReleases)
    .values({
      tenantId,
      appId: app.id,
      version: tagged.version,
      tag,
      sha: tagged.sha,
      previousTag: tagged.previousTag,
      prs,
      status: 'tagged',
      createdByUserId: input.userId,
    })
    .onConflictDoNothing({ target: [appReleases.appId, appReleases.tag] })
    .returning()
  if (!inserted) {
    // A retry after the row was written: the same release.
    return getRelease(deps, { tenantId, appId: app.id, releaseId: '', tag })
  }

  // The merges first, so the chain reads PR → merge → release.
  const recorded = await recordedPrNumbers(
    db,
    tenantId,
    app.id,
    prs.map(p => p.number)
  )
  for (const pr of prs) {
    if (recorded.has(pr.number)) continue
    await recordPrMerged(db, { tenantId, appId: app.id, pr, actor: input.actor, via: 'release' })
  }
  await recordAudit(db, {
    tenantId,
    ...input.actor,
    action: 'release.created',
    targetType: 'release',
    targetId: inserted.id,
    appId: app.id,
    summary: {
      after: {
        version: inserted.version,
        tag: inserted.tag,
        sha: inserted.sha,
        previousTag: inserted.previousTag,
        prs: prs.map(p => p.number),
        bump: input.bump,
      },
    },
  })
  nudgeRelease(deps, inserted)
  return inserted
}

/** `entity.changed { entity: 'release' }` — the releases card and the chain refresh. */
export function nudgeRelease(deps: Pick<ApprovalDeps, 'realtime'>, release: AppReleaseRow): void {
  nudge(
    deps.realtime,
    realtimeEvent('entity.changed', release.tenantId, {
      entity: RELEASE_REALTIME_ENTITY,
      id: release.id,
      appId: release.appId,
    })
  )
}

export async function listReleases(
  deps: Pick<ApprovalDeps, 'db'>,
  input: { tenantId: string; appId: string }
): Promise<AppReleaseRow[]> {
  return deps.db
    .select()
    .from(appReleases)
    .where(and(eq(appReleases.tenantId, input.tenantId), eq(appReleases.appId, input.appId)))
    .orderBy(desc(appReleases.createdAt))
    .limit(100)
}

/** One release of the app, by id (or by `tag` when given); 404 `release_not_found`. */
export async function getRelease(
  deps: Pick<ApprovalDeps, 'db'>,
  input: { tenantId: string; appId: string; releaseId: string; tag?: string }
): Promise<AppReleaseRow> {
  const [row] = await deps.db
    .select()
    .from(appReleases)
    .where(
      and(
        eq(appReleases.tenantId, input.tenantId),
        eq(appReleases.appId, input.appId),
        input.tag ? eq(appReleases.tag, input.tag) : eq(appReleases.id, input.releaseId)
      )
    )
    .limit(1)
  if (!row) throw new NotFoundError('Release not found', 'release_not_found')
  return row
}
