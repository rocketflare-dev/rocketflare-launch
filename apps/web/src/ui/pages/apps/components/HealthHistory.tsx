/**
 * Twenty-four hours of health per environment, as a status-page strip: one bar per quarter hour,
 * coloured by the WORST check in it (a single `down` in fifteen minutes is worth seeing), grey where
 * nothing was checked. Beside it, the share of checks that answered `up` and the median latency.
 */
import type { AppEnvironment, AppHealthCheck, HealthStatus } from '@launch/shared/launch-apps'
import { format } from 'date-fns'
import { SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useAppHealth } from '@/ui/hooks/useApps'
import { HEALTH_LABEL } from './HealthDot'

const HOURS = 24
const BUCKET_MINUTES = 15
const BUCKETS = (HOURS * 60) / BUCKET_MINUTES

const SEVERITY: Record<HealthStatus, number> = { unknown: 0, up: 1, degraded: 2, down: 3 }

/** Literal class strings, so Tailwind's scanner sees every one. */
const BAR: Record<HealthStatus | 'none', string> = {
  up: 'bg-success',
  degraded: 'bg-warning',
  down: 'bg-error',
  unknown: 'bg-base-300',
  none: 'bg-base-300 opacity-60',
}

export interface Bucket {
  start: Date
  status: HealthStatus | 'none'
  checks: number
}

/** Pure, so the bucketing is testable: `BUCKETS` slots ending at `now`, worst status wins. */
export function bucketChecks(checks: AppHealthCheck[], now: Date): Bucket[] {
  const width = BUCKET_MINUTES * 60 * 1000
  const end = now.getTime()
  const start = end - BUCKETS * width
  const buckets: Bucket[] = Array.from({ length: BUCKETS }, (_, i) => ({
    start: new Date(start + i * width),
    status: 'none' as const,
    checks: 0,
  }))
  for (const check of checks) {
    const index = Math.floor((check.checkedAt.getTime() - start) / width)
    const bucket = buckets[index]
    if (!bucket) continue
    bucket.checks += 1
    if (bucket.status === 'none' || SEVERITY[check.status] > SEVERITY[bucket.status]) {
      bucket.status = check.status
    }
  }
  return buckets
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? null
}

function EnvironmentStrip({
  env,
  checks,
  now,
}: {
  env: AppEnvironment
  checks: AppHealthCheck[]
  now: Date
}) {
  const buckets = bucketChecks(checks, now)
  const up = checks.filter(c => c.status === 'up').length
  const uptime = checks.length ? (up / checks.length) * 100 : null
  const latency = median(checks.flatMap(c => (c.latencyMs === null ? [] : [c.latencyMs])))
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-1.5">
        <span className="text-sm font-medium capitalize">{env.name}</span>
        <span className="text-xs text-muted tabular-nums">
          {uptime === null
            ? 'no checks yet'
            : `${uptime >= 99.95 ? '100' : uptime.toFixed(1)}% up${latency !== null ? ` · ${latency} ms median` : ''}`}
        </span>
      </div>
      <div
        className="flex gap-px h-7 items-stretch"
        role="img"
        aria-label={`${env.name}: ${checks.length} checks in the last ${HOURS} hours${
          uptime === null ? '' : `, ${uptime.toFixed(1)}% up`
        }`}
      >
        {buckets.map(bucket => (
          <div
            key={bucket.start.getTime()}
            className={`flex-1 rounded-[2px] ${BAR[bucket.status]}`}
            title={`${format(bucket.start, 'HH:mm')} — ${
              bucket.status === 'none'
                ? 'no checks'
                : `${HEALTH_LABEL[bucket.status]} (${bucket.checks} check${bucket.checks === 1 ? '' : 's'})`
            }`}
          />
        ))}
      </div>
    </div>
  )
}

export function HealthHistory({
  appId,
  environments,
}: {
  appId: string
  environments: AppEnvironment[]
}) {
  const { data, isLoading, dataUpdatedAt } = useAppHealth(appId, HOURS)
  const now = new Date(dataUpdatedAt || Date.now())
  return (
    <SectionPanel
      title="Health, last 24 hours"
      description="Checked every five minutes: /api/health and /api/ready, five-second timeout."
    >
      {isLoading ? (
        <SkeletonRows rows={2} />
      ) : (
        <div className="space-y-5">
          {environments.map(env => (
            <EnvironmentStrip
              key={env.id}
              env={env}
              checks={data?.items.filter(c => c.environmentId === env.id) ?? []}
              now={now}
            />
          ))}
          <div className="flex justify-between text-[11px] text-muted font-mono">
            <span>{HOURS}h ago</span>
            <span className="flex items-center gap-3">
              {(['up', 'degraded', 'down'] as const).map(s => (
                <span key={s} className="flex items-center gap-1">
                  <span className={`inline-block w-2 h-2 rounded-[2px] ${BAR[s]}`} />
                  {HEALTH_LABEL[s].toLowerCase()}
                </span>
              ))}
            </span>
            <span>now</span>
          </div>
        </div>
      )}
    </SectionPanel>
  )
}
