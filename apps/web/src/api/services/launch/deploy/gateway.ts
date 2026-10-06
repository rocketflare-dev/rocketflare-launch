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
 *   approved by policy (`auto`; spec/12 #9 keeps it outside the approvals engine). Production
 *   claims the environment's live pre-approval if there is one bound to the run's ref (a granted
 *   Promote, or "Deploy to production"), or opens `pending` AND a `deploy.production` approval
 *   (subject `deploy_ticket`, requester `github:<actor>`, expiring with the ticket) that an owner
 *   decides within `PENDING_APPROVAL_TTL_MS` (P4, plan §1.9). A run on `refs/tags/X.Y.Z` is linked
 *   to the app's release `X.Y.Z` (`release_id`) — the release chain's link (plan §1.11).
 * - **get** — the ticket's state; a pending ticket past its window becomes `rejected`.
 * - **upload** — only on `approved` (409). The toml is parsed here and `checkBindings` decides;
 *   a refusal is 403 `{ error, refused }` and the ticket `failed`. P5 (plan §1.5): a toml var a
 *   live grant of the app and environment supplies is dropped from the upload and recorded as
 *   `shadowedVars` (on the ticket and in `deploy.uploaded`) — the grant's secret wins. Issue #12:
 *   Launch's artifact digest of the upload is recorded on the ticket (`checkArtifact`); a
 *   production upload that differs from the staging deploy of the same version is warned about
 *   and recorded, and refused only when the job declares `source: 'bundle'`.
 * - **activate** — only on `uploaded` (409): registers the build's Workflows and cron schedules
 *   (a version upload does neither), deploys the version at 100%, revokes the migrator. A release's
 *   run moves it to `staging_active` / `production_active` (audited `release.*`). P5 (plan §1.6):
 *   a grant pushed after the upload began gets a `repair` push, because the version carries the
 *   secrets as of its upload.
 * - **finish** — idempotent: revokes the migrator if still live, closes the ticket once, and
 *   wakes the launch run waiting on it (`DEPLOY_FINISHED_EVENT`). A ticket it closes without an
 *   activation (the job died after upload — at its migration, say) records
 *   `FINISHED_BEFORE_ACTIVATE` as its `error`: it is closed, not deployed (`isDeployed`).
 *
 * Every call that names a ticket must come from the run attempt and environment that opened it
 * (`assertRunOwnsTicket`), so one run cannot spend another's approval. Every transition is a
 * compare-and-set (`tickets.ts`) and is audited. **The migrator URI is never logged, stored or
 * put in an error** — it is returned from `uploadDeploy` and nowhere else.
 */
import { githubRequesterLabel } from '@launch/shared/launch-approvals'
import { DEPLOY_FINISHED_EVENT, type DeployUpload } from '@launch/shared/launch-pipeline'
import { RELEASE_REALTIME_ENTITY, taggedRunVersion } from '@launch/shared/launch-releases'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { parse as parseToml } from 'smol-toml'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import {
  type AppReleaseRow,
  appEnvironments,
  appGrants,
  type DeployTicketRow,
  deployTickets,
} from '../../../../db/schema'
import {
  ApiError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  isApiError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../../utils/core/errors'
import type { Defer } from '../../../utils/routes/route-helpers'
import { open as openApproval } from '../../approvals/engine'
import type { ApprovalDeps } from '../../approvals/types'
import { grantedKeys, pushedSince } from '../../grants/holders'
import { startPush } from '../../grants/push'
import { activeVersion } from '../../grants/values'
import { nudge, type Realtime, realtimeEvent } from '../../realtime'
import { type AuditActor, recordAudit } from '../audit'
import type { ResolvedCaller } from '../ci/caller'
import { CloudflareClient } from '../cloudflare'
import { getCredential, getSetting } from '../credentials'
import { NeonClient, type NeonOptions } from '../neon'
import { launchInstanceOf } from '../pipeline/instance'
import {
  releaseExclusions,
  releaseForRef,
  releaseRunActivated,
  releaseRunFailed,
  releaseRunStarted,
} from '../releases/lifecycle'
import { prepareLiveVersion } from '../releases/publish'
import { deployArtifactDigest } from './artifact-digest'
import { type BindingCheckResult, type CheckedWorkflow, checkBindings } from './binding-check'
import { issueMigratorUrl, revokeMigrator } from './migrator'
import {
  claimIntent,
  closeTicket,
  expirePending,
  getTenantTicket,
  isDeployed,
  linkTicket,
  markActivationStarted,
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
  /**
   * What the approvals engine runs with (P4): a production `start` with nothing to claim opens a
   * `deploy.production` approval through it. Absent, the ticket waits with no approval and expires.
   */
  approvals?: ApprovalDeps
  /**
   * Issue #12: where a side effect after the response goes (`waitUntil`) — production's
   * `activate` writing Live's Worker version into the release's GitHub notes. Absent, it is skipped.
   */
  defer?: Defer
}

/**
 * A deploy run moved something (a ticket, an environment's live version, its release): nudge the
 * app's views — `entity.changed { entity: 'release', appId }` for the releases card and the
 * pipeline strip, `{ entity: 'apps', id }` for the deploys list and the environments. Ids only;
 * every reader re-reads through its own authorized route. The router calls this after each
 * successful write (`routes/ci-deploy.ts`), so no transition below needs its own.
 */
export function nudgeDeployMoved(realtime: Realtime | undefined, caller: ResolvedCaller): void {
  const { tenantId } = caller
  const appId = caller.app.id
  nudge(
    realtime,
    realtimeEvent('entity.changed', tenantId, { entity: RELEASE_REALTIME_ENTITY, appId })
  )
  nudge(realtime, realtimeEvent('entity.changed', tenantId, { entity: 'apps', id: appId }))
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
    approvalId: ticket.approvalId ?? null,
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
  const environment = caller.environment.name
  // A run on `refs/tags/X.Y.Z` deploys the app's release X.Y.Z, when Launch cut one.
  const release = await releaseForRef(db, caller.tenantId, caller.app.id, run.ref)

  if (environment === 'production') {
    const intent = await claimIntent(db, scope, run, launchRunId, now)
    if (intent) {
      const claimed =
        release && intent.releaseId !== release.id
          ? ((await linkTicket(db, intent, { releaseId: release.id })) ?? intent)
          : intent
      if (release) await releaseRunStarted(db, release, 'production', claimed)
      await audit(ctx, claimed, 'deploy.started', {
        status: claimed.status,
        decisionSource: claimed.decisionSource,
        sha: run.sha,
        ref: run.ref,
        ...(release ? { release: release.tag } : {}),
      })
      return claimed
    }
  }

  const staging = environment === 'staging'
  const { ticket, created } = await openRunTicket(db, scope, run, {
    purpose: 'deploy',
    status: staging ? 'approved' : 'pending',
    decisionSource: staging ? 'auto' : null,
    decidedAt: staging ? now : null,
    expiresAt: staging ? null : new Date(now.getTime() + PENDING_APPROVAL_TTL_MS),
    launchRunId,
    releaseId: release?.id ?? null,
  })
  if (created) {
    if (release) await releaseRunStarted(db, release, environment, ticket)
    await audit(ctx, ticket, 'deploy.started', {
      status: ticket.status,
      decisionSource: ticket.decisionSource,
      sha: run.sha,
      ref: run.ref,
      ...(release ? { release: release.tag } : {}),
    })
  }
  // A job-originated production run (a Release published, or a dispatch made, by hand in GitHub)
  // waits on an approval. Checked on every `start`, not only the first, so a retried call heals a
  // ticket whose approval could not be opened the first time.
  if (!staging && ticket.status === 'pending' && !ticket.approvalId) {
    return openTicketApproval(ctx, ticket, release)
  }
  return ticket
}

/**
 * Open the `deploy.production` approval a waiting production ticket needs (plan §1.9): subject the
 * ticket, requested by `github:<actor>`, excluding the release's authors, expiring no later than
 * the ticket. Returns the ticket as it stands afterwards (a policy may auto-approve it).
 */
async function openTicketApproval(
  ctx: GatewayContext,
  ticket: DeployTicketRow,
  release: AppReleaseRow | null
): Promise<DeployTicketRow> {
  const { caller, db } = ctx
  if (!ctx.approvals) {
    ctx.logger?.warn(
      { ticketId: ticket.id },
      'deploy: no approvals engine in this context; the ticket waits unapproved'
    )
    return ticket
  }
  const [stagingEnv] = await db
    .select()
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, caller.tenantId),
        eq(appEnvironments.appId, caller.app.id),
        eq(appEnvironments.name, 'staging')
      )
    )
    .limit(1)
  const actor = ticket.actor ?? 'unknown'
  const opened = await openApproval(ctx.approvals, {
    tenantId: caller.tenantId,
    kind: 'deploy.production',
    subject: { type: 'deploy_ticket', id: ticket.id },
    appId: caller.app.id,
    requester: { label: githubRequesterLabel(actor) },
    reason: `A production deploy of ${ticket.ref ?? 'a build'} started in GitHub by ${actor}`,
    context: {
      kind: 'deploy.production',
      environment: 'production',
      version: release?.version ?? null,
      tag: release?.tag ?? null,
      sha: ticket.sha,
      ref: ticket.ref,
      compareUrl: null,
      prs: release?.prs.map(p => ({ ...p, checks: null })) ?? [],
      stagingHealth: stagingEnv?.healthStatus ?? null,
      stagingVersion: stagingEnv?.healthVersion ?? stagingEnv?.lastDeployVersion ?? null,
      runUrl:
        ticket.repository && ticket.runId
          ? `https://github.com/${ticket.repository}/actions/runs/${ticket.runId}`
          : null,
      actor,
    },
    excludedUserIds: release ? await releaseExclusions(db, release) : [],
    expiresNoLaterThan: ticket.expiresAt,
    actor: ctx.actor,
  })
  await linkTicket(db, ticket, { approvalId: opened.request.id })
  return (await getTenantTicket(db, ticket.tenantId, ticket.id)) ?? ticket
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

/**
 * What `deploy_tickets.bindings` keeps of a checked build: names and ids, never a var's value.
 * P5 adds two facts about the upload itself (plan §1.5, §1.6): `shadowedVars` — the toml vars a
 * live grant supplies, dropped from the upload — and `uploadedAt`, when the upload began (the
 * moment `keep_bindings` copied the Worker's secrets), which `activate` compares with the grants'
 * pushes.
 */
export interface TicketBindings {
  bindings: { type: string; name: string; target?: string }[]
  crons: string[]
  workflows: CheckedWorkflow[]
  migrationTag: string | null
  shadowedVars: string[]
  /** ISO timestamp; null on a ticket uploaded before P5. */
  uploadedAt: string | null
}

function ticketBindings(
  check: BindingCheckResult,
  upload: Pick<TicketBindings, 'shadowedVars' | 'uploadedAt'> = {
    shadowedVars: [],
    uploadedAt: null,
  }
): TicketBindings {
  const targetKeys = ['namespace_id', 'queue_name', 'bucket_name', 'workflow_name', 'class_name']
  return {
    bindings: check.bindings.map(b => {
      const key = targetKeys.find(k => typeof b[k] === 'string')
      return { type: b.type, name: b.name, ...(key ? { target: b[key] as string } : {}) }
    }),
    crons: check.crons,
    workflows: check.workflows,
    migrationTag: check.migrationTag,
    shadowedVars: upload.shadowedVars,
    uploadedAt: upload.uploadedAt,
  }
}

function storedBindings(ticket: DeployTicketRow): TicketBindings {
  const raw = (ticket.bindings ?? {}) as Partial<TicketBindings>
  return {
    bindings: raw.bindings ?? [],
    crons: raw.crons ?? [],
    workflows: raw.workflows ?? [],
    migrationTag: raw.migrationTag ?? null,
    shadowedVars: raw.shadowedVars ?? [],
    uploadedAt: raw.uploadedAt ?? null,
  }
}

/**
 * Launch P5 (plan §1.5): drop the toml's `plain_text` / `json` bindings whose name a live grant of
 * this app and environment supplies. The grant is pushed as a Worker secret and kept by
 * `keep_bindings`; a var of the same name beside it is Cloudflare's 10053 "Binding name already in
 * use" — and the grant is what the app should read. The app's repo needs no change.
 */
async function withoutShadowedVars(
  ctx: GatewayContext,
  ticket: DeployTicketRow,
  check: BindingCheckResult
): Promise<{ check: BindingCheckResult; shadowedVars: string[] }> {
  const granted = new Set(
    await grantedKeys(ctx.db, ticket.tenantId, ticket.appId, ctx.caller.environment.name)
  )
  if (granted.size === 0) return { check, shadowedVars: [] }
  const shadows = (b: BindingCheckResult['bindings'][number]) =>
    (b.type === 'plain_text' || b.type === 'json') && granted.has(b.name)
  const shadowedVars = check.bindings.filter(shadows).map(b => b.name)
  if (shadowedVars.length === 0) return { check, shadowedVars }
  return { check: { ...check, bindings: check.bindings.filter(b => !shadows(b)) }, shadowedVars }
}

/** Fail an in-flight ticket and audit it; the caller throws the response. */
async function failTicket(
  ctx: GatewayContext,
  ticket: DeployTicketRow,
  from: 'approved' | 'uploaded',
  error: string
): Promise<void> {
  const failed = await transitionTicket(ctx.db, ticket, [from], 'failed', { error })
  if (failed) {
    await audit(ctx, failed, 'deploy.failed', { from, error })
    await releaseRunFailed(ctx.db, failed, ctx.caller.environment.name, error)
  }
}

/**
 * Issue #12: what `upload` learnt about the artifact. `stagingDigest` is set on a production
 * upload only — the digest of the latest activated staging deploy of the same version, or null
 * when there is none (or it predates issue #12).
 */
interface ArtifactCheck {
  digest: string
  stagingDigest?: string | null
  mismatch: boolean
}

/** The digest of the newest activated staging deploy of `version` on this app, if recorded. */
async function stagingDigestOf(
  ctx: GatewayContext,
  ticket: DeployTicketRow,
  version: string
): Promise<string | null> {
  const [row] = await ctx.db
    .select({ digest: deployTickets.artifactDigest })
    .from(deployTickets)
    .innerJoin(appEnvironments, eq(appEnvironments.id, deployTickets.environmentId))
    .where(
      and(
        eq(deployTickets.tenantId, ticket.tenantId),
        eq(deployTickets.appId, ticket.appId),
        eq(appEnvironments.tenantId, ticket.tenantId),
        eq(appEnvironments.name, 'staging'),
        eq(deployTickets.version, version),
        isNotNull(deployTickets.activatedAt),
        isNotNull(deployTickets.artifactDigest)
      )
    )
    .orderBy(desc(deployTickets.activatedAt))
    .limit(1)
  return row?.digest ?? null
}

/**
 * Issue #12 (build once): Launch's own digest of the upload (`deployArtifactDigest`), checked
 * against what the job claims and — on production — against the staging deploy of the same
 * version. Before any vendor call, so a refusal uploads nothing.
 *
 * - A `digest` the job sent that is not Launch's: 400 `deploy_digest_invalid`, the ticket failed.
 * - Production, staging recorded a digest for this version and this one differs: a job that says
 *   it deployed the staging bundle (`source: 'bundle'`) is refused (409 `deploy_digest_mismatch`,
 *   the ticket failed); any other upload — a rebuild (`source: 'build'`, the fallback for a tag with
 *   no release asset) or a kit that says nothing — is warned about and recorded
 *   (`deploy.uploaded`'s `digestMismatch`, and the release view's `artifact.matches: false`).
 */
async function checkArtifact(
  ctx: GatewayContext,
  ticket: DeployTicketRow,
  body: DeployUpload,
  version: string
): Promise<ArtifactCheck> {
  const digest = await deployArtifactDigest(body)
  if (body.digest && body.digest !== digest) {
    const error = 'the upload does not match the digest the job sent'
    await failTicket(ctx, ticket, 'approved', error)
    throw new DeployerProtocolError(400, error, 'deploy_digest_invalid', {
      digest,
      claimed: body.digest,
    })
  }
  if (ctx.caller.environment.name !== 'production') return { digest, mismatch: false }

  const stagingDigest = await stagingDigestOf(ctx, ticket, version)
  const mismatch = stagingDigest !== null && stagingDigest !== digest
  if (mismatch && body.source === 'bundle') {
    const error = `the upload is not the build staging ran for ${version}`
    await failTicket(ctx, ticket, 'approved', error)
    throw new DeployerProtocolError(409, error, 'deploy_digest_mismatch', {
      digest,
      stagingDigest,
    })
  }
  if (mismatch) {
    ctx.logger?.warn(
      { ticketId: ticket.id, version, digest, stagingDigest, source: body.source ?? null },
      'deploy: the production upload is not the build staging ran'
    )
  }
  return { digest, stagingDigest, mismatch }
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
  // App page P3: a dispatch on a release tag (a rollback) labels its build `X.Y.Z-<sha7>`; it IS
  // release X.Y.Z, and the ticket, the environment and the Worker's RELEASE_VERSION say so.
  const version = taggedRunVersion(body.version, ticket)

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
      version,
      error,
    })
    if (failed) {
      await audit(ctx, failed, 'deploy.refused', { refused: check.refused })
      await releaseRunFailed(ctx.db, failed, environment.name, error)
    }
    throw new DeployerProtocolError(403, error, 'deploy_bindings_refused', {
      refused: check.refused,
    })
  }

  const artifact = await checkArtifact(ctx, ticket, body, version)

  const { check: uploading, shadowedVars } = await withoutShadowedVars(ctx, ticket, check)
  const vendors = await ctx.vendors()
  const workerName = environment.workerName ?? ''
  // Before the upload call: a push landing while it runs may or may not be copied, and a repair
  // push at `activate` for one that was is harmless.
  const uploadedAt = (ctx.now?.() ?? new Date()).toISOString()
  let versionId: string
  try {
    versionId = await uploadVersion(vendors.cf, vendors.accountId, {
      workerName,
      config,
      check: uploading,
      upload: { ...body, version },
      ticketId: ticket.id,
    })
  } catch (err) {
    if (isApiError(err)) throw err
    const error = `The upload to Cloudflare failed: ${vendorMessage(err)}`
    await failTicket(ctx, ticket, 'approved', error)
    throw new ApiError(502, error, 'deploy_upload_failed')
  }

  const uploaded = await transitionTicket(ctx.db, ticket, ['approved'], 'uploaded', {
    version,
    cfVersionId: versionId,
    artifactDigest: artifact.digest,
    bindings: ticketBindings(uploading, { shadowedVars, uploadedAt }) as unknown as Record<
      string,
      unknown
    >,
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
    version,
    versionId,
    bindings: ticketBindings(uploading).bindings.map(b => `${b.type}:${b.name}`),
    ...(shadowedVars.length > 0 ? { shadowedVars } : {}),
    digest: artifact.digest,
    ...(body.source ? { source: body.source } : {}),
    ...(artifact.stagingDigest !== undefined ? { stagingDigest: artifact.stagingDigest } : {}),
    ...(artifact.mismatch ? { digestMismatch: true } : {}),
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

/**
 * Launch P5 (plan §1.6): the version just activated carries the grant secrets as of its UPLOAD
 * (`keep_bindings`). A grant pushed after that — a rotation, a first push, a repair — was undone by
 * activating, so each one gets a `repair` push of its resource's active version. Best-effort: the
 * deploy is live whatever happens here, so a push that cannot start (a rotation's push still
 * running, 409 `push_in_progress`; no approvals context) is logged and left on the grant's
 * `push_error` for its owners to re-push. Returns what it started, for the audit row.
 */
async function repairNewerPushes(
  ctx: GatewayContext,
  ticket: DeployTicketRow,
  uploadedAt: string | null
): Promise<{ grantId: string; pushId: string | null }[]> {
  if (!uploadedAt) return []
  const environment = ctx.caller.environment.name
  const grants = await pushedSince(
    ctx.db,
    ticket.tenantId,
    ticket.appId,
    environment,
    new Date(uploadedAt)
  )
  const out: { grantId: string; pushId: string | null }[] = []
  for (const grant of grants) {
    let pushId: string | null = null
    try {
      if (!ctx.approvals) throw new Error('no grant push context')
      const version = await activeVersion(ctx.db, grant.tenantId, grant.resourceId, environment)
      if (!version) throw new Error(`no values for ${environment}`)
      pushId = (
        await startPush(ctx.approvals, {
          tenantId: grant.tenantId,
          resourceId: grant.resourceId,
          environment,
          reason: 'repair',
          grantId: grant.id,
          versionId: version.id,
        })
      ).pushId
    } catch (err) {
      const error = `Deploy ${ticket.version ?? ticket.id} replaced a newer push; re-push this grant (${vendorMessage(err)})`
      ctx.logger?.warn(
        { ticketId: ticket.id, grantId: grant.id, err: vendorMessage(err) },
        'deploy: could not start the grant repair push'
      )
      await ctx.db
        .update(appGrants)
        .set({ pushError: error.slice(0, 1000), updatedAt: ctx.now?.() ?? new Date() })
        .where(and(eq(appGrants.tenantId, grant.tenantId), eq(appGrants.id, grant.id)))
    }
    out.push({ grantId: grant.id, pushId })
  }
  return out
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
  // The overview's "activating" (deploy/progress.ts): stamped before the first vendor call, so a
  // hung or failed activation shows where it stopped.
  await markActivationStarted(ctx.db, ticket, ctx.now?.() ?? new Date())

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

  // `activated_at` is set HERE and nowhere else: it is what "deployed" means (`isDeployed`).
  const now = ctx.now?.() ?? new Date()
  const active = await transitionTicket(ctx.db, ticket, ['uploaded'], 'active', {
    activatedAt: now,
  })
  if (!active) wrongState(ticket, 'uploaded')
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
  const grantRepairs = await repairNewerPushes(ctx, active, stored.uploadedAt)
  await audit(ctx, active, 'deploy.activated', {
    version: active.version,
    versionId: active.cfVersionId,
    workflows: stored.workflows.map(w => w.name),
    crons: stored.crons,
    ...(grantRepairs.length > 0 ? { grantRepairs } : {}),
  })
  if (active.releaseId) {
    await releaseRunActivated(ctx.db, {
      releaseId: active.releaseId,
      tenantId: active.tenantId,
      environment: environment.name,
      ticket: active,
      // Read when the caller was resolved, so before the update above: what it replaced.
      previousVersion: environment.lastDeployVersion,
      actor: ctx.actor,
    })
    // Issue #12: the release's GitHub notes were written at publish, before production ran; its
    // `Live Worker version` line is filled in now, after the response (best-effort).
    const approvals = ctx.approvals
    if (environment.name === 'production' && active.cfVersionId && approvals && ctx.defer) {
      const input = {
        tenantId: active.tenantId,
        releaseId: active.releaseId,
        versionId: active.cfVersionId,
      }
      const write = await prepareLiveVersion(approvals, input)
      if (write) ctx.defer(write)
    }
  }
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
    activated: isDeployed(closed),
    ...(closed.error ? { error: closed.error } : {}),
  })
  if (closed.launchRunId && ctx.launchWorkflow) {
    try {
      const instance = await ctx.launchWorkflow.get(
        launchInstanceOf(ctx.caller.app, closed.launchRunId)
      )
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
