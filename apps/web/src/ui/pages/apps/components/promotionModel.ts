/**
 * Where the app page's Staging → Live flow stands (rocketflare-launch#5 part 8) — pure, so every
 * state and its sentence is decided in one place over `appPromotionSchema`. The UI calls the
 * environments Staging and Live; GitHub and wrangler keep the names staging/production.
 *
 * - `ready` — staging runs the newest release, it is healthy, and Live runs something older: Ship
 *   is on offer;
 * - `blocked` — Ship is not on offer, with the reason in plain words ("v1.4.2 is tagged — GitHub
 *   is checking it before it deploys to staging" while its tag's run has not reached the staging
 *   job, "Deploying v1.4.2 to staging…", "v1.4.2 did not deploy: ci / Gate failed", "Staging is
 *   still deploying" when no run is known, "v1.4.2 never reached staging" once a release with no
 *   run in flight is past `RELEASE_STAGING_TIMEOUT_MINUTES`, "Staging is unhealthy", "Live
 *   already runs v1.4.2", "Nothing on staging yet"). With the tag's run (`view.candidateRun`) it
 *   carries `run`: the job it is on and the link to it on GitHub; `progress` sorts the candidate's
 *   reasons into on-its-way (`moving`) and needs-a-person (`failed`);
 * - `awaiting` — shipped; the `deploy.production` request waits on the people it names;
 * - `deploying` — approved; Live is deploying it;
 * - `live` — the newest release is Live.
 *
 * The server stays the judge: the route re-checks staging (and probes it when the reading is
 * stale), so a stale `ready` costs a 409 shown in the dialog, never a wrong deploy.
 */
import type { HealthStatus } from '@launch/shared/launch-apps'
import {
  type AppPromotion,
  type CandidateRun,
  candidateRunFailed,
  compareReleaseVersions,
  type PromotionApproval,
} from '@launch/shared/launch-promotion'
import { RELEASE_STAGING_TIMEOUT_MINUTES, type Release } from '@launch/shared/launch-releases'

export type PromotionState =
  | { kind: 'ready'; release: Release; askedBefore: boolean }
  | {
      kind: 'blocked'
      reason: string
      release: Release | null
      /** Production is at or past the candidate: there is nothing to ship, so no list. */
      productionAhead?: boolean
      /** The candidate's tag run on GitHub: what it is doing now, and where to see it. */
      run?: PromotionRunNote
      /**
       * For the app page: `moving` — the candidate is on its way to staging (an inline line on the
       * Staging row); `failed` — it will not get there by itself (a Needs-you item). Absent for
       * every other reason.
       */
      progress?: 'moving' | 'failed'
    }
  | { kind: 'awaiting'; release: Release; approval: PromotionApproval | null }
  | { kind: 'deploying'; release: Release }
  | { kind: 'live'; release: Release }

/** A line under the reason about the tag's run, and its link ("View on GitHub"). */
export interface PromotionRunNote {
  /** "Running: ci / Gate", or null when GitHub named no job. */
  detail: string | null
  url: string | null
}

/** `1.4.2` → `v1.4.2`; a build that is not a release (`main-64a36e6`) stays as it is. */
export function v(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version
}

/** A release cut this long ago that is still not live on staging is stuck, not deploying. */
function stuck(release: Release, now: Date): boolean {
  return now.getTime() - release.createdAt.getTime() >= RELEASE_STAGING_TIMEOUT_MINUTES * 60_000
}

const UNHEALTHY_REASON: Record<Exclude<HealthStatus, 'up'>, string> = {
  degraded: 'Staging is unhealthy',
  down: 'Staging is unhealthy',
  unknown: 'Staging has not been checked since it was deployed — Check now is on Activity',
}

/** The note for a run still going: the job it is on, and its link. Pure. */
function runningNote(run: CandidateRun): PromotionRunNote {
  return { detail: run.currentJob ? `Running: ${run.currentJob}` : null, url: run.url }
}

/** The sentence for a run that ended without deploying. Pure. */
function failedRunReason(version: string, run: CandidateRun): string {
  return run.failedJob
    ? `${v(version)} did not deploy: ${run.failedJob} failed`
    : `${v(version)} did not deploy`
}

export function promotionState(view: AppPromotion, now: Date = new Date()): PromotionState {
  const release = view.candidate
  if (!release) return { kind: 'blocked', reason: 'Nothing on staging yet', release: null }
  const production = view.production?.version ?? null
  // `?? null`: a view built by hand (or by an older server) may not carry it.
  const run = view.candidateRun ?? null
  switch (release.status) {
    case 'tagged':
    case 'staging': {
      // The tag's run ended without deploying, and the server has not moved the release yet.
      if (run && candidateRunFailed(run)) {
        return {
          kind: 'blocked',
          reason: failedRunReason(release.version, run),
          release,
          run: { detail: null, url: run.url },
          progress: 'failed',
        }
      }
      const inFlight = run && run.status !== 'completed' ? run : null
      if (release.status === 'staging' && (inFlight || !stuck(release, now))) {
        return {
          kind: 'blocked',
          reason: `Deploying ${v(release.version)} to staging…`,
          release,
          ...(run ? { run: runningNote(run) } : {}),
          progress: 'moving',
        }
      }
      if (inFlight) {
        return {
          kind: 'blocked',
          reason: `${v(release.version)} is tagged — GitHub is checking it before it deploys to staging`,
          release,
          run: runningNote(inFlight),
          progress: 'moving',
        }
      }
      return stuck(release, now)
        ? {
            kind: 'blocked',
            reason: `${v(release.version)} never reached staging`,
            release,
            progress: 'failed',
          }
        : { kind: 'blocked', reason: 'Staging is still deploying', release, progress: 'moving' }
    }
    case 'awaiting_approval':
      return { kind: 'awaiting', release, approval: view.approval }
    case 'promoting':
      return { kind: 'deploying', release }
    case 'production_active':
      return { kind: 'live', release }
    case 'rolled_back':
      // App page P3: Live went back to an earlier release; this one is not shipped again.
      return {
        kind: 'blocked',
        reason: `${v(release.version)} was rolled back; release a fix to ship again`,
        release,
      }
    case 'failed':
      return run && candidateRunFailed(run)
        ? {
            kind: 'blocked',
            reason: failedRunReason(release.version, run),
            release,
            run: { detail: null, url: run.url },
            progress: 'failed',
          }
        : {
            kind: 'blocked',
            reason: `${v(release.version)} did not deploy`,
            release,
            progress: 'failed',
          }
    case 'staging_active':
    case 'rejected': {
      if (production && compareReleaseVersions(production, release.version) >= 0) {
        return {
          kind: 'blocked',
          reason: `Live already runs ${v(production)}`,
          release,
          productionAhead: true,
        }
      }
      const staging = view.staging
      if (!staging?.version) {
        return { kind: 'blocked', reason: 'Nothing on staging yet', release }
      }
      if (staging.version !== release.version) {
        return {
          kind: 'blocked',
          reason: `Staging runs ${v(staging.version)}, not ${v(release.version)}`,
          release,
        }
      }
      if (staging.healthStatus !== 'up') {
        return { kind: 'blocked', reason: UNHEALTHY_REASON[staging.healthStatus], release }
      }
      return { kind: 'ready', release, askedBefore: release.status === 'rejected' }
    }
  }
}

/** "Ana", "Ana and Ben", "Ana, Ben and 3 others" — first names where the server knows them. */
export function peopleSentence(
  people: readonly { name: string | null; email: string }[],
  shown = 3
): string {
  const names = people.map(p => p.name?.trim() || p.email)
  if (names.length === 0) return ''
  if (names.length === 1) return names[0] as string
  if (names.length <= shown) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  const rest = names.length - shown
  return `${names.slice(0, shown).join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`
}

/** Who may press Ship, for somebody who may not: the app's owners and the admins. */
export function promotersSentence(ownerTeam: string | null): string {
  return ownerTeam
    ? `The ${ownerTeam} team and organisation admins can ship it live.`
    : 'This app’s owners and organisation admins can ship it live.'
}

/**
 * How many changes (sessions and pull requests) staging carries that Live does not — "3 changes
 * not live", "50+ changes not live" — or null when there is nothing to list: no candidate, Live is
 * at or past it, or it is already Live. Pure.
 */
export function changesNotLive(
  view: Pick<AppPromotion, 'changes' | 'changesTruncated'>,
  state: PromotionState
): string | null {
  if (!state.release || state.kind === 'live') return null
  if (state.kind === 'blocked' && state.productionAhead) return null
  const count = view.changes.length
  if (count === 0) return null
  return `${count}${view.changesTruncated ? '+' : ''} ${count === 1 && !view.changesTruncated ? 'change' : 'changes'} not live`
}

/** Longest summary line shown under a change; the rest is one click away on the PR. */
const SUMMARY_LINE_MAX = 220

/**
 * Issue #5: a change's stored ship summary (markdown from the PR body) as ONE plain line — its
 * first paragraph that is not just a heading, list and quote marks stripped, clipped. Rendered as
 * text, never markdown (this chunk carries no renderer). Null when there is nothing to say. Pure.
 */
export function summaryLine(summary: string | null | undefined): string | null {
  if (!summary) return null
  const paragraph = summary
    .split(/\n\s*\n/)
    .map(part =>
      part
        .split('\n')
        .filter(line => !/^\s*#{1,6}\s/.test(line))
        .map(line => line.replace(/^\s*([-*+]\s+|\d+\.\s+|>\s?)/, '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\*\*|__|`/g, '')
    )
    .find(Boolean)
  if (!paragraph) return null
  return paragraph.length > SUMMARY_LINE_MAX
    ? `${paragraph.slice(0, SUMMARY_LINE_MAX).trimEnd()}…`
    : paragraph
}
