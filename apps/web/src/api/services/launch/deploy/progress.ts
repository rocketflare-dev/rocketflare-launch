/**
 * Deploy progress (Launch, after P5): where an app's latest deploy is, for the app overview
 * (`GET /api/apps/:id/deploys/latest`) and the catalogue (`GET /api/apps`'s `latestDeploy`).
 * A production deploy used to show only in the audit log while it ran; this is the read that shows
 * it — dispatched → approved → uploaded → migrating → activating → done, or failed — with its run.
 *
 * **Derived, never stored.** Every phase is read off the deploy ticket's own columns
 * (`deployPhase`, `deployReached`, pure): an unclaimed approved pre-approval is `dispatched`, a
 * run's approved ticket `approved`, `cf_version_id` `uploaded`, `credentials_issued_at` `migrating`,
 * `activation_started_at` (stamped by `activate` before its vendor calls) `activating`, and
 * `activated_at` — THE answer to "did it deploy" (`isDeployed`) — `done`. A ticket `finish` closed
 * without an activation, a refused or failed one, a rejected or expired approval, and an intent no
 * run claimed before it lapsed are `failed`, each with a sentence.
 *
 * **Polled on read**, the way `pipeline/wait-poll.ts` polls a launch's CI job: a deploy whose job
 * died on GitHub (a cancelled run, a runner lost mid-migration) never calls `finish`, so its ticket
 * would read "migrating" for ever. So a read looks at the GitHub run of each in-progress ticket a
 * run has claimed (`approved` / `uploaded`):
 *
 * 1. **Throttled in the database, per ticket**: a compare-and-set stamps `run_polled_at` when the
 *    last stamp is older than {@link DEPLOY_RUN_POLL_WINDOW_MS}, and only the request whose update
 *    landed polls — however many tabs, or catalogue readers, look. `updated_at` is left alone: it
 *    says when the ticket last MOVED. At most {@link DEPLOY_RUN_POLL_MAX} tickets per read.
 * 2. **The run itself** (`GET …/actions/runs/{id}`, an installation token narrowed to the one repo
 *    and `actions: read`, revoked after). A run that is `completed`, or whose latest attempt is
 *    newer than the ticket's (a re-run opens its own ticket), has ended without the deploy.
 * 3. **Ended → failed**, once: `approved|uploaded → failed` with the run's conclusion as the error
 *    (a compare-and-set, so a `finish` racing it wins or loses cleanly), the migrator credential
 *    revoked if it is still live (best effort — the job that held it is gone), audited
 *    `deploy.failed` (`polledOnRead`) and the release run failed. A launch waiting on a staging
 *    deploy sees the failed ticket at its next poll (`deployPoll`).
 *
 * Everything that can go wrong in the poll is logged and skipped ({@link pollDeployRunsSafely}):
 * the view is then simply the rows as they stand.
 */
import type {
  AppCatalogueItem,
  AppEnvironmentName,
  AppSummary,
  DeployPhase,
  DeployProgress,
  DeployStep,
} from '@launch/shared/launch-apps'
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import {
  type AppRow,
  appEnvironments,
  type DeployTicketRow,
  deployTickets,
} from '../../../../db/schema'
import { recordAudit, SYSTEM_ACTOR } from '../audit'
import { type GitHubOptions, type GitHubWorkflowRun, getWorkflowRun } from '../github-app'
import { type ImportGitHub, loadImportGitHub } from '../import'
import { withRepoToken } from '../releases/github'
import { releaseRunFailed } from '../releases/lifecycle'
import { loadDeployVendors } from './gateway'
import { revokeMigrator } from './migrator'
import {
  FINISHED_BEFORE_ACTIVATE,
  isDeployed,
  markCredentialsRevoked,
  type TicketWithEnvironment,
  transitionTicket,
} from './tickets'

/** One read poll per ticket per window, however many readers. */
export const DEPLOY_RUN_POLL_WINDOW_MS = 20_000

/** The most tickets one read polls (a catalogue read could otherwise fan out). */
export const DEPLOY_RUN_POLL_MAX = 5

/** Statuses a claimed run is still working on — the only ones the read polls. */
const POLLED_STATUSES = ['approved', 'uploaded'] as const

type TicketFacts = Pick<
  DeployTicketRow,
  | 'status'
  | 'runId'
  | 'decidedAt'
  | 'cfVersionId'
  | 'credentialsIssuedAt'
  | 'activationStartedAt'
  | 'activatedAt'
  | 'expiresAt'
  | 'error'
  | 'refused'
>

// ---- the derivation (pure) ------------------------------------------------------------------------

/** The last milestone the ticket reached (see `DEPLOY_STEPS`), or null for none. Pure. */
export function deployReached(t: TicketFacts): DeployStep | null {
  if (isDeployed(t)) return 'done'
  if (t.activationStartedAt) return 'activating'
  if (t.credentialsIssuedAt) return 'migrating'
  if (t.cfVersionId) return 'uploaded'
  if (t.runId && t.decidedAt && t.status !== 'pending' && t.status !== 'rejected') {
    return 'approved'
  }
  if (t.runId || t.status === 'approved') return 'dispatched'
  return null
}

/** Where the deploy is now, and why it failed when it did. Pure. */
export function deployPhase(
  t: TicketFacts,
  now = new Date()
): { phase: DeployPhase; error: string | null } {
  if (isDeployed(t)) return { phase: 'done', error: null }
  const expired = !!t.expiresAt && t.expiresAt.getTime() <= now.getTime()
  switch (t.status) {
    case 'rejected':
      return { phase: 'failed', error: t.error ?? 'The production deploy was rejected' }
    case 'failed': {
      const refused = t.refused?.length ? `Refused: ${t.refused.join(', ')}` : null
      return { phase: 'failed', error: refused ?? t.error ?? 'The deploy failed' }
    }
    case 'finished':
      return {
        phase: 'failed',
        error:
          !t.error || t.error === FINISHED_BEFORE_ACTIVATE
            ? 'The job ended without activating the new version — see the run'
            : t.error,
      }
    case 'pending':
      return expired
        ? { phase: 'failed', error: 'Nobody approved it in time' }
        : { phase: 'awaiting_approval', error: null }
    case 'approved':
      if (t.runId) return { phase: 'approved', error: null }
      return expired
        ? { phase: 'failed', error: 'No deploy run claimed the approval before it lapsed' }
        : { phase: 'dispatched', error: null }
    case 'uploaded':
      if (t.activationStartedAt) return { phase: 'activating', error: null }
      if (t.credentialsIssuedAt) return { phase: 'migrating', error: null }
      return { phase: 'uploaded', error: null }
    case 'active':
      // `activate` sets `activated_at` in the same compare-and-set; a row without it is odd, not live.
      return { phase: 'activating', error: null }
  }
}

function runUrlOf(t: Pick<DeployTicketRow, 'repository' | 'runId'>): string | null {
  return t.repository && t.runId
    ? `https://github.com/${t.repository}/actions/runs/${encodeURIComponent(t.runId)}`
    : null
}

/** A ticket as the overview and the catalogue show it. Never a credential. */
export function toDeployProgress(
  t: DeployTicketRow,
  environment: AppEnvironmentName,
  now = new Date()
): DeployProgress {
  const { phase, error } = deployPhase(t, now)
  return {
    ticketId: t.id,
    environment,
    phase,
    reached: deployReached(t),
    inProgress: phase !== 'done' && phase !== 'failed',
    version: t.version,
    sha: t.sha,
    ref: t.ref,
    actor: t.actor,
    runUrl: runUrlOf(t),
    error,
    approvalId: t.approvalId,
    startedAt: t.createdAt,
    updatedAt: t.updatedAt,
    activatedAt: t.activatedAt,
    finishedAt: t.finishedAt,
  }
}

/**
 * Why a claimed ticket's run has ended without the deploy, or null while it may still get there:
 * the run completed (whatever its conclusion — a finished job calls `finish`, which closes the
 * ticket first), or a newer attempt of it started (a re-run opens a ticket of its own). A run
 * GitHub no longer lists is no verdict. Pure.
 */
export function endedRunReason(
  ticket: Pick<DeployTicketRow, 'status' | 'runAttempt'>,
  run: Pick<GitHubWorkflowRun, 'status' | 'conclusion' | 'run_attempt'> | null
): string | null {
  if (!run) return null
  const stage = ticket.status === 'uploaded' ? 'before it was activated' : 'before it was uploaded'
  if ((run.run_attempt ?? 1) > (ticket.runAttempt ?? 1)) {
    return `Attempt ${ticket.runAttempt ?? 1} of the GitHub Actions run ended ${stage}; attempt ${run.run_attempt} is a deploy of its own`
  }
  if (run.status !== 'completed') return null
  return `The GitHub Actions run ended “${run.conclusion ?? 'without a result'}” ${stage}`
}

// ---- reads ------------------------------------------------------------------------------------------

/** Each (app, environment)'s newest deploy ticket, for the tenant's `appIds`. */
export async function latestTickets(
  db: Database,
  tenantId: string,
  appIds: readonly string[]
): Promise<TicketWithEnvironment[]> {
  if (appIds.length === 0) return []
  return db
    .selectDistinctOn([deployTickets.appId, deployTickets.environmentId], {
      ticket: deployTickets,
      environment: appEnvironments.name,
    })
    .from(deployTickets)
    .innerJoin(
      appEnvironments,
      and(
        eq(appEnvironments.id, deployTickets.environmentId),
        eq(appEnvironments.tenantId, tenantId)
      )
    )
    .where(
      and(
        eq(deployTickets.tenantId, tenantId),
        inArray(deployTickets.appId, [...appIds]),
        eq(deployTickets.purpose, 'deploy')
      )
    )
    .orderBy(
      deployTickets.appId,
      deployTickets.environmentId,
      desc(deployTickets.createdAt),
      desc(deployTickets.id)
    )
}

/** Staging first, then production. */
function byEnvironment(a: TicketWithEnvironment, b: TicketWithEnvironment): number {
  return (a.environment === 'staging' ? 0 : 1) - (b.environment === 'staging' ? 0 : 1)
}

// ---- the poll ---------------------------------------------------------------------------------------

type RepoOf = Pick<AppRow, 'repoOwner' | 'repoName' | 'defaultBranch'>

interface PollLogger {
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface DeployReadOptions extends Pick<GitHubOptions, 'fetch' | 'apiBase'> {
  now?: Date
  /** The GitHub App credentials (tests); loaded from the platform store otherwise. */
  github?: ImportGitHub
  logger?: PollLogger
}

/** Take the ticket's read-poll turn: true for the one request whose compare-and-set landed. */
async function claimRunPoll(db: Database, ticket: DeployTicketRow, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - DEPLOY_RUN_POLL_WINDOW_MS)
  const claimed = await db
    .update(deployTickets)
    .set({
      runPolledAt: now,
      // Kept: `updated_at` is when the ticket last moved, not a read counter.
      updatedAt: sql`${deployTickets.updatedAt}`,
    })
    .where(
      and(
        eq(deployTickets.tenantId, ticket.tenantId),
        eq(deployTickets.id, ticket.id),
        inArray(deployTickets.status, [...POLLED_STATUSES]),
        isNotNull(deployTickets.runId),
        or(isNull(deployTickets.runPolledAt), lt(deployTickets.runPolledAt, cutoff))
      )
    )
    .returning({ id: deployTickets.id })
  return claimed.length > 0
}

/** Revoke a migrator credential the dead job still held — best effort, logged on failure. */
async function revokeLeftCredential(
  db: Database,
  cfg: AppConfig,
  ticket: DeployTicketRow,
  options: DeployReadOptions
): Promise<void> {
  if (!ticket.credentialsIssuedAt || ticket.credentialsRevokedAt) return
  try {
    const [environment] = await db
      .select({ neon: appEnvironments.neon })
      .from(appEnvironments)
      .where(
        and(
          eq(appEnvironments.tenantId, ticket.tenantId),
          eq(appEnvironments.id, ticket.environmentId)
        )
      )
    const vendors = await loadDeployVendors(db, cfg, { fetch: options.fetch })
    await revokeMigrator(vendors.neon, environment?.neon)
    await markCredentialsRevoked(db, ticket)
  } catch (err) {
    options.logger?.warn(
      { ticketId: ticket.id, err: err instanceof Error ? err.message : String(err) },
      'deploy progress: could not revoke the dead job’s migrator credential'
    )
  }
}

/** The ended run's ticket → `failed`, once, audited; the release run fails with it. */
async function failEndedTicket(
  db: Database,
  cfg: AppConfig,
  entry: TicketWithEnvironment,
  error: string,
  options: DeployReadOptions,
  now: Date
): Promise<boolean> {
  const { ticket, environment } = entry
  const from = ticket.status as (typeof POLLED_STATUSES)[number]
  const failed = await transitionTicket(db, ticket, [from], 'failed', { error, finishedAt: now })
  if (!failed) return false
  await revokeLeftCredential(db, cfg, failed, options)
  await recordAudit(db, {
    tenantId: failed.tenantId,
    ...SYSTEM_ACTOR,
    action: 'deploy.failed',
    targetType: 'deploy_ticket',
    targetId: failed.id,
    appId: failed.appId,
    approvalId: failed.approvalId ?? null,
    summary: {
      after: {
        environment,
        runId: failed.runId,
        actor: failed.actor,
        from,
        error,
        polledOnRead: true,
      },
    },
  })
  await releaseRunFailed(db, failed, environment, error)
  return true
}

/**
 * Poll the GitHub run of each in-progress, run-claimed ticket in `entries` (see the header).
 * Returns whether any ticket changed. Throws on a database error; a vendor error on one ticket is
 * logged and the rest go on.
 */
export async function pollDeployRuns(
  db: Database,
  cfg: AppConfig,
  apps: ReadonlyMap<string, RepoOf>,
  entries: readonly TicketWithEnvironment[],
  options: DeployReadOptions = {}
): Promise<boolean> {
  const now = options.now ?? new Date()
  const candidates = entries
    .filter(({ ticket }) => {
      const app = apps.get(ticket.appId)
      return (
        (POLLED_STATUSES as readonly string[]).includes(ticket.status) &&
        !!ticket.runId &&
        !isDeployed(ticket) &&
        !!app?.repoOwner &&
        !!app.repoName
      )
    })
    .sort((a, b) => b.ticket.createdAt.getTime() - a.ticket.createdAt.getTime())
    .slice(0, DEPLOY_RUN_POLL_MAX)
  let github: ImportGitHub | undefined = options.github
  let changed = false
  for (const entry of candidates) {
    const { ticket } = entry
    if (!(await claimRunPoll(db, ticket, now))) continue
    try {
      github ??= await loadImportGitHub(db, cfg)
      const http = { fetch: options.fetch, apiBase: options.apiBase }
      const run = await withRepoToken(
        db,
        cfg,
        apps.get(ticket.appId) as RepoOf,
        { actions: 'read' },
        (token, repo) => getWorkflowRun(token, repo.owner, repo.repo, ticket.runId as string, http),
        { ...http, github }
      )
      const ended = endedRunReason(ticket, run)
      if (ended) changed = (await failEndedTicket(db, cfg, entry, ended, options, now)) || changed
    } catch (err) {
      options.logger?.warn(
        { ticketId: ticket.id, err: err instanceof Error ? err.message : String(err) },
        'deploy progress: could not read the deploy run; the view is unchanged'
      )
    }
  }
  return changed
}

/** {@link pollDeployRuns} for a route: any error is logged and the read carries on. */
export async function pollDeployRunsSafely(
  db: Database,
  cfg: AppConfig,
  apps: ReadonlyMap<string, RepoOf>,
  entries: readonly TicketWithEnvironment[],
  options: DeployReadOptions = {}
): Promise<boolean> {
  try {
    return await pollDeployRuns(db, cfg, apps, entries, options)
  } catch (err) {
    options.logger?.error({ err }, 'deploy progress: the run poll failed; the view is unchanged')
    return false
  }
}

// ---- what the routes call ----------------------------------------------------------------------------

/** `GET /api/apps/:id/deploys/latest`: each environment's newest deploy, after the run poll. */
export async function readAppDeploys(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  app: AppRow,
  options: DeployReadOptions = {}
): Promise<DeployProgress[]> {
  const now = options.now ?? new Date()
  let latest = await latestTickets(db, tenantId, [app.id])
  if (await pollDeployRunsSafely(db, cfg, new Map([[app.id, app]]), latest, options)) {
    latest = await latestTickets(db, tenantId, [app.id])
  }
  return [...latest].sort(byEnvironment).map(e => toDeployProgress(e.ticket, e.environment, now))
}

/**
 * The deploy a catalogue row shows: the newest IN-PROGRESS one when there is one, else the newest
 * of all; null for none. Pure.
 */
export function catalogueDeploy(items: readonly DeployProgress[]): DeployProgress | null {
  const newest = (list: readonly DeployProgress[]) =>
    list.reduce<DeployProgress | null>(
      (best, d) => (!best || d.startedAt.getTime() > best.startedAt.getTime() ? d : best),
      null
    )
  return newest(items.filter(d => d.inProgress)) ?? newest(items)
}

/** `GET /api/apps`: the catalogue rows with each app's latest deploy, after the run poll. */
export async function withLatestDeploys(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  summaries: readonly AppSummary[],
  options: DeployReadOptions = {}
): Promise<AppCatalogueItem[]> {
  const now = options.now ?? new Date()
  const ids = summaries.map(s => s.id)
  let latest = await latestTickets(db, tenantId, ids)
  const repos = new Map<string, RepoOf>(
    summaries.map(s => [
      s.id,
      { repoOwner: s.repoOwner, repoName: s.repoName, defaultBranch: null },
    ])
  )
  const owed = latest.filter(e => toDeployProgress(e.ticket, e.environment, now).inProgress)
  if (owed.length > 0 && (await pollDeployRunsSafely(db, cfg, repos, owed, options))) {
    latest = await latestTickets(db, tenantId, ids)
  }
  const byApp = new Map<string, DeployProgress[]>()
  for (const e of latest) {
    byApp.set(e.ticket.appId, [
      ...(byApp.get(e.ticket.appId) ?? []),
      toDeployProgress(e.ticket, e.environment, now),
    ])
  }
  return summaries.map(s => ({ ...s, latestDeploy: catalogueDeploy(byApp.get(s.id) ?? []) }))
}
