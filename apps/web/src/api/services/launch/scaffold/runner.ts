/**
 * The scaffold seam (plan §1, "P3 seam"): WHERE the one-shot scaffold job runs, behind one small
 * interface, so the launch run does not care. P2 ships `GitHubActionsScaffoldRunner` (the job is a
 * workflow in the new repo); P3's sandbox runner runs the same `SCAFFOLD_SCRIPT` with the push
 * token handed in through `--token-from-env`.
 *
 * The shape is the pipeline's `ScaffoldRunnerPort` (`services/launch/pipeline/ports.ts`, slice
 * 2c): the `scaffold.start` step opens the scaffold ticket, then `start(ctx, plan)` and records the
 * ids it returns; `scaffold.wait` polls the ticket (the truth for success — `/ci/scaffold/done`
 * finishes it) and asks `poll(ctx, ids)` only to notice a job that FAILED before its 30 minutes.
 *
 * `start` may throw `ScaffoldNotReadyError` — the runner cannot start the job YET (GitHub has not
 * registered a workflow file pushed seconds ago); the step retries it.
 */
import type { ScaffoldPlan } from '@launch/shared/launch-pipeline'

export type ScaffoldRunState = 'running' | 'succeeded' | 'failed'

/** Ids a runner hands back from `start` — string values only, so they fit `app_operations`. */
export type ScaffoldExternalIds = Record<string, string>

/** Everything a runner needs to reach the app's repo. No secret beyond `token`. */
export interface ScaffoldRunContext {
  /** An installation token for the app repo that may dispatch and read Actions runs. */
  token: string
  /** The repo, `owner` and `name` separately. */
  owner: string
  repo: string
  /** The scaffold ticket the job will claim (informational for P2's runner). */
  ticketId?: string
  /** Launch's `APP_URL` — the job's OIDC audience. Overrides the runner's own. */
  launchUrl?: string
  fetch?: typeof fetch
  /** GitHub API base (tests, GitHub Enterprise); no trailing slash. */
  apiBase?: string
  /** For `start` to stamp; tests pin it. */
  now?: () => Date
}

export interface ScaffoldPollResult {
  status: ScaffoldRunState
  /** A sentence for the step's error, e.g. the run's conclusion. */
  detail?: string
  /** The job's run, once the runner can see it — recorded on the wait's row. */
  runId?: string
  /** Where a person reads the job's log (a GitHub Actions run's `html_url`). */
  url?: string
}

export interface ScaffoldRunner {
  /** Recorded with the ids, so `poll` on a retry uses the runner that started the job. */
  readonly id: string
  /** Start the job. Returns ids to record; throws `ScaffoldNotReadyError` when it should be retried. */
  start(ctx: ScaffoldRunContext, plan: ScaffoldPlan): Promise<ScaffoldExternalIds>
  /** Where the job started by `start` is now. */
  poll(ctx: ScaffoldRunContext, ids: ScaffoldExternalIds): Promise<ScaffoldPollResult>
}

/** The job cannot be started yet; retrying the same `start` later is expected to work. */
export class ScaffoldNotReadyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScaffoldNotReadyError'
  }
}
