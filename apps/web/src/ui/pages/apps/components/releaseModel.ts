/**
 * What the releases card and a release's chain SAY — pure, so the wording is unit-tested
 * (`tests/config/release-model.test.ts`) and the card, the timeline and the approval page read one
 * release the same way.
 *
 * - `RELEASE_BADGE` — the lifecycle (`tagged → staging → staging_active → awaiting_approval →
 *   promoting → production_active`, with `rejected` / `failed`) in the `.status-badge` vocabulary;
 * - `nextVersion(latest, bump)` — the version the Release button would cut, when a previous release
 *   is known (the server reads `package.json`; this is only the preview);
 * - `chainEntry(event)` — one audit row of the chain as a sentence, a tone and the environment it
 *   touched. Unknown actions fall back to the action itself, never to nothing.
 */
import type { AuditEvent } from '@launch/shared/launch-audit'
import {
  bumpVersion,
  isPromotableRelease,
  parseReleaseVersion,
  type Release,
  type ReleaseBump,
  type ReleaseStatus,
} from '@launch/shared/launch-releases'

export const RELEASE_BADGE: Record<ReleaseStatus, { tone: string; label: string }> = {
  tagged: { tone: 'queued', label: 'tagged' },
  staging: { tone: 'running', label: 'deploying to staging' },
  staging_active: { tone: 'active', label: 'on staging' },
  awaiting_approval: { tone: 'awaiting-review', label: 'awaiting approval' },
  promoting: { tone: 'running', label: 'deploying to production' },
  production_active: { tone: 'completed', label: 'in production' },
  rejected: { tone: 'rejected', label: 'rejected' },
  failed: { tone: 'failed', label: 'failed' },
}

/** The version the next release would get, or null when there is nothing to bump from. */
export function nextVersion(latest: string | null | undefined, bump: ReleaseBump): string | null {
  if (!latest || !parseReleaseVersion(latest)) return null
  return bumpVersion(latest, bump)
}

/** Whether Promote is offered: the statuses the route accepts (live on staging, or rejected). */
export function canPromote(release: Pick<Release, 'status'>): boolean {
  return isPromotableRelease(release.status)
}

/** The newest release (the list is newest first) — what "latest" means for the bump preview. */
export function latestRelease(items: readonly Release[]): Release | null {
  return items[0] ?? null
}

export type ChainTone = 'neutral' | 'success' | 'warning' | 'error' | 'primary'

export interface ChainEntry {
  label: string
  tone: ChainTone
  /** `staging` / `production` for a deploy row, from the audit summary. */
  environment: string | null
  /** A PR number, a version — whatever the row names beyond its action. */
  detail: string | null
}

function field(event: Pick<AuditEvent, 'summary'>, key: string): unknown {
  return event.summary.after?.[key] ?? event.summary.before?.[key]
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value
    : typeof value === 'number'
      ? String(value)
      : null
}

const LABELS: Record<string, { label: string; tone: ChainTone }> = {
  'session.created': { label: 'Coding session started', tone: 'neutral' },
  'session.shipped': { label: 'Session shipped a pull request', tone: 'neutral' },
  'pr.merged': { label: 'Pull request merged', tone: 'success' },
  'release.created': { label: 'Release tagged', tone: 'primary' },
  'release.staging_active': { label: 'Live on staging', tone: 'success' },
  'release.promoted': { label: 'Promoted — production approval requested', tone: 'primary' },
  'release.production': { label: 'Live in production', tone: 'success' },
  'release.rejected': { label: 'Release rejected', tone: 'error' },
  'release.failed': { label: 'Release failed', tone: 'error' },
  'deploy.started': { label: 'Deploy started', tone: 'neutral' },
  'deploy.uploaded': { label: 'Build uploaded', tone: 'neutral' },
  'deploy.activated': { label: 'Deploy activated', tone: 'success' },
  'deploy.finished': { label: 'Deploy finished', tone: 'neutral' },
  'deploy.failed': { label: 'Deploy failed', tone: 'error' },
  'deploy.refused': { label: 'Deploy refused', tone: 'error' },
  'deploy.production.approved': { label: 'Production deploy approved', tone: 'success' },
  'deploy.production.rejected': { label: 'Production deploy rejected', tone: 'error' },
  'approval.requested': { label: 'Approval requested', tone: 'warning' },
  'approval.decided': { label: 'Decision recorded', tone: 'neutral' },
  'approval.approved': { label: 'Approved', tone: 'success' },
  'approval.rejected': { label: 'Rejected', tone: 'error' },
  'approval.expired': { label: 'Approval expired', tone: 'warning' },
  'approval.cancelled': { label: 'Approval withdrawn', tone: 'neutral' },
  'approval.apply_failed': { label: 'Applying the approval failed', tone: 'error' },
}

export function chainEntry(event: Pick<AuditEvent, 'action' | 'summary'>): ChainEntry {
  const known = LABELS[event.action]
  const environment = event.action.startsWith('deploy.') ? text(field(event, 'environment')) : null
  let detail: string | null = null
  if (event.action === 'pr.merged' || event.action === 'session.shipped') {
    const number = text(field(event, 'number') ?? field(event, 'prNumber'))
    detail = number ? `#${number}` : null
  } else if (event.action.startsWith('release.') || event.action.startsWith('deploy.')) {
    // `release.*` carry `version`/`tag`; `deploy.activated` the deployed `version`; `deploy.started`
    // only the release's tag, as `release` (the version is not known until the upload).
    detail = text(field(event, 'version') ?? field(event, 'tag') ?? field(event, 'release'))
  } else if (event.action === 'approval.decided') {
    detail = text(field(event, 'decision'))
  }
  return {
    label: known?.label ?? event.action,
    tone: known?.tone ?? 'neutral',
    environment,
    detail,
  }
}
