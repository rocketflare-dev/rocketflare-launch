/**
 * Starting the two pipelines (Launch P2, plan §3 2c) — the part a ROUTE runs, synchronously and
 * quickly; everything slow happens in the Workflows.
 *
 * `createApp`:
 * 1. The slug is checked (`newAppSlugProblem`: spec/04's rules plus no `launch-` prefix → 400),
 *    the Workflow binding must exist and Setup must be finished (apps domain, Cloudflare, Neon,
 *    the GitHub App → 503 — the codes the create modal maps), the owner group must be the
 *    tenant's — all BEFORE any write, so a refusal leaves nothing behind. A taken slug is 409.
 * 2. One transaction: the `apps` row (`source='created'`, `status='requested'`, `launch_run_id`),
 *    both `app_environments` rows named by the adapter (`names`), the creator in `app_owners`,
 *    and `app.create.requested` — whose summary carries the run id and options a retry reuses.
 * 3. `APP_LAUNCH_WORKFLOW.create({ id: runId, params })`. If that fails the app is marked `failed`
 *    (audited `app.launch_failed`) and the error goes back to the caller.
 *
 * `startTeardown` checks the typed confirmation slug, refuses while a launch or a teardown is
 * still running, audits `app.teardown.requested` and starts `APP_TEARDOWN_WORKFLOW`.
 */
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  type AppLaunchParams,
  type AppTeardownParams,
  type CreateAppRequest,
  newAppSlugProblem,
  type TeardownRequest,
} from '@launch/shared/launch-pipeline'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppRow, appEnvironments, appOwners, apps, tenantUsers } from '../../../../db/schema'
import {
  BadRequestError,
  ConflictError,
  isUniqueViolation,
  ServiceUnavailableError,
} from '../../../utils/core/errors'
import { newId } from '../../../utils/core/ids'
import { assertGroupInTenant, getAppRow } from '../apps'
import { type AuditActor, recordAudit, SYSTEM_ACTOR } from '../audit'
import {
  loadPipelineSettings,
  missingSetup,
  type PipelineSettings,
  requireAppsDomain,
} from './context'
import type { PipelinePorts } from './ports'
import { deriveRunStatus, latestRunId, runRows } from './runs'

/** The slice of a Workflow binding the pipeline uses — `RecordingWorkflow` satisfies it. */
export interface WorkflowStarter<P> {
  create(options: { id: string; params: P }): Promise<{ id: string }>
}

const ENVIRONMENTS: readonly AppEnvironmentName[] = ['staging', 'production']

export function requireWorkflow<P>(
  binding: WorkflowStarter<P> | undefined,
  which: 'APP_LAUNCH_WORKFLOW' | 'APP_TEARDOWN_WORKFLOW'
): WorkflowStarter<P> {
  if (!binding) {
    throw new ServiceUnavailableError(
      `Creating apps is not configured: this Worker has no ${which} binding`,
      'app_pipeline_not_configured'
    )
  }
  return binding
}

/**
 * Tests hand these in rather than storing settings and credentials: `launch_settings` and
 * `admin_credentials` are global, and the setup suite owns them.
 */
export interface CreateAppOptions {
  settings?: PipelineSettings
  missingSetup?: (db: Database, settings: PipelineSettings) => Promise<string[]>
}

export interface CreateAppResult {
  app: AppRow
  runId: string
}

export async function createApp(
  db: Database,
  workflow: WorkflowStarter<AppLaunchParams> | undefined,
  ports: PipelinePorts,
  tenantId: string,
  input: CreateAppRequest,
  actor: AuditActor,
  opts: CreateAppOptions = {}
): Promise<CreateAppResult> {
  const problem = newAppSlugProblem(input.slug)
  if (problem) throw new BadRequestError(problem, 'invalid_slug', { slug: input.slug })
  const launcher = requireWorkflow(workflow, 'APP_LAUNCH_WORKFLOW')
  const settings = opts.settings ?? (await loadPipelineSettings(db))
  const missing = await (opts.missingSetup ?? missingSetup)(db, settings)
  if (missing.length) {
    throw new ServiceUnavailableError(
      `Finish Setup before creating an app: connect ${missing.join(', ')}`,
      'launch_not_set_up'
    )
  }
  const appsDomain = requireAppsDomain(settings)
  if (input.ownerGroupId) await assertGroupInTenant(db, tenantId, input.ownerGroupId)

  const runId = newId()
  const options = { deployStaging: input.options.deployStaging }
  let app: AppRow
  try {
    app = await db.transaction(async tx => {
      const [row] = await tx
        .insert(apps)
        .values({
          tenantId,
          slug: input.slug,
          displayName: input.displayName,
          description: input.description || null,
          ownerGroupId: input.ownerGroupId ?? null,
          source: 'created',
          template: 'rocketflare',
          status: 'requested',
          launchRunId: runId,
          createdByUserId: actor.actorUserId,
        })
        .returning()
      if (!row) throw new Error('apps insert returned no row')

      await tx.insert(appEnvironments).values(
        ENVIRONMENTS.map(name => {
          const names = ports.names(input.slug, name, appsDomain)
          return { tenantId, appId: row.id, name, url: names.url, workerName: names.workerName }
        })
      )

      if (actor.actorUserId) {
        // The creator owns what they made — when they are a member of this tenant (a global admin
        // acting from outside it is not, and `app_owners` requires the membership).
        const [member] = await tx
          .select({ userId: tenantUsers.userId })
          .from(tenantUsers)
          .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, actor.actorUserId)))
        if (member) {
          await tx.insert(appOwners).values({ tenantId, appId: row.id, userId: member.userId })
        }
      }

      await recordAudit(tx, {
        tenantId,
        ...actor,
        action: 'app.create.requested',
        targetType: 'App',
        targetId: row.id,
        appId: row.id,
        summary: {
          after: {
            slug: row.slug,
            displayName: row.displayName,
            runId,
            host: ports.names(input.slug, 'staging', appsDomain).host,
            ...options,
          },
        },
      })
      return row
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`The slug "${input.slug}" is already taken`, 'slug_taken', {
        slug: input.slug,
      })
    }
    throw err
  }

  const params: AppLaunchParams = {
    tenantId,
    appId: app.id,
    runId,
    userId: actor.actorUserId,
    options,
  }
  try {
    await launcher.create({ id: runId, params })
  } catch (err) {
    await markLaunchFailed(db, tenantId, app.id, runId, err)
    throw err
  }
  return { app, runId }
}

/** Status `failed` and `app.launch_failed` — the one terminal write both the route and the run make. */
export async function markLaunchFailed(
  db: Database,
  tenantId: string,
  appId: string,
  runId: string,
  err: unknown
): Promise<void> {
  const error = err instanceof Error ? err.message : String(err)
  await db.transaction(async tx => {
    await tx
      .update(apps)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
    await recordAudit(tx, {
      tenantId,
      ...SYSTEM_ACTOR,
      action: 'app.launch_failed',
      targetType: 'App',
      targetId: appId,
      appId,
      summary: { after: { runId, error: error.slice(0, 500) } },
    })
  })
}

/** Starting `APP_TEARDOWN_WORKFLOW` for an app (see the header). */
export async function startTeardown(
  db: Database,
  workflow: WorkflowStarter<AppTeardownParams> | undefined,
  tenantId: string,
  appId: string,
  input: TeardownRequest,
  actor: AuditActor
): Promise<{ runId: string }> {
  const app = await getAppRow(db, tenantId, appId)
  if (input.confirmSlug !== app.slug) {
    throw new BadRequestError(
      'Type the app’s slug exactly to confirm archiving it',
      'confirm_slug_mismatch'
    )
  }
  if (app.status === 'archived') {
    throw new ConflictError('This app is already archived', 'app_archived')
  }
  const launchRun = await latestRunId(db, tenantId, app, 'create')
  if (app.status === 'provisioning' && launchRun) {
    const status = deriveRunStatus('create', await runRows(db, tenantId, launchRun))
    if (status === 'running') {
      throw new ConflictError(
        'The app is still being created — wait for the launch to finish or fail',
        'launch_in_progress'
      )
    }
  }
  const lastTeardown = await latestRunId(db, tenantId, app, 'teardown')
  if (lastTeardown) {
    const status = deriveRunStatus('teardown', await runRows(db, tenantId, lastTeardown))
    if (status === 'running') {
      throw new ConflictError('A teardown of this app is already running', 'teardown_in_progress')
    }
  }
  const starter = requireWorkflow(workflow, 'APP_TEARDOWN_WORKFLOW')

  const runId = newId()
  await recordAudit(db, {
    tenantId,
    ...actor,
    action: 'app.teardown.requested',
    targetType: 'App',
    targetId: app.id,
    appId: app.id,
    summary: { after: { slug: app.slug, runId, deleteRepo: input.deleteRepo } },
  })
  await starter.create({
    id: runId,
    params: {
      tenantId,
      appId: app.id,
      runId,
      userId: actor.actorUserId,
      deleteRepo: input.deleteRepo,
    },
  })
  return { runId }
}
