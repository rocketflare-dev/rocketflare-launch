/**
 * One environment on the detail page: its URL and Worker, the latest health with the reason when it
 * is not up, the last deploy, and the resources its toml declares — ids, as spec/06 records them.
 */
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import {
  type AppEnvironment,
  type AppEnvironmentResources,
  HEALTH_NOT_DEPLOYED_ERROR,
} from '@launch/shared/launch-apps'
import { formatDateTime, timeAgo } from '@/ui/lib/format'
import { HEALTH_LABEL, HealthDot } from './HealthDot'

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

/**
 * Nothing has ever been deployed here: the last probe met Launch's placeholder Worker (the server
 * records `HEALTH_NOT_DEPLOYED_ERROR`), so it is not an outage. Pure.
 */
export function notDeployedYet(env: AppEnvironment): boolean {
  return env.healthStatus === 'unknown' && env.healthError === HEALTH_NOT_DEPLOYED_ERROR
}

export function EnvironmentCard({ env }: { env: AppEnvironment }) {
  const resources = resourceRows(env.resources)
  const empty = notDeployedYet(env)
  const host = env.url ? env.url.replace(/^https?:\/\//, '') : null
  return (
    <section className="surface-panel flex flex-col gap-4 min-w-0">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold capitalize">{env.name}</h3>
            {env.name === 'staging' && (
              <span className="status-badge no-dot tone-warning">pre-release</span>
            )}
          </div>
          {env.url ? (
            <a
              href={env.url}
              target="_blank"
              rel="noopener noreferrer"
              className="link link-hover text-sm text-secondary inline-flex items-center gap-1 max-w-full"
            >
              <span className="truncate">{host}</span>
              <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5 shrink-0" />
            </a>
          ) : (
            <p className="text-sm text-muted">No URL in its toml</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 surface-inset px-2.5 py-1.5">
          <HealthDot status={empty ? 'unknown' : env.healthStatus} />
          <span className="text-sm font-medium">
            {empty ? 'Not deployed yet' : HEALTH_LABEL[env.healthStatus]}
          </span>
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div>
          <dt className="text-xs text-muted">Last checked</dt>
          <dd title={formatDateTime(env.healthCheckedAt)}>{timeAgo(env.healthCheckedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Version</dt>
          <dd className="font-mono text-xs pt-0.5">{env.healthVersion ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Response</dt>
          <dd className="tabular-nums">
            {env.healthLatencyMs !== null ? `${env.healthLatencyMs} ms` : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Worker</dt>
          <dd className="font-mono text-xs pt-0.5 truncate">{env.workerName ?? '—'}</dd>
        </div>
        {env.lastDeployAt && (
          <div className="col-span-2">
            <dt className="text-xs text-muted">Last deploy</dt>
            <dd>
              {env.lastDeployVersion ?? 'unknown version'} · {timeAgo(env.lastDeployAt)}
              {env.lastDeployBy ? ` by ${env.lastDeployBy}` : ''}
            </dd>
          </div>
        )}
      </dl>

      {empty ? (
        <p className="text-sm text-secondary" data-testid="not-deployed">
          Nothing has been deployed here yet. Until the first deploy, Launch’s “being set up” page
          answers this address.
        </p>
      ) : (
        env.healthError &&
        env.healthStatus !== 'up' && (
          <p className="text-xs font-mono surface-inset px-3 py-2 text-secondary break-words">
            {env.healthError}
          </p>
        )
      )}

      <div>
        <h4 className="text-xs text-muted uppercase tracking-wide mb-1.5">Declared resources</h4>
        {resources.length === 0 ? (
          <p className="text-sm text-muted">None recorded</p>
        ) : (
          <ul className="divide-y divide-base-300 text-sm">
            {resources.map(r => (
              <li key={`${r.kind}:${r.binding}`} className="flex items-center gap-3 py-1.5">
                <span className="w-28 shrink-0 text-xs text-muted">{r.kind}</span>
                <span className="font-mono text-xs w-40 shrink-0 truncate">{r.binding}</span>
                <span className="font-mono text-xs text-secondary truncate" title={r.value}>
                  {r.value}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
