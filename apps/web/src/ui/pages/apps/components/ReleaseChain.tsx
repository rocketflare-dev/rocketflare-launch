/**
 * A release's whole story, oldest first (plan §1.11): the pull requests and the sessions that
 * shipped them, the tag, the staging deploy, the production approval and its decisions, the
 * production deploy. `GET /api/apps/:id/releases/:rid/chain` links every row by id — this renders
 * what it answered, in its order, and infers nothing from timestamps.
 *
 * Read when somebody opens it (the card's row expander, the approval page for a deploy), never for
 * every row of a list. A long chain windows rather than virtualises (ui.md): the last `WINDOW` rows
 * and one "Show earlier" button, because the end of the story is what a reader came for.
 */
import type { AuditEvent } from '@launch/shared/launch-audit'
import { useState } from 'react'
import { SkeletonRows } from '@/ui/components/shared'
import { useReleaseChain } from '@/ui/hooks/useReleases'
import { formatDateTime, timeAgo } from '@/ui/lib/format'
import { type ChainTone, chainEntry } from './releaseModel'

const WINDOW = 30

/** Literal class strings, so Tailwind's scanner sees every one. */
const DOT: Record<ChainTone, string> = {
  neutral: 'bg-base-300',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  primary: 'bg-primary',
}

function actorOf(event: AuditEvent): string {
  if (event.actorType === 'system') return 'Launch'
  if (event.actorType === 'app') return 'the deploy job'
  return event.actorEmail ?? 'someone'
}

export function ReleaseChainList({ events }: { events: readonly AuditEvent[] }) {
  const [showAll, setShowAll] = useState(false)
  if (events.length === 0) {
    return <p className="text-sm text-muted">Nothing has been recorded for this release yet.</p>
  }
  const hidden = showAll ? 0 : Math.max(0, events.length - WINDOW)
  const shown = events.slice(hidden)
  return (
    <div>
      {hidden > 0 && (
        <button
          type="button"
          className="btn btn-ghost btn-xs mb-2"
          onClick={() => setShowAll(true)}
        >
          Show {hidden} earlier
        </button>
      )}
      <ol className="relative space-y-3" aria-label="Release chain">
        {shown.map(event => {
          const entry = chainEntry(event)
          return (
            <li
              key={event.id}
              className="flex items-start gap-3 text-sm"
              data-action={event.action}
            >
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[entry.tone]}`}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{entry.label}</span>
                  {entry.detail && (
                    <span className="font-mono text-xs text-secondary">{entry.detail}</span>
                  )}
                  {entry.environment && (
                    <span
                      className={`status-badge no-dot capitalize ${entry.environment === 'production' ? 'tone-primary' : 'tone-warning'}`}
                    >
                      {entry.environment}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted">
                  {actorOf(event)} ·{' '}
                  <time dateTime={event.at.toISOString()} title={formatDateTime(event.at)}>
                    {timeAgo(event.at)}
                  </time>
                </p>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export function ReleaseChain({ appId, releaseId }: { appId: string; releaseId: string }) {
  const { data, isLoading, isError } = useReleaseChain(appId, releaseId)
  if (isLoading) return <SkeletonRows rows={4} />
  if (isError || !data) {
    return (
      <p className="text-sm text-error" role="alert">
        The release’s history could not be loaded.
      </p>
    )
  }
  return <ReleaseChainList events={data.events} />
}
