/**
 * Where a release has got to (Launch P4, plan §1.8 / §1.11) — the transitions the deploy gateway
 * and the `deploy.production` kind move it through, and the links that make its chain:
 *
 *   tagged → staging → staging_active → awaiting_approval → promoting → production_active
 *                                          ↘ rejected
 *
 * - **`releaseForRef`**: a run's OIDC `ref` of `refs/tags/X.Y.Z` names the app's release `X.Y.Z` —
 *   that is how `start` sets `deploy_tickets.release_id` (linked, never inferred from timing).
 * - **`releaseRunStarted` / `releaseRunActivated`**: a run on the release's tag starting and going
 *   live, per environment, audited `release.staging_active` / `release.production`.
 * - **`releaseExclusions`**: who may not approve the release's production deploy (plan §1.6) —
 *   whoever cut it and the creators of the sessions whose PRs it carries. GitHub-only authors are
 *   logins, not Launch users (a known gap).
 *
 * - **Rollback (app page P3)**: a production run of a release that was live before activating is a
 *   re-deploy or a rollback (`releaseRedeployed`): an earlier version than production ran records
 *   `rolled_back_from` on it and moves the replaced release `production_active → rolled_back`,
 *   audited `release.rolled_back`.
 *
 * Every transition is a compare-and-set on the current status, so a late or repeated event (a
 * retried activate, a staging re-run after promotion) never moves a release backwards.
 */
import {
  compareReleaseVersions,
  parseReleaseVersion,
  type ReleaseStatus,
  ROLLBACK_TARGET_STATUSES,
} from '@launch/shared/launch-releases'
import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import {
  type AppReleaseRow,
  appReleases,
  type DeployTicketRow,
  sessions,
} from '../../../../db/schema'
import { type AuditActor, recordAudit, SYSTEM_ACTOR } from '../audit'

const TAG_REF_PREFIX = 'refs/tags/'

/** The app's release whose tag `ref` names, or null (a branch ref, or a tag Launch did not cut). */
export async function releaseForRef(
  db: Database,
  tenantId: string,
  appId: string,
  ref: string | null | undefined
): Promise<AppReleaseRow | null> {
  if (!ref?.startsWith(TAG_REF_PREFIX)) return null
  const tag = ref.slice(TAG_REF_PREFIX.length)
  const [row] = await db
    .select()
    .from(appReleases)
    .where(
      and(
        eq(appReleases.tenantId, tenantId),
        eq(appReleases.appId, appId),
        eq(appReleases.tag, tag)
      )
    )
    .limit(1)
  return row ?? null
}

/** Compare-and-set the release's status (plus columns), or null when it had moved on. */
export async function moveRelease(
  db: Database,
  release: Pick<AppReleaseRow, 'id' | 'tenantId'>,
  from: readonly ReleaseStatus[],
  to: ReleaseStatus,
  patch: Partial<
    Pick<
      AppReleaseRow,
      'approvalId' | 'stagingTicketId' | 'productionTicketId' | 'error' | 'rolledBackFrom'
    >
  > = {}
): Promise<AppReleaseRow | null> {
  const [row] = await db
    .update(appReleases)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(
      and(
        eq(appReleases.id, release.id),
        eq(appReleases.tenantId, release.tenantId),
        inArray(appReleases.status, [...from])
      )
    )
    .returning()
  return row ?? null
}

/** A run on the release's tag started: staging moves it to `staging`; both record the ticket. */
export async function releaseRunStarted(
  db: Database,
  release: AppReleaseRow,
  environment: 'staging' | 'production',
  ticket: Pick<DeployTicketRow, 'id'>
): Promise<void> {
  if (environment === 'staging') {
    await moveRelease(db, release, ['tagged', 'staging', 'failed'], 'staging', {
      stagingTicketId: ticket.id,
    })
    return
  }
  // Production: keep the status (`promoting` or `awaiting_approval`); only remember the run.
  await db
    .update(appReleases)
    .set({ productionTicketId: ticket.id, updatedAt: new Date() })
    .where(and(eq(appReleases.id, release.id), eq(appReleases.tenantId, release.tenantId)))
}

interface RunActivatedInput {
  releaseId: string
  tenantId: string
  environment: 'staging' | 'production'
  ticket: Pick<DeployTicketRow, 'id' | 'approvalId' | 'version'>
  /** What the environment ran BEFORE this activation (its `last_deploy_version`). */
  previousVersion?: string | null
  actor?: AuditActor
}

/** The app's release `version`, tenant-first, or null. */
async function releaseByVersion(
  db: Database,
  tenantId: string,
  appId: string,
  version: string
): Promise<AppReleaseRow | null> {
  const [row] = await db
    .select()
    .from(appReleases)
    .where(
      and(
        eq(appReleases.tenantId, tenantId),
        eq(appReleases.appId, appId),
        eq(appReleases.version, version)
      )
    )
    .limit(1)
  return row ?? null
}

/**
 * App page P3: production went live with a release that had been live before
 * (`ROLLBACK_TARGET_STATUSES`) — a Rollback's dispatch, or the same dispatch made by hand in
 * GitHub (the app stays detachable, so the run is recognised by its tag, not by who started it).
 *
 * - EARLIER than what production ran → a rollback: this release records `rolled_back_from` (the
 *   version it replaced), the release that was live goes `rolled_back`, audited `release.rolled_back`
 *   on it (the one rolled back);
 * - the same version (a re-deploy) or a later one (rolling forward to a release rolled back
 *   before) → it is simply live again; a roll forward clears its own `rolled_back_from`.
 */
async function releaseRedeployed(
  db: Database,
  target: AppReleaseRow,
  input: RunActivatedInput
): Promise<AppReleaseRow | null> {
  const from = input.previousVersion ?? null
  const order = from ? compareReleaseVersions(target.version, from) : 0
  const back = from !== null && parseReleaseVersion(from) !== null && order < 0
  if (!back) {
    return moveRelease(db, target, ROLLBACK_TARGET_STATUSES, 'production_active', {
      productionTicketId: input.ticket.id,
      ...(order > 0 ? { rolledBackFrom: null } : {}),
    })
  }
  const moved = await moveRelease(db, target, ROLLBACK_TARGET_STATUSES, 'production_active', {
    productionTicketId: input.ticket.id,
    rolledBackFrom: from,
  })
  if (!moved) return null
  const replaced = await releaseByVersion(db, target.tenantId, target.appId, from)
  const rolledBack = replaced
    ? await moveRelease(db, replaced, ['production_active'], 'rolled_back')
    : null
  await recordAudit(db, {
    ...(input.actor ?? SYSTEM_ACTOR),
    tenantId: target.tenantId,
    action: 'release.rolled_back',
    targetType: 'release',
    // The release rolled back, when Launch cut it; else the one rolled back to.
    targetId: replaced?.id ?? moved.id,
    appId: moved.appId,
    approvalId: input.ticket.approvalId ?? null,
    summary: {
      before: { live: from, status: replaced?.status ?? null },
      after: {
        live: moved.version,
        tag: moved.tag,
        releaseId: moved.id,
        status: rolledBack?.status ?? replaced?.status ?? null,
        ticketId: input.ticket.id,
      },
    },
  })
  return moved
}

/**
 * A run on the release's tag went live: `staging_active` / `production_active`, audited. A
 * production run of a release that was live before is a re-deploy or a rollback
 * (`releaseRedeployed`).
 */
export async function releaseRunActivated(
  db: Database,
  input: RunActivatedInput
): Promise<AppReleaseRow | null> {
  const release = { id: input.releaseId, tenantId: input.tenantId }
  if (input.environment === 'production') {
    const [current] = await db
      .select()
      .from(appReleases)
      .where(and(eq(appReleases.id, release.id), eq(appReleases.tenantId, release.tenantId)))
      .limit(1)
    if (current && (ROLLBACK_TARGET_STATUSES as readonly string[]).includes(current.status)) {
      return releaseRedeployed(db, current, input)
    }
  }
  const moved =
    input.environment === 'staging'
      ? await moveRelease(db, release, ['tagged', 'staging', 'failed'], 'staging_active', {
          stagingTicketId: input.ticket.id,
        })
      : await moveRelease(
          db,
          release,
          ['tagged', 'staging', 'staging_active', 'awaiting_approval', 'promoting', 'failed'],
          'production_active',
          { productionTicketId: input.ticket.id }
        )
  if (!moved) return null
  await recordAudit(db, {
    ...(input.actor ?? SYSTEM_ACTOR),
    tenantId: input.tenantId,
    action: input.environment === 'staging' ? 'release.staging_active' : 'release.production',
    targetType: 'release',
    targetId: moved.id,
    appId: moved.appId,
    approvalId: input.environment === 'production' ? (input.ticket.approvalId ?? null) : null,
    summary: {
      after: {
        status: moved.status,
        version: moved.version,
        tag: moved.tag,
        ticketId: input.ticket.id,
        deployedVersion: input.ticket.version ?? null,
      },
    },
  })
  return moved
}

/**
 * A run on the release's tag failed (a refused build, a failed upload or activation).
 *
 * Only the release's CURRENT run of that environment may fail it (app page P2): after a Retry
 * re-ran the run, attempt 2 opened a ticket of its own and the release names that one, so attempt
 * 1's ticket — failed late by the run poll ("attempt 2 is a deploy of its own") — leaves the
 * release alone instead of failing the retry it was superseded by.
 */
export async function releaseRunFailed(
  db: Database,
  ticket: Pick<DeployTicketRow, 'id' | 'releaseId' | 'tenantId'>,
  environment: 'staging' | 'production',
  error: string
): Promise<void> {
  if (!ticket.releaseId) return
  const current =
    environment === 'staging' ? appReleases.stagingTicketId : appReleases.productionTicketId
  await db
    .update(appReleases)
    .set({ status: 'failed', error: `${environment}: ${error}`, updatedAt: new Date() })
    .where(
      and(
        eq(appReleases.id, ticket.releaseId),
        eq(appReleases.tenantId, ticket.tenantId),
        inArray(
          appReleases.status,
          environment === 'staging' ? ['tagged', 'staging'] : ['promoting']
        ),
        or(isNull(current), eq(current, ticket.id))
      )
    )
}

/**
 * Who may not approve `release`'s production deploy: whoever cut it and the creators of the
 * sessions whose PRs it carries (plus, at open, the requester — the engine adds them).
 */
export async function releaseExclusions(
  db: Database,
  release: Pick<AppReleaseRow, 'tenantId' | 'appId' | 'createdByUserId' | 'prs'>
): Promise<string[]> {
  const out = new Set<string>()
  if (release.createdByUserId) out.add(release.createdByUserId)
  const sessionIds = release.prs.map(p => p.sessionId).filter((id): id is string => Boolean(id))
  if (sessionIds.length > 0) {
    const rows = await db
      .select({ createdByUserId: sessions.createdByUserId })
      .from(sessions)
      .where(
        and(
          eq(sessions.tenantId, release.tenantId),
          eq(sessions.appId, release.appId),
          inArray(sessions.id, sessionIds),
          isNotNull(sessions.createdByUserId)
        )
      )
    for (const row of rows) if (row.createdByUserId) out.add(row.createdByUserId)
  }
  return [...out]
}
