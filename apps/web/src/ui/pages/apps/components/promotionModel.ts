/**
 * What the app page's pipeline strip SAYS (rocketflare-launch#5 part 8) — pure, so every state and
 * its sentence is decided in one place over `appPromotionSchema`:
 *
 * - `ready` — staging runs the newest release, it is healthy, and production runs something older:
 *   Promote is on offer;
 * - `blocked` — Promote is not on offer, with the reason in plain words ("Staging is still
 *   deploying", "Staging is unhealthy", "Production already runs v1.4.2", "Nothing on staging
 *   yet");
 * - `awaiting` — promoted; the `deploy.production` request waits on the people it names;
 * - `deploying` — approved; production is deploying it;
 * - `live` — the newest release is in production.
 *
 * The server stays the judge: the route re-checks staging (and probes it when the reading is
 * stale), so a stale `ready` costs a 409 shown in the dialog, never a wrong deploy.
 */
import type { HealthStatus } from '@launch/shared/launch-apps'
import {
  type AppPromotion,
  compareReleaseVersions,
  type PromotionApproval,
} from '@launch/shared/launch-promotion'
import type { Release } from '@launch/shared/launch-releases'

export type PromotionState =
  | { kind: 'ready'; release: Release; askedBefore: boolean }
  | {
      kind: 'blocked'
      reason: string
      release: Release | null
      /** Production is at or past the candidate: there is nothing to ship, so no list. */
      productionAhead?: boolean
    }
  | { kind: 'awaiting'; release: Release; approval: PromotionApproval | null }
  | { kind: 'deploying'; release: Release }
  | { kind: 'live'; release: Release }

/** `1.4.2` → `v1.4.2`. */
export function v(version: string): string {
  return `v${version}`
}

export const STAGING_HEALTH_WORD: Record<HealthStatus, string> = {
  up: 'healthy',
  degraded: 'partly working',
  down: 'down',
  unknown: 'not checked yet',
}

const UNHEALTHY_REASON: Record<Exclude<HealthStatus, 'up'>, string> = {
  degraded: 'Staging is unhealthy',
  down: 'Staging is unhealthy',
  unknown: 'Staging has not been checked yet',
}

export function promotionState(view: AppPromotion): PromotionState {
  const release = view.candidate
  if (!release) return { kind: 'blocked', reason: 'Nothing on staging yet', release: null }
  const production = view.production?.version ?? null
  switch (release.status) {
    case 'tagged':
    case 'staging':
      return { kind: 'blocked', reason: 'Staging is still deploying', release }
    case 'awaiting_approval':
      return { kind: 'awaiting', release, approval: view.approval }
    case 'promoting':
      return { kind: 'deploying', release }
    case 'production_active':
      return { kind: 'live', release }
    case 'failed':
      return { kind: 'blocked', reason: `${v(release.version)} did not deploy`, release }
    case 'staging_active':
    case 'rejected': {
      if (production && compareReleaseVersions(production, release.version) >= 0) {
        return {
          kind: 'blocked',
          reason: `Production already runs ${v(production)}`,
          release,
          productionAhead: true,
        }
      }
      const staging = view.staging
      if (!staging?.version) {
        return { kind: 'blocked', reason: 'Nothing on staging yet', release }
      }
      if (staging.version !== release.version) {
        return { kind: 'blocked', reason: 'Staging is still deploying', release }
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

/** Who may press Promote, for somebody who may not: the app's owners and the admins. */
export function promotersSentence(ownerTeam: string | null): string {
  return ownerTeam
    ? `The ${ownerTeam} team and organisation admins can promote to production.`
    : 'This app’s owners and organisation admins can promote to production.'
}

/** The heading over what the promotion ships, or null when there is nothing to list. */
export function changesTitle(state: PromotionState): string | null {
  if (!state.release) return null
  if (state.kind === 'blocked' && state.productionAhead) return null
  return state.kind === 'live'
    ? `What ${v(state.release.version)} brought to production`
    : 'What this promotion ships'
}
