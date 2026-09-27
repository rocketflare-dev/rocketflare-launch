/**
 * The deploy gateway (Launch P2, spec/08 "Launch deploys, so Launch is the gate") — the five
 * operations of the external deployer protocol v1 (the kit's `docs/DEPLOYER.md`), behind
 * `routes/ci-deploy.ts`. CI holds no Cloudflare token and no database credential; everything a
 * deploy job can do is here, in this order, and the order IS the security property:
 *
 *   start → (approval) → upload: CHECK the build, store it as an undeployed version, THEN issue
 *   the migrator URL → (the job migrates) → activate: deploy at 100%, revoke → finish (always).
 *
 * A refused build therefore never reaches Neon at all: no password reset, no URI, no migration.
 *
 * - **start** — a retried call from the same run attempt gets the same ticket. Staging is
 *   approved by policy (`auto`). Production claims the environment's live "Deploy to production"
 *   pre-approval (`intent`) if there is one, or opens `pending` for an owner to decide on the app
 *   page within `PENDING_APPROVAL_TTL_MS`.
 * - **get** — the ticket's state; a pending ticket past its window becomes `rejected`.
 * - **upload** — only on `approved` (409). The toml is parsed here and `checkBindings` decides;
 *   a refusal is 403 `{ error, refused }` and the ticket `failed`.
 * - **activate** — only on `uploaded` (409): registers the build's Workflows and cron schedules
 *   (a version upload does neither), deploys the version at 100%, revokes the migrator.
 * - **finish** — idempotent: revokes the migrator if still live, closes the ticket once, and
 *   wakes the launch run waiting on it (`DEPLOY_FINISHED_EVENT`).
 *
 * Every call that names a ticket must come from the run attempt and environment that opened it
 * (`assertRunOwnsTicket`), so one run cannot spend another's approval. Every transition is a
 * compare-and-set (`tickets.ts`) and is audited. **The migrator URI is never logged, stored or
 * put in an error** — it is returned from `uploadDeploy` and nowhere else.
 */
import { DEPLOY_FINISHED_EVENT, type DeployUpload } from '@launch/shared/launch-pipeline'
import { and, eq } from 'drizzle-orm'
import { parse as parseToml } from 'smol-toml'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { appEnvironments, type DeployTicketRow } from '../../../../db/schema'
import {
  ApiError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  isApiError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../../utils/core/errors'
import { type AuditActor, recordAudit } from '../audit'
import type { ResolvedCaller } from '../ci/caller'
import { CloudflareClient } from '../cloudflare'
import { getCredential, getSetting } from '../credentials'
import { NeonClient, type NeonOptions } from '../neon'
import { type BindingCheckResult, type CheckedWorkflow, checkBindings } from './binding-check'
import { issueMigratorUrl, revokeMigrator } from './migrator'
import {
  claimIntent,
  closeTicket,
  expirePending,
  markCredentialsIssued,
  markCredentialsRevoked,
  openRunTicket,
  type TicketRun,
  transitionTicket,
} from './tickets'
import { uploadVersion } from './worker-upload'

/** The protocol versions this gateway speaks (DEPLOYER.md "Versioning"). */
export const SUPPORTED_PROTOCOLS = [1] as const

/** How long a production `pending` ticket waits for an owner before it counts as rejected. */
export const PENDING_APPROVAL_TTL_MS = 60 * 60 * 1000

/**
 * A protocol error whose body carries DEPLOYER.md's own top-level fields (`supported`, `refused`)
 * beside the shared envelope, so the kit's client and Launch's UI both read it.
 */
export class DeployerProtocolError extends ApiError {
  constructor(
    statusCode: number,
    message: string,
    code: string,
    readonly extra: Record<string, unknown>
  ) {
    super(statusCode, message, code, extra)
    this.name = 'DeployerProtocolError'
  }

  override toJSON() {
    return { ...super.toJSON(), ...this.extra }
  }
}

function assertProtocol(protocol: number): void {
  if (!(SUPPORTED_PROTOCOLS as readonly number[]).includes(protocol)) {
    throw new DeployerProtocolError(
      400,
      `Deployer protocol ${protocol} is not supported`,
      'deployer_protocol_unsupported',
      { supported: [...SUPPORTED_PROTOCOLS] }
    )
  }
}

/** What the gateway acts with: Launch's Cloudflare token and account, and the Neon org key. */
export interface DeployVendors {
  cf: CloudflareClient
  accountId: string
  neon: NeonClient
}

export interface VendorOverrides {
  fetch?: typeof fetch
  neon?: Pick<NeonOptions, 'sleep' | 'lockedDelayMs'>
}

/** The stored credentials, or 503 `ci_deployer_not_configured` — the setup wizard's job. */
export async function loadDeployVendors(
  db: Database,
  cfg: AppConfig,
  overrides: VendorOverrides = {}
): Promise<DeployVendors> {
  const [cloudflare, neonKey, accountId] = await Promise.all([
    getCredential(db, cfg, 'cloudflare_api_token'),
    getCredential(db, cfg, 'neon_org_api_key'),
    getSetting<string>(db, 'cloudflare_account_id'),
  ])
  if (!cloudflare || !neonKey || typeof accountId !== 'string' || !accountId) {
    throw new ServiceUnavailableError(
      'Launch cannot deploy yet: connect Cloudflare and Neon in Setup',
      'ci_deployer_not_configured'
    )
  }
  return {
    cf: new CloudflareClient(cloudflare.secret.apiToken, { fetch: overrides.fetch }),
    accountId,
    neon: new NeonClient(neonKey.secret.apiKey, { fetch: overrides.fetch, ...overrides.neon }),
  }
}

/** The Workflow binding the launch run waits on (only `get(id).sendEvent` is used). */
export interface LaunchWorkflowBinding {
  get(id: string): Promise<{ sendEvent(event: { type: string; payload: unknown }): Promise<void> }>
}

interface Logger {
  warn(obj: object, msg?: string): void
}

export interface GatewayContext {
  db: Database
  caller: ResolvedCaller
  actor: AuditActor
  /** Lazy: `start` and `get` touch no vendor, so a half-configured Launch can still answer them. */
  vendors: () => Promise<DeployVendors>
  launchWorkflow?: LaunchWorkflowBinding
  logger?: Logger
  now?: () => Date
}

/** `start` and `get`'s body: `{ id, status }` plus what the job's log may find useful. */
export function ticketState(ticket: DeployTicketRow, environment: string) {
  return {
    id: ticket.id,
    status: ticket.status,
    environment,
    ...(ticket.version ? { version: ticket.version } : {}),
    ...(ticket.cfVersionId ? { versionId: ticket.cfVersionId } : {}),
    ...(ticket.expiresAt && ticket.status === 'pending'
      ? { expiresAt: ticket.expiresAt.toISOString() }
      : {}),
    ...(ticket.error ? { error: ticket.error } : {}),
  }
}

/** The run's claims, as the ticket records them. */
function runOf(caller: ResolvedCaller): TicketRun {
  const { claims } = caller
  return {
    repositoryId: claims.repository_id,
    repository: claims.repository,
    runId: claims.run_id,
    runAttempt: Number.parseInt(claims.run_attempt, 10),
    sha: claims.sha,
    ref: claims.ref,
    actor: claims.actor,
    jobWorkflowRef: claims.job_workflow_ref,
  }
}

async function audit(
  ctx: GatewayContext,
  ticket: DeployTicketRow,
  action: string,
  after: Record<string, unknown>
): Promise<void> {
  await recordAudit(ctx.db, {
    tenantId: ticket.tenantId,
    ...ctx.actor,
    action,
    targetType: 'deploy_ticket',
    targetId: ticket.id,
    appId: ticket.appId,
    summary: {
      after: {
        environment: ctx.caller.environment.name,
        runId: ticket.runId,
        actor: ticket.actor,
        ...after,
      },
    },
  })
}

/** The ticket, if this caller's run attempt and environment opened it; else 404 or 403. */
export function assertRunOwnsTicket(
  caller: ResolvedCaller,
  ticket: DeployTicketRow | null
): DeployTicketRow {
  if (!ticket || ticket.appId !== caller.app.id || ticket.purpose !== 'deploy') {
    throw new NotFoundError('No such deploy ticket for this app', 'deploy_ticket_not_found')
  }
  if (
    ticket.environmentId !== caller.environment.id ||
    ticket.runId !== caller.claims.run_id ||
    String(ticket.runAttempt) !== caller.claims.run_attempt
  ) {
    throw new ForbiddenError(
      'This ticket belongs to another run or environment',
      'deploy_ticket_other_run'
    )
  }
  return ticket
}

function wrongState(ticket: DeployTicketRow, expected: string): never {
  throw new ConflictError(
    `The ticket is ${ticket.status}; this step needs it ${expected}`,
    'deploy_ticket_state'
  )
}

/** A vendor failure's own message (Cloudflare's or Neon's) — never a credential. */
function vendorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- start ------------------------------------------------------------------------------------

/**
 * `POST /deploy/start`. Returns the ticket (new or, for a retried call, the one this run attempt
 * already opened).
 */
export async function startDeploy(
  ctx: GatewayContext,
  body: { protocol: number }
): Promise<DeployTicketRow> {
  assertProtocol(body.protocol)
  const { caller, db } = ctx
  const now = ctx.now?.() ?? new Date()
  const scope = {
    tenantId: caller.tenantId,
    appId: caller.app.id,
    environmentId: caller.environment.id,
  }
  const run = runOf(caller)
  // A launch run still provisioning is waiting for this deploy (`deploy_staging.wait`).
  const launchRunId = caller.app.status === 'live' ? null : (caller.app.launchRunId ?? null)

  if (caller.environment.name === 'production') {
    const claimed = await claimIntent(db, scope, run, launchRunId, now)
    if (claimed) {
      await audit(ctx, claimed, 'deploy.started', {
        status: claimed.status,
        decisionSource: 'intent',
        sha: run.sha,
        ref: run.ref,
      })
      return claimed
    }
  }

  const staging = caller.environment.name === 'staging'
  const { ticket, created } = await openRunTicket(db, scope, run, {
    purpose: 'deploy',
    status: staging ? 'approved' : 'pending',
    decisionSource: staging ? 'auto' : null,
    decidedAt: staging ? now : null,
    expiresAt: staging ? null : new Date(now.getTime() + PENDING_APPROVAL_TTL_MS),
    launchRunId,
  })
  if (created) {
    await audit(ctx, ticket, 'deploy.started', {
      status: ticket.status,
      decisionSource: ticket.decisionSource,
      sha: run.sha,
      ref: run.ref,
    })
  }
  return ticket
}

// ---- get ----------------------------------------------------------------------------------------

/** `GET /deploy/:id`. A pending ticket past its window is rejected first. */
export async function getDeploy(
  ctx: GatewayContext,
  ticket: DeployTicketRow
): Promise<DeployTicketRow> {
  const now = ctx.now?.() ?? new Date()
  if (ticket.status === 'pending' && ticket.expiresAt && ticket.expiresAt <= now) {
    const expired = await expirePending(ctx.db, ticket, now)
    if (expired) {
      await audit(ctx, expired, 'deploy.production.rejected', { reason: 'expired' })
      return expired
    }
  }
  return ticket
}

// ---- upload -------------------------------------------------------------------------------------

/** What `deploy_tickets.bindings` keeps of a checked build: names and ids, never a var's value. */
export interface TicketBindings {
  bindings: { type: string; name: string; target?: string }[]
  crons: string[]
  workflows: CheckedWorkflow[]
  migrationTag: string | null
}

function ticketBindings(check: BindingCheckResult): TicketBindings {
  const targetKeys = ['namespace_id', 'queue_name', 'bucket_name', 'workflow_name', 'class_name']
  return {
    bindings: check.bindings.map(b => {
      const key = targetKeys.find(k => typeof b[k] === 'string')
      return { type: b.type, name: b.name, ...(key ? { target: b[key] as string } : {}) }
    }),
    crons: check.crons,
    workflows: check.workflows,
    migrationTag: check.migrationTag,
  }
}

function storedBindings(ticket: DeployTicketRow): TicketBindings {
  const raw = (ticket.bindings ?? {}) as Partial<TicketBindings>
  return {
    bindings: raw.bindings ?? [],
    crons: raw.crons ?? [],
    workflows: raw.workflows ?? [],
    migrationTag: raw.migrationTag ?? null,
  }
}

/** Fail an in-flight ticket and audit it; the caller throws the response. */
async function failTicket(
  ctx: GatewayContext,
  ticket: DeployTicketRow,
  from: 'approved' | 'uploaded',
  error: string
): Promise<void> {
  const failed = await transitionTicket(ctx.db, ticket, [from], 'failed', { error })
  if (failed) await audit(ctx, failed, 'deploy.failed', { from, error })
}

export interface UploadResult {
  ticket: DeployTicketRow
  /** A CREDENTIAL. Returned to the job once; never logged, stored or audited. */
  migratorUrl: string
}

/**
 * `POST /deploy/:id/upload`. Check → upload the assets and an undeployed version → only then the
 * migrator URL. A refusal makes no vendor call at all.
 */
export async function uploadDeploy(
  ctx: GatewayContext,
  ticket: DeployTicketRow,
  body: DeployUpload
): Promise<UploadResult> {
  assertProtocol(body.protocol)
  if (ticket.status !== 'approved') wrongState(ticket, 'approved')
  const { environment } = ctx.caller

  let config: Record<string, unknown>
  try {
    config = parseToml(body.toml) as Record<string, unknown>
  } catch (err) {
    throw new BadRequestError(
      `The wrangler config is not valid TOML: ${vendorMessage(err)}`,
      'deploy_toml_invalid'
    )
  }

  const check = checkBindings(config, {
    workerName: environment.workerName ?? '',
    resources: environment.resources,
  })
  if (check.refused.length > 0) {
    const error = 'bindings not registered for this app'
    const failed = await transitionTicket(ctx.db, ticket, ['approved'], 'failed', {
      refused: check.refused,
      version: body.version,
      error,
    })
    if (failed) await audit(ctx, failed, 'deploy.refused', { refused: check.refused })
    throw new DeployerProtocolError(403, error, 'deploy_bindings_refused', {
      refused: check.refused,
    })
  }

  const vendors = await ctx.vendors()
  const workerName = environment.workerName ?? ''
  let versionId: string
  try {
    versionId = await uploadVersion(vendors.cf, vendors.accountId, {
      workerName,
      config,
      check,
      upload: body,
      ticketId: ticket.id,
    })
  } catch (err) {
    if (isApiError(err)) throw err
    const error = `The upload to Cloudflare failed: ${vendorMessage(err)}`
    await failTicket(ctx, ticket, 'approved', error)
    throw new ApiError(502, error, 'deploy_upload_failed')
  }

  const uploaded = await transitionTicket(ctx.db, ticket, ['approved'], 'uploaded', {
    version: body.version,
    cfVersionId: versionId,
    bindings: ticketBindings(check) as unknown as Record<string, unknown>,
  })
  if (!uploaded) {
    throw new ConflictError(
      'The ticket moved on while its build was uploading',
      'deploy_ticket_state'
    )
  }

  // Mark first, then mint: if anything below dies, `finish` still sees a credential to revoke.
  await markCredentialsIssued(ctx.db, uploaded)
  let migratorUrl: string
  try {
    migratorUrl = await issueMigratorUrl(vendors.neon, environment.neon)
  } catch (err) {
    const error = isApiError(err)
      ? err.message
      : `Launch could not issue migration credentials: ${vendorMessage(err)}`
    await failTicket(ctx, uploaded, 'uploaded', error)
    if (isApiError(err)) throw err
    throw new ApiError(502, error, 'deploy_migrator_failed')
  }

  await audit(ctx, uploaded, 'deploy.uploaded', {
    version: body.version,
    versionId,
    bindings: ticketBindings(check).bindings.map(b => `${b.type}:${b.name}`),
    migrator: 'issued',
  })
  return { ticket: uploaded, migratorUrl }
}

// ---- activate -----------------------------------------------------------------------------------

/** Revoke the migrator if this ticket still has a live one. Throws on a Neon failure. */
async function revokeIfLive(
  ctx: GatewayContext,
  vendors: DeployVendors,
  ticket: DeployTicketRow
): Promise<void> {
  if (!ticket.credentialsIssuedAt || ticket.credentialsRevokedAt) return
  await revokeMigrator(vendors.neon, ctx.caller.environment.neon)
  await markCredentialsRevoked(ctx.db, ticket)
}

/** `POST /deploy/:id/activate`: workflows + schedules, the version live at 100%, migrator revoked. */
export async function activateDeploy(
  ctx: GatewayContext,
  ticket: DeployTicketRow
): Promise<DeployTicketRow> {
  if (ticket.status !== 'uploaded') wrongState(ticket, 'uploaded')
  if (!ticket.cfVersionId) wrongState(ticket, 'uploaded with a version')
  const { environment } = ctx.caller
  const workerName = environment.workerName ?? ''
  const vendors = await ctx.vendors()
  const stored = storedBindings(ticket)

  try {
    // A version upload registers no Workflow and sets no cron (plan §0.2) — Launch does both,
    // BEFORE the deployment, so a failure here leaves the previous version serving.
    for (const w of stored.workflows) {
      await vendors.cf.putWorkflow(vendors.accountId, w.name, {
        scriptName: workerName,
        className: w.className,
      })
    }
    await vendors.cf.putSchedules(vendors.accountId, workerName, stored.crons)
    await vendors.cf.createDeployment(
      vendors.accountId,
      workerName,
      ticket.cfVersionId as string,
      `launch deploy ticket ${ticket.id}`
    )
  } catch (err) {
    const error = `Activation failed: ${vendorMessage(err)}`
    await revokeIfLive(ctx, vendors, ticket).catch(() => {})
    await failTicket(ctx, ticket, 'uploaded', error)
    throw new ApiError(502, error, 'deploy_activate_failed')
  }

  // The version is live. A revoke that fails here is retried by `finish` (the row still says
  // issued-not-revoked), so it does not undo the activation.
  try {
    await revokeIfLive(ctx, vendors, ticket)
  } catch (err) {
    ctx.logger?.warn(
      { ticketId: ticket.id, err: vendorMessage(err) },
      'deploy: migrator revoke failed at activate; finish will retry'
    )
  }

  const active = await transitionTicket(ctx.db, ticket, ['uploaded'], 'active')
  if (!active) wrongState(ticket, 'uploaded')
  const now = ctx.now?.() ?? new Date()
  await ctx.db
    .update(appEnvironments)
    .set({
      lastDeployVersion: active.version,
      lastDeployAt: now,
      lastDeployBy: `github:${active.actor ?? 'unknown'}`,
      updatedAt: now,
    })
    .where(
      and(eq(appEnvironments.id, environment.id), eq(appEnvironments.tenantId, ctx.caller.tenantId))
    )
  await audit(ctx, active, 'deploy.activated', {
    version: active.version,
    versionId: active.cfVersionId,
    workflows: stored.workflows.map(w => w.name),
    crons: stored.crons,
  })
  return active
}

// ---- finish -------------------------------------------------------------------------------------

/**
 * `POST /deploy/:id/finish` — always last, any number of times. Revokes a live migrator, closes
 * the ticket ONCE (`closeTicket`), and on that one close audits and wakes the launch run.
 */
export async function finishDeploy(
  ctx: GatewayContext,
  ticket: DeployTicketRow
): Promise<DeployTicketRow> {
  let current = ticket
  if (current.credentialsIssuedAt && !current.credentialsRevokedAt) {
    const vendors = await ctx.vendors()
    try {
      await revokeIfLive(ctx, vendors, current)
    } catch (err) {
      throw new ApiError(
        502,
        `Launch could not revoke the migration credentials: ${vendorMessage(err)}`,
        'deploy_revoke_failed'
      )
    }
  }
  const closed = await closeTicket(ctx.db, current, ctx.now?.() ?? new Date())
  if (!closed) return current
  current = closed
  await audit(ctx, closed, 'deploy.finished', {
    status: closed.status,
    version: closed.version,
    versionId: closed.cfVersionId,
  })
  if (closed.launchRunId && ctx.launchWorkflow) {
    try {
      const instance = await ctx.launchWorkflow.get(closed.launchRunId)
      await instance.sendEvent({ type: DEPLOY_FINISHED_EVENT, payload: { ticketId: closed.id } })
    } catch (err) {
      // The run re-reads the ticket after its wait (`deploy_staging.check`), so a lost event
      // costs time, not correctness.
      ctx.logger?.warn(
        { ticketId: closed.id, launchRunId: closed.launchRunId, err: vendorMessage(err) },
        'deploy: could not wake the launch run'
      )
    }
  }
  return current
}
