/**
 * "Fix in a session" (app page P2, plan decision 7): the first message of a coding session started
 * from a failed release (`POST /api/apps/:id/sessions { fixRelease: { releaseId } }`). It says
 * which stage failed and why (`failedStageOf`, the release's error), links the GitHub run and —
 * when GitHub still has it — carries the tail of the failing job's log, redacted the way a
 * landing's failed-check log is (`redactCheckLog`), so the agent starts from the evidence.
 *
 * The log read uses an installation token narrowed to the one repo and `actions: read`, revoked
 * after; any GitHub failure only drops the excerpt — the session still starts. A release that is
 * not failing is 409 `release_not_retryable`: there is nothing to fix.
 */

import {
  RELEASE_ERROR_CODES,
  RELEASE_STAGE_LABELS,
  type ReleaseFailedStage,
} from '@launch/shared/launch-releases'
import { SESSION_MESSAGE_MAX } from '@launch/shared/launch-sessions'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import type { AppReleaseRow, AppRow } from '../../../../db/schema'
import { ConflictError } from '../../../utils/core/errors'
import { redactCheckLog } from '../../sessions/land'
import { logTail } from '../../sessions/repo/github-repo-host'
import { GITHUB_TOKEN_PERMISSIONS, type GitHubOptions, getJobLogs } from '../github-app'
import { failedStageOf, type StageEnvironments, stageEnvironments } from './failed-stage'
import { withRepoToken } from './github'
import { getRelease } from './release'
import { failedJobOf, findReleaseRun } from './release-run'

export interface FixSessionSeed {
  title: string
  message: string
  stage: ReleaseFailedStage
}

interface Evidence {
  runUrl: string | null
  job: string | null
  log: string | null
}

interface SeedLogger {
  warn(obj: object, msg?: string): void
}

/** The run, its failed job and that job's log tail — whatever GitHub still has. Never throws. */
async function deployEvidence(
  db: Database,
  cfg: AppConfig,
  app: AppRow,
  release: AppReleaseRow,
  environment: 'staging' | 'production',
  options: { fetch?: typeof fetch; logger?: SeedLogger }
): Promise<Evidence> {
  const gh: GitHubOptions = { fetch: options.fetch }
  try {
    return await withRepoToken(
      db,
      cfg,
      app,
      GITHUB_TOKEN_PERMISSIONS.jobLogs,
      async (token, repo) => {
        const found = await findReleaseRun(db, token, repo, release, environment, gh)
        if (!found) return { runUrl: null, job: null, log: null }
        const job = await failedJobOf(token, repo, found.runId, gh)
        const raw = job ? await getJobLogs(token, repo.owner, repo.repo, job.id, gh) : null
        return {
          runUrl: found.url,
          job: job?.name ?? null,
          log: raw ? redactCheckLog(logTail(raw)) : null,
        }
      },
      gh
    )
  } catch (err) {
    options.logger?.warn(
      { releaseId: release.id, err: err instanceof Error ? err.message : String(err) },
      'fix session: could not read the failed run from GitHub; seeding without its log'
    )
    return { runUrl: null, job: null, log: null }
  }
}

/** The seed's text. Pure. */
export function fixSessionMessage(input: {
  version: string
  stage: ReleaseFailedStage
  error: string | null
  evidence: Evidence
  healthError?: string | null
}): string {
  const { version, stage, error, evidence } = input
  const lines = [`Release ${version} of this app failed at: ${RELEASE_STAGE_LABELS[stage]}.`]
  if (error) lines.push(`Launch recorded: ${error}`)
  if (input.healthError) lines.push(`The health check said: ${input.healthError}`)
  if (evidence.runUrl) lines.push(`GitHub Actions run: ${evidence.runUrl}`)
  if (evidence.job) lines.push(`Failed job: ${evidence.job}`)
  if (evidence.log) {
    lines.push('', 'The end of the failed job’s log:', '```', evidence.log, '```')
  }
  lines.push(
    '',
    stage === 'staging_health' || stage === 'production_health'
      ? 'The deploy succeeded but the app is not healthy (GET /api/health and /api/ready). Find the cause in this repository and fix it.'
      : 'Find the cause in this repository and fix it. If the failure is outside the code (a secret, a setting, a flaky runner), say so instead of changing code.',
    'When the fix is ready, ship it; Launch cuts the next release from it.'
  )
  const text = lines.join('\n')
  return text.length > SESSION_MESSAGE_MAX ? `${text.slice(0, SESSION_MESSAGE_MAX - 1)}…` : text
}

export async function fixSessionSeed(
  db: Database,
  cfg: AppConfig,
  input: { tenantId: string; app: AppRow; releaseId: string },
  options: { fetch?: typeof fetch; logger?: SeedLogger; envs?: StageEnvironments } = {}
): Promise<FixSessionSeed> {
  const release = await getRelease(
    { db },
    { tenantId: input.tenantId, appId: input.app.id, releaseId: input.releaseId }
  )
  const envs = options.envs ?? (await stageEnvironments(db, input.tenantId, input.app.id))
  const stage = failedStageOf(release, envs)
  if (!stage) {
    throw new ConflictError(
      `Release ${release.version} is ${release.status}; nothing about it is failing`,
      RELEASE_ERROR_CODES.notRetryable
    )
  }
  const environment =
    stage === 'production_deploy' || stage === 'production_health' ? 'production' : 'staging'
  const evidence =
    stage === 'staging_deploy' || stage === 'production_deploy'
      ? await deployEvidence(db, cfg, input.app, release, environment, options)
      : { runUrl: null, job: null, log: null }
  const healthError =
    stage === 'staging_health'
      ? envs.staging?.healthError
      : stage === 'production_health'
        ? envs.production?.healthError
        : null
  return {
    stage,
    title: `Fix ${release.version}: ${RELEASE_STAGE_LABELS[stage].toLowerCase()} failed`,
    message: fixSessionMessage({
      version: release.version,
      stage,
      error: release.error,
      evidence,
      healthError,
    }),
  }
}
