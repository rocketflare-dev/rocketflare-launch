/**
 * The `sessions.checks` cron task (Launch P3, plan §1.10; P4 §1.10): on the `*\/5` schedule,
 *
 * 1. every shipped session whose PR's CI is still pending (or was never read, or read `none`
 *    within an hour of the ship — GitHub had not queued the workflows yet) gets its checks
 *    refreshed (`runSessionChecks` in `ship.ts`), so the session page and the app's sessions card
 *    show green or red without anyone having to open the PR. Reads also refresh on demand (`GET
 *    /api/sessions/:id/pr`, at most every 30 s); this is what settles a PR nobody is looking at.
 * 2. (P4) every shipped session's PR is FOLLOWED until it is merged or closed, for at most
 *    `MERGE_FOLLOW_WINDOW_MS` after the session: a merge is audited `pr.merged` with its merge
 *    SHA — the first external link of the release chain (PR → merge → tag → … → production) —
 *    and a close without a merge `pr.closed`, after which the PR is no longer read. GitHub is
 *    polled, not listened to (webhooks are P6); a release's compare catches every other PR.
 *    A PR Launch merged itself (issue #5's landing) is recorded already, so it is skipped.
 * 3. (Issue #5) the landings' safety net, `nudgeLandingSessions` (`land.ts`): a `shipping` /
 *    `shipped` session whose landing is in a moving stage and quiet for three of its rounds is
 *    woken — or its instance restarted when it is gone — so a lost Workflow never strands a merge
 *    or a release half-way.
 *
 * Registered in `api/scheduled.ts` under `'*\/5 * * * *'`, beside `healthPoll` and `sessions.expire`.
 * With `SESSION_BACKEND=local` the PRs are local stand-ins and step 2 is skipped.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { apps, auditEvents, sessions, tenants } from '../../../db/schema'
import type { ScheduledTask } from '../../scheduled'
import { type GitHubPullRequest, getPullRequest } from '../launch/github-app'
import { withRepoToken } from '../launch/releases/github'
import {
  PR_CLOSED_ACTION,
  PR_MERGED_ACTION,
  PR_TARGET_TYPE,
  recordPrClosed,
  recordPrMerged,
} from '../launch/releases/pr-audit'
import { nudgeLandingSessions } from './land'
import { defaultSessionPorts, type RepoHostPort } from './ports'
import { runSessionChecks } from './ship'

/** How long after a session a PR is still followed to its merge (plan §1.10: ≤ 14 days). */
export const MERGE_FOLLOW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/** One PR read: `null` when GitHub does not know it. */
export type PullReader = (input: {
  db: Database
  repo: { repoOwner: string | null; repoName: string | null; defaultBranch: string | null }
  number: number
}) => Promise<GitHubPullRequest | null>

/** The real reader: one call under a read-only token for the one repo, revoked after. */
export function githubPullReader(cfg: AppConfig, fetchImpl?: typeof fetch): PullReader {
  return ({ db, repo, number }) =>
    withRepoToken(
      db,
      cfg,
      repo,
      { pull_requests: 'read' },
      (token, { owner, repo: name }) =>
        getPullRequest(token, owner, name, number, { fetch: fetchImpl }),
      { fetch: fetchImpl }
    )
}

/**
 * Step 2: every shipped session PR not yet recorded as merged or closed, read once. One tenant at
 * a time and tenant-first, like `runSessionChecks`.
 */
export async function followMergedPullRequests(
  db: Database,
  readPull: PullReader,
  opts: { now?: Date; limitPerTenant?: number; tenantIds?: string[] } = {}
): Promise<{ merged: number; closed: number; open: number; failed: number }> {
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - MERGE_FOLLOW_WINDOW_MS)
  const tenantIds =
    opts.tenantIds ?? (await db.select({ id: tenants.id }).from(tenants)).map(t => t.id)
  const out = { merged: 0, closed: 0, open: 0, failed: 0 }
  for (const tenantId of tenantIds) {
    const rows = await db
      .select({
        id: sessions.id,
        appId: sessions.appId,
        prNumber: sessions.prNumber,
        prUrl: sessions.prUrl,
        repoOwner: apps.repoOwner,
        repoName: apps.repoName,
        defaultBranch: apps.defaultBranch,
      })
      .from(sessions)
      .innerJoin(apps, and(eq(apps.id, sessions.appId), eq(apps.tenantId, sessions.tenantId)))
      .where(
        and(
          eq(sessions.tenantId, tenantId),
          eq(sessions.status, 'shipped'),
          isNotNull(sessions.prNumber),
          sql`coalesce(${sessions.endedAt}, ${sessions.createdAt}) > ${since.toISOString()}::timestamptz`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${auditEvents}
            WHERE ${auditEvents.tenantId} = ${tenantId}
              AND ${auditEvents.appId} = ${sessions.appId}
              AND ${auditEvents.targetType} = ${PR_TARGET_TYPE}
              AND ${auditEvents.targetId} = ${sessions.prNumber}::text
              AND ${auditEvents.action} IN (${PR_MERGED_ACTION}, ${PR_CLOSED_ACTION})
          )`
        )
      )
      .limit(opts.limitPerTenant ?? 50)
    for (const row of rows) {
      const number = row.prNumber as number
      try {
        const pull = await readPull({ db, repo: row, number })
        if (pull?.merged_at) {
          await recordPrMerged(db, {
            tenantId,
            appId: row.appId,
            via: 'sessions.checks',
            pr: {
              number,
              title: pull.title ?? `#${number}`,
              author: pull.user?.login ?? null,
              mergedAt: new Date(pull.merged_at).toISOString(),
              mergeSha: pull.merge_commit_sha ?? null,
              url: pull.html_url ?? row.prUrl,
              sessionId: row.id,
            },
          })
          out.merged++
        } else if (pull && pull.state === 'closed') {
          await recordPrClosed(db, {
            tenantId,
            appId: row.appId,
            number,
            sessionId: row.id,
            url: pull.html_url ?? row.prUrl,
          })
          out.closed++
        } else {
          out.open++
        }
      } catch {
        out.failed++
      }
    }
  }
  return out
}

/** Step 3's scope: every tenant (the cron), or the ones a test names. */
export interface LandingNudgeScope {
  tenantIds?: string[]
}

/**
 * The task over injected ports (tests); the default binds the backend's own. `landings` scopes
 * step 3 to some tenants — a test's own, since the cron's body is cross-tenant.
 */
export function sessionsChecksTask(
  repoHostFor?: (db: Database) => RepoHostPort,
  pullReaderFor?: (cfg: AppConfig) => PullReader | null,
  landings: LandingNudgeScope = {}
): ScheduledTask {
  return {
    name: 'sessions.checks',
    async run({ db, env, config, logger }) {
      const result = await runSessionChecks(
        db,
        repoHostFor ?? (d => defaultSessionPorts(env, config).repoHost(d))
      )
      logger.info(result, 'sessions.checks: refreshed pending pull request checks')
      try {
        const nudged = await nudgeLandingSessions(db, env, logger, new Date(), landings)
        if (nudged > 0) logger.info({ nudged }, 'sessions.checks: woke quiet landings')
      } catch (err) {
        logger.warn({ err }, 'sessions.checks: could not nudge the landings')
      }
      const reader = pullReaderFor
        ? pullReaderFor(config)
        : config.SESSION_BACKEND === 'local'
          ? null
          : githubPullReader(config)
      if (!reader) return
      const merges = await followMergedPullRequests(db, reader)
      logger.info(merges, 'sessions.checks: followed shipped pull requests to their merge')
    },
  }
}

export const sessionsChecks: ScheduledTask = sessionsChecksTask()
