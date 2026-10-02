/**
 * Main ahead (app page P3, plan decision 5): `GET /api/apps/:id/releases/compare` — how many
 * commits the default branch carries over the latest release tag, so the Overview can offer
 * `main  N commits ahead  [Release to staging ▸]`. A plain GitHub compare (`base...branch`), read
 * through a one-repo installation token (`withRepoToken`, `contents: read`).
 *
 * - **The base** is the newest release's tag (Launch cut it, so GitHub has it); an app with no
 *   release yet falls back to the highest `X.Y.Z` tag GitHub lists — the tags are the source of
 *   truth (decision 3), so a tag pushed by hand counts. No tag at all → `aheadBy: null`.
 * - **Throttled, not live**: the answer is cached on the app row (`apps.main_compare`) and GitHub is
 *   asked at most once per app per `RELEASE_COMPARE_TTL_SECONDS`, however many people watch the
 *   page. The read turn is a compare-and-set on `apps.main_compare_at` (the `tag_run_polled_at`
 *   pattern), so two viewers at the window's edge make one call. A cached answer against a base that
 *   is no longer the newest release's tag (a release was cut since) is stale at once.
 * - **A GitHub failure is an answer**, not an error: `aheadBy: null` with `error`, cached for the
 *   same window so a failing GitHub is not hammered. The UI shows nothing for it.
 */
import {
  compareReleaseVersions,
  parseReleaseVersion,
  prNumberOfMessage,
  RELEASE_COMPARE_MAX_COMMITS,
  RELEASE_COMPARE_TTL_SECONDS,
  type ReleaseCompare,
  releaseCompareSchema,
} from '@launch/shared/launch-releases'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { type AppRow, apps } from '../../../../db/schema'
import { compareCommits, type GitHubComparison, listTags } from '../github-app'
import { type RepoGitHubOptions, repoOf, withRepoToken } from './github'
import { listReleases } from './release'

export interface ReleaseCompareOptions extends RepoGitHubOptions {
  now?: Date
}

/** The highest plain `X.Y.Z` among `names`, or null. Pure. */
export function highestVersionTag(names: readonly string[]): string | null {
  let best: string | null = null
  for (const name of names) {
    if (!parseReleaseVersion(name)) continue
    if (!best || compareReleaseVersions(name, best) > 0) best = name
  }
  return best
}

/** A GitHub comparison as the contract carries it: newest first, capped, first lines only. Pure. */
export function toReleaseCompare(
  comparison: Pick<GitHubComparison, 'ahead_by' | 'html_url' | 'commits'>,
  input: { branch: string; base: string; checkedAt: Date }
): ReleaseCompare {
  const newestFirst = [...comparison.commits].reverse()
  return {
    branch: input.branch,
    base: input.base,
    headSha: newestFirst[0]?.sha ?? null,
    aheadBy: comparison.ahead_by,
    commits: newestFirst.slice(0, RELEASE_COMPARE_MAX_COMMITS).map(c => ({
      sha: c.sha,
      message: c.commit.message.split('\n', 1)[0] ?? '',
      author: c.commit.author?.name ?? null,
      prNumber: prNumberOfMessage(c.commit.message),
    })),
    compareUrl: comparison.html_url || null,
    checkedAt: input.checkedAt,
    error: null,
  }
}

function unknown(
  branch: string,
  base: string | null,
  checkedAt: Date,
  error: string | null
): ReleaseCompare {
  return {
    branch,
    base,
    headSha: null,
    aheadBy: null,
    commits: [],
    compareUrl: null,
    checkedAt,
    error,
  }
}

/** The cached reading, when it still answers for `branch` and `base` inside the window. */
function freshCache(
  app: Pick<AppRow, 'mainCompare' | 'mainCompareAt'>,
  branch: string,
  base: string | null,
  now: Date
): ReleaseCompare | null {
  const cached = app.mainCompare ? releaseCompareSchema.safeParse(app.mainCompare) : null
  if (!cached?.success || !app.mainCompareAt) return null
  if (now.getTime() - app.mainCompareAt.getTime() >= RELEASE_COMPARE_TTL_SECONDS * 1000) return null
  if (cached.data.branch !== branch) return null
  // A release cut since the reading moved the base: the reading is stale whatever its age.
  if (base !== null && cached.data.base !== base) return null
  return cached.data
}

export async function releaseCompare(
  db: Database,
  cfg: AppConfig,
  input: { tenantId: string; app: AppRow },
  opts: ReleaseCompareOptions = {}
): Promise<ReleaseCompare> {
  const { tenantId, app } = input
  const now = opts.now ?? new Date()
  const { branch } = repoOf(app)
  const [newest] = await listReleases({ db }, { tenantId, appId: app.id })
  const localBase = newest?.tag ?? null

  const cached = freshCache(app, branch, localBase, now)
  if (cached) return cached

  // The read turn: only the caller that moves `main_compare_at` asks GitHub.
  const staleBefore = new Date(now.getTime() - RELEASE_COMPARE_TTL_SECONDS * 1000)
  const [turn] = await db
    .update(apps)
    .set({ mainCompareAt: now })
    .where(
      and(
        eq(apps.tenantId, tenantId),
        eq(apps.id, app.id),
        app.mainCompareAt
          ? or(eq(apps.mainCompareAt, app.mainCompareAt), lt(apps.mainCompareAt, staleBefore))
          : or(isNull(apps.mainCompareAt), lt(apps.mainCompareAt, staleBefore))
      )
    )
    .returning({ id: apps.id })
  if (!turn) {
    // Somebody else is asking right now; their answer lands within the window.
    const prior = app.mainCompare ? releaseCompareSchema.safeParse(app.mainCompare) : null
    return prior?.success && prior.data.branch === branch && prior.data.base === localBase
      ? prior.data
      : unknown(branch, localBase, now, null)
  }

  let answer: ReleaseCompare
  try {
    answer = await withRepoToken(
      db,
      cfg,
      app,
      { contents: 'read' },
      async (token, { owner, repo }) => {
        const gh = { fetch: opts.fetch, apiBase: opts.apiBase }
        const base =
          localBase ?? highestVersionTag((await listTags(token, owner, repo, gh)).map(t => t.name))
        if (!base) return unknown(branch, null, now, null)
        const comparison = await compareCommits(token, owner, repo, base, branch, gh)
        return toReleaseCompare(comparison, { branch, base, checkedAt: now })
      },
      opts
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    answer = unknown(branch, localBase, now, `GitHub could not compare ${branch}: ${message}`)
  }

  await db
    .update(apps)
    .set({ mainCompare: answer })
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, app.id)))
  return answer
}
