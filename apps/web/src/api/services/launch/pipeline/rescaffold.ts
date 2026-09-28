/**
 * Re-scaffolding an app that has not gone live (`POST /api/apps/:id/pipeline/rescaffold`,
 * `manage App`). The kit pin is read only by the scaffold, so a launch that failed LATER — the
 * app's CI red on a kit bug a newer kit release fixes — cannot pick the newer kit up by a retry,
 * which skips the succeeded scaffold. Before the first deploy the repository holds nothing but the
 * scaffold and Launch's config commit, so it is safe to scaffold it again from the CURRENT pin,
 * keeping the name, the repository, the Neon project, the Cloudflare resources, the sign-in
 * client and the secrets. Allowed only as `rescaffold-check.ts` says (409 with its code).
 *
 * **Mechanics — a retry with the repository's steps re-opened.** The rows whose work depends on
 * the repository's CONTENT (`RESCAFFOLD_STEPS`) are re-opened, keeping their `externalIds` — which
 * `runStep` hands the next attempt as `ctx.prior` — and then `retryPipeline` starts `<runId>-rN`:
 *
 * - `scaffold.start` becomes `failed` "Reset by re-scaffold": that keeps the run `failed` for the
 *   retry's check even when the step that failed is one of those re-opened. Its prior
 *   `scaffoldTicketId` is the old, `finished` ticket, so the step opens a FRESH ticket, re-commits
 *   the job files the previous job deleted (`commitFilesIfChanged`) and dispatches the job, which
 *   builds its plan from the pin as it is NOW.
 * - Every other one becomes `pending` (no error, no times): a run with a `pending` row derives
 *   `running`, so while the new instance works the page shows it running, not failed — a failed
 *   row downstream would read as a failed run until the instance reached it. `runStep` claims a
 *   pending row like a failed one (attempt + 1, `ctx.prior` = its ids): `placeholders` keeps its
 *   route id and applied DO migration tag (the Workers exist; only newer migrations are sent, and
 *   the script PUT keeps the Worker's secrets — `keep_bindings`), `write_config` re-applies the
 *   config onto the fresh tomls, `scaffold.verify` checks the NEW kit version, and the waits are
 *   re-opened empty by the step that dispatches their job.
 * - Kept as they are: `reserve`, `repo`, `neon`, `cloudflare`, `oidc_client`, `github_env`,
 *   `worker_secrets` and `email` — none reads the repository's content (the Workers keep their
 *   names, the secrets stay on them, the environments and variables are the repository's).
 *
 * Audited `app.pipeline.rescaffolded` with the old and the new kit tag (beside the retry's own
 * `app.pipeline.retried`, which numbers the instance).
 */
import type { RescaffoldPipelineResponse } from '@launch/shared/launch-pipeline'
import { templatePinLabel } from '@launch/shared/launch-setup'
import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { appOperations } from '../../../../db/schema'
import { ConflictError } from '../../../utils/core/errors'
import { getAppRow } from '../apps'
import { type AuditActor, recordAudit } from '../audit'
import { loadPipelineSettings } from './context'
import { requireWorkflow } from './create'
import { rescaffoldBlock } from './rescaffold-check'
import { type RetryWorkflows, retryPipeline } from './retry'
import { deriveRunStatus, latestRunId, runRows } from './runs'

/** The launch rows a re-scaffold re-opens, in run order. `scaffold.start` first: it is failed. */
export const RESCAFFOLD_STEPS = [
  'scaffold.start',
  'scaffold.wait',
  'scaffold.verify',
  'write_config',
  'placeholders',
  'deploy_staging.start',
  'deploy_staging.wait',
  'deploy_staging.check',
  'health',
  'production',
  'live',
] as const

export const RESCAFFOLD_RESET_ERROR = 'Reset by re-scaffold'

export async function rescaffoldPipeline(
  db: Database,
  workflows: RetryWorkflows,
  tenantId: string,
  appId: string,
  actor: AuditActor
): Promise<RescaffoldPipelineResponse> {
  const app = await getAppRow(db, tenantId, appId)
  const runId = await latestRunId(db, tenantId, app, 'create')
  const rows = runId ? await runRows(db, tenantId, runId) : []
  const status =
    runId && rows.length === 0 && app.status === 'failed'
      ? 'failed'
      : deriveRunStatus('create', rows)
  const block = await rescaffoldBlock(db, tenantId, app, { runId, status })
  if (block || !runId) {
    throw new ConflictError(block?.message ?? 'This app has no launch to re-scaffold', block?.code)
  }
  // Refuse before any row is touched when there is nothing to start the run on.
  requireWorkflow(workflows.APP_LAUNCH_WORKFLOW, 'APP_LAUNCH_WORKFLOW')
  const pin = (await loadPipelineSettings(db)).templatePin

  const now = new Date()
  await db.transaction(async tx => {
    await tx
      .update(appOperations)
      .set({ status: 'failed', error: RESCAFFOLD_RESET_ERROR, finishedAt: now, updatedAt: now })
      .where(
        and(
          eq(appOperations.tenantId, tenantId),
          eq(appOperations.runId, runId),
          eq(appOperations.step, 'scaffold.start')
        )
      )
    await tx
      .update(appOperations)
      .set({ status: 'pending', error: null, startedAt: null, finishedAt: null, updatedAt: now })
      .where(
        and(
          eq(appOperations.tenantId, tenantId),
          eq(appOperations.runId, runId),
          inArray(appOperations.step, RESCAFFOLD_STEPS.slice(1))
        )
      )
  })

  const started = await retryPipeline(db, workflows, tenantId, app.id, 'create', actor)
  // An app cut from an unreleased commit recorded the SHA as its ref: shown as @<short sha>.
  const previousTemplateTag =
    app.templateRef && /^[0-9a-f]{40}$/.test(app.templateRef)
      ? templatePinLabel({ commit: app.templateRef })
      : (app.templateVersion ?? app.templateRef ?? null)
  const templateTag = templatePinLabel(pin)
  await recordAudit(db, {
    tenantId,
    ...actor,
    action: 'app.pipeline.rescaffolded',
    targetType: 'App',
    targetId: app.id,
    appId: app.id,
    summary: {
      before: { templateTag: previousTemplateTag },
      after: {
        runId: started.runId,
        instanceId: started.instanceId,
        templateTag,
        templateCommit: pin.commit,
        steps: [...RESCAFFOLD_STEPS],
      },
    },
  })
  return { ...started, templateTag, previousTemplateTag }
}
