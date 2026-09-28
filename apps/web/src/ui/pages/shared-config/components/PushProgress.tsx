/**
 * One push as it happens and after (Launch P5, plan §1.10, §1.12): an N/M bar of the apps it has
 * updated, the status, and — once it settles partly or wholly failed — each failed app with its
 * (scrubbed) error and a Retry. Freshness is the `grant_push` nudge every settled target sends,
 * plus a poll only while the push is queued or running (`useGrantPush`).
 *
 * The owners and admins see it (the push routes 404 anybody else). No value appears here: a target
 * carries the key NAMES it wrote or removed, never what was in them.
 */
import { ArrowPathIcon, ExclamationCircleIcon } from '@heroicons/react/24/outline'
import { GRANT_ERROR_CODES } from '@launch/shared/launch-grants'
import { Link } from 'react-router-dom'
import { useGrantPush, useRetryGrantPush } from '@/ui/hooks/useSharedResources'
import { ApiError } from '@/ui/lib/api-client'
import { timeAgo } from '@/ui/lib/format'
import { mayRetry, PUSH_REASON, PUSH_STATUS, pushProgress } from '../sharedConfigModel'

export function PushProgress({
  resourceId,
  pushId,
  canRetry,
}: {
  resourceId: string
  pushId: string
  canRetry: boolean
}) {
  const { data: push, isLoading, isError } = useGrantPush(resourceId, pushId)
  const retry = useRetryGrantPush(resourceId)

  if (isLoading) {
    return <div className="h-10 rounded surface-inset animate-pulse" aria-busy="true" />
  }
  if (isError || !push) {
    return <p className="text-xs text-muted">This push could not be loaded.</p>
  }

  const badge = PUSH_STATUS[push.status]
  const progress = pushProgress(push)
  const failed = push.targets.filter(target => target.status === 'failed')
  const retryConflict =
    retry.error instanceof ApiError && retry.error.code === GRANT_ERROR_CODES.pushInProgress

  return (
    <section
      className="surface-inset rounded-md p-3 space-y-2"
      aria-label={`${PUSH_REASON[push.reason]} push`}
      aria-live="polite"
      data-push={push.id}
      data-status={push.status}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">
          {PUSH_REASON[push.reason]}
          {push.version ? ` · version ${push.version}` : ''}
        </span>
        <span className="flex items-center gap-2">
          <span className="text-xs text-muted">{timeAgo(push.createdAt)}</span>
          <span className="status-badge" data-status={badge.tone}>
            {badge.label}
          </span>
        </span>
      </div>
      <progress
        className={`progress h-1.5 w-full ${push.failed > 0 ? 'progress-warning' : 'progress-primary'}`}
        value={progress.value}
        max={progress.max}
        aria-label="Apps updated"
      />
      <p className="text-xs text-secondary tabular-nums" data-testid="push-progress-label">
        {progress.label}
      </p>

      {failed.length > 0 && (
        <ul className="space-y-1" aria-label="Apps the push failed on">
          {failed.map(target => (
            <li key={target.id} className="flex items-start gap-1.5 text-xs">
              <ExclamationCircleIcon className="w-4 h-4 shrink-0 text-error" />
              <span className="min-w-0">
                <Link to={`/apps/${target.app.slug}`} className="link link-hover font-medium">
                  {target.app.displayName}
                </Link>
                {target.error && <span className="text-muted"> — {target.error}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canRetry && mayRetry(push.status) && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-xs gap-1"
            disabled={retry.isPending}
            onClick={() => retry.mutate(push.id)}
          >
            {retry.isPending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <ArrowPathIcon className="w-3.5 h-3.5" />
            )}
            Retry the failed apps
          </button>
          <span className="text-xs text-muted">Apps already updated are skipped.</span>
        </div>
      )}
      {retry.error && (
        <p className={`text-xs ${retryConflict ? 'text-secondary' : 'text-error'}`} role="status">
          {retryConflict
            ? 'Another push is running for this environment; try again when it finishes.'
            : retry.error.message}
        </p>
      )}
    </section>
  )
}
