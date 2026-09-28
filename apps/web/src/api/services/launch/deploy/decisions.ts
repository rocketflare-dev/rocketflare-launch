/**
 * Deploy decisions on the app page (Launch P2, moved onto the approvals engine in P4) — the human
 * side of the deploy gateway, behind `routes/app-deploys.ts`.
 *
 * - **List** — the app's deploy tickets, newest first, as `deployTicketSchema`. Never a credential:
 *   the migrator URL is not stored anywhere to show.
 * - **Decide** — a thin redirect (plan §4d): a waiting production ticket carries its
 *   `deploy.production` approval (`deploy_tickets.approval_id`, opened by the gateway's `start`),
 *   and deciding the ticket is `engine.decide` on that approval — the same eligibility, the same
 *   "not the author" rule, the same audit as the inbox. The kind's `applyInTx` moves the ticket
 *   (`decidePending(source: 'approval')`), and 409 `deploy_run_gone` once the run stopped waiting.
 * - **Deploy to production** — for an app with no release to promote (an imported app, a hotfix
 *   off the default branch): opens `deploy.production` with subject `app`. On approval the kind
 *   writes a pre-approval bound to the default branch and dispatches `deploy.yml` with
 *   `environment=production`; the run's `start` claims it (`claimIntent`) exactly once.
 */
import type { DeployDecision, DeployTicket } from '@launch/shared/launch-pipeline'
import type { MembershipRole } from '@launch/shared/tenants'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppRow, appEnvironments, type DeployTicketRow } from '../../../../db/schema'
import { ConflictError, NotFoundError } from '../../../utils/core/errors'
import { decide, open } from '../../approvals/engine'
import type { ApprovalDeps, ApprovalViewer } from '../../approvals/types'
import type { AuditActor } from '../audit'
import { DEPLOY_WORKFLOW_FILE, repoOf } from '../releases/github'
import { findApprovalIntent, findOpenIntent, getAppTicket, listAppTickets } from './tickets'

export { DEPLOY_WORKFLOW_FILE }

/** A row as the app page shows it. */
export function toDeployTicket(
  row: DeployTicketRow,
  environment: DeployTicket['environment']
): DeployTicket {
  return {
    id: row.id,
    appId: row.appId,
    environmentId: row.environmentId,
    environment,
    purpose: row.purpose,
    status: row.status,
    repository: row.repository,
    runId: row.runId,
    runAttempt: row.runAttempt,
    sha: row.sha,
    ref: row.ref,
    actor: row.actor,
    version: row.version,
    cfVersionId: row.cfVersionId,
    activatedAt: row.activatedAt,
    refused: row.refused ?? null,
    decisionSource: row.decisionSource,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    releaseId: row.releaseId,
    approvalId: row.approvalId,
  }
}

export async function listDeploys(
  db: Database,
  tenantId: string,
  appId: string
): Promise<DeployTicket[]> {
  const rows = await listAppTickets(db, tenantId, appId)
  return rows.map(r => toDeployTicket(r.ticket, r.environment))
}

/**
 * Approve or reject a waiting production ticket: `engine.decide` on its approval. 404 for a ticket
 * that is not this app's; 409 for one that is not a production ticket waiting on an approval.
 * The engine's own 403/409s (`not_an_approver`, `self_approval`, `already_decided`, `not_pending`)
 * and the kind's `deploy_run_gone` pass through.
 */
export async function decideDeploy(
  deps: ApprovalDeps,
  input: {
    tenantId: string
    app: Pick<AppRow, 'id'>
    ticketId: string
    decision: DeployDecision
    viewer: ApprovalViewer
    actor: AuditActor
  }
): Promise<DeployTicket> {
  const { db } = deps
  const found = await getAppTicket(db, input.tenantId, input.app.id, input.ticketId)
  if (!found || found.ticket.purpose !== 'deploy') {
    throw new NotFoundError('Deploy not found', 'deploy_ticket_not_found')
  }
  const { ticket, environment } = found
  if (environment === 'production' && ticket.status === 'pending' && !ticket.approvalId) {
    // `start` inserts the ticket, then opens its approval: a click in between waits a moment.
    throw new ConflictError(
      'This deploy is still opening its approval; try again in a moment',
      'deploy_ticket_state'
    )
  }
  if (environment !== 'production' || !ticket.approvalId) {
    throw new ConflictError(
      `Only a production deploy waiting on an approval can be decided (this one is ${environment}, ${ticket.status})`,
      'deploy_ticket_state'
    )
  }
  await decide(deps, {
    requestId: ticket.approvalId,
    viewer: input.viewer,
    decision: input.decision.decision,
    comment: input.decision.reason ?? null,
    actor: input.actor,
  })
  const after = await getAppTicket(db, input.tenantId, input.app.id, ticket.id)
  return toDeployTicket(after?.ticket ?? ticket, environment)
}

async function productionOf(db: Database, tenantId: string, appId: string) {
  const [row] = await db
    .select()
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, tenantId),
        eq(appEnvironments.appId, appId),
        eq(appEnvironments.name, 'production')
      )
    )
    .limit(1)
  return row ?? null
}

/**
 * "Deploy to production" without a release: open `deploy.production` with subject `app`, the
 * clicker as requester (so a second person approves). Returns the approval, and the pre-approval
 * when a policy auto-approved it on the spot.
 */
export async function requestProductionDeploy(
  deps: ApprovalDeps,
  input: {
    tenantId: string
    app: AppRow
    user: { id: string; email: string; role: MembershipRole | null }
    actor: AuditActor
    reason?: string | null
  }
): Promise<{ ticket: DeployTicket | null; approvalId: string }> {
  const { db } = deps
  const { tenantId, app } = input
  const production = await productionOf(db, tenantId, app.id)
  if (!production) {
    throw new ConflictError('This app has no production environment', 'app_environment_missing')
  }
  const { branch } = repoOf(app)
  const scope = { tenantId, appId: app.id, environmentId: production.id }
  if (await findOpenIntent(db, scope, deps.now?.() ?? new Date())) {
    throw new ConflictError(
      'A production deploy is already approved and waiting for its run',
      'production_deploy_pending'
    )
  }
  const staging = await db
    .select()
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, tenantId),
        eq(appEnvironments.appId, app.id),
        eq(appEnvironments.name, 'staging')
      )
    )
    .limit(1)
    .then(rows => rows[0] ?? null)

  const opened = await open(deps, {
    tenantId,
    kind: 'deploy.production',
    subject: { type: 'app', id: app.id },
    appId: app.id,
    requester: { userId: input.user.id, email: input.user.email, role: input.user.role },
    reason: input.reason ?? `Deploy ${branch} to production (${DEPLOY_WORKFLOW_FILE})`,
    context: {
      kind: 'deploy.production',
      environment: 'production',
      version: null,
      tag: null,
      sha: null,
      ref: `refs/heads/${branch}`,
      compareUrl: null,
      prs: [],
      stagingHealth: staging?.healthStatus ?? null,
      stagingVersion: staging?.healthVersion ?? staging?.lastDeployVersion ?? null,
    },
    excludedUserIds: [input.user.id],
    actor: input.actor,
  })
  const intent: DeployTicketRow | null = await findApprovalIntent(db, tenantId, opened.request.id)
  return {
    ticket: intent ? toDeployTicket(intent, 'production') : null,
    approvalId: opened.request.id,
  }
}
