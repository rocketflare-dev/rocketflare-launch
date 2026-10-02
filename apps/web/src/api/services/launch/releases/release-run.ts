/**
 * The GitHub run a release is deploying (or failed) on, per environment (app page P2) — what Retry
 * re-runs, Cancel cancels and "Fix in a session" reads the log of:
 *
 * - **staging**: the run of the release's staging ticket (`staging_ticket_id`, set when the run's
 *   staging job called `/ci/deploy/start`); before any staging job reached Launch (a red gate), the
 *   newest `push` run of `deploy.yml` on the tag — the one `tag-run.ts` follows;
 * - **production**: the run of the release's production ticket. A production run that died before
 *   its job reached Launch has no ticket, and so no run here (a known gap).
 *
 * Called inside `withRepoToken`, with the token the caller narrowed for what it is about to do.
 */
import { CANDIDATE_RUN_FAILED_CONCLUSIONS } from '@launch/shared/launch-promotion'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppReleaseRow, type DeployTicketRow, deployTickets } from '../../../../db/schema'
import {
  type GitHubOptions,
  type GitHubWorkflowJob,
  type GitHubWorkflowRun,
  getWorkflowRun,
  listWorkflowRunJobs,
  listWorkflowRuns,
} from '../github-app'
import { DEPLOY_WORKFLOW_FILE } from './github'

export type ReleaseEnvironment = 'staging' | 'production'

export interface ReleaseRun {
  environment: ReleaseEnvironment
  runId: string
  /** GitHub's view of it (its LATEST attempt), or null when GitHub no longer lists it. */
  run: GitHubWorkflowRun | null
  /** The ticket the run opened in Launch, when its deploy job got that far. */
  ticket: DeployTicketRow | null
  url: string
}

interface Repo {
  owner: string
  repo: string
}

export function runUrlOf(repo: Repo, runId: string | number): string {
  return `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${encodeURIComponent(String(runId))}`
}

async function ticketOf(
  db: Database,
  tenantId: string,
  ticketId: string | null
): Promise<DeployTicketRow | null> {
  if (!ticketId) return null
  const [row] = await db
    .select()
    .from(deployTickets)
    .where(and(eq(deployTickets.tenantId, tenantId), eq(deployTickets.id, ticketId)))
    .limit(1)
  return row ?? null
}

/** The release's run in `environment` (see the header), or null when there is none to name. */
export async function findReleaseRun(
  db: Database,
  token: string,
  repo: Repo,
  release: AppReleaseRow,
  environment: ReleaseEnvironment,
  gh: GitHubOptions = {}
): Promise<ReleaseRun | null> {
  const ticket = await ticketOf(
    db,
    release.tenantId,
    environment === 'staging' ? release.stagingTicketId : release.productionTicketId
  )
  let runId = ticket?.runId ?? null
  let run: GitHubWorkflowRun | null = null
  if (!runId && environment === 'staging') {
    const runs = await listWorkflowRuns(
      token,
      repo.owner,
      repo.repo,
      DEPLOY_WORKFLOW_FILE,
      { branch: release.tag, event: 'push', perPage: 5 },
      gh
    )
    run =
      runs.find(
        r => (r.head_branch ?? release.tag) === release.tag && (r.event ?? 'push') === 'push'
      ) ?? null
    runId = run ? String(run.id) : null
  }
  if (!runId) return null
  run ??= await getWorkflowRun(token, repo.owner, repo.repo, runId, gh)
  return {
    environment,
    runId,
    run,
    ticket,
    url: run?.html_url ?? runUrlOf(repo, runId),
  }
}

/** Whether GitHub calls the run finished (any conclusion). */
export function runCompleted(run: Pick<GitHubWorkflowRun, 'status'> | null): boolean {
  return run?.status === 'completed'
}

/** The first job of the run's latest attempt that failed, or null. */
export async function failedJobOf(
  token: string,
  repo: Repo,
  runId: string,
  gh: GitHubOptions = {}
): Promise<GitHubWorkflowJob | null> {
  const jobs = await listWorkflowRunJobs(token, repo.owner, repo.repo, runId, gh)
  return (
    jobs.find(
      j =>
        j.status === 'completed' &&
        (CANDIDATE_RUN_FAILED_CONCLUSIONS as readonly string[]).includes(j.conclusion ?? '')
    ) ?? null
  )
}
