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
import { templatePinRef } from '@launch/shared/launch-setup'
import { and, desc, eq, gte, isNull, or } from 'drizzle-orm'
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
import { applyLaunchRuleset, isRulesetsUnavailable } from '../branch-protection'
import { FINISHED_BEFORE_ACTIVATE, isDeployed } from '../deploy/tickets'
import { ensureGateVariable, LAUNCH_GATE_APP_ID_VARIABLE } from '../gate-variable'
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
import { appScaffoldPin } from '../kit-pin'
import { type AdapterApp, adapterFor, type TemplateAdapter } from '../kits/adapter'
import type { WranglerEnvironment } from '../kits/app-manifest'
import {
  createAppOidcClient,
  getAppOidcClient,
  issuerOf,
  rotateAppOidcSecret,
} from '../oidc-clients'
import { publicUrlProblem } from '../public-url'
import { SCAFFOLD_JOB_COMMIT_MESSAGES } from '../scaffold/job'
import { scaffoldPinIds, scaffoldPinOf } from '../scaffold/service'
import {
  cloudflareClient,
  loadPipelineVendors,
  neonClient,
  type PipelineVendors,
  requireAppsDomain,
  requireVendor,
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
  type PipelinePorts,
  SCAFFOLD_TICKET_ENVIRONMENT,
  type ScaffoldRunnerContext,
} from './ports'
import {
  idKey,
  provisionStorage,
  putPlaceholder,
  recordedStorage,
  type StoragePlan,
  storagePlan,
} from './provision-cloudflare'
import { ensureRepo, readRepoFiles, repoToken } from './provision-github'
import { environmentNeon, freshAppDatabaseUrl, type NeonIds, provisionNeon } from './provision-neon'
import { mintSendingKey } from './provision-resend'
import { generateSecret, putWorkerSecrets } from './worker-secrets'

/** What every step body acts with. `vendors()` unseals the credentials on first use in a step. */
export interface PipelineDeps {
  db: Database
  cfg: AppConfig
  /**
   * The app's `TemplateAdapter` (D36 K2): built from the manifest snapshot ON the app
   * (`apps.kit_manifest`), else its kit's — never fetched mid-run, so a retried step resolves the
   * same one.
   */
  adapterFor: (app: AdapterApp) => Promise<TemplateAdapter>
  /** The ports of the app's adapter (or a test's). */
  portsFor: (app: AdapterApp) => Promise<PipelinePorts>
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
      ? `It calls Launch back at ${launchUrl}, which GitHub's runners cannot reach — see Settings › Public URL.`
      : 'Open the run on GitHub for its log.',
  ].join(' ')
}

function repoOf(app: AppRow): { owner: string; name: string; branch: string } {
  if (!app.repoOwner || !app.repoName) throw new Error('The app has no repository yet')
  return { owner: app.repoOwner, name: app.repoName, branch: app.defaultBranch ?? 'main' }
}

/** The scaffolded toml of each environment, read at the default branch's head. */
async function readTomls(
  token: string,
  owner: string,
  repo: string,
  adapter: TemplateAdapter
): Promise<Record<AppEnvironmentName, { path: string; text: string }>> {
  const { tomls } = adapter.paths
  const files = await readRepoFiles(token, owner, repo, [tomls.staging, tomls.production])
  const read = (env: AppEnvironmentName) => {
    const text = files[tomls[env]]
    if (!text) throw new Error(`${tomls[env]} is missing`)
    return { path: tomls[env], text }
  }
  return { staging: read('staging'), production: read('production') }
}

/** What `cloudflare` creates for one environment's toml (the same plan every later step reads). */
function storageOf(adapter: TemplateAdapter, slug: string, env: AppEnvironmentName, toml: string) {
  return storagePlan(adapter.resources(toml), binding => adapter.kvTitle(slug, binding, env))
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
      const ports = await d.portsFor(app)
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
        ports.scaffoldFiles(),
        SCAFFOLD_JOB_COMMIT_MESSAGES.add
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
    const ports = await d.portsFor(app)
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
        ports.scaffoldFiles(),
        SCAFFOLD_JOB_COMMIT_MESSAGES.update
      )
      if (refreshed.changed) await ctx.record({ scaffoldFilesCommit: refreshed.sha })
    }
    // D36 K3: the APP's kit at its pin (the default kit's for an app with none), recorded on this
    // row — the token route hands the job this pin, and `scaffold.verify` checks against it.
    const pin = await appScaffoldPin(d.db, app, vendors.settings.templatePin)
    const pinIds = scaffoldPinIds(pin)
    await ctx.record(pinIds)
    const plan: ScaffoldPlan = {
      slug: app.slug,
      displayName: app.displayName,
      domain: requireAppsDomain(vendors.settings),
      repo: `${repo.owner}/${repo.name}`,
      kitRepo: pin.repo,
      tag: pin.tag ?? null,
      commit: pin.commit,
      kitId: (await d.adapterFor(app)).id,
    }
    const runner = ports.scaffoldRunner
    const ids = await runner.start(await scaffoldContext(d, app, ticketId, ctx), plan)
    // The job is on its way: its wait shows running from now, with no ids of an earlier job.
    await openWait(d.db, launchKey(params, 'scaffold.wait'))
    return { scaffoldTicketId: ticketId, runner: runner.id, ...pinIds, ...ids }
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
  const state = await (await d.portsFor(app)).scaffoldRunner.poll(context, runIds)
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

export function scaffoldVerifyStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'scaffold.verify'), async ctx => {
    const vendors = await d.vendors()
    const app = await loadApp(d.db, params)
    // The pin `scaffold.start` planned (and the job was handed); a run from before D36 K3 recorded
    // none, so the app's kit's pin then.
    const pin =
      scaffoldPinOf(await stepIds(d.db, launchKey(params, 'scaffold.start'))) ??
      (await appScaffoldPin(d.db, app, vendors.settings.templatePin))
    const adapter = await d.adapterFor(app)
    const repo = repoOf(app)
    const { token, owner } = await repoToken(vendors, repo.name, { contents: 'read' }, ctx)
    const manifestPath = adapter.paths.manifest
    const { tomls } = adapter.paths
    const files = await readRepoFiles(token, owner, repo.name, [
      manifestPath,
      tomls.staging,
      tomls.production,
    ])
    const problems: string[] = []
    const manifestText = files[manifestPath]
    // A release pin: the kit version IS the tag. A commit pin has no tag to compare, so the
    // version is whatever the kit's manifest reports (recorded as such) and the COMMIT is the
    // proof — the job stamps it, and a commit pin requires it.
    let kitVersion: string | null = null
    if (!manifestText) {
      problems.push(`${manifestPath} is missing`)
    } else {
      const identity = adapter.parseManifest(manifestText, manifestPath)
      kitVersion = identity.kitVersion
      if (identity.slug !== app.slug) {
        problems.push(`${manifestPath} names the app ${identity.slug ?? 'nothing'}`)
      }
      if (pin.tag && identity.kitVersion !== pin.tag) {
        problems.push(
          `${manifestPath} says kit ${identity.kitVersion ?? 'unknown'}, not ${pin.tag}`
        )
      }
      if (!pin.tag && !identity.kitVersion) {
        problems.push(`${manifestPath} records no kit version`)
      }
      if ((!pin.tag || identity.kitCommit) && identity.kitCommit !== pin.commit) {
        problems.push(
          `${manifestPath} says kit commit ${identity.kitCommit ?? 'unknown'}, not ${pin.commit}`
        )
      }
    }
    // Every account-scoped name by the kit's naming rule (`kits/names.ts` `namingProblems`).
    for (const env of ENVIRONMENTS) {
      const text = files[tomls[env]]
      if (!text) {
        problems.push(`${tomls[env]} is missing`)
        continue
      }
      problems.push(...adapter.namingProblems(tomls[env], env, adapter.resources(text), app.slug))
    }
    if (problems.length) {
      throw new Error(`The scaffold does not match the plan: ${problems.join('; ')}`)
    }
    const head = await getRef(token, owner, repo.name, `heads/${repo.branch}`)
    await updateApp(d.db, app, {
      // A commit pin: the ref is the SHA and the version the kit's manifest reported.
      templateRef: templatePinRef(pin),
      templateCommit: pin.commit,
      templateVersion: pin.tag ?? kitVersion,
      templateContractVersion: adapter.contractVersion,
    })
    return { scaffoldCommit: head.object.sha }
  })
}

// ---- 4. neon -------------------------------------------------------------------------------------

export function neonStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'neon'), async ctx => {
    const app = await loadApp(d.db, params)
    const { database } = await d.adapterFor(app)
    const envs = await loadEnvironments(d.db, params)
    const ids = await provisionNeon(neonClient(await d.vendors(), { sleep: d.sleep }), ctx, {
      slug: app.slug,
      database,
    })
    for (const env of ENVIRONMENTS) {
      await updateEnvironment(d.db, envs[env], { neon: environmentNeon(ids, env, database) })
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
    const app = await loadApp(d.db, params)
    const adapter = await d.adapterFor(app)
    const repo = repoOf(app)
    const cf = cloudflareClient(vendors)
    // What the scaffolded tomls declare is what gets created (D36: the kit's bindings).
    const { token, owner } = await repoToken(vendors, repo.name, { contents: 'read' }, ctx)
    const tomls = await readTomls(token, owner, repo.name, adapter)
    for (const env of ENVIRONMENTS) {
      const plan = storageOf(adapter, app.slug, env, tomls[env].text)
      await provisionStorage(cf, ctx, env, plan, (kind, id) =>
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
    const adapter = await d.adapterFor(app)
    const ports = await d.portsFor(app)
    const { token, owner } = await repoToken(vendors, repo.name, { contents: 'write' }, ctx)
    const current = await readTomls(token, owner, repo.name, adapter)
    const sendsEmail = Boolean(adapter.manifest.launchProvides.emailFrom)

    const changed: { path: string; content: string }[] = []
    for (const env of ENVIRONMENTS) {
      const { path, text: before } = current[env]
      const names = ports.names(app.slug, env, domain)
      const plan = storageOf(adapter, app.slug, env, before)
      const made = recordedStorage(storage, env, plan)
      // Every KV namespace the toml declares was created by `cloudflare`; one with no recorded id
      // is refused by `writeConfig` (no id for it) rather than left with a placeholder.
      if (plan.kv.length > 0 && made.kv.length === 0) {
        throw new Error(`No ${env} KV namespace was recorded`)
      }
      const written = ports.writeConfig(before, env, {
        appUrl: names.url,
        emailFrom: sendsEmail ? emailFrom(app, vendors.settings.notificationsDomain) : '',
        kvIds: Object.fromEntries(made.kv.map(k => [k.binding, k.id])),
        oidcIssuer: issuerOf(d.cfg),
        oidcClientId: client.clientId,
      })
      const parsed = adapter.parseToml(written, path)
      if (parsed.placeholders.length) {
        throw new Error(`${path} still has placeholders: ${parsed.placeholders.join(', ')}`)
      }
      if (written !== before) changed.push({ path, content: written })
      await updateEnvironment(d.db, envs[env], {
        url: names.url,
        workerName: names.workerName,
        resources: recordedResources(parsed, recordedStorage(storage, env, plan)),
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

/** The toml's bindings, with the KV titles and queue ids the pipeline recorded added. */
function recordedResources(
  toml: WranglerEnvironment,
  made: ReturnType<typeof recordedStorage>
): AppEnvironmentResources {
  return {
    ...toml.resources,
    kv: toml.resources.kv?.map(k => {
      const title = made.kv.find(m => m.id === k.id)?.title
      return title ? { ...k, title } : k
    }),
    queues: toml.resources.queues?.map(q => {
      const id = made.queues.find(m => m.name === q.queue)?.id
      return id ? { ...q, id } : q
    }),
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
    const adapter = await d.adapterFor(app)
    const ports = await d.portsFor(app)
    const { token, owner } = await repoToken(vendors, repo.name, { contents: 'read' }, ctx)
    const tomls = await readTomls(token, owner, repo.name, adapter)
    for (const env of ENVIRONMENTS) {
      const { path, text: tomlText } = tomls[env]
      const toml = adapter.parseToml(tomlText, path)
      const plan: StoragePlan = storageOf(adapter, app.slug, env, tomlText)
      const made = recordedStorage(storage, env, plan)
      const result = await putPlaceholder(cf, ctx, {
        env,
        names: ports.names(app.slug, env, domain),
        tomlText,
        toml,
        // A retry after the script PUT: its DO migrations are already applied.
        script: ports.placeholderScript(tomlText, {
          appliedTag:
            ctx.prior[idKey('migrationTag', env)] ?? envs[env].resources?.doMigrationTag ?? null,
          appName: app.displayName,
        }),
        queueIds: Object.fromEntries(made.queues.map(q => [q.name, q.id])),
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
      // Creating an environment is GitHub's "Administration" permission, not "Environments";
      // repository variables are "Variables" (`actions_variables`).
      { administration: 'write', actions_variables: 'write' },
      ctx
    )
    for (const env of ENVIRONMENTS) await putEnvironment(token, owner, repo.name, env)
    // DEPLOYER.md: the deploy job speaks to Launch's `/ci` surface, with Launch's origin as the
    // OIDC audience. Variables, not secrets — the job holds no credential at all.
    const issuer = issuerOf(d.cfg)
    await upsertRepoVariable(token, owner, repo.name, 'DEPLOYER_URL', `${issuer}/ci`)
    await upsertRepoVariable(token, owner, repo.name, 'DEPLOYER_AUDIENCE', issuer)
    // Issue #10: the kit's `verified` CI job trusts a `launch/gate` check run from this App id
    // only. Written only when it differs, so a retry is a read.
    const githubAppId = requireVendor(vendors, 'github').auth.appId
    await ensureGateVariable(token, owner, repo.name, githubAppId)
    const done = {
      environments: ENVIRONMENTS.join(','),
      variables: `DEPLOYER_URL,DEPLOYER_AUDIENCE,${LAUNCH_GATE_APP_ID_VARIABLE}`,
    }
    // Issue #5 (plan §1.13): Launch's `launch` ruleset on the default branch — `Gate` required,
    // the App a bypass actor so the release bump still lands. Idempotent by name, so a retry
    // updates rather than duplicates; a plan without rulesets is recorded, never fatal.
    const appId = Number(githubAppId)
    try {
      const { requiredCheck } = await d.adapterFor(app)
      const { rulesetId } = await applyLaunchRuleset(token, owner, repo.name, appId, {
        requiredCheck,
      })
      return { ...done, rulesetId: String(rulesetId), branchProtection: 'ok' }
    } catch (err) {
      if (!isRulesetsUnavailable(err)) throw err
      return { ...done, branchProtection: 'unavailable', branchProtectionDetail: err.message }
    }
  })
}

// ---- 10. worker_secrets --------------------------------------------------------------------------

export function workerSecretsStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'worker_secrets'), async ctx => {
    const vendors = await d.vendors()
    const app = await loadApp(d.db, params)
    const adapter = await d.adapterFor(app)
    const secretNames = adapter.secrets
    if (secretNames.generated.length > 1) {
      throw new Error(
        `The kit names ${secretNames.generated.length} generated secrets; Launch generates at most one per environment`
      )
    }
    const generated = secretNames.generated[0] ?? null
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
      // The kit's generated secret (Rocketflare's OAUTH_ENCRYPTION_KEY): kept, never rotated.
      let kept: Record<string, string> = {}
      if (generated) {
        let value = await decryptToken(d.cfg, row.encryptionKeySealed)
        if (!value) {
          value = generateSecret(generated.kind)
          // Sealed and stored BEFORE the put, so a retry puts the same value back.
          await updateEnvironment(d.db, row, {
            encryptionKeySealed: await encryptToken(d.cfg, value),
          })
        }
        ctx.redact(value)
        kept = { [generated.name]: value }
      }
      const branchId = env === 'production' ? ids.mainBranchId : ids.stagingBranchId
      const secrets: Record<string, string> = {
        ...kept,
        [secretNames.oidcClientSecret]: rotated.clientSecret,
        ...(creator?.email && secretNames.bootstrapAdmins
          ? { [secretNames.bootstrapAdmins]: creator.email }
          : {}),
        [secretNames.databaseUrl]: await freshAppDatabaseUrl(
          neon.client,
          ctx,
          ids.projectId,
          branchId,
          adapter.database.appRole
        ),
      }
      const names = await putWorkerSecrets(cf, ctx, row.workerName, secrets)
      put.push(...names.map(n => `${env}:${n}`))
    }
    return { secrets: put.join(',') }
  })
}

// ---- 11. email (non-blocking) --------------------------------------------------------------------

/**
 * Why the fleet cannot mint an email key at all (no Resend credential, or no verified notifications
 * domain recorded by its Setup check), or null. A precondition, not a failure: retrying it cannot
 * help, so the step is recorded `skipped` with this reason and the launch carries on.
 */
function emailUnavailable(vendors: PipelineVendors): string | null {
  if (!vendors.resend) return 'Email not configured: no Resend key in Setup'
  if (!vendors.resend.domainId) {
    const domain = vendors.settings.notificationsDomain ?? 'the notifications domain'
    return `Email not configured: ${domain} is not a verified Resend domain yet — verify it and re-run the Resend check in Setup`
  }
  return null
}

export async function emailStep(d: PipelineDeps, params: AppLaunchParams) {
  const adapter = await d.adapterFor(await loadApp(d.db, params))
  const keyName = adapter.secrets.emailApiKey
  const unavailable = keyName
    ? emailUnavailable(await d.vendors())
    : `The ${adapter.name} kit sends no email, so there is no sending key to mint`
  if (unavailable || !keyName) {
    await skipStep(d.db, launchKey(params, 'email'), unavailable ?? 'No email')
    return
  }
  return runStep(d.db, launchKey(params, 'email'), async ctx => {
    const vendors = await d.vendors()
    const domain = requireAppsDomain(vendors.settings)
    const resend = resendClient(vendors)
    const cf = cloudflareClient(vendors)
    const app = await loadApp(d.db, params)
    const ports = await d.portsFor(app)
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
          keyName: ports.names(app.slug, env, domain).resendKeyName,
          confirmedKeyId: row.resendKeyId,
        },
        async token => {
          await putWorkerSecrets(cf, ctx, workerName, { [keyName]: token })
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
    const { release } = await d.adapterFor(app)
    const repo = repoOf(app)
    const { token, owner } = await repoToken(vendors, repo.name, { actions: 'write' }, ctx)
    const dispatchedAt = new Date().toISOString()
    await ctx.record({ dispatchedAt })
    await dispatchWorkflow(token, owner, repo.name, release.workflowFile, {
      ref: repo.branch,
      inputs: { [release.environmentInput]: 'staging' },
    })
    await openWait(d.db, launchKey(params, 'deploy_staging.wait'))
    return { dispatchedAt, deployWorkflowFile: release.workflowFile }
  })
}

/**
 * The newest staging deploy ticket opened since the dispatch (less a little clock skew), leaving
 * out one CLOSED before the dispatch: `finished_at` and `dispatchedAt` are both Launch's clock, so
 * a ticket `finish` closed before this dispatch was made belongs to an earlier job — the one a
 * Retry is retrying, which now fails its wait the moment it closes unactivated, well inside the
 * skew window.
 */
async function latestStagingTicket(
  d: PipelineDeps,
  params: AppLaunchParams
): Promise<DeployTicketRow | null> {
  const started = await stepIds(d.db, launchKey(params, 'deploy_staging.start'))
  const dispatchedAt = started.dispatchedAt ? new Date(started.dispatchedAt) : null
  const since = dispatchedAt ? new Date(dispatchedAt.getTime() - DISPATCH_SKEW_MS) : new Date(0)
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
        gte(deployTickets.createdAt, since),
        ...(dispatchedAt
          ? [or(isNull(deployTickets.finishedAt), gte(deployTickets.finishedAt, dispatchedAt))]
          : [])
      )
    )
    .orderBy(desc(deployTickets.createdAt))
    .limit(1)
  return row ?? null
}

/**
 * Live: `activate` ran (`activated_at`, with the version it put live). Never status + version — a
 * job that died between upload and activate still calls `finish`, which closes the ticket
 * `finished` with an uploaded version that never served a request (guidemode/hola-world run
 * 36408593621: `db:migrate:ci` failed, and the launch went on to `health` against the placeholder).
 */
function deployed(ticket: DeployTicketRow | null): boolean {
  return isDeployed(ticket)
}

/**
 * A ticket `finish` closed without an activation: the job has ended (`finish` is its last call and
 * nothing moves a closed ticket), so the deploy failed. The sentence for the wait row, or null.
 */
function unactivatedClose(ticket: DeployTicketRow | null): string | null {
  if (!ticket || ticket.status !== 'finished' || isDeployed(ticket)) return null
  const where = ticket.cfVersionId
    ? 'it stopped after upload — see the run'
    : 'it stopped before uploading — see the run'
  const detail =
    ticket.error && ticket.error !== FINISHED_BEFORE_ACTIVATE ? `: ${ticket.error}` : ''
  return `The staging deploy job ended without activating the new version (${where})${detail}`
}

/** One round's look at the staging deploy: the ticket first, then the GitHub run behind it. */
export async function deployPoll(d: PipelineDeps, params: AppLaunchParams): Promise<WaitState> {
  const waitKey = launchKey(params, 'deploy_staging.wait')
  const settled = await waitRowState(d.db, waitKey)
  if (settled) return settled
  const ticket = await latestStagingTicket(d, params)
  if (deployed(ticket)) return { done: true }
  const unactivated = unactivatedClose(ticket)
  if (unactivated) return failWait(d.db, waitKey, unactivated)
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
    const { release } = await d.adapterFor(app)
    const repo = repoOf(app)
    const { token, owner } = await repoToken(await d.vendors(), repo.name, { actions: 'read' })
    const since = new Date(started.dispatchedAt).getTime() - DISPATCH_SKEW_MS
    const run = (
      await listWorkflowRuns(token, owner, repo.name, release.workflowFile, {
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
        throw new Error(
          unactivatedClose(ticket) ?? 'The staging deploy did not finish within 45 minutes'
        )
      }
      return { deployTicketId: ticket.id }
    },
    { continuesWait: true }
  )
}

/** The staging ticket was ACTIVATED (`activated_at`) — safe even when the event was lost. */
export function deployCheckStep(d: PipelineDeps, params: AppLaunchParams) {
  return runStep(d.db, launchKey(params, 'deploy_staging.check'), async () => {
    const ticket = await latestStagingTicket(d, params)
    if (!ticket || !deployed(ticket)) {
      throw new Error(
        unactivatedClose(ticket) ??
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
  /** The app's adapter; absent, it is resolved from the app (`kits/adapter.ts` `adapterFor`). */
  adapter?: TemplateAdapter
  vendors?: PipelineVendors
  sleep?: (ms: number) => Promise<void>
  health?: HealthPollOptions
}

/** The deps for one step: its own `db`, and credentials unsealed at most once, on first use. */
export function pipelineDeps(
  db: Database,
  cfg: AppConfig,
  overrides: PipelineOverrides,
  defaults: { ports: (adapter: TemplateAdapter) => PipelinePorts }
): PipelineDeps {
  let vendors: Promise<PipelineVendors> | null = null
  const resolve = async (app: AdapterApp) => overrides.adapter ?? adapterFor(db, app)
  return {
    db,
    cfg,
    adapterFor: resolve,
    portsFor: async app => overrides.ports ?? defaults.ports(await resolve(app)),
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
