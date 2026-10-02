/**
 * What the app page SAYS — pure, so the layout, the Overview, the Releases tab and the release
 * page read one app the same way, and every decision is unit-tested
 * (`tests/config/app-page-model.test.ts`) rather than reasoned about in a component.
 *
 * - paths: `appPath`, `appTabPath`, `settingsPath`, `releasePath` — the page's sub-routes;
 * - `appStage` — whether the first build (or its create approval) takes the Overview over;
 * - environments: `ENV_LABEL` (Staging / Live — "preview" is a session's), `notDeployedYet`,
 *   `liveVersion`, `resourceRows`;
 * - `stagingInFlight` / `liveInFlight` — the one line under an environment row while a release is
 *   on its way to it (the big steppers are gone);
 * - `needsYou` — the band that shows only when something needs a person: a failed release or
 *   deploy, a pending approval, a missing config grant;
 * - deploy tickets: `ticketBadge`, `ticketVersion`, `deployRows`, `pendingProduction`, `ticketRunUrl`;
 * - `releaseRows` — the Releases tab's one row per version, merging releases and deploy tickets.
 *
 * The server stays the judge of every action; nothing here decides who MAY do something beyond
 * what the detail (`viewerCanDeploy`) and the config view (`canRequest`) already said.
 */
import { approvalPath } from '@launch/shared/launch-approvals'
import {
  APP_ENVIRONMENT_NAMES,
  type AppDetail,
  type AppEnvironment,
  type AppEnvironmentName,
  type AppEnvironmentResources,
  type DeployProgress,
  HEALTH_NOT_DEPLOYED_ERROR,
} from '@launch/shared/launch-apps'
import type { AppConfigView } from '@launch/shared/launch-grants'
import type { DeployTicket, PipelineView } from '@launch/shared/launch-pipeline'
import type { Release } from '@launch/shared/launch-releases'
import { missingEnvironments } from '../components/configModel'
import { DEPLOY_PHASE_LABELS } from '../components/deployProgressModel'
import { type PromotionState, peopleSentence, v } from '../components/promotionModel'
import { failedStageTitle } from '../components/releaseModel'

// ---- Paths ---------------------------------------------------------------------------------------

export const APP_TABS = ['overview', 'sessions', 'releases', 'activity', 'settings'] as const
export type AppTab = (typeof APP_TABS)[number]

export const SETTINGS_SECTIONS = ['general', 'config', 'access', 'shipping', 'danger'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export function isSettingsSection(value: string | undefined): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value ?? '')
}

/** `/apps/:slug` — the Overview. */
export function appPath(slug: string): string {
  return `/apps/${encodeURIComponent(slug)}`
}

export function appTabPath(slug: string, tab: AppTab): string {
  return tab === 'overview' ? appPath(slug) : `${appPath(slug)}/${tab}`
}

export function settingsPath(slug: string, section: SettingsSection = 'general'): string {
  return `${appPath(slug)}/settings/${section}`
}

export function releasePath(slug: string, version: string): string {
  return `${appPath(slug)}/releases/${encodeURIComponent(version)}`
}

// ---- Stage ---------------------------------------------------------------------------------------

export interface AppStage {
  /** A created app whose first build has not succeeded and gone live yet. */
  launching: boolean
  /** Launching, or a new app waiting on its create approval: the Overview is the takeover. */
  holding: boolean
}

/**
 * Whether the first build takes the Overview over. The launch panel stays until the run succeeds
 * and the app is live: while the row says a run is owed (`appBusy`), or while the latest create run
 * has not succeeded. Pure.
 */
export function appStage(
  app: Pick<AppDetail, 'source' | 'status'>,
  input: {
    waitingForApproval: boolean
    appBusy: boolean
    createStatus: PipelineView['status'] | undefined
  }
): AppStage {
  const launching =
    app.source === 'created' &&
    app.status !== 'live' &&
    app.status !== 'archived' &&
    !input.waitingForApproval &&
    (input.appBusy || (input.createStatus !== undefined && input.createStatus !== 'succeeded'))
  return { launching, holding: launching || input.waitingForApproval }
}

// ---- Environments --------------------------------------------------------------------------------

/** The UI's names: Staging and Live. GitHub and wrangler keep `staging` / `production`. */
export const ENV_LABEL: Record<AppEnvironmentName, string> = {
  staging: 'Staging',
  production: 'Live',
}

/**
 * Nothing has ever been deployed here: the last probe met Launch's placeholder Worker (the server
 * records `HEALTH_NOT_DEPLOYED_ERROR`), so it is not an outage. Pure.
 */
export function notDeployedYet(env: Pick<AppEnvironment, 'healthStatus' | 'healthError'>): boolean {
  return env.healthStatus === 'unknown' && env.healthError === HEALTH_NOT_DEPLOYED_ERROR
}

/** The version Live runs (the header's "v1.4.2 live"), or null before its first deploy. Pure. */
export function liveVersion(app: Pick<AppDetail, 'environments'>): string | null {
  const live = app.environments.find(env => env.name === 'production')
  if (!live || notDeployedYet(live)) return null
  return live.lastDeployVersion ?? null
}

interface ResourceRow {
  kind: string
  binding: string
  value: string
}

/** Flatten the jsonb into rows a table can show. Pure. */
export function resourceRows(resources: AppEnvironmentResources): ResourceRow[] {
  return [
    ...(resources.kv ?? []).map(r => ({ kind: 'KV', binding: r.binding, value: r.id })),
    ...(resources.queues ?? []).map(r => ({ kind: 'Queue', binding: r.binding, value: r.queue })),
    ...(resources.r2 ?? []).map(r => ({ kind: 'R2', binding: r.binding, value: r.bucketName })),
    ...(resources.durableObjects ?? []).map(r => ({
      kind: 'Durable Object',
      binding: r.binding,
      value: r.className,
    })),
    ...(resources.workflows ?? []).map(r => ({
      kind: 'Workflow',
      binding: r.binding,
      value: r.name,
    })),
    ...(resources.hyperdrive ?? []).map(r => ({
      kind: 'Hyperdrive',
      binding: r.binding,
      value: r.id,
    })),
  ]
}

// ---- The in-flight line ------------------------------------------------------------------------

/** The line under an environment row while a release is on its way to it. */
export type InFlight =
  | {
      kind: 'moving'
      /** `v1.4.2`, or the short commit of a build that is not a release. */
      version: string | null
      /** "uploading", "GitHub is checking it", "starting". */
      what: string
      since: Date | null
      runUrl: string | null
      /** The release this run deploys, when Cancel can stop it (app page P2's ⋯ Cancel). */
      release?: Release
    }
  | {
      kind: 'awaiting'
      version: string | null
      /** "Ana and Ben", or null when the server named nobody. */
      approvers: string | null
      approvalId: string | null
    }

/** The candidate release, when its run in `statuses` is the one this line shows. Pure. */
function cancellable(
  state: PromotionState | null,
  statuses: readonly Release['status'][],
  version: string | null | undefined
): { release?: Release } {
  const release = state && 'release' in state ? state.release : null
  if (!release || !statuses.includes(release.status)) return {}
  if (version && version !== release.version) return {}
  return { release }
}

function deployVersion(deploy: Pick<DeployProgress, 'version' | 'sha'>): string | null {
  if (deploy.version) return v(deploy.version)
  return deploy.sha ? deploy.sha.slice(0, 7) : null
}

/**
 * Staging's line: its latest deploy while it runs (the phase it is in), else the candidate
 * release while GitHub checks its tag (`progress: 'moving'`). A failure is not a line — it is a
 * Needs-you item. Pure.
 */
export function stagingInFlight(
  deploy: DeployProgress | undefined,
  state: PromotionState | null
): InFlight | null {
  if (deploy?.inProgress && deploy.phase !== 'awaiting_approval') {
    return {
      kind: 'moving',
      version: deployVersion(deploy),
      what: DEPLOY_PHASE_LABELS[deploy.phase],
      since: deploy.startedAt,
      runUrl: deploy.runUrl,
      ...cancellable(state, ['tagged', 'staging'], deploy.version),
    }
  }
  if (state?.kind === 'blocked' && state.progress === 'moving' && state.release) {
    return {
      kind: 'moving',
      version: v(state.release.version),
      what: state.release.status === 'tagged' ? 'GitHub is checking it' : 'deploying to staging',
      since: state.release.createdAt,
      runUrl: state.run?.url ?? null,
      ...cancellable(state, ['tagged', 'staging'], null),
    }
  }
  return null
}

/**
 * Live's line: who a shipped release waits on, then its deploy as it runs. A production deploy
 * that waits on a person without the release flow (the default branch, deployed directly) waits
 * on its approval the same way. Pure.
 */
export function liveInFlight(
  deploy: DeployProgress | undefined,
  state: PromotionState | null
): InFlight | null {
  if (state?.kind === 'awaiting') {
    const approvers = state.approval?.approvers ?? []
    return {
      kind: 'awaiting',
      version: v(state.release.version),
      approvers: approvers.length ? peopleSentence(approvers) : null,
      approvalId: state.approval?.id ?? state.release.approvalId,
    }
  }
  if (deploy?.inProgress) {
    if (deploy.phase === 'awaiting_approval') {
      return {
        kind: 'awaiting',
        version: deployVersion(deploy),
        approvers: null,
        approvalId: deploy.approvalId,
      }
    }
    return {
      kind: 'moving',
      version: deployVersion(deploy),
      what: DEPLOY_PHASE_LABELS[deploy.phase],
      since: deploy.startedAt,
      runUrl: deploy.runUrl,
      ...cancellable(state, ['promoting'], deploy.version),
    }
  }
  if (state?.kind === 'deploying') {
    return {
      kind: 'moving',
      version: v(state.release.version),
      what: 'starting',
      since: state.release.updatedAt,
      runUrl: null,
    }
  }
  return null
}

// ---- Deploy tickets ------------------------------------------------------------------------------

/** Ticket status → the `.status-badge` vocabulary in `index.css`, and the word shown. */
const TICKET_BADGE: Record<DeployTicket['status'], { tone: string; label: string }> = {
  pending: { tone: 'awaiting-review', label: 'awaiting approval' },
  approved: { tone: 'queued', label: 'approved' },
  rejected: { tone: 'rejected', label: 'rejected' },
  uploaded: { tone: 'running', label: 'deploying' },
  active: { tone: 'active', label: 'live' },
  finished: { tone: 'completed', label: 'finished' },
  failed: { tone: 'failed', label: 'failed' },
}

/**
 * The badge for a ticket. `finished` alone is not "deployed": a ticket `finish` closed without an
 * activation (the job died after upload) went nowhere, and reads as such. Pure.
 */
export function ticketBadge(ticket: Pick<DeployTicket, 'status' | 'activatedAt'>): {
  tone: string
  label: string
} {
  if (ticket.status === 'finished' && !ticket.activatedAt) {
    return { tone: 'failed', label: 'not activated' }
  }
  return TICKET_BADGE[ticket.status]
}

/** Newest first, deploys only (the scaffold job's ticket is the launch's business). Pure. */
export function deployRows(items: readonly DeployTicket[]): DeployTicket[] {
  return items.filter(t => t.purpose === 'deploy')
}

/** The production ticket waiting on a person, if any — the oldest, since it expires first. Pure. */
export function pendingProduction(items: readonly DeployTicket[]): DeployTicket | null {
  const pending = items.filter(t => t.environment === 'production' && t.status === 'pending')
  return pending.at(-1) ?? null
}

/** A short, honest name for what was deployed: the version, else the commit. Pure. */
export function ticketVersion(ticket: Pick<DeployTicket, 'version' | 'sha'>): string {
  return ticket.version ?? (ticket.sha ? ticket.sha.slice(0, 7) : '—')
}

export function ticketRunUrl(ticket: Pick<DeployTicket, 'repository' | 'runId'>): string | null {
  return ticket.repository && ticket.runId
    ? `https://github.com/${ticket.repository}/actions/runs/${ticket.runId}`
    : null
}

// ---- Needs you -----------------------------------------------------------------------------------

export type NeedsYouItem =
  | {
      kind: 'release-failed'
      key: string
      title: string
      detail: string | null
      version: string
      runUrl: string | null
      canAct: boolean
      /** The stuck release: its `failedStage` picks the Retry (app page P2). */
      release: Release
    }
  | {
      kind: 'deploy-failed'
      key: string
      title: string
      detail: string | null
      version: string | null
      runUrl: string | null
      canAct: boolean
    }
  | { kind: 'approval'; key: string; title: string; href: string; canAct: boolean }
  /** A pending production ticket from before the approvals engine: decided in place. */
  | { kind: 'deploy-decision'; key: string; ticket: DeployTicket; canAct: boolean }
  | { kind: 'grant'; key: string; title: string; canAct: boolean }

export interface NeedsYouInput {
  state: PromotionState | null
  /** Each environment's newest deploy (`GET /deploys/latest`). */
  latest: readonly DeployProgress[]
  tickets: readonly DeployTicket[]
  config: Pick<AppConfigView, 'matched' | 'canRequest'> | null
  viewerId: string | null
  /** The app's owners and admins: they ship, retry and decide production deploys. */
  viewerCanDeploy: boolean
}

/**
 * Everything on the app that needs a person, in the order to deal with it: what broke, what is
 * waiting on a decision, what config is missing. `canAct` says whether THIS reader can do
 * something about the item — a reader who can act on none sees the same list read-only, under
 * "Attention" instead of "Needs you". Pure.
 */
export function needsYou(input: NeedsYouInput): NeedsYouItem[] {
  const items: NeedsYouItem[] = []
  const { state } = input

  // A release that will not get further by itself: one that failed on its way to staging, or any
  // candidate the server says is stuck (`failedStage` — a failed Live deploy, an environment down
  // on it, a turned-down approval, a tag GitHub never ran).
  let failedVersion: string | null = null
  const candidate = state && 'release' in state ? state.release : null
  if (state?.kind === 'blocked' && state.progress === 'failed' && state.release) {
    failedVersion = state.release.version
    items.push({
      kind: 'release-failed',
      key: `release:${state.release.id}`,
      title: /[.…!?]$/.test(state.reason) ? state.reason.slice(0, -1) : state.reason,
      detail: state.release.error,
      version: state.release.version,
      runUrl: state.run?.url ?? null,
      canAct: input.viewerCanDeploy,
      release: state.release,
    })
  } else if (candidate?.failedStage) {
    failedVersion = candidate.version
    items.push({
      kind: 'release-failed',
      key: `release:${candidate.id}`,
      title: failedStageTitle(candidate) ?? `${v(candidate.version)} is stuck`,
      detail: candidate.error,
      version: candidate.version,
      runUrl: null,
      canAct: input.viewerCanDeploy,
      release: candidate,
    })
  }

  // An environment whose newest deploy failed — unless it is the release already listed.
  for (const deploy of input.latest) {
    if (deploy.phase !== 'failed') continue
    if (failedVersion && deploy.version === failedVersion) continue
    const what = deployVersion(deploy)
    items.push({
      kind: 'deploy-failed',
      key: `deploy:${deploy.ticketId}`,
      title: `${ENV_LABEL[deploy.environment]} deploy${what ? ` of ${what}` : ''} failed`,
      detail: deploy.error,
      version: deploy.version,
      runUrl: deploy.runUrl,
      canAct: input.viewerCanDeploy,
    })
  }

  // A shipped release waiting on THIS reader's approval.
  const approval = state?.kind === 'awaiting' ? state.approval : null
  if (
    state?.kind === 'awaiting' &&
    approval &&
    input.viewerId &&
    approval.approvers.some(person => person.id === input.viewerId)
  ) {
    items.push({
      kind: 'approval',
      key: `approval:${approval.id}`,
      title: `${v(state.release.version)} is waiting for your approval to go live`,
      href: approvalPath(approval.id),
      canAct: true,
    })
  }

  // A production deploy of the default branch waiting on a decision.
  const pending = pendingProduction(deployRows(input.tickets))
  if (pending && pending.approvalId !== approval?.id) {
    items.push(
      pending.approvalId
        ? {
            kind: 'approval',
            key: `approval:${pending.approvalId}`,
            title: `Live deploy of ${ticketVersion(pending)} is waiting for approval`,
            href: approvalPath(pending.approvalId),
            canAct: input.viewerCanDeploy,
          }
        : {
            kind: 'deploy-decision',
            key: `ticket:${pending.id}`,
            ticket: pending,
            canAct: input.viewerCanDeploy,
          }
    )
  }

  // Shared config the app declares and does not hold.
  for (const match of input.config?.matched ?? []) {
    if (match.resource.archived) continue
    const envs = missingEnvironments(match)
    if (envs.length === 0) continue
    const where =
      envs.length === APP_ENVIRONMENT_NAMES.length
        ? 'anywhere'
        : `on ${ENV_LABEL[envs[0] as AppEnvironmentName]}`
    items.push({
      kind: 'grant',
      key: `grant:${match.resource.id}`,
      title: `${match.resource.displayName} is not held ${where}`,
      canAct: input.config?.canRequest ?? false,
    })
  }
  return items
}

// ---- Releases tab --------------------------------------------------------------------------------

/** One version on the Releases tab: the release (when there is one) and its newest deploys. */
export interface ReleaseRow {
  key: string
  /** The release version, a ticket's version, or null for a build that has neither. */
  version: string | null
  /** What the row is called: `v1.4.2`, or the short commit. */
  label: string
  release: Release | null
  staging: DeployTicket | null
  production: DeployTicket | null
  /** Newest first by this. */
  at: Date
}

/**
 * One row per version (decision 9): every release, with the newest staging and production deploy
 * ticket that carried it — matched by `releaseId`, else by version — and deploy tickets that belong
 * to no release in rows of their own (by version, else one per commit). Newest first. Pure.
 */
export function releaseRows(
  releases: readonly Release[],
  tickets: readonly DeployTicket[]
): ReleaseRow[] {
  const rows = new Map<string, ReleaseRow>()
  const byVersion = new Map<string, string>()
  for (const release of releases) {
    rows.set(release.id, {
      key: release.id,
      version: release.version,
      label: v(release.version),
      release,
      staging: null,
      production: null,
      at: release.createdAt,
    })
    byVersion.set(release.version, release.id)
  }
  // Tickets arrive newest first, so the first one seen per environment is the newest.
  for (const ticket of deployRows(tickets)) {
    const key =
      (ticket.releaseId && rows.has(ticket.releaseId) ? ticket.releaseId : null) ??
      (ticket.version ? byVersion.get(ticket.version) : undefined) ??
      (ticket.version ? `version:${ticket.version}` : `ticket:${ticket.id}`)
    let row = rows.get(key)
    if (!row) {
      row = {
        key,
        version: ticket.version,
        label: ticket.version ? v(ticket.version) : ticketVersion(ticket),
        release: null,
        staging: null,
        production: null,
        at: ticket.createdAt,
      }
      rows.set(key, row)
      if (ticket.version) byVersion.set(ticket.version, key)
    }
    if (ticket.environment === 'staging') row.staging ??= ticket
    else row.production ??= ticket
    if (!row.release && ticket.createdAt > row.at) row.at = ticket.createdAt
  }
  return [...rows.values()].sort((a, b) => b.at.getTime() - a.at.getTime())
}

/** What one environment cell of a release row says — one status, never two. */
export function releaseCell(
  row: Pick<ReleaseRow, 'release' | 'staging' | 'production'>,
  env: AppEnvironmentName
): { tone: string; label: string } | null {
  const status = row.release?.status
  if (env === 'staging') {
    if (row.staging) return ticketBadge(row.staging)
    if (status === 'tagged') return { tone: 'queued', label: 'tagged' }
    if (status === 'staging') return { tone: 'running', label: 'deploying' }
    if (status === 'failed') return { tone: 'failed', label: 'failed' }
    return null
  }
  // Live: the release's own state first where the ticket cannot say it (awaiting, rejected).
  if (status === 'awaiting_approval') return { tone: 'awaiting-review', label: 'awaiting approval' }
  if (status === 'rejected' && !row.production) return { tone: 'rejected', label: 'rejected' }
  if (row.production) return ticketBadge(row.production)
  if (status === 'promoting') return { tone: 'running', label: 'deploying' }
  if (status === 'production_active') return { tone: 'active', label: 'live' }
  return null
}
