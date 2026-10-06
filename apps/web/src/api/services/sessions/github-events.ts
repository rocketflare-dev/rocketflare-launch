/**
 * The GitHub App webhook's back half (issue #19): a `github.event` job (one delivery, already
 * verified and deduped by `POST /api/github/webhook`) mapped to the SUBJECTS waiting on it, each
 * of which is then woken.
 *
 * **Tenant isolation.** The delivery names a repository and nothing else Launch trusts as a tenant.
 * `appsForRepository` is the one pre-tenant lookup (as `/ci`'s caller lookup is): GitHub's numeric
 * repository id → the app (`apps.github_repo_id`, unique, stable across a rename), or — for an app
 * imported before that column was recorded — its `owner/name` where the id is still null. Every
 * query after it names THAT app's tenant and app id, so an event on app A's repo can only ever
 * reach app A's sessions and releases, whatever SHA or tag it carries.
 *
 * **Subjects** (`resolveGitHubSubjects`):
 * - a **landing** — a `shipping`/`shipped` session of the app whose landing is in a moving stage
 *   (`MOVING_LANDING_STAGES`) and which the event is about: one of its PR numbers is the landing's
 *   PR; its head SHA is the landing's gate SHA (`land.ci`), merge SHA (`land.main-ci`) or its
 *   release's commit; its tag is the landing's release tag (`land.staging` follows that tag's
 *   deploy run); or — in `releasing` — it is about the default branch (issue #21's newer head
 *   whose `Gate` the release waits for, or another landing's release holding the claim).
 * - a **release** — the app's release in `tagged`/`staging` (its tag's deploy run is still
 *   followed, `releases/tag-run.ts`) whose tag or commit the event names.
 *
 * **Delivery** (`deliverGitHubSubject`, the ONE place an event acts — a realtime nudge for the
 * session or release views belongs there too): a landing's Workflow instance gets
 * `SESSION_WAKE_EVENT` (empty payload: the row is the truth, and what the woken round reads is
 * GitHub, exactly as when its timeout fired); a release's tag-run read throttle is cleared so that
 * read is fresh. A subject whose instance is gone is logged, never restarted here — the
 * `sessions.checks` cron's safety net owns that. An event with no subject is a no-op.
 */
import type { GitHubEventPayload } from '@launch/shared/launch-github'
import {
  MOVING_LANDING_STAGES,
  type SessionLanding,
  type ShipLandingStage,
} from '@launch/shared/launch-sessions'
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type AppRow, appReleases, apps, sessions } from '../../../db/schema'
import type { Logger } from '../../utils/core/logger'
import { expireTagRunReading, TAG_RUN_FOLLOWED } from '../launch/releases/tag-run'
import { wakeSession } from './chat'
import { landingOf } from './steps'

/** What one delivery is about, inside one tenant. */
export type GitHubSubject =
  | {
      kind: 'landing'
      tenantId: string
      appId: string
      sessionId: string
      /** The session's current Workflow instance (`<id>-rN` after a restart). */
      instanceId: string
      stage: ShipLandingStage
    }
  | {
      kind: 'release'
      tenantId: string
      appId: string
      releaseId: string
      tag: string
    }

type AppRef = Pick<AppRow, 'id' | 'tenantId' | 'defaultBranch'>

/**
 * The apps a delivery's repository is — PRE-TENANT by design (see the header): the tenant is
 * taken from each row. By GitHub's repository id; by `owner/name` (case-insensitive) only for an
 * app with no id recorded. Archived apps are left out.
 */
export async function appsForRepository(
  db: Database,
  repository: GitHubEventPayload['repository']
): Promise<AppRef[]> {
  return db
    .select({ id: apps.id, tenantId: apps.tenantId, defaultBranch: apps.defaultBranch })
    .from(apps)
    .where(
      and(
        ne(apps.status, 'archived'),
        or(
          eq(apps.githubRepoId, repository.id),
          and(
            isNull(apps.githubRepoId),
            sql`lower(${apps.repoOwner}) = lower(${repository.owner})`,
            sql`lower(${apps.repoName}) = lower(${repository.name})`
          )
        )
      )
    )
    .limit(10)
}

/** Whether the event names `tag` (a known tag, or a head branch that may be the tag). Pure. */
function namesTag(event: GitHubEventPayload, tag: string | null): boolean {
  return !!tag && event.ref === tag && event.refKind !== 'branch'
}

/** Whether the event is about the default branch `branch`. Pure. */
function namesBranch(event: GitHubEventPayload, branch: string | null): boolean {
  return !!branch && event.ref === branch && event.refKind !== 'tag'
}

/**
 * Whether `event` concerns this landing (see the header). `releaseIds` are the app's followed
 * releases the event already matched by tag or commit. Pure.
 */
export function landingConcerned(
  landing: SessionLanding,
  event: GitHubEventPayload,
  app: Pick<AppRef, 'defaultBranch'>,
  releaseIds: ReadonlySet<string>
): boolean {
  if (event.prNumbers.includes(landing.prNumber)) return true
  const sha = event.headSha
  if (sha && (sha === landing.gateSha || sha === landing.mergeSha || sha === landing.mainCi?.sha)) {
    return true
  }
  if (namesTag(event, landing.tag)) return true
  if (landing.releaseId && releaseIds.has(landing.releaseId)) return true
  return landing.stage === 'releasing' && namesBranch(event, app.defaultBranch ?? 'main')
}

/** The followed releases of one app the event names by tag or commit — tenant-first. */
async function releaseSubjects(
  db: Database,
  app: AppRef,
  event: GitHubEventPayload
): Promise<GitHubSubject[]> {
  const byTag = event.ref && event.refKind !== 'branch' ? event.ref : null
  if (!byTag && !event.headSha) return []
  const rows = await db
    .select({ id: appReleases.id, tag: appReleases.tag })
    .from(appReleases)
    .where(
      and(
        eq(appReleases.tenantId, app.tenantId),
        eq(appReleases.appId, app.id),
        inArray(appReleases.status, [...TAG_RUN_FOLLOWED]),
        or(
          byTag ? eq(appReleases.tag, byTag) : undefined,
          event.headSha ? eq(appReleases.sha, event.headSha) : undefined
        )
      )
    )
    .limit(20)
  return rows.map(r => ({
    kind: 'release' as const,
    tenantId: app.tenantId,
    appId: app.id,
    releaseId: r.id,
    tag: r.tag,
  }))
}

/** The moving landings of one app the event concerns — tenant-first. */
async function landingSubjects(
  db: Database,
  app: AppRef,
  event: GitHubEventPayload,
  releaseIds: ReadonlySet<string>
): Promise<GitHubSubject[]> {
  const rows = await db
    .select({ id: sessions.id, instanceId: sessions.instanceId, landing: sessions.landing })
    .from(sessions)
    .where(
      and(
        eq(sessions.tenantId, app.tenantId),
        eq(sessions.appId, app.id),
        inArray(sessions.status, ['shipping', 'shipped']),
        inArray(sql<string>`${sessions.landing}->>'stage'`, [...MOVING_LANDING_STAGES])
      )
    )
    .limit(100)
  const out: GitHubSubject[] = []
  for (const row of rows) {
    const landing = landingOf(row)
    if (!landing || !landingConcerned(landing, event, app, releaseIds)) continue
    out.push({
      kind: 'landing',
      tenantId: app.tenantId,
      appId: app.id,
      sessionId: row.id,
      instanceId: row.instanceId ?? row.id,
      stage: landing.stage,
    })
  }
  return out
}

/** Every subject `event` concerns, across the apps its repository is (each in its own tenant). */
export async function resolveGitHubSubjects(
  db: Database,
  event: GitHubEventPayload
): Promise<GitHubSubject[]> {
  const subjects: GitHubSubject[] = []
  for (const app of await appsForRepository(db, event.repository)) {
    const releases = await releaseSubjects(db, app, event)
    const releaseIds = new Set(releases.map(r => (r.kind === 'release' ? r.releaseId : '')))
    subjects.push(...releases, ...(await landingSubjects(db, app, event, releaseIds)))
  }
  return subjects
}

export interface GitHubDeliveryDeps {
  db: Database
  /** `SESSION_WORKFLOW`; without it (sessions not configured) a landing subject is skipped. */
  workflow: Workflow | undefined
  logger: Pick<Logger, 'info' | 'warn'>
}

/** What delivering one subject did. */
export type GitHubDeliveryOutcome = 'woken' | 'not_woken' | 'expired' | 'unchanged'

/**
 * Act on ONE subject (see the header) — the single place a webhook does anything. Never throws
 * for a lost instance: polling and the cron cover it.
 */
export async function deliverGitHubSubject(
  subject: GitHubSubject,
  event: GitHubEventPayload,
  deps: GitHubDeliveryDeps
): Promise<GitHubDeliveryOutcome> {
  if (subject.kind === 'release') {
    const cleared = await expireTagRunReading(deps.db, subject.tenantId, subject.releaseId)
    return cleared ? 'expired' : 'unchanged'
  }
  if (!deps.workflow) return 'not_woken'
  const woken = await wakeSession(
    deps.workflow,
    { id: subject.sessionId, instanceId: subject.instanceId },
    {
      warn: (obj, msg) =>
        deps.logger.warn({ ...obj, deliveryId: event.deliveryId, event: event.event }, msg),
    }
  )
  return woken ? 'woken' : 'not_woken'
}

/** The `github.event` job: resolve, then deliver each subject. Returns the counts it logged. */
export async function handleGitHubEventPayload(
  event: GitHubEventPayload,
  deps: GitHubDeliveryDeps
): Promise<{ subjects: number; woken: number; expired: number }> {
  const subjects = await resolveGitHubSubjects(deps.db, event)
  let woken = 0
  let expired = 0
  for (const subject of subjects) {
    const outcome = await deliverGitHubSubject(subject, event, deps)
    if (outcome === 'woken') woken++
    if (outcome === 'expired') expired++
  }
  const summary = { subjects: subjects.length, woken, expired }
  deps.logger.info(
    {
      deliveryId: event.deliveryId,
      event: event.event,
      action: event.action,
      repository: `${event.repository.owner}/${event.repository.name}`,
      ...summary,
    },
    subjects.length ? 'github.event: delivered' : 'github.event: nothing waits on this event'
  )
  return summary
}
