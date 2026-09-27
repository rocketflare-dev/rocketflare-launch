/**
 * Scaffold tickets (Launch P2) — the `deploy_tickets` rows with `purpose = 'scaffold'` behind
 * `/ci/scaffold`. Every query here carries the tenant: the caller was resolved first
 * (`resolveCaller`), and its tenant is the app row's.
 *
 * The life of one: the launch run's `scaffold.start` step (slice 2c, `pipeline/launch-steps.ts`)
 * opens it `approved`, `run_id` NULL, on the app's PRODUCTION environment (`main` is production's
 * branch, and the job carries no `environment` claim), with `launch_run_id` set. The job's `POST
 * /ci/scaffold/token` CLAIMS it — binds the GitHub run with a compare-and-set on `run_id IS NULL`,
 * so a second call from any run finds nothing and gets a 409 — and `POST /ci/scaffold/done`
 * finishes it with `sha` = the commit the job pushed, which the pipeline's wait reads.
 */
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type DeployTicketRow, deployTickets } from '../../../../db/schema'
import { ConflictError } from '../../../utils/core/errors'
import type { ResolvedCaller } from '../ci/caller'

/**
 * The environment a scaffold ticket belongs to, and the one the job's token (which names none)
 * resolves to — the pipeline's `SCAFFOLD_TICKET_ENVIRONMENT`.
 */
export const SCAFFOLD_ENVIRONMENT = 'production' as const

/**
 * Bind the caller's GitHub run to the app's waiting scaffold ticket (newest first), or null when
 * there is none — never waiting, already claimed (by this run or another) or expired. One
 * statement: the `run_id IS NULL` in the UPDATE is the compare-and-set.
 */
export async function claimScaffoldTicket(
  db: Database,
  caller: ResolvedCaller,
  now: Date = new Date()
): Promise<DeployTicketRow | null> {
  const { claims } = caller
  const waiting = db
    .select({ id: deployTickets.id })
    .from(deployTickets)
    .where(
      and(
        eq(deployTickets.tenantId, caller.tenantId),
        eq(deployTickets.appId, caller.app.id),
        eq(deployTickets.environmentId, caller.environment.id),
        eq(deployTickets.purpose, 'scaffold'),
        eq(deployTickets.status, 'approved'),
        isNull(deployTickets.runId),
        or(isNull(deployTickets.expiresAt), gt(deployTickets.expiresAt, now))
      )
    )
    .orderBy(desc(deployTickets.createdAt))
    .limit(1)
  const [row] = await db
    .update(deployTickets)
    .set({
      repositoryId: claims.repository_id,
      repository: claims.repository,
      runId: claims.run_id,
      runAttempt: Number.parseInt(claims.run_attempt, 10) || 1,
      ref: claims.ref,
      actor: claims.actor,
      jobWorkflowRef: claims.job_workflow_ref,
      credentialsIssuedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(deployTickets.tenantId, caller.tenantId),
        isNull(deployTickets.runId),
        eq(deployTickets.status, 'approved'),
        sql`${deployTickets.id} = (${waiting})`
      )
    )
    .returning()
  return row ?? null
}

/** A claimed ticket could not be served (the token mint failed): it is `failed`, with why. */
export async function failScaffoldTicket(
  db: Database,
  ticket: DeployTicketRow,
  error: string,
  now: Date = new Date()
): Promise<void> {
  await db
    .update(deployTickets)
    .set({ status: 'failed', error, finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(deployTickets.tenantId, ticket.tenantId),
        eq(deployTickets.id, ticket.id),
        eq(deployTickets.status, 'approved')
      )
    )
}

/**
 * Finish the caller's run's scaffold ticket with the commit it pushed. Idempotent for the same
 * commit (a retried `done` gets the same answer); a different commit, or a ticket in any other
 * state, is a 409. No ticket bound to this run is a 409 too — `done` before `token` means nothing.
 */
export async function finishScaffoldTicket(
  db: Database,
  caller: ResolvedCaller,
  commit: string,
  now: Date = new Date()
): Promise<{ ticket: DeployTicketRow; repeated: boolean }> {
  const bound = and(
    eq(deployTickets.tenantId, caller.tenantId),
    eq(deployTickets.appId, caller.app.id),
    eq(deployTickets.environmentId, caller.environment.id),
    eq(deployTickets.purpose, 'scaffold'),
    eq(deployTickets.runId, caller.claims.run_id)
  )
  const [finished] = await db
    .update(deployTickets)
    .set({ status: 'finished', sha: commit, finishedAt: now, updatedAt: now })
    .where(and(bound, eq(deployTickets.status, 'approved')))
    .returning()
  if (finished) return { ticket: finished, repeated: false }

  const [existing] = await db
    .select()
    .from(deployTickets)
    .where(bound)
    .orderBy(desc(deployTickets.createdAt))
    .limit(1)
  if (existing?.status === 'finished' && existing.sha === commit) {
    return { ticket: existing, repeated: true }
  }
  throw new ConflictError(
    existing
      ? `The scaffold ticket is ${existing.status}${existing.sha ? ` (commit ${existing.sha})` : ''}`
      : 'This run holds no scaffold ticket: call /ci/scaffold/token first',
    'scaffold_ticket_not_open'
  )
}
