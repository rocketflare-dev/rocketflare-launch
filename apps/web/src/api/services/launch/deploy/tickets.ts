/**
 * Deploy tickets (Launch P2) — the rows behind `/ci/deploy` and `/ci/scaffold`
 * (`db/schema/deploy-tickets.ts`), and the compare-and-set transitions of DEPLOYER.md's status
 * table:
 *
 * | From                              | To         | By                                          |
 * |-----------------------------------|------------|---------------------------------------------|
 * | (none)                            | `approved` | staging `start` (policy), or a pre-approval |
 * | (none)                            | `pending`  | production `start` with no pre-approval     |
 * | `pending`                         | `approved` / `rejected` | a `deploy.production` approval (P4), or expiry |
 * | `approved`                        | `uploaded` | a build that passed the check               |
 * | `approved` / `uploaded`           | `failed`   | a refused build, a failed upload/activation |
 * | `uploaded`                        | `active`   | `activate`                                  |
 * | `pending`/`approved`/`uploaded`/`active` | `finished` | `finish`                            |
 *
 * **Every transition is `UPDATE … WHERE id = $id AND status IN ($from) RETURNING`**: a caller that
 * lost a race gets `null` and answers 409, never a lost write. A pre-approval is CLAIMED the same
 * way (`run_id IS NULL` in the predicate), so two runs cannot both take it — and, from P4, only by a
 * run on the ref it was bound to.
 *
 * **Lookups by ticket id are pre-tenant by design** (allow-listed in
 * `tests/config/unscoped-allowlist.test.ts`): a CI call names a ticket id and carries a GitHub
 * OIDC token, not a session. The caller proves itself first (`resolveCaller`), the ticket is then
 * read by id, and it must belong to the caller's app and environment — its `tenant_id` is the
 * row's, never the request's. Every write after that names the row's tenant too.
 */
import type { DeployDecisionSource, DeployTicketStatus } from '@launch/shared/launch-pipeline'
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import {
  appEnvironments,
  type DeployTicketRow,
  deployTickets,
  type NewDeployTicketRow,
} from '../../../../db/schema'

/** A ticket by id, whatever its tenant, or null. The caller checks app, environment and run. */
export async function getTicketById(
  db: Database,
  ticketId: string
): Promise<DeployTicketRow | null> {
  const [row] = await db.select().from(deployTickets).where(eq(deployTickets.id, ticketId)).limit(1)
  return row ?? null
}

/** Who opened a ticket — the GitHub OIDC claims it records. */
export interface TicketRun {
  repositoryId: string
  repository: string
  runId: string
  runAttempt: number
  sha: string
  ref: string
  actor: string
  jobWorkflowRef: string
}

export interface TicketScope {
  tenantId: string
  appId: string
  environmentId: string
}

/** The ticket this run attempt already opened in the environment, if any (`start` is idempotent). */
export async function findRunTicket(
  db: Database,
  scope: TicketScope,
  purpose: DeployTicketRow['purpose'],
  run: Pick<TicketRun, 'runId' | 'runAttempt'>
): Promise<DeployTicketRow | null> {
  const [row] = await db
    .select()
    .from(deployTickets)
    .where(
      and(
        eq(deployTickets.tenantId, scope.tenantId),
        eq(deployTickets.environmentId, scope.environmentId),
        eq(deployTickets.purpose, purpose),
        eq(deployTickets.runId, run.runId),
        eq(deployTickets.runAttempt, run.runAttempt)
      )
    )
    .limit(1)
  return row ?? null
}

/**
 * Open a ticket for a run. The unique `(environment_id, purpose, run_id, run_attempt)` makes a
 * retried `start` a no-op: on a conflict the existing row comes back and `created` is false.
 */
export async function openRunTicket(
  db: Database,
  scope: TicketScope,
  run: TicketRun,
  values: Pick<
    NewDeployTicketRow,
    'purpose' | 'status' | 'decisionSource' | 'decidedAt' | 'expiresAt' | 'launchRunId'
  > &
    Partial<Pick<NewDeployTicketRow, 'releaseId'>>
): Promise<{ ticket: DeployTicketRow; created: boolean }> {
  const [row] = await db
    .insert(deployTickets)
    .values({ ...scope, ...run, ...values })
    .onConflictDoNothing({
      target: [
        deployTickets.environmentId,
        deployTickets.purpose,
        deployTickets.runId,
        deployTickets.runAttempt,
      ],
    })
    .returning()
  if (row) return { ticket: row, created: true }
  const existing = await findRunTicket(db, scope, values.purpose, run)
  if (!existing) throw new Error('deploy_tickets: conflict without a row')
  return { ticket: existing, created: false }
}

/**
 * Claim the environment's oldest live pre-approval ("Deploy to production", or a Promote's
 * approval) for `run`: the row takes the run's claims, and `run_id IS NULL` in the UPDATE makes it
 * claimable exactly once. From P4 a pre-approval may be BOUND to a ref (`refs/tags/X.Y.Z` for a
 * release, the default branch for "Deploy to production"): only a run carrying that ref may claim
 * it (`ref IS NULL OR ref = run.ref`), so an approval of tag A is never spent by a run of tag B.
 * Returns null when there is none (the caller opens a `pending` ticket instead).
 */
export async function claimIntent(
  db: Database,
  scope: TicketScope,
  run: TicketRun,
  launchRunId: string | null,
  now = new Date()
): Promise<DeployTicketRow | null> {
  const candidates = await db
    .select({ id: deployTickets.id })
    .from(deployTickets)
    .where(
      and(
        eq(deployTickets.tenantId, scope.tenantId),
        eq(deployTickets.environmentId, scope.environmentId),
        eq(deployTickets.purpose, 'deploy'),
        eq(deployTickets.status, 'approved'),
        isNull(deployTickets.runId),
        gt(deployTickets.expiresAt, now),
        or(isNull(deployTickets.ref), eq(deployTickets.ref, run.ref))
      )
    )
    .orderBy(asc(deployTickets.createdAt))
    .limit(5)
  for (const { id } of candidates) {
    const [claimed] = await db
      .update(deployTickets)
      .set({ ...run, launchRunId, updatedAt: now })
      .where(
        and(
          eq(deployTickets.id, id),
          eq(deployTickets.tenantId, scope.tenantId),
          eq(deployTickets.status, 'approved'),
          isNull(deployTickets.runId),
          gt(deployTickets.expiresAt, now),
          or(isNull(deployTickets.ref), eq(deployTickets.ref, run.ref))
        )
      )
      .returning()
    if (claimed) return claimed
  }
  return null
}

/** An unclaimed, unexpired pre-approval for the environment, if one is waiting. */
export async function findOpenIntent(
  db: Database,
  scope: TicketScope,
  now = new Date()
): Promise<DeployTicketRow | null> {
  const [row] = await db
    .select()
    .from(deployTickets)
    .where(
      and(
        eq(deployTickets.tenantId, scope.tenantId),
        eq(deployTickets.environmentId, scope.environmentId),
        eq(deployTickets.purpose, 'deploy'),
        eq(deployTickets.status, 'approved'),
        isNull(deployTickets.runId),
        gt(deployTickets.expiresAt, now)
      )
    )
    .limit(1)
  return row ?? null
}

/**
 * Insert a pre-approval: `approved`, no run yet, expiring soon. P2's "Deploy to production" wrote
 * one directly (`source: 'intent'`); from P4 a granted `deploy.production` approval writes it
 * (`source: 'approval'`), bound to the ref its run must carry and linked to the approval and the
 * release — the chain's links (plan §1.11).
 */
export async function insertIntent(
  db: Database,
  scope: TicketScope,
  input: {
    userId: string | null
    expiresAt: Date
    now?: Date
    /** Only a run on this ref may claim it (`claimIntent`); null = any ref (P2's intents). */
    ref?: string | null
    approvalId?: string | null
    releaseId?: string | null
    source?: 'intent' | 'approval'
  }
): Promise<DeployTicketRow> {
  const now = input.now ?? new Date()
  const [row] = await db
    .insert(deployTickets)
    .values({
      ...scope,
      purpose: 'deploy',
      status: 'approved',
      decisionSource: input.source ?? 'intent',
      decidedByUserId: input.userId,
      decidedAt: now,
      expiresAt: input.expiresAt,
      ref: input.ref ?? null,
      approvalId: input.approvalId ?? null,
      releaseId: input.releaseId ?? null,
    })
    .returning()
  if (!row) throw new Error('deploy_tickets insert returned no row')
  return row
}

/** The pre-approval (claimed or not) a `deploy.production` approval wrote, if any. */
export async function findApprovalIntent(
  db: Database,
  tenantId: string,
  approvalId: string
): Promise<DeployTicketRow | null> {
  const [row] = await db
    .select()
    .from(deployTickets)
    .where(and(eq(deployTickets.tenantId, tenantId), eq(deployTickets.approvalId, approvalId)))
    .orderBy(desc(deployTickets.createdAt))
    .limit(1)
  return row ?? null
}

/** A ticket of the tenant by id, or null. */
export async function getTenantTicket(
  db: Database,
  tenantId: string,
  ticketId: string
): Promise<DeployTicketRow | null> {
  const [row] = await db
    .select()
    .from(deployTickets)
    .where(and(eq(deployTickets.tenantId, tenantId), eq(deployTickets.id, ticketId)))
    .limit(1)
  return row ?? null
}

/** Link a ticket into the audit chain: the release its tag names, the approval that gates it. */
export async function linkTicket(
  db: Database,
  ticket: Pick<DeployTicketRow, 'id' | 'tenantId'>,
  links: { releaseId?: string | null; approvalId?: string | null }
): Promise<DeployTicketRow | null> {
  const set: Partial<NewDeployTicketRow> = {}
  if (links.releaseId !== undefined) set.releaseId = links.releaseId
  if (links.approvalId !== undefined) set.approvalId = links.approvalId
  if (Object.keys(set).length === 0) return null
  const [row] = await db
    .update(deployTickets)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(deployTickets.id, ticket.id), eq(deployTickets.tenantId, ticket.tenantId)))
    .returning()
  return row ?? null
}

/** Columns a transition may set beside the status. */
export type TicketPatch = Partial<
  Pick<
    NewDeployTicketRow,
    | 'version'
    | 'cfVersionId'
    | 'bindings'
    | 'refused'
    | 'credentialsIssuedAt'
    | 'credentialsRevokedAt'
    | 'decidedByUserId'
    | 'decidedAt'
    | 'decisionSource'
    | 'error'
    | 'finishedAt'
  >
>

/**
 * Compare-and-set: move `ticket` to `to` only if it is still in one of `from`. Returns the updated
 * row, or null when another call moved it first (the caller answers 409).
 */
export async function transitionTicket(
  db: Database,
  ticket: Pick<DeployTicketRow, 'id' | 'tenantId'>,
  from: readonly DeployTicketStatus[],
  to: DeployTicketStatus,
  patch: TicketPatch = {}
): Promise<DeployTicketRow | null> {
  const [row] = await db
    .update(deployTickets)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(
      and(
        eq(deployTickets.id, ticket.id),
        eq(deployTickets.tenantId, ticket.tenantId),
        inArray(deployTickets.status, [...from])
      )
    )
    .returning()
  return row ?? null
}

/**
 * A person's (or the expiry's) decision on a PENDING ticket. Approval also needs it unexpired; a
 * rejection does not. Null when it was not pending (or had expired) — 409.
 */
export async function decidePending(
  db: Database,
  ticket: Pick<DeployTicketRow, 'id' | 'tenantId'>,
  decision: {
    approve: boolean
    userId: string | null
    source: DeployDecisionSource
    error?: string
  },
  now = new Date()
): Promise<DeployTicketRow | null> {
  const [row] = await db
    .update(deployTickets)
    .set({
      status: decision.approve ? 'approved' : 'rejected',
      decidedByUserId: decision.userId,
      decidedAt: now,
      decisionSource: decision.source,
      ...(decision.error ? { error: decision.error } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(deployTickets.id, ticket.id),
        eq(deployTickets.tenantId, ticket.tenantId),
        eq(deployTickets.status, 'pending'),
        ...(decision.approve ? [gt(deployTickets.expiresAt, now)] : [])
      )
    )
    .returning()
  return row ?? null
}

/** A pending ticket whose approval window closed becomes `rejected` (null if it was not). */
export async function expirePending(
  db: Database,
  ticket: Pick<DeployTicketRow, 'id' | 'tenantId'>,
  now = new Date()
): Promise<DeployTicketRow | null> {
  const [row] = await db
    .update(deployTickets)
    .set({ status: 'rejected', error: 'Nobody approved it in time', updatedAt: now })
    .where(
      and(
        eq(deployTickets.id, ticket.id),
        eq(deployTickets.tenantId, ticket.tenantId),
        eq(deployTickets.status, 'pending'),
        lte(deployTickets.expiresAt, now)
      )
    )
    .returning()
  return row ?? null
}

/** Record that the migrator credential was revoked — once; null when it already was. */
export async function markCredentialsRevoked(
  db: Database,
  ticket: Pick<DeployTicketRow, 'id' | 'tenantId'>
): Promise<DeployTicketRow | null> {
  const [row] = await db
    .update(deployTickets)
    .set({ credentialsRevokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(deployTickets.id, ticket.id),
        eq(deployTickets.tenantId, ticket.tenantId),
        sql`${deployTickets.credentialsIssuedAt} IS NOT NULL`,
        isNull(deployTickets.credentialsRevokedAt)
      )
    )
    .returning()
  return row ?? null
}

/** Record that the migrator credential was issued (the URI itself is never stored). */
export async function markCredentialsIssued(
  db: Database,
  ticket: Pick<DeployTicketRow, 'id' | 'tenantId'>
): Promise<DeployTicketRow | null> {
  const [row] = await db
    .update(deployTickets)
    .set({ credentialsIssuedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(deployTickets.id, ticket.id),
        eq(deployTickets.tenantId, ticket.tenantId),
        eq(deployTickets.status, 'uploaded')
      )
    )
    .returning()
  return row ?? null
}

/** Statuses `finish` moves to `finished`; the terminal ones keep their status. */
const OPEN_STATUSES = ['pending', 'approved', 'uploaded', 'active'] as const

/**
 * Close a ticket, once: `finished_at` is set by exactly one call (the one that gets a row back),
 * and an open status becomes `finished`. A `rejected` or `failed` ticket keeps its status.
 */
export async function closeTicket(
  db: Database,
  ticket: Pick<DeployTicketRow, 'id' | 'tenantId'>,
  now = new Date()
): Promise<DeployTicketRow | null> {
  const [row] = await db
    .update(deployTickets)
    .set({
      status: sql`CASE WHEN ${deployTickets.status} IN (${sql.join(
        OPEN_STATUSES.map(s => sql`${s}`),
        sql`, `
      )}) THEN 'finished'::deploy_ticket_status ELSE ${deployTickets.status} END`,
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(deployTickets.id, ticket.id),
        eq(deployTickets.tenantId, ticket.tenantId),
        isNull(deployTickets.finishedAt)
      )
    )
    .returning()
  return row ?? null
}

/** A ticket with its environment's name, as the app page lists it. */
export interface TicketWithEnvironment {
  ticket: DeployTicketRow
  environment: 'staging' | 'production'
}

/** The app's deploy tickets, newest first. */
export async function listAppTickets(
  db: Database,
  tenantId: string,
  appId: string,
  limit = 50
): Promise<TicketWithEnvironment[]> {
  const rows = await db
    .select({ ticket: deployTickets, environment: appEnvironments.name })
    .from(deployTickets)
    .innerJoin(appEnvironments, eq(appEnvironments.id, deployTickets.environmentId))
    .where(
      and(
        eq(deployTickets.tenantId, tenantId),
        eq(deployTickets.appId, appId),
        eq(deployTickets.purpose, 'deploy')
      )
    )
    .orderBy(desc(deployTickets.createdAt))
    .limit(limit)
  return rows
}

/** One of the app's tickets, with its environment's name, or null. */
export async function getAppTicket(
  db: Database,
  tenantId: string,
  appId: string,
  ticketId: string
): Promise<TicketWithEnvironment | null> {
  const [row] = await db
    .select({ ticket: deployTickets, environment: appEnvironments.name })
    .from(deployTickets)
    .innerJoin(appEnvironments, eq(appEnvironments.id, deployTickets.environmentId))
    .where(
      and(
        eq(deployTickets.tenantId, tenantId),
        eq(deployTickets.appId, appId),
        eq(deployTickets.id, ticketId)
      )
    )
    .limit(1)
  return row ?? null
}
