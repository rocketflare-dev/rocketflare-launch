/**
 * `GitHubActionsScaffoldRunner` (P2): the scaffold job is `launch-scaffold.yml` in the new repo,
 * committed there by the `repo` step (`scaffoldFiles()`), dispatched on `main` with Launch's URL
 * as its one input.
 *
 * - `start` → `POST …/actions/workflows/launch-scaffold.yml/dispatches`. GitHub answers 204 with
 *   no run id, so the run is found afterwards by listing the workflow's `workflow_dispatch` runs
 *   created since the dispatch; if it is not listed yet, `poll` finds it later. A 404 means GitHub
 *   has not registered the freshly pushed workflow file yet → `ScaffoldNotReadyError` (retry).
 * - `poll` → the run's `status` / `conclusion`: `completed` + `success` is `succeeded`, any other
 *   completed run is `failed`, anything else is `running`; with the run's id and `html_url` as
 *   soon as it is listed, for the wait's row. A dispatch GitHub has not listed a run for within
 *   `SCAFFOLD_START_WINDOW_MS` is `failed` too — a job that never started must not hold the launch
 *   for the whole 30-minute wait.
 */
import type { ScaffoldPlan } from '@launch/shared/launch-pipeline'
import {
  dispatchWorkflow,
  GitHubApiError,
  type GitHubOptions,
  type GitHubWorkflowRun,
  listWorkflowRuns,
} from '../github-app'
import { SCAFFOLD_WORKFLOW_FILE } from '../rocketflare/scaffold-job'
import {
  type ScaffoldExternalIds,
  ScaffoldNotReadyError,
  type ScaffoldPollResult,
  type ScaffoldRunContext,
  type ScaffoldRunner,
} from './runner'

/** The branch the job runs on — the only ref `/ci/scaffold` accepts besides tags. */
const SCAFFOLD_REF = 'main'
/** A run created this long before `dispatchedAt` still counts (clock skew between us and GitHub). */
const CLOCK_SKEW_MS = 60_000
/** How long after the dispatch GitHub may take to list the run before the job counts as not started. */
export const SCAFFOLD_START_WINDOW_MS = 10 * 60_000

function githubOpts(ctx: ScaffoldRunContext): GitHubOptions {
  return { fetch: ctx.fetch, apiBase: ctx.apiBase }
}

/** The newest dispatch run of the scaffold workflow created since `since`, or the one with `runId`. */
async function findRun(
  ctx: ScaffoldRunContext,
  since: Date,
  runId?: string
): Promise<GitHubWorkflowRun | null> {
  const runs = await listWorkflowRuns(
    ctx.token,
    ctx.owner,
    ctx.repo,
    SCAFFOLD_WORKFLOW_FILE,
    { event: 'workflow_dispatch', perPage: 20 },
    githubOpts(ctx)
  )
  if (runId) return runs.find(r => String(r.id) === runId) ?? null
  const cutoff = since.getTime() - CLOCK_SKEW_MS
  return runs.find(r => !r.created_at || new Date(r.created_at).getTime() >= cutoff) ?? null
}

export interface GitHubActionsScaffoldRunnerOptions {
  /** Launch's `APP_URL`, dispatched as `launch_url` (a context's `launchUrl` overrides it). */
  launchUrl?: string
}

export class GitHubActionsScaffoldRunner implements ScaffoldRunner {
  readonly id = 'github-actions'

  constructor(private readonly options: GitHubActionsScaffoldRunnerOptions = {}) {}

  async start(ctx: ScaffoldRunContext, _plan: ScaffoldPlan): Promise<ScaffoldExternalIds> {
    const launchUrl = (ctx.launchUrl ?? this.options.launchUrl)?.replace(/\/+$/, '')
    if (!launchUrl) throw new Error('The scaffold runner needs Launch’s URL (APP_URL)')
    const dispatchedAt = (ctx.now ?? (() => new Date()))()
    try {
      await dispatchWorkflow(
        ctx.token,
        ctx.owner,
        ctx.repo,
        SCAFFOLD_WORKFLOW_FILE,
        { ref: SCAFFOLD_REF, inputs: { launch_url: launchUrl } },
        githubOpts(ctx)
      )
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) {
        throw new ScaffoldNotReadyError(
          `GitHub has not registered ${SCAFFOLD_WORKFLOW_FILE} in ${ctx.owner}/${ctx.repo} yet`
        )
      }
      throw err
    }
    const ids: ScaffoldExternalIds = {
      workflow: SCAFFOLD_WORKFLOW_FILE,
      dispatchedAt: dispatchedAt.toISOString(),
    }
    const run = await findRun(ctx, dispatchedAt).catch(() => null)
    if (run) ids.runId = String(run.id)
    return ids
  }

  async poll(ctx: ScaffoldRunContext, ids: ScaffoldExternalIds): Promise<ScaffoldPollResult> {
    const since = ids.dispatchedAt ? new Date(ids.dispatchedAt) : new Date(0)
    const run = await findRun(ctx, since, ids.runId)
    if (!run) {
      const now = (ctx.now ?? (() => new Date()))().getTime()
      if (ids.dispatchedAt && now - since.getTime() > SCAFFOLD_START_WINDOW_MS) {
        const minutes = Math.round((now - since.getTime()) / 60_000)
        return {
          status: 'failed',
          detail: `GitHub has not started a run of ${SCAFFOLD_WORKFLOW_FILE} ${minutes} minutes after it was dispatched`,
        }
      }
      return { status: 'running' }
    }
    const seen = { runId: String(run.id), ...(run.html_url ? { url: run.html_url } : {}) }
    if (run.status !== 'completed') return { status: 'running', ...seen }
    if (run.conclusion === 'success') return { status: 'succeeded', ...seen }
    return {
      status: 'failed',
      detail: `the GitHub Actions run ended “${run.conclusion ?? 'without a conclusion'}”`,
      ...seen,
    }
  }
}
