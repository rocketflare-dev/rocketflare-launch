/**
 * The step BODIES of `AppLaunchWorkflow` (Launch P2, plan §3 2c steps 1–15) — plain functions over
 * `PipelineDeps`, so the Workflow class only wires `step.do` names and database clients, and a
 * test can reason about each body on its own.
 *
 * Every body that owns an `app_operations` row runs inside `runStep` (`operations.ts`): a row that
 * already succeeded is skipped with its stored ids (which is how a retry `<runId>-rN` resumes), an
 * id is recorded the moment a vendor returns it, and a failure is stored scrubbed. Each returns
 * ids and flags only — **never a secret**, because Workflows persist step results. The step that
 * mints a secret (`worker_secrets`, `email`) puts it on the Worker before returning.
 *
 * The two long waits (the scaffold job, the staging deploy) are ROUNDS rather than one
 * `waitForEvent`: `…poll#N` reads the ticket row (the truth — the event is a nudge) and asks
 * whether the job itself died, then `…wait#N` parks on the event for one round. A lost event (the
 * instance was restarted, or the send failed) therefore costs one round, not the whole timeout, and
 * a job that crashed ends the wait at the next poll. The `<prefix>.wait` row is OPENED `running`
 * by the step that dispatched the job (`openWait`), so the step list shows the job running; a poll
 * records the job's GitHub run (`runId`, `runUrl`) on it the moment the run is listed, and the
 * wait ends it — succeeded, or failed with a readable, scrubbed reason. A poll that finds a failure
 * does not throw inside its `step.do` (whose retries would only fail it again): it answers
 * `{ done, error }` and the Workflow throws outside.
 */
import type {
  AppEnvironmentName,
  AppEnvironmentResources,
  AppOperationExternalIds,
} from '@launch/shared/launch-apps'
import type { AppLaunchParams, ScaffoldPlan } from '@launch/shared/launch-pipeline'
import { and, desc, eq, gte } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import {
  type AppEnvironmentRow,
  type AppRow,
  appEnvironments,
  appOperations,
  apps,
  type DeployTicketRow,
  deployTickets,
  users,
} from '../../../../db/schema'
import { decryptToken, encryptToken } from '../../../auth/oauth-encryption'
import { notify } from '../../notifications'
import { recordAudit, SYSTEM_ACTOR } from '../audit'
import {
  commitFiles,
  commitFilesIfChanged,
  dispatchWorkflow,
  getRef,
  listWorkflowRuns,
  putEnvironment,
  upsertRepoVariable,
} from '../github-app'
import { checkAppHealth, type HealthPollOptions } from '../health'
import { ROCKETFLARE_CONTRACT_VERSION } from '../import'
import {
  createAppOidcClient,
  getAppOidcClient,
  issuerOf,
  rotateAppOidcSecret,
} from '../oidc-clients'
import { publicUrlProblem } from '../public-url'
import { KIT_BINDINGS } from '../rocketflare/names'
import {
  MANIFEST_PATHS,
  parseManifest,
  parseWranglerToml,
  WRANGLER_PATHS,
  type WranglerEnvironment,
} from '../rocketflare-manifest'
import {
  cloudflareClient,
  loadPipelineVendors,
  neonClient,
  type PipelineVendors,
  requireAppsDomain,
  resendClient,
} from './context'
import { markLaunchFailed } from './create'
import {
  failOpenStep,
  openWait,
  recordRunningIds,
  runStep,
  type StepContext,
  type StepKey,
  skipStep,
} from './operations'
import {
  DEPLOY_WORKFLOW_FILE,
  type PipelinePorts,
  SCAFFOLD_TICKET_ENVIRONMENT,
  type ScaffoldRunnerContext,
} from './ports'
import { idKey, provisionStorage, putPlaceholder } from './provision-cloudflare'
import { ensureRepo, readRepoFiles, repoToken } from './provision-github'
import { environmentNeon, freshAppDatabaseUrl, type NeonIds, provisionNeon } from './provision-neon'
import { mintSendingKey } from './provision-resend'
import { generateEncryptionKey, putWorkerSecrets } from './worker-secrets'

/** What every step body acts with. `vendors()` unseals the credentials on first use in a step. */
export interface PipelineDeps {
  db: Database
  cfg: AppConfig
  ports: PipelinePorts
  vendors: () => Promise<PipelineVendors>
  /** Neon's 423 / operation-poll wait (tests: resolve at once). */
  sleep?: (ms: number) => Promise<void>
  /** The health probes' options (tests shorten the timeout). */
  health?: HealthPollOptions
}

export const ENVIRONMENTS: readonly AppEnvironmentName[] = ['staging', 'production']

/**
 * The scaffold wait: 30 rounds of 1 minute = the plan's 30. Short rounds because the event only
 * says the job SUCCEEDED — a job that dies is noticed by the next poll, so a round is how long a
 * failure can go unseen.
 */
export const SCAFFOLD_WAIT = { rounds: 30, roundTimeout: '1 minute' } as const
/** The staging deploy wait: 15 rounds of 3 minutes = the plan's 45. */
export const DEPLOY_WAIT = { rounds: 15, roundTimeout: '3 minutes' } as const
/** Health: up to 20 probes, 30 seconds apart. */
export const HEALTH_TRIES = 20

/** A ticket created this long before the dispatch still counts (clock skew between systems). */
const DISPATCH_SKEW_MS = 30 * 1000

export function launchKey(params: AppLaunchParams, step: string): StepKey {
  return {
    tenantId: params.tenantId,
    appId: params.appId,
    runId: params.runId,
    kind: 'create',
    step,
  }
}

// ---- reads ---------------------------------------------------------------------------------------

async function loadApp(db: Database, params: { tenantId: string; appId: string }): Promise<AppRow> {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.tenantId, params.tenantId), eq(apps.id, params.appId)))
  if (!row) throw new Error(`App ${params.appId} no longer exists`)
  return row
}

async function loadEnvironments(
  db: Database,
  params: { tenantId: string; appId: string }
): Promise<Record<AppEnvironmentName, AppEnvironmentRow>> {
  const rows = await db
    .select()
    .from(appEnvironments)
    .where(
      and(eq(appEnvironments.tenantId, params.tenantId), eq(appEnvironments.appId, params.appId))
    )
  const staging = rows.find(r => r.name === 'staging')
  const production = rows.find(r => r.name === 'production')
  if (!staging || !production) throw new Error('The app is missing an environment row')
  return { staging, production }
}

async function updateEnvironment(
  db: Database,
  env: AppEnvironmentRow,
  set: Partial<AppEnvironmentRow>
): Promise<void> {
  await db
    .update(appEnvironments)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(appEnvironments.tenantId, env.tenantId), eq(appEnvironments.id, env.id)))
}

async function updateApp(db: Database, app: AppRow, set: Partial<AppRow>): Promise<void> {
  await db
    .update(apps)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(apps.tenantId, app.tenantId), eq(apps.id, app.id)))
}

/** The ids a row of this run recorded (`{}` when it has none yet). */
export async function stepIds(db: Database, key: StepKey): Promise<AppOperationExternalIds> {
  const row = await stepRow(db, key)
  return row?.externalIds ?? {}
}

async function stepRow(db: Database, key: StepKey) {
  const [row] = await db
    .select()
    .from(appOperations)
    .where(
      and(
        eq(appOperations.tenantId, key.tenantId),
        eq(appOperations.runId, key.runId),
        eq(appOperations.step, key.step)
      )
    )
  return row ?? null
}

async function stepSucceeded(db: Database, key: StepKey): Promise<boolean> {
  return (await stepRow(db, key))?.status === 'succeeded'
}

/** A wait round's answer: `done`, and `error` when the wait ended because the job failed. */
export interface WaitState {
  done: boolean
  error?: string
}

/** Record the wait `key` as failed with `message` (scrubbed, its ids kept) and end the wait. */
async function failWait(db: Database, key: StepKey, message: string): Promise<WaitState> {
  await failOpenStep(db, key, message)
  const row = await stepRow(db, key)
  return { done: true, error: row?.error ?? message }
}

/**
 * What a wait's row says before a poll looks further: settled (succeeded → done), already failed
 * (a person stopped the run, or an earlier poll failed it → done with that error), or open —
 * opened here when it has no row (a run started before waits were opened by their start step).
 */
async function waitRowState(db: Database, key: StepKey): Promise<WaitState | null> {
  const row = await stepRow(db, key)
  if (row?.status === 'succeeded') return { done: true }
  if (row?.status === 'failed') return { done: true, error: row.error ?? 'The wait failed' }
  if (!row) await openWait(db, key)
  return null
}

/** A sentence for a job that died on GitHub, with why when Launch itself is the likely cause. */
function jobFailure(what: string, detail: string | undefined, launchUrl: string): string {
  const unreachable = publicUrlProblem(launchUrl)
  return [
    `${what} failed${detail ? `: ${detail}` : ''}.`,
    unreachable
      ? `It calls Launch back at ${launchUrl}, which GitHub's runners cannot reach — see Setup › Public URL.`
      : 'Open the run on GitHub for its log.',
  ].join(' ')
}

function repoOf(app: AppRow): { owner: string; name: string; branch: string } {
  if (!app.repoOwner || !app.repoName) throw new Error('The app has no repository yet')
  return { owner: app.repoOwner, name: app.repoName, branch: app.defaultBranch ?? 'main' }
}

function emailFrom(app: AppRow, notificationsDomain: string | null): string {
  if (!notificationsDomain) throw new Error('No notifications domain: set the apps domain in Setup')
  return `${app.displayName.replace(/[<>"]/g, '')} <${app.slug}@${notificationsDomain}>`
}

// ---- 1. reserve ----------------------------------------------------------------------------------

export function reserveStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'reserve'), async () => {
    const app = await loadApp(d.db, params)
    if (app.status === 'archived') throw new Error('The app was archived before it launched')
    await updateApp(d.db, app, { status: 'provisioning', launchRunId: params.runId })
    return { slug: app.slug, deployStaging: String(params.options.deployStaging) }
  })
}

// ---- 2. repo -------------------------------------------------------------------------------------

export function repoStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'repo'), async ctx => {
    const vendors = await d.vendors()
    const app = await loadApp(d.db, params)
    const repo = await ensureRepo(vendors, ctx, { name: app.slug, description: app.description })
    await updateApp(d.db, app, {
      repoOwner: repo.owner.login,
      repoName: repo.name,
      defaultBranch: repo.default_branch,
      githubRepoId: String(repo.id),
    })
    if (!ctx.prior.scaffoldFilesCommit) {
      const { token, owner } = await repoToken(
        vendors,
        repo.name,
        { contents: 'write', workflows: 'write' },
        ctx
      )
      const commit = await commitFiles(
        token,
        owner,
        repo.name,
        repo.default_branch,
        d.ports.scaffoldFiles(),
        'Add the Launch scaffold job'
      )
      await ctx.record({ scaffoldFilesCommit: commit.sha })
    }
    return { repoId: String(repo.id), repo: repo.full_name }
  })
}

// ---- 3. scaffold ---------------------------------------------------------------------------------

async function scaffoldContext(
  d: PipelineDeps,
  app: AppRow,
  ticketId: string,
  ctx?: Pick<StepContext, 'redact'>
): Promise<ScaffoldRunnerContext> {
  const repo = repoOf(app)
  const { token } = await repoToken(
    await d.vendors(),
    repo.name,
    { actions: 'write', contents: 'read' },
    ctx
  )
  return { token, owner: repo.owner, repo: repo.name, ticketId, launchUrl: issuerOf(d.cfg) }
}

export function scaffoldStartStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'scaffold.start'), async ctx => {
    const vendors = await d.vendors()
    const app = await loadApp(d.db, params)
    const envs = await loadEnvironments(d.db, params)
    const repo = repoOf(app)
    // An earlier attempt's ticket is reused only while no job has claimed it; a retry after a
    // failed job needs a fresh one (the claim binds a run id, and `token` answers once).
    const prior = ctx.prior.scaffoldTicketId
      ? await ticketById(d.db, params.tenantId, ctx.prior.scaffoldTicketId)
      : null
    let ticketId = prior?.status === 'approved' && !prior.runId ? prior.id : undefined
    if (!ticketId) {
      if (prior?.status === 'approved') {
        // Claimed by the job that died: it must not be able to finish over the new one.
        await d.db
          .update(deployTickets)
          .set({ status: 'failed', error: 'Superseded by a retry', updatedAt: new Date() })
          .where(
            and(
              eq(deployTickets.tenantId, params.tenantId),
              eq(deployTickets.id, prior.id),
              eq(deployTickets.status, 'approved')
            )
          )
      }
      const now = new Date()
      const [ticket] = await d.db
        .insert(deployTickets)
        .values({
          tenantId: params.tenantId,
          appId: app.id,
          environmentId: envs[SCAFFOLD_TICKET_ENVIRONMENT].id,
          purpose: 'scaffold',
          status: 'approved',
          repositoryId: app.githubRepoId,
          repository: `${repo.owner}/${repo.name}`,
          decisionSource: 'auto',
          decidedAt: now,
          expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          launchRunId: params.runId,
        })
        .returning({ id: deployTickets.id })
      if (!ticket) throw new Error('deploy_tickets insert returned no row')
      ticketId = ticket.id
      await ctx.record({ scaffoldTicketId: ticketId })
    }
    if (prior) {
      // A re-dispatch runs the job files on main, which the `repo` step (skipped on a retry)
      // committed from an older Launch: bring them up to date so a fixed job is what runs.
      const { token, owner } = await repoToken(
        vendors,
        repo.name,
        { contents: 'write', workflows: 'write' },
        ctx
      )
      const refreshed = await commitFilesIfChanged(
        token,
        owner,
        repo.name,
        repo.branch,
        d.ports.scaffoldFiles(),
        'Update the Launch scaffold job'
      )
      if (refreshed.changed) await ctx.record({ scaffoldFilesCommit: refreshed.sha })
    }
    const pin = vendors.settings.templatePin
    const plan: ScaffoldPlan = {
      slug: app.slug,
      displayName: app.displayName,
      domain: requireAppsDomain(vendors.settings),
      repo: `${repo.owner}/${repo.name}`,
      kitRepo: pin.repo,
      tag: pin.tag,
      commit: pin.commit,
    }
    const runner = d.ports.scaffoldRunner
    const ids = await runner.start(await scaffoldContext(d, app, ticketId, ctx), plan)
    // The job is on its way: its wait shows running from now, with no ids of an earlier job.
    await openWait(d.db, launchKey(params, 'scaffold.wait'))
    return { scaffoldTicketId: ticketId, runner: runner.id, ...ids }
  })
}

async function ticketById(
  db: Database,
  tenantId: string,
  ticketId: string
): Promise<DeployTicketRow | null> {
  const [row] = await db
    .select()
    .from(deployTickets)
    .where(and(eq(deployTickets.tenantId, tenantId), eq(deployTickets.id, ticketId)))
  return row ?? null
}

/**
 * One round's look at the scaffold job: the ticket (the truth for success), then the runner, whose
 * run id and URL go on the `scaffold.wait` row as soon as it reports them. `{ done, error }`.
 */
export async function scaffoldPoll(d: PipelineDeps, params: AppLaunchParams): Promise<WaitState> {
  const waitKey = launchKey(params, 'scaffold.wait')
  const settled = await waitRowState(d.db, waitKey)
  if (settled) return settled
  const started = await stepIds(d.db, launchKey(params, 'scaffold.start'))
  const ticketId = started.scaffoldTicketId
  if (!ticketId) return failWait(d.db, waitKey, 'The scaffold job was never started')
  const ticket = await ticketById(d.db, params.tenantId, ticketId)
  if (ticket?.status === 'finished') return { done: true }
  if (!ticket || ticket.status === 'failed' || ticket.status === 'rejected') {
    return failWait(d.db, waitKey, `The scaffold job failed: ${ticket?.error ?? 'ticket missing'}`)
  }
  const app = await loadApp(d.db, params)
  const { scaffoldTicketId: _t, runner: _r, ...runIds } = started
  const waitIds = await stepIds(d.db, waitKey)
  if (waitIds.runId) runIds.runId = waitIds.runId
  const context = await scaffoldContext(d, app, ticketId)
  const state = await d.ports.scaffoldRunner.poll(context, runIds)
  if (state.runId && (state.runId !== waitIds.runId || (state.url && !waitIds.runUrl))) {
    await recordRunningIds(d.db, waitKey, {
      runId: state.runId,
      ...(state.url ? { runUrl: state.url } : {}),
    })
  }
  if (state.status === 'failed') {
    return failWait(
      d.db,
      waitKey,
      jobFailure('The scaffold job', state.detail, context.launchUrl ?? issuerOf(d.cfg))
    )
  }
  return { done: false }
}

/** The end of the scaffold wait: the ticket finished, or the wait ran out. */
export function scaffoldWaitStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(
    d.db,
    launchKey(params, 'scaffold.wait'),
    async () => {
      const started = await stepIds(d.db, launchKey(params, 'scaffold.start'))
      const ticket = started.scaffoldTicketId
        ? await ticketById(d.db, params.tenantId, started.scaffoldTicketId)
        : null
      if (ticket?.status !== 'finished') {
        throw new Error('The scaffold job did not finish within 30 minutes')
      }
      return { scaffoldTicketId: ticket.id, ...(ticket.sha ? { scaffoldCommit: ticket.sha } : {}) }
    },
    { continuesWait: true }
  )
}

/** Every name the scaffolded toml must carry, against the adapter's naming (plan §1). */
function nameProblems(
  env: AppEnvironmentName,
  toml: WranglerEnvironment,
  names: ReturnType<PipelinePorts['names']>
): string[] {
  const problems: string[] = []
  const expect = (what: string, found: readonly string[], wanted: string) => {
    if (!found.includes(wanted)) {
      problems.push(`${env} ${what} is ${found.join(', ') || 'missing'}, expected ${wanted}`)
    }
  }
  expect('Worker name', toml.workerName ? [toml.workerName] : [], names.workerName)
  expect(
    'queue',
    (toml.resources.queues ?? []).map(q => q.queue),
    names.queue
  )
  expect(
    'R2 bucket',
    (toml.resources.r2 ?? []).map(b => b.bucketName),
    names.r2Bucket
  )
  expect(
    'workflow',
    (toml.resources.workflows ?? []).map(w => w.name),
    names.workflow
  )
  return problems
}

export function scaffoldVerifyStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'scaffold.verify'), async ctx => {
    const vendors = await d.vendors()
    const domain = requireAppsDomain(vendors.settings)
    const pin = vendors.settings.templatePin
    const app = await loadApp(d.db, params)
    const repo = repoOf(app)
    const { token, owner } = await repoToken(vendors, repo.name, { contents: 'read' }, ctx)
    const manifestPath = MANIFEST_PATHS[0]
    const files = await readRepoFiles(token, owner, repo.name, [
      manifestPath,
      WRANGLER_PATHS.staging,
      WRANGLER_PATHS.production,
    ])
    const problems: string[] = []
    const manifestText = files[manifestPath]
    if (!manifestText) {
      problems.push(`${manifestPath} is missing`)
    } else {
      const identity = parseManifest(manifestText, manifestPath)
      if (identity.slug !== app.slug) {
        problems.push(`${manifestPath} names the app ${identity.slug ?? 'nothing'}`)
      }
      if (identity.kitVersion !== pin.tag) {
        problems.push(
          `${manifestPath} says kit ${identity.kitVersion ?? 'unknown'}, not ${pin.tag}`
        )
      }
    }
    for (const env of ENVIRONMENTS) {
      const text = files[WRANGLER_PATHS[env]]
      if (!text) {
        problems.push(`${WRANGLER_PATHS[env]} is missing`)
        continue
      }
      const toml = parseWranglerToml(text, WRANGLER_PATHS[env])
      problems.push(...nameProblems(env, toml, d.ports.names(app.slug, env, domain)))
    }
    if (problems.length) {
      throw new Error(`The scaffold does not match the plan: ${problems.join('; ')}`)
    }
    const head = await getRef(token, owner, repo.name, `heads/${repo.branch}`)
    await updateApp(d.db, app, {
      templateRef: pin.tag,
      templateCommit: pin.commit,
      templateVersion: pin.tag,
      templateContractVersion: ROCKETFLARE_CONTRACT_VERSION,
    })
    return { scaffoldCommit: head.object.sha }
  })
}

// ---- 4. neon -------------------------------------------------------------------------------------

export function neonStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'neon'), async ctx => {
    const app = await loadApp(d.db, params)
    const envs = await loadEnvironments(d.db, params)
    const ids = await provisionNeon(neonClient(await d.vendors(), { sleep: d.sleep }), ctx, {
      slug: app.slug,
    })
    for (const env of ENVIRONMENTS) {
      await updateEnvironment(d.db, envs[env], { neon: environmentNeon(ids, env) })
    }
    return {
      neonProjectId: ids.projectId,
      neonMainBranchId: ids.mainBranchId,
      neonStagingBranchId: ids.stagingBranchId,
    }
  })
}

// ---- 5. cloudflare -------------------------------------------------------------------------------

/** Whether another app of the tenant records `id` — a conflict is only adopted when none does. */
async function claimedByAnotherApp(
  db: Database,
  params: AppLaunchParams,
  kind: 'kv' | 'queue' | 'r2',
  id: string
): Promise<boolean> {
  const rows = await db
    .select({ appId: appEnvironments.appId, resources: appEnvironments.resources })
    .from(appEnvironments)
    .where(eq(appEnvironments.tenantId, params.tenantId))
  return rows.some(({ appId, resources }) => {
    if (appId === params.appId) return false
    if (kind === 'kv') return (resources.kv ?? []).some(k => k.id === id)
    if (kind === 'queue') return (resources.queues ?? []).some(q => q.id === id)
    return (resources.r2 ?? []).some(b => b.bucketName === id)
  })
}

export function cloudflareStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'cloudflare'), async ctx => {
    const vendors = await d.vendors()
    const domain = requireAppsDomain(vendors.settings)
    const app = await loadApp(d.db, params)
    const cf = cloudflareClient(vendors)
    for (const env of ENVIRONMENTS) {
      await provisionStorage(cf, ctx, env, d.ports.names(app.slug, env, domain), (kind, id) =>
        claimedByAnotherApp(d.db, params, kind, id)
      )
    }
  })
}

// ---- 6. oidc_client ------------------------------------------------------------------------------

export function oidcClientStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'oidc_client'), async () => {
    const app = await loadApp(d.db, params)
    const existing = await getAppOidcClient(d.db, params.tenantId, app.id)
    if (existing) return { oidcClientId: existing.clientId }
    // The secret this returns is dropped on purpose: `worker_secrets` rotates one and puts it on
    // both Workers in the same step, so no secret ever crosses a step boundary.
    const created = await createAppOidcClient(d.db, d.cfg, params.tenantId, app, SYSTEM_ACTOR)
    return { oidcClientId: created.clientId }
  })
}

// ---- 7. write_config -----------------------------------------------------------------------------

export function writeConfigStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'write_config'), async ctx => {
    const vendors = await d.vendors()
    const domain = requireAppsDomain(vendors.settings)
    const app = await loadApp(d.db, params)
    const envs = await loadEnvironments(d.db, params)
    const repo = repoOf(app)
    const storage = await stepIds(d.db, launchKey(params, 'cloudflare'))
    const client = await getAppOidcClient(d.db, params.tenantId, app.id)
    if (!client) throw new Error('The app has no OIDC client yet')
    const { token, owner } = await repoToken(vendors, repo.name, { contents: 'write' }, ctx)
    const current = await readRepoFiles(token, owner, repo.name, [
      WRANGLER_PATHS.staging,
      WRANGLER_PATHS.production,
    ])

    const changed: { path: string; content: string }[] = []
    for (const env of ENVIRONMENTS) {
      const path = WRANGLER_PATHS[env]
      const before = current[path]
      if (!before) throw new Error(`${path} is missing`)
      const names = d.ports.names(app.slug, env, domain)
      const kvId = storage[idKey('kv', env)]
      if (!kvId) throw new Error(`No ${env} KV namespace was recorded`)
      // The pipeline creates the kit's one KV namespace; a toml declaring another is refused by
      // `writeConfig` (no id for it) rather than left with a placeholder.
      const written = d.ports.writeConfig(before, env, {
        appUrl: names.url,
        emailFrom: emailFrom(app, vendors.settings.notificationsDomain),
        kvIds: { [KIT_BINDINGS.rateLimitKv]: kvId },
        oidcIssuer: issuerOf(d.cfg),
        oidcClientId: client.clientId,
      })
      const parsed = parseWranglerToml(written, path)
      if (parsed.placeholders.length) {
        throw new Error(`${path} still has placeholders: ${parsed.placeholders.join(', ')}`)
      }
      if (written !== before) changed.push({ path, content: written })
      await updateEnvironment(d.db, envs[env], {
        url: names.url,
        workerName: names.workerName,
        resources: recordedResources(parsed, storage, env),
      })
    }
    if (changed.length === 0) return { configCommit: 'unchanged' }
    const commit = await commitFiles(
      token,
      owner,
      repo.name,
      repo.branch,
      changed,
      'Configure the app for Launch'
    )
    return { configCommit: commit.sha }
  })
}

/** The toml's bindings, with the KV title and queue ids the pipeline recorded added. */
function recordedResources(
  toml: WranglerEnvironment,
  storage: AppOperationExternalIds,
  env: AppEnvironmentName
): AppEnvironmentResources {
  const kvTitle = storage[idKey('kvTitle', env)]
  const queueId = storage[idKey('queue', env)]
  const queueName = storage[idKey('queueName', env)]
  return {
    ...toml.resources,
    kv: toml.resources.kv?.map(k =>
      k.id === storage[idKey('kv', env)] && kvTitle ? { ...k, title: kvTitle } : k
    ),
    queues: toml.resources.queues?.map(q =>
      q.queue === queueName && queueId ? { ...q, id: queueId } : q
    ),
  }
}

// ---- 8. placeholders -----------------------------------------------------------------------------

export function placeholdersStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'placeholders'), async ctx => {
    const vendors = await d.vendors()
    const domain = requireAppsDomain(vendors.settings)
    const app = await loadApp(d.db, params)
    const envs = await loadEnvironments(d.db, params)
    const repo = repoOf(app)
    const cf = cloudflareClient(vendors)
    const storage = await stepIds(d.db, launchKey(params, 'cloudflare'))
    const { token, owner } = await repoToken(vendors, repo.name, { contents: 'read' }, ctx)
    const tomls = await readRepoFiles(token, owner, repo.name, [
      WRANGLER_PATHS.staging,
      WRANGLER_PATHS.production,
    ])
    for (const env of ENVIRONMENTS) {
      const path = WRANGLER_PATHS[env]
      const tomlText = tomls[path]
      if (!tomlText) throw new Error(`${path} is missing`)
      const toml = parseWranglerToml(tomlText, path)
      const queueName = storage[idKey('queueName', env)]
      const queueId = storage[idKey('queue', env)]
      const result = await putPlaceholder(cf, ctx, {
        env,
        names: d.ports.names(app.slug, env, domain),
        tomlText,
        toml,
        // A retry after the script PUT: its DO migrations are already applied.
        script: d.ports.placeholderScript(tomlText, {
          appliedTag:
            ctx.prior[idKey('migrationTag', env)] ?? envs[env].resources?.doMigrationTag ?? null,
        }),
        queueIds: queueName && queueId ? { [queueName]: queueId } : {},
      })
      const current = envs[env].resources ?? {}
      await updateEnvironment(d.db, envs[env], {
        routeIds: [result.routeId],
        resources: {
          ...current,
          queueConsumers: result.queueConsumers,
          ...(result.migrationTag ? { doMigrationTag: result.migrationTag } : {}),
        },
      })
    }
  })
}

// ---- 9. github_env -------------------------------------------------------------------------------

export function githubEnvStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'github_env'), async ctx => {
    const vendors = await d.vendors()
    const app = await loadApp(d.db, params)
    const repo = repoOf(app)
    const { token, owner } = await repoToken(
      vendors,
      repo.name,
      { environments: 'write', actions_variables: 'write' },
      ctx
    )
    for (const env of ENVIRONMENTS) await putEnvironment(token, owner, repo.name, env)
    // DEPLOYER.md: the deploy job speaks to Launch's `/ci` surface, with Launch's origin as the
    // OIDC audience. Variables, not secrets — the job holds no credential at all.
    const issuer = issuerOf(d.cfg)
    await upsertRepoVariable(token, owner, repo.name, 'DEPLOYER_URL', `${issuer}/ci`)
    await upsertRepoVariable(token, owner, repo.name, 'DEPLOYER_AUDIENCE', issuer)
    return { environments: ENVIRONMENTS.join(','), variables: 'DEPLOYER_URL,DEPLOYER_AUDIENCE' }
  })
}

// ---- 10. worker_secrets --------------------------------------------------------------------------

export function workerSecretsStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'worker_secrets'), async ctx => {
    const vendors = await d.vendors()
    const app = await loadApp(d.db, params)
    const envs = await loadEnvironments(d.db, params)
    const cf = cloudflareClient(vendors)
    const neon = neonClient(vendors, { sleep: d.sleep })
    const neonIds = (await stepIds(d.db, launchKey(params, 'neon'))) as Partial<
      Record<'neonProjectId' | 'neonMainBranchId' | 'neonStagingBranchId', string>
    >
    const ids: Partial<NeonIds> = {
      projectId: neonIds.neonProjectId,
      mainBranchId: neonIds.neonMainBranchId,
      stagingBranchId: neonIds.neonStagingBranchId,
    }
    if (!ids.projectId || !ids.mainBranchId || !ids.stagingBranchId) {
      throw new Error('The database was not recorded')
    }
    const creator = params.userId
      ? (
          await d.db.select({ email: users.email }).from(users).where(eq(users.id, params.userId))
        )[0]
      : undefined

    // ONE new client secret for both Workers — rotated here, put below, never returned.
    const rotated = await rotateAppOidcSecret(d.db, d.cfg, params.tenantId, app, SYSTEM_ACTOR)
    ctx.redact(rotated.clientSecret)

    const put: string[] = []
    for (const env of ENVIRONMENTS) {
      const row = envs[env]
      if (!row.workerName) throw new Error(`The ${env} environment has no Worker`)
      let encryptionKey = await decryptToken(d.cfg, row.encryptionKeySealed)
      if (!encryptionKey) {
        encryptionKey = generateEncryptionKey()
        // Sealed and stored BEFORE the put, so a retry puts the same key back.
        await updateEnvironment(d.db, row, {
          encryptionKeySealed: await encryptToken(d.cfg, encryptionKey),
        })
      }
      ctx.redact(encryptionKey)
      const branchId = env === 'production' ? ids.mainBranchId : ids.stagingBranchId
      const secrets: Record<string, string> = {
        OAUTH_ENCRYPTION_KEY: encryptionKey,
        OIDC_CLIENT_SECRET: rotated.clientSecret,
        ...(creator?.email ? { BOOTSTRAP_ADMIN_EMAILS: creator.email } : {}),
        DATABASE_URL: await freshAppDatabaseUrl(neon.client, ctx, ids.projectId, branchId),
      }
      const names = await putWorkerSecrets(cf, ctx, row.workerName, secrets)
      put.push(...names.map(n => `${env}:${n}`))
    }
    return { secrets: put.join(',') }
  })
}

// ---- 11. email (non-blocking) --------------------------------------------------------------------

export function emailStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'email'), async ctx => {
    const vendors = await d.vendors()
    const domain = requireAppsDomain(vendors.settings)
    const resend = resendClient(vendors)
    const cf = cloudflareClient(vendors)
    const app = await loadApp(d.db, params)
    const envs = await loadEnvironments(d.db, params)
    for (const env of ENVIRONMENTS) {
      const row = envs[env]
      const workerName = row.workerName
      if (!workerName) throw new Error(`The ${env} environment has no Worker`)
      const { keyId, minted } = await mintSendingKey(
        resend,
        ctx,
        {
          env,
          keyName: d.ports.names(app.slug, env, domain).resendKeyName,
          confirmedKeyId: row.resendKeyId,
        },
        async token => {
          await putWorkerSecrets(cf, ctx, workerName, { RESEND_API_KEY: token })
        }
      )
      if (minted) await updateEnvironment(d.db, row, { resendKeyId: keyId })
    }
  })
}

// ---- 12. deploy staging --------------------------------------------------------------------------

export function deployStartStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'deploy_staging.start'), async ctx => {
    const vendors = await d.vendors()
    const app = await loadApp(d.db, params)
    const repo = repoOf(app)
    const { token, owner } = await repoToken(vendors, repo.name, { actions: 'write' }, ctx)
    const dispatchedAt = new Date().toISOString()
    await ctx.record({ dispatchedAt })
    await dispatchWorkflow(token, owner, repo.name, DEPLOY_WORKFLOW_FILE, {
      ref: repo.branch,
      inputs: { environment: 'staging' },
    })
    await openWait(d.db, launchKey(params, 'deploy_staging.wait'))
    return { dispatchedAt, deployWorkflowFile: DEPLOY_WORKFLOW_FILE }
  })
}

/** The newest staging deploy ticket opened since the dispatch (less a little clock skew). */
async function latestStagingTicket(
  d: PipelineDeps,
  params: AppLaunchParams
): Promise<DeployTicketRow | null> {
  const started = await stepIds(d.db, launchKey(params, 'deploy_staging.start'))
  const since = started.dispatchedAt
    ? new Date(new Date(started.dispatchedAt).getTime() - DISPATCH_SKEW_MS)
    : new Date(0)
  const envs = await loadEnvironments(d.db, params)
  const [row] = await d.db
    .select()
    .from(deployTickets)
    .where(
      and(
        eq(deployTickets.tenantId, params.tenantId),
        eq(deployTickets.appId, params.appId),
        eq(deployTickets.environmentId, envs.staging.id),
        eq(deployTickets.purpose, 'deploy'),
        gte(deployTickets.createdAt, since)
      )
    )
    .orderBy(desc(deployTickets.createdAt))
    .limit(1)
  return row ?? null
}

/** Live: `active` or `finished`, with the version the upload created. */
function deployed(ticket: DeployTicketRow | null): boolean {
  return (
    !!ticket && (ticket.status === 'active' || ticket.status === 'finished') && !!ticket.cfVersionId
  )
}

/** One round's look at the staging deploy: the ticket first, then the GitHub run behind it. */
export async function deployPoll(d: PipelineDeps, params: AppLaunchParams): Promise<WaitState> {
  const waitKey = launchKey(params, 'deploy_staging.wait')
  const settled = await waitRowState(d.db, waitKey)
  if (settled) return settled
  const ticket = await latestStagingTicket(d, params)
  if (deployed(ticket)) return { done: true }
  if (ticket && (ticket.status === 'failed' || ticket.status === 'rejected')) {
    const refused = ticket.refused?.length ? ` (refused: ${ticket.refused.join(', ')})` : ''
    return failWait(
      d.db,
      waitKey,
      `The staging deploy ${ticket.status === 'rejected' ? 'was rejected' : 'failed'}: ${
        ticket.error ?? 'no detail'
      }${refused}`
    )
  }
  // No verdict on the ticket yet: did the job itself die (a red gate never reaches `finish`)?
  const started = await stepIds(d.db, launchKey(params, 'deploy_staging.start'))
  if (started.dispatchedAt) {
    const app = await loadApp(d.db, params)
    const repo = repoOf(app)
    const { token, owner } = await repoToken(await d.vendors(), repo.name, { actions: 'read' })
    const since = new Date(started.dispatchedAt).getTime() - DISPATCH_SKEW_MS
    const run = (
      await listWorkflowRuns(token, owner, repo.name, DEPLOY_WORKFLOW_FILE, {
        event: 'workflow_dispatch',
      })
    ).find(r => !r.created_at || Date.parse(r.created_at) >= since)
    if (run && (await stepIds(d.db, waitKey)).runId !== String(run.id)) {
      await recordRunningIds(d.db, waitKey, {
        runId: String(run.id),
        ...(run.html_url ? { runUrl: run.html_url } : {}),
      })
    }
    if (run?.status === 'completed' && run.conclusion !== 'success') {
      return failWait(
        d.db,
        waitKey,
        jobFailure(
          'The staging deploy job',
          `the GitHub Actions run ended “${run.conclusion ?? 'without a result'}”`,
          issuerOf(d.cfg)
        )
      )
    }
  }
  return { done: false }
}

export function deployWaitStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(
    d.db,
    launchKey(params, 'deploy_staging.wait'),
    async () => {
      const ticket = await latestStagingTicket(d, params)
      if (!ticket || !deployed(ticket)) {
        throw new Error('The staging deploy did not finish within 45 minutes')
      }
      return { deployTicketId: ticket.id }
    },
    { continuesWait: true }
  )
}

/** The staging ticket is `active`/`finished` with a version — safe even when the event was lost. */
export function deployCheckStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'deploy_staging.check'), async () => {
    const ticket = await latestStagingTicket(d, params)
    if (!ticket || !deployed(ticket)) {
      throw new Error(
        `The staging deploy is not live (ticket ${ticket ? ticket.status : 'missing'})`
      )
    }
    return {
      deployTicketId: ticket.id,
      cfVersionId: ticket.cfVersionId ?? '',
      ...(ticket.version ? { version: ticket.version } : {}),
    }
  })
}

/** `deployStaging: false` — the three deploy rows and `health` are recorded as skipped. */
export async function skipDeploy(d: PipelineDeps, params: AppLaunchParams): Promise<void> {
  for (const step of [
    'deploy_staging.start',
    'deploy_staging.wait',
    'deploy_staging.check',
    'health',
  ]) {
    await skipStep(d.db, launchKey(params, step), 'Staging deploy not requested')
  }
}

// ---- 13. health ----------------------------------------------------------------------------------

export interface HealthProbe {
  up: boolean
  status: string
  error: string | null
  version: string | null
}

export async function healthProbe(d: PipelineDeps, params: AppLaunchParams): Promise<HealthProbe> {
  if (await stepSucceeded(d.db, launchKey(params, 'health'))) {
    return { up: true, status: 'up', error: null, version: null }
  }
  const rows = await checkAppHealth(d.db, params.tenantId, params.appId, d.health)
  const staging = rows.find(r => r.name === 'staging')
  return {
    up: staging?.healthStatus === 'up',
    status: staging?.healthStatus ?? 'unknown',
    error: staging?.healthError ?? null,
    version: staging?.healthVersion ?? null,
  }
}

export function healthStep(d: PipelineDeps, params: AppLaunchParams, last: HealthProbe) {
  return runStep(d.db, launchKey(params, 'health'), async () => {
    if (!last.up) {
      throw new Error(
        `Staging did not answer healthy after ${HEALTH_TRIES} tries (${last.status}${
          last.error ? `: ${last.error}` : ''
        })`
      )
    }
    const ids: Record<string, string> = {}
    if (last.version) ids.version = last.version
    return ids
  })
}

// ---- 14–15. production, live ---------------------------------------------------------------------

export function productionStep(d: PipelineDeps, params: AppLaunchParams) {
  return skipStep(
    d.db,
    launchKey(params, 'production'),
    "Waits for the first release and an owner's approval"
  )
}

export function liveStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'live'), async () => {
    const app = await loadApp(d.db, params)
    const envs = await loadEnvironments(d.db, params)
    await d.db.transaction(async tx => {
      await updateApp(tx, app, { status: 'live' })
      await recordAudit(tx, {
        tenantId: params.tenantId,
        ...SYSTEM_ACTOR,
        action: 'app.launched',
        targetType: 'App',
        targetId: app.id,
        appId: app.id,
        summary: {
          after: {
            slug: app.slug,
            runId: params.runId,
            staging: envs.staging.url,
            deployedStaging: params.options.deployStaging,
          },
        },
      })
    })
    if (params.userId) {
      await notify(d.db, {
        tenantId: params.tenantId,
        userId: params.userId,
        type: 'app.launched',
        title: `${app.displayName} is live`,
        body: params.options.deployStaging
          ? `Staging is up at ${envs.staging.url}`
          : 'Its resources are ready; deploy staging when you are',
        data: { appId: app.id, slug: app.slug },
      })
    }
    return { status: 'live' }
  })
}

/**
 * The run's uncaught failure: status `failed` and `app.launch_failed`. The reason is the failed
 * row's SCRUBBED error — never the thrown message, which `runStep` rethrows unredacted.
 */
export async function launchFailedStep(d: PipelineDeps, params: AppLaunchParams): Promise<void> {
  const [failed] = await d.db
    .select({ step: appOperations.step, error: appOperations.error })
    .from(appOperations)
    .where(
      and(
        eq(appOperations.tenantId, params.tenantId),
        eq(appOperations.runId, params.runId),
        eq(appOperations.status, 'failed')
      )
    )
    .orderBy(desc(appOperations.updatedAt))
    .limit(1)
  const reason = failed ? `${failed.step}: ${failed.error ?? 'failed'}` : 'The launch stopped'
  await markLaunchFailed(d.db, params.tenantId, params.appId, params.runId, new Error(reason))
}

/** What a Workflow class may replace (tests only): the adapter, the credentials, the waits. */
export interface PipelineOverrides {
  ports?: PipelinePorts
  vendors?: PipelineVendors
  sleep?: (ms: number) => Promise<void>
  health?: HealthPollOptions
}

/** The deps for one step: its own `db`, and credentials unsealed at most once, on first use. */
export function pipelineDeps(
  db: Database,
  cfg: AppConfig,
  overrides: PipelineOverrides,
  defaults: { ports: () => PipelinePorts }
): PipelineDeps {
  let vendors: Promise<PipelineVendors> | null = null
  return {
    db,
    cfg,
    get ports() {
      return overrides.ports ?? defaults.ports()
    },
    vendors: () => {
      vendors ??= overrides.vendors
        ? Promise.resolve(overrides.vendors)
        : loadPipelineVendors(db, cfg)
      return vendors
    },
    sleep: overrides.sleep,
    health: overrides.health,
  }
}
