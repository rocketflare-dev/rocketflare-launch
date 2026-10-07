/**
 * The words the app commands (`apps`, `deploys`) share, copied from the app page so a terminal
 * and the console describe an app the same way: the environments are Staging and Live (GitHub and
 * wrangler keep staging/production), health is Up / Degraded / Down / Not checked yet
 * (`HealthDot.tsx`), a deploy's phase is one short phrase (`deployProgressModel.ts`). Pure.
 */
import type {
  AppEnvironmentName,
  AppEnvironmentSummary,
  DeployPhase,
  DeployProgress,
  HealthStatus,
} from '@launch/shared/launch-apps'
import { HEALTH_NOT_DEPLOYED_ERROR } from '@launch/shared/launch-apps'

export const ENVIRONMENT_LABELS: Record<AppEnvironmentName, string> = {
  staging: 'Staging',
  production: 'Live',
}

export const HEALTH_LABELS: Record<HealthStatus, string> = {
  up: 'Up',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Not checked yet',
}

export const DEPLOY_PHASE_LABELS: Record<DeployPhase, string> = {
  awaiting_approval: 'awaiting approval',
  dispatched: 'dispatched',
  approved: 'building',
  uploaded: 'uploaded',
  migrating: 'migrating',
  activating: 'activating',
  done: 'live',
  failed: 'failed',
}

/** `1.4.2` → `v1.4.2`; a build that is not a release (`main-64a36e6`) stays as it is. */
export function v(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version
}

/** An environment's health in a few words: "Up · v1.4.2 · 120 ms", "Not deployed yet". */
export function healthLine(
  env: Pick<
    AppEnvironmentSummary,
    'healthStatus' | 'healthVersion' | 'healthLatencyMs' | 'healthError'
  >
): string {
  if (env.healthStatus === 'unknown' && env.healthError === HEALTH_NOT_DEPLOYED_ERROR)
    return 'Not deployed yet'
  const parts = [HEALTH_LABELS[env.healthStatus]]
  if (env.healthVersion) parts.push(v(env.healthVersion))
  if (env.healthLatencyMs !== null) parts.push(`${env.healthLatencyMs} ms`)
  return parts.join(' · ')
}

/** "Staging v1.4.2 · migrating", "Live v1.4.1 · failed" — a deploy in one phrase. */
export function deployLine(d: Pick<DeployProgress, 'environment' | 'version' | 'phase'>): string {
  const version = d.version ? ` ${v(d.version)}` : ''
  return `${ENVIRONMENT_LABELS[d.environment]}${version} · ${DEPLOY_PHASE_LABELS[d.phase]}`
}

/** "3 s", "4 min", "1 h 5 min" between two times; null when either is missing. */
export function duration(
  from: Date | null | undefined,
  to: Date | null | undefined
): string | null {
  if (!from || !to) return null
  const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}
