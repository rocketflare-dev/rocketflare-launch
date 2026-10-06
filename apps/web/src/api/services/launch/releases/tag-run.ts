/**
 * The GitHub run a release's tag push started (`deploy.yml`, `event=push`, `head_branch` the tag)
 * — what Launch otherwise cannot see between cutting a release and its staging job calling `/ci`.
 *
 * Cutting a release pushes tag `X.Y.Z`; the app's `deploy.yml` runs guard → "Already gated?" →
 * (when the commit has no green CI yet) the gate (~5 minutes) → "Deploy to staging", the FIRST job
 * that talks to Launch (`releaseRunStarted`, `lifecycle.ts`). Until then the release is `tagged` and
 * Launch knows nothing; a run that fails BEFORE the staging job (a red gate) would leave it `tagged`
 * for ever. So, while a release is `tagged` or `staging`, the pipeline strip's read
 * (`promotion.ts`) and a session's landing (`landStaging`) follow the run here:
 *
 * 1. **Throttled in the database, per release**: a compare-and-set stamps `tag_run_polled_at` when
 *    the last stamp is older than {@link TAG_RUN_POLL_WINDOW_MS}, and only the caller whose update
 *    landed reads GitHub; everybody else gets the last reading (`tag_run`). `updated_at` is left
 *    alone — it says when the release last MOVED.
 * 2. **The read** (`readTagRun`): the newest `push` run of `deploy.yml` on the tag and its latest
 *    attempt's jobs, under an installation token narrowed to the one repo and `actions: read`
 *    (`GITHUB_TOKEN_PERMISSIONS.tagRun`), revoked after → `candidateRunSchema`.
 * 3. **Settled on read**: a run that COMPLETED with a failing conclusion
 *    (`CANDIDATE_RUN_FAILED_CONCLUSIONS`) moves the release `tagged|staging → failed` (a
 *    compare-and-set — a staging job racing it wins or loses cleanly) with the error `staging: the
 *    deploy run failed at "<job>" (<run url>)`, audited `release.failed`. Only a FRESH reading
 *    settles: a cached one may predate a re-run, which `releaseRunStarted` would already have
 *    moved back out of `failed`.
 *
 * A `failed` release keeps its last reading, so the strip can still say which job failed; no
 * other status reads GitHub. Any GitHub error is logged and the answer is null — it never fails
 * the read it is part of.
 */
import {
  CANDIDATE_RUN_FAILED_CONCLUSIONS,
  type CandidateRun,
  type CandidateRunStatus,
  candidateRunFailed,
  candidateRunSchema,
} from '@launch/shared/launch-promotion'
import type { ReleaseStatus } from '@launch/shared/launch-releases'
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { type AppReleaseRow, type AppRow, appReleases } from '../../../../db/schema'
import type { Realtime } from '../../realtime'
import { recordAudit, SYSTEM_ACTOR } from '../audit'
import {
  GITHUB_TOKEN_PERMISSIONS,
  type GitHubOptions,
  type GitHubWorkflowJob,
  type GitHubWorkflowRun,
  listWorkflowRunJobs,
  listWorkflowRuns,
} from '../github-app'
import type { ImportGitHub } from '../import'
import { DEPLOY_WORKFLOW_FILE, withRepoToken } from './github'
import { moveRelease } from './lifecycle'
import { nudgeRelease } from './release'

/** One GitHub read per release per window, however many readers. */
export const TAG_RUN_POLL_WINDOW_MS = 20_000

/** The statuses whose tag run is still worth reading: no staging job has gone live yet. */
const FOLLOWED: readonly ReleaseStatus[] = ['tagged', 'staging']

type RepoOf = Pick<AppRow, 'repoOwner' | 'repoName' | 'defaultBranch'>

interface TagRunLogger {
  warn(obj: object, msg?: string): void
}

export interface TagRunOptions extends Pick<GitHubOptions, 'fetch' | 'apiBase'> {
  now?: Date
  /** The GitHub App credentials (tests); loaded from the platform store otherwise. */
  github?: ImportGitHub
  logger?: TagRunLogger
  /**
   * Where a reading that changed (or failed the release) is announced: `entity.changed { entity:
   * 'release', id, appId }`, so every open strip and releases card refreshes — not only the reader
   * whose turn it was. Absent, nothing is nudged.
   */
  realtime?: Realtime
}

/** Whether two readings of a tag run differ in anything the strip shows. Pure. */
export function tagRunChanged(prev: unknown, next: CandidateRun | null): boolean {
  const parsed = prev ? candidateRunSchema.safeParse(prev) : null
  const before = parsed?.success ? parsed.data : null
  if (!before || !next) return before !== next
  return (
    before.status !== next.status ||
    before.conclusion !== next.conclusion ||
    before.url !== next.url ||
    before.currentJob !== next.currentJob ||
    before.failedJob !== next.failedJob
  )
}

/** GitHub's run status, folded to the three the strip speaks of. Pure. */
function runStatus(status: string | null): CandidateRunStatus {
  if (status === 'completed') return 'completed'
  if (status === 'in_progress') return 'in_progress'
  return 'queued'
}

/** A run and its jobs as `candidateRunSchema`. Pure. */
export function toCandidateRun(
  run: GitHubWorkflowRun,
  jobs: readonly GitHubWorkflowJob[]
): CandidateRun {
  const failing = (j: GitHubWorkflowJob) =>
    j.status === 'completed' &&
    (CANDIDATE_RUN_FAILED_CONCLUSIONS as readonly string[]).includes(j.conclusion ?? '')
  const current =
    jobs.find(j => j.status === 'in_progress') ??
    jobs.find(j => j.status !== 'completed' && j.status !== null)
  const status = runStatus(run.status)
  return candidateRunSchema.parse({
    status,
    conclusion: status === 'completed' ? (run.conclusion ?? null) : null,
    url: run.html_url ?? null,
    currentJob: status === 'completed' ? null : (current?.name ?? null),
    failedJob: jobs.find(failing)?.name ?? null,
  })
}

/**
 * The newest `push` run of `deploy.yml` on `tag`, with its jobs, or null when GitHub has none.
 * Throws on any GitHub error (the caller decides what that means).
 */
export async function readTagRun(
  db: Database,
  cfg: AppConfig,
  app: RepoOf,
  tag: string,
  options: TagRunOptions = {}
): Promise<CandidateRun | null> {
  const http = { fetch: options.fetch, apiBase: options.apiBase }
  return withRepoToken(
    db,
    cfg,
    app,
    GITHUB_TOKEN_PERMISSIONS.tagRun,
    async (token, repo) => {
      const runs = await listWorkflowRuns(
        token,
        repo.owner,
        repo.repo,
        DEPLOY_WORKFLOW_FILE,
        { branch: tag, event: 'push', perPage: 5 },
        http
      )
      // GitHub filters by `branch` and `event` already; this guards a looser answer.
      const run = runs.find(r => (r.head_branch ?? tag) === tag && (r.event ?? 'push') === 'push')
      if (!run) return null
      const jobs = await listWorkflowRunJobs(token, repo.owner, repo.repo, run.id, http)
      return toCandidateRun(run, jobs)
    },
    { ...http, github: options.github }
  )
}

/** Take the release's read turn: true for the one caller whose compare-and-set landed. */
async function claimTagRunPoll(db: Database, release: AppReleaseRow, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - TAG_RUN_POLL_WINDOW_MS)
  const claimed = await db
    .update(appReleases)
    .set({ tagRunPolledAt: now, updatedAt: sql`${appReleases.updatedAt}` })
    .where(
      and(
        eq(appReleases.tenantId, release.tenantId),
        eq(appReleases.id, release.id),
        inArray(appReleases.status, [...FOLLOWED]),
        or(isNull(appReleases.tagRunPolledAt), lt(appReleases.tagRunPolledAt, cutoff))
      )
    )
    .returning({ id: appReleases.id })
  return claimed.length > 0
}

/** The sentence a failed run leaves on the release (`staging:` — the run never got past staging). */
export function tagRunFailureError(run: CandidateRun): string {
  const where = run.failedJob
    ? `failed at "${run.failedJob}"`
    : `ended ${run.conclusion ?? 'without deploying'}`
  return `staging: the deploy run ${where}${run.url ? ` (${run.url})` : ''}`
}

/** `tagged|staging → failed` for a run that ended without deploying, once, audited. */
async function failReleaseOnRun(
  db: Database,
  release: AppReleaseRow,
  run: CandidateRun
): Promise<AppReleaseRow | null> {
  const error = tagRunFailureError(run)
  const moved = await moveRelease(db, release, FOLLOWED, 'failed', { error })
  if (!moved) return null
  await recordAudit(db, {
    ...SYSTEM_ACTOR,
    tenantId: moved.tenantId,
    action: 'release.failed',
    targetType: 'release',
    targetId: moved.id,
    appId: moved.appId,
    summary: {
      before: { status: release.status },
      after: {
        status: moved.status,
        version: moved.version,
        tag: moved.tag,
        error,
        runUrl: run.url,
        failedJob: run.failedJob,
        conclusion: run.conclusion,
      },
    },
  })
  return moved
}

/** What a `failed` release still shows: its last reading, when that reading is why it failed. */
function lastFailedRun(release: AppReleaseRow): CandidateRun | null {
  const parsed = release.tagRun ? candidateRunSchema.safeParse(release.tagRun) : null
  return parsed?.success && candidateRunFailed(parsed.data) ? parsed.data : null
}

/**
 * Follow `release`'s tag run (see the header): the release as it now stands (moved to `failed`
 * when a fresh reading says the run failed) and the run, or null. Never throws for GitHub.
 */
export async function followTagRun(
  db: Database,
  cfg: AppConfig,
  app: RepoOf,
  release: AppReleaseRow,
  options: TagRunOptions = {}
): Promise<{ release: AppReleaseRow; run: CandidateRun | null }> {
  if (release.status === 'failed') return { release, run: lastFailedRun(release) }
  if (!FOLLOWED.includes(release.status) || !app.repoOwner || !app.repoName) {
    return { release, run: null }
  }
  const now = options.now ?? new Date()
  if (!(await claimTagRunPoll(db, release, now))) {
    const parsed = release.tagRun ? candidateRunSchema.safeParse(release.tagRun) : null
    return { release, run: parsed?.success ? parsed.data : null }
  }
  let run: CandidateRun | null = null
  try {
    run = await readTagRun(db, cfg, app, release.tag, options)
  } catch (err) {
    options.logger?.warn(
      { releaseId: release.id, err: err instanceof Error ? err.message : String(err) },
      'release tag run: could not read the deploy run on GitHub'
    )
  }
  const [stored] = await db
    .update(appReleases)
    .set({ tagRun: run, updatedAt: sql`${appReleases.updatedAt}` })
    .where(and(eq(appReleases.tenantId, release.tenantId), eq(appReleases.id, release.id)))
    .returning()
  const current = stored ?? release
  if (run && candidateRunFailed(run)) {
    const failed = await failReleaseOnRun(db, current, run)
    if (failed) {
      nudgeRelease({ realtime: options.realtime }, failed)
      return { release: failed, run }
    }
  }
  if (tagRunChanged(release.tagRun, run)) nudgeRelease({ realtime: options.realtime }, current)
  return { release: current, run }
}
