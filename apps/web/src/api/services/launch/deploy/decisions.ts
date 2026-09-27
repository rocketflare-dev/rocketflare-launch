/**
 * Deploy decisions on the app page (Launch P2) — the human side of the deploy gateway, behind
 * `routes/app-deploys.ts`. P4 swaps the decision source for the approvals engine (spec/08); until
 * then an app's owners and the organisation's admins decide here.
 *
 * - **List** — the app's deploy tickets, newest first, as `deployTicketSchema`. Never a credential:
 *   the migrator URL is not stored anywhere to show.
 * - **Decide** — approve or reject a `pending` PRODUCTION ticket while its run is still waiting
 *   (compare-and-set: a second decider, or one after the window closed, gets 409). Audited as
 *   `deploy.production.approved` / `deploy.production.rejected`.
 * - **Deploy to production** — a pre-approval (an `approved` ticket with no run, expiring after
 *   `PRODUCTION_INTENT_TTL_MS`), then `workflow_dispatch` of `deploy.yml` with
 *   `environment=production` on the default branch. The run's `start` claims it
 *   (`claimIntent`), so it is spent exactly once. A failed dispatch fails the intent.
 */
import {
  type DeployDecision,
  type DeployTicket,
  PRODUCTION_INTENT_TTL_MS,
} from '@launch/shared/launch-pipeline'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { type AppRow, appEnvironments, type DeployTicketRow } from '../../../../db/schema'
import { ApiError, ConflictError, NotFoundError } from '../../../utils/core/errors'
import { type AuditActor, recordAudit } from '../audit'
import {
  dispatchWorkflow,
  type GitHubOptions,
  installationToken,
  listInstallations,
  revokeInstallationToken,
} from '../github-app'
import { type ImportGitHub, loadImportGitHub } from '../import'
import {
  decidePending,
  expirePending,
  findOpenIntent,
  getAppTicket,
  insertIntent,
  listAppTickets,
  transitionTicket,
} from './tickets'

/** The workflow file every deploy runs (DEPLOYER.md; `resolveCaller` checks the same name). */
export const DEPLOY_WORKFLOW_FILE = 'deploy.yml'

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
    refused: row.refused ?? null,
    decisionSource: row.decisionSource,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
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

/** Approve or reject a pending production ticket. 404 / 409 as the header says. */
export async function decideDeploy(
  db: Database,
  input: {
    tenantId: string
    app: Pick<AppRow, 'id'>
    ticketId: string
    decision: DeployDecision
    userId: string
    actor: AuditActor
    now?: Date
  }
): Promise<DeployTicket> {
  const now = input.now ?? new Date()
  const found = await getAppTicket(db, input.tenantId, input.app.id, input.ticketId)
  if (!found || found.ticket.purpose !== 'deploy') {
    throw new NotFoundError('Deploy not found', 'deploy_ticket_not_found')
  }
  const { ticket, environment } = found
  if (environment !== 'production' || ticket.status !== 'pending') {
    throw new ConflictError(
      `Only a pending production deploy can be decided (this one is ${environment}, ${ticket.status})`,
      'deploy_ticket_state'
    )
  }
  const approve = input.decision.decision === 'approve'
  const decided = await decidePending(
    db,
    ticket,
    {
      approve,
      userId: input.userId,
      source: 'user',
      error: approve ? undefined : input.decision.reason,
    },
    now
  )
  if (!decided) {
    // Lost a race, or the window closed while the page was open.
    const expired = await expirePending(db, ticket, now)
    throw new ConflictError(
      expired ? 'The run stopped waiting for approval' : 'Someone else decided this deploy first',
      expired ? 'deploy_ticket_expired' : 'deploy_ticket_state'
    )
  }
  await recordAudit(db, {
    tenantId: input.tenantId,
    ...input.actor,
    action: approve ? 'deploy.production.approved' : 'deploy.production.rejected',
    targetType: 'deploy_ticket',
    targetId: decided.id,
    appId: decided.appId,
    summary: {
      before: { status: 'pending' },
      after: {
        status: decided.status,
        source: 'user',
        runId: decided.runId,
        sha: decided.sha,
        ...(input.decision.reason ? { reason: input.decision.reason } : {}),
      },
    },
  })
  return toDeployTicket(decided, environment)
}

/** The installation that can act on `owner`'s repos. */
async function installationFor(
  github: ImportGitHub,
  owner: string,
  opts: GitHubOptions
): Promise<number | string> {
  const sameOrg = !github.org || github.org.toLowerCase() === owner.toLowerCase()
  if (github.installationId !== null && sameOrg) return github.installationId
  const match = (await listInstallations(github.auth, opts)).find(
    i => i.account?.login.toLowerCase() === owner.toLowerCase()
  )
  if (!match) {
    throw new ConflictError(
      `The GitHub App is not installed on ${owner}`,
      'github_app_not_installed'
    )
  }
  return match.id
}

export interface ProductionDeployOptions extends Pick<GitHubOptions, 'fetch' | 'apiBase'> {
  github?: ImportGitHub
}

/** "Deploy to production": a pre-approval, then the dispatch. Returns the intent ticket. */
export async function requestProductionDeploy(
  db: Database,
  cfg: AppConfig,
  input: { tenantId: string; app: AppRow; userId: string; actor: AuditActor; now?: Date },
  opts: ProductionDeployOptions = {}
): Promise<DeployTicket> {
  const { tenantId, app } = input
  const now = input.now ?? new Date()
  const [production] = await db
    .select()
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, tenantId),
        eq(appEnvironments.appId, app.id),
        eq(appEnvironments.name, 'production')
      )
    )
    .limit(1)
  if (!production) {
    throw new ConflictError('This app has no production environment', 'app_environment_missing')
  }
  if (!app.repoOwner || !app.repoName) {
    throw new ConflictError('This app has no repository to deploy from', 'app_repo_missing')
  }
  const scope = { tenantId, appId: app.id, environmentId: production.id }
  if (await findOpenIntent(db, scope, now)) {
    throw new ConflictError(
      'A production deploy is already approved and waiting for its run',
      'production_deploy_pending'
    )
  }

  const github = opts.github ?? (await loadImportGitHub(db, cfg))
  const intent = await insertIntent(db, scope, {
    userId: input.userId,
    expiresAt: new Date(now.getTime() + PRODUCTION_INTENT_TTL_MS),
    now,
  })

  try {
    const installationId = await installationFor(github, app.repoOwner, opts)
    const { token } = await installationToken(
      github.auth,
      installationId,
      { repositories: [app.repoName], permissions: { actions: 'write' } },
      opts
    )
    try {
      await dispatchWorkflow(
        token,
        app.repoOwner,
        app.repoName,
        DEPLOY_WORKFLOW_FILE,
        { ref: app.defaultBranch ?? 'main', inputs: { environment: 'production' } },
        opts
      )
    } finally {
      await revokeInstallationToken(token, opts).catch(() => {})
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const error = `Launch could not start the production deploy: ${message}`
    await transitionTicket(db, intent, ['approved'], 'failed', { error })
    if (err instanceof ApiError) throw err
    throw new ApiError(502, error, 'deploy_dispatch_failed')
  }

  await recordAudit(db, {
    tenantId,
    ...input.actor,
    action: 'deploy.production.approved',
    targetType: 'deploy_ticket',
    targetId: intent.id,
    appId: app.id,
    summary: {
      after: {
        status: 'approved',
        source: 'intent',
        expiresAt: intent.expiresAt?.toISOString() ?? null,
        workflow: DEPLOY_WORKFLOW_FILE,
      },
    },
  })
  return toDeployTicket(intent, 'production')
}
