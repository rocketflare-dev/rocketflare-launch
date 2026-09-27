/**
 * The operations log (spec/06): every pipeline run against this app — an import today, a launch or
 * a teardown later — as its steps, with the ids each step recorded. Those ids are what make a retry
 * or a teardown exact, so they are shown rather than summarised.
 */
import { QueueListIcon } from '@heroicons/react/24/outline'
import type { AppOperation, AppOperationStatus } from '@launch/shared/launch-apps'
import { EmptyState, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useAppOperations } from '@/ui/hooks/useApps'
import { formatDateTime } from '@/ui/lib/format'

/** Operation status → the `.status-badge` vocabulary in `index.css`. */
const BADGE: Record<AppOperationStatus, string> = {
  pending: 'pending',
  running: 'running',
  succeeded: 'completed',
  failed: 'failed',
  skipped: 'idle',
}

export interface OperationRun {
  runId: string
  kind: string
  at: Date
  steps: AppOperation[]
}

/** Group newest-first rows into runs, each run's steps in the order they started. Pure. */
export function groupRuns(items: AppOperation[]): OperationRun[] {
  const runs = new Map<string, OperationRun>()
  for (const op of items) {
    const run = runs.get(op.runId) ?? {
      runId: op.runId,
      kind: op.kind,
      at: op.createdAt,
      steps: [],
    }
    run.steps.push(op)
    if (op.createdAt > run.at) run.at = op.createdAt
    runs.set(op.runId, run)
  }
  const started = (op: AppOperation) => (op.startedAt ?? op.createdAt).getTime()
  return [...runs.values()]
    .map(run => ({
      ...run,
      steps: [...run.steps].sort((a, b) => started(a) - started(b) || a.step.localeCompare(b.step)),
    }))
    .sort((a, b) => b.at.getTime() - a.at.getTime())
}

const stepLabel = (step: string) => step.replace(/_/g, ' ')

export function OperationsLog({ appId }: { appId: string }) {
  const { data, isLoading } = useAppOperations(appId)
  const runs = groupRuns(data?.items ?? [])
  return (
    <SectionPanel
      title="Operations"
      description="Every run Launch made against this app, step by step."
    >
      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : runs.length === 0 ? (
        <EmptyState icon={QueueListIcon} size="sm" message="No operations recorded" />
      ) : (
        <ol className="space-y-5">
          {runs.map(run => (
            <li key={run.runId}>
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <span className="text-sm font-medium capitalize">{run.kind}</span>
                <span className="text-xs text-muted">
                  {formatDateTime(run.at)} ·{' '}
                  <span className="font-mono" title={run.runId}>
                    {run.runId.slice(0, 8)}
                  </span>
                </span>
              </div>
              <ol className="border-l border-base-300 ml-1.5 space-y-2.5">
                {run.steps.map(op => (
                  <li key={op.id} className="pl-4 relative">
                    <span
                      aria-hidden="true"
                      className={`absolute -left-[4.5px] top-2 w-2 h-2 rounded-full ${
                        op.status === 'failed'
                          ? 'bg-error'
                          : op.status === 'succeeded'
                            ? 'bg-success'
                            : 'bg-base-300'
                      }`}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm capitalize">{stepLabel(op.step)}</span>
                      <span className="status-badge no-dot" data-status={BADGE[op.status]}>
                        {op.status}
                      </span>
                      {op.attempt > 1 && (
                        <span className="text-xs text-muted">attempt {op.attempt}</span>
                      )}
                    </div>
                    {op.error && <p className="text-xs text-error mt-1">{op.error}</p>}
                    {Object.keys(op.externalIds).length > 0 && (
                      <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                        {Object.entries(op.externalIds).map(([key, value]) => (
                          <div key={key} className="flex gap-1 min-w-0">
                            <dt className="text-muted">{key}</dt>
                            <dd
                              className="font-mono text-secondary truncate max-w-[22rem]"
                              title={value}
                            >
                              {value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </SectionPanel>
  )
}
