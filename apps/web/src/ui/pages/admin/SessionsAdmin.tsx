/**
 * Settings → All sessions (Launch P3, plan §1.8): every live coding session on this deployment, and the
 * drain.
 *
 * Sessions are platform capacity — containers under one `max_instances`, all on one image — so
 * this is the operator's page (`globalAdmin`, like the rest of the Operator group). The one thing it exists
 * for is **the drain before a deploy that touches the session image or `[[containers]]`**
 * (`docs/DEPLOY.md`): Drain pauses new sessions and asks every live one to suspend at its next
 * safe point (a checkpoint keeps its branch and transcript); after the deploy, Undrain lets people
 * start and resume again. Both confirm, and the confirm says exactly that.
 *
 * The list is `?scope=active` by default (a toggle includes finished ones), polled only while a
 * listed session is moving — suspending after a drain is exactly such a stretch.
 */
import { PauseCircleIcon, PlayCircleIcon, ServerStackIcon } from '@heroicons/react/24/outline'
import { type AdminSession, isActiveSessionStatus } from '@launch/shared/launch-sessions'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ConfirmModal, EmptyState, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useAdminSessions, useDrainSessions, useUndrainSessions } from '@/ui/hooks/useSessions'
import { timeAgo } from '@/ui/lib/format'
import { SessionStatusBadge } from '@/ui/pages/sessions/components/SessionStatusBadge'

const usd = (microcents: number) => `$${(microcents / 100_000_000).toFixed(2)}`

/** `1h 04m` of container time. Pure. */
export function containerTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function Row({ session }: { session: AdminSession }) {
  return (
    <tr>
      <td>
        <Link
          to={`/apps/${session.appSlug}/sessions/${session.id}`}
          className="link link-hover font-medium"
        >
          {session.title?.trim() || `Session ${session.shortId.slice(0, 6)}`}
        </Link>
        <span className="block font-mono text-xs text-muted">{session.appSlug}</span>
      </td>
      <td>
        <SessionStatusBadge status={session.status} shipping={session.shipping} />
      </td>
      <td className="tabular-nums text-sm">{session.turnCount}</td>
      <td className="tabular-nums text-sm">{usd(session.costMicrocents)}</td>
      <td className="tabular-nums text-sm">{containerTime(session.containerSeconds)}</td>
      <td className="font-mono text-xs text-muted">{session.imageVersion ?? '—'}</td>
      <td className="whitespace-nowrap text-sm text-muted">
        {timeAgo(session.lastActivityAt ?? session.createdAt)}
      </td>
    </tr>
  )
}

export default function SessionsAdmin() {
  const [showAll, setShowAll] = useState(false)
  const [confirm, setConfirm] = useState<'drain' | 'undrain' | null>(null)
  const { data, isLoading, error } = useAdminSessions(showAll ? 'all' : 'active')
  const drain = useDrainSessions()
  const undrain = useUndrainSessions()
  const paused = data?.paused ?? false
  const items = data?.items ?? []

  return (
    <div className="space-y-4">
      {paused ? (
        <div className="alert alert-warning alert-soft text-sm" role="status">
          <PauseCircleIcon className="h-5 w-5" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Sessions are drained.</p>
            <p className="text-xs">
              Nobody can start or resume a session until you undrain. Deploy, then undrain.
            </p>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => setConfirm('undrain')}>
            <PlayCircleIcon className="h-4 w-4" />
            Undrain
          </button>
        </div>
      ) : (
        <div className="surface-panel flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Deploying the session image or containers?</p>
            <p className="text-sm text-secondary">
              Drain first: new sessions pause and live ones suspend safely, so no turn is cut off
              mid-way.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-warning gap-1.5"
            onClick={() => setConfirm('drain')}
          >
            <PauseCircleIcon className="h-4 w-4" />
            Drain sessions
          </button>
        </div>
      )}

      <SectionPanel
        title="Live sessions"
        description="Coding sessions across every organisation on this deployment."
        flush
        actions={
          <label className="label cursor-pointer gap-2 text-xs">
            <input
              type="checkbox"
              className="toggle toggle-xs"
              checked={showAll}
              onChange={event => setShowAll(event.target.checked)}
            />
            Show finished
          </label>
        }
      >
        {isLoading ? (
          <SkeletonRows rows={4} className="px-5 pb-5" />
        ) : error ? (
          <p className="px-5 pb-5 text-sm text-error">{error.message}</p>
        ) : items.length === 0 ? (
          <EmptyState icon={ServerStackIcon} message="No live sessions" size="sm" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Status</th>
                  <th>Turns</th>
                  <th>Cost</th>
                  <th>Container</th>
                  <th>Image</th>
                  <th>Last active</th>
                </tr>
              </thead>
              <tbody>
                {items.map(session => (
                  <Row key={session.id} session={session} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionPanel>

      <ConfirmModal
        isOpen={confirm === 'drain'}
        title="Drain every session?"
        message={
          <div className="space-y-2 text-sm">
            <p>
              New sessions are refused, and each live session checkpoints and suspends — its branch,
              database and chat are kept. People resume after you undrain.
            </p>
            <p className="text-secondary">
              {
                items.filter(s => isActiveSessionStatus(s.status) && s.status !== 'suspended')
                  .length
              }{' '}
              live session(s) will be asked to suspend.
            </p>
          </div>
        }
        confirmText="Drain"
        confirmButtonClass="btn-warning"
        isLoading={drain.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => drain.mutate(undefined, { onSettled: () => setConfirm(null) })}
      />
      <ConfirmModal
        isOpen={confirm === 'undrain'}
        title="Undrain sessions?"
        message="People can start new sessions and resume suspended ones again. Do this after the deploy has finished."
        confirmText="Undrain"
        isLoading={undrain.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => undrain.mutate(undefined, { onSettled: () => setConfirm(null) })}
      />
    </div>
  )
}
