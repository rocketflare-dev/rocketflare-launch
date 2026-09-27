/**
 * The one health vocabulary the registry pages use: ● up (success), ◐ degraded (warning),
 * ● down (error), ○ unknown (muted). The glyph carries the state for anyone who cannot tell the
 * colours apart, and the label is always in the accessible name.
 */
import type { AppEnvironmentSummary, HealthStatus } from '@launch/shared/launch-apps'
import { formatDateTime, timeAgo } from '@/ui/lib/format'

export const HEALTH_LABEL: Record<HealthStatus, string> = {
  up: 'Up',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Not checked yet',
}

const GLYPH: Record<HealthStatus, string> = { up: '●', degraded: '◐', down: '●', unknown: '○' }

/** Literal class strings, so Tailwind's scanner sees every one. */
const TONE: Record<HealthStatus, string> = {
  up: 'text-success',
  degraded: 'text-warning',
  down: 'text-error',
  unknown: 'text-muted',
}

export function healthTone(status: HealthStatus): string {
  return TONE[status]
}

export function HealthDot({
  status,
  className = '',
}: {
  status: HealthStatus
  className?: string
}) {
  return (
    <span
      role="img"
      aria-label={HEALTH_LABEL[status]}
      title={HEALTH_LABEL[status]}
      className={`inline-block leading-none select-none ${TONE[status]} ${className}`}
    >
      {GLYPH[status]}
    </span>
  )
}

/** "● Production · up · checked 3 minutes ago", compact enough for a catalogue row. */
export function EnvironmentHealth({
  env,
  showName = true,
  className = '',
}: {
  env: AppEnvironmentSummary
  showName?: boolean
  className?: string
}) {
  const detail = [
    env.healthVersion ? `version ${env.healthVersion}` : null,
    env.healthLatencyMs !== null ? `${env.healthLatencyMs} ms` : null,
    env.healthError,
    env.healthCheckedAt ? `checked ${formatDateTime(env.healthCheckedAt)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className={`flex items-center gap-2 min-w-0 ${className}`} title={detail || undefined}>
      <HealthDot status={env.healthStatus} className="text-sm" />
      <div className="min-w-0 leading-tight">
        {showName && (
          <span className="text-sm font-medium capitalize">
            {env.name}
            <span className="sr-only">: {HEALTH_LABEL[env.healthStatus]}</span>
          </span>
        )}
        <div className="text-xs text-muted truncate">
          {env.healthStatus === 'unknown' && !env.healthCheckedAt
            ? 'not checked yet'
            : `${HEALTH_LABEL[env.healthStatus].toLowerCase()} · ${timeAgo(env.healthCheckedAt)}`}
        </div>
      </div>
    </div>
  )
}
