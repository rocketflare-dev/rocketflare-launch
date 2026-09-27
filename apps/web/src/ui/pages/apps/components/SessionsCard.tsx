/**
 * An app's coding sessions (Launch P3, spec/07) on its detail page: "Start session" — the page's
 * way into the Lovable loop — and the sessions already running or recently finished.
 *
 * - **Start** posts `POST /api/apps/:id/sessions` and goes straight to the new session's page;
 *   there is nothing to fill in first (a title is optional, and the chat is where you say what
 *   you want). The refusals are explained IN PLACE, never toasted: the app's concurrency limit
 *   and a paused deployment (drained for a deploy) are information, a missing budget or backend
 *   is a sentence naming who can fix it.
 * - **The list** is `?scope=active` by default, with a toggle to include finished ones. Each row
 *   is a real `<Link>` to the session page (middle-click works), with its status, turns, cost and
 *   PR. Members see their own sessions; the app's owners and admins see everyone's — the route
 *   decides, the card just renders what it gets.
 * - Freshness is the `['session']` nudge, plus a poll only while a listed session is moving.
 */
import {
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  PlayIcon,
} from '@heroicons/react/24/outline'
import type { SessionSummary } from '@launch/shared/launch-sessions'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { EmptyState, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useAppSessions, useStartSession } from '@/ui/hooks/useSessions'
import { ApiError } from '@/ui/lib/api-client'
import { timeAgo } from '@/ui/lib/format'
import { SessionStatusBadge } from '@/ui/pages/sessions/components/SessionStatusBadge'

/** A start refusal → what the card says about it. Pure. */
export function startRefusal(error: unknown): { tone: 'info' | 'warning'; message: string } {
  if (!(error instanceof ApiError)) {
    return { tone: 'warning', message: 'The session could not be started. Try again.' }
  }
  switch (error.code) {
    case 'session_limit':
      return {
        tone: 'info',
        message:
          'This app already has as many sessions running as it is allowed. End or ship one to start another.',
      }
    case 'sessions_paused':
      return {
        tone: 'info',
        message: 'Sessions are paused while Launch is being updated. Try again in a few minutes.',
      }
    case 'session_budget_exhausted':
      return {
        tone: 'warning',
        message:
          'This app has used its coding-session budget for the month. An administrator can raise it.',
      }
    case 'sessions_not_configured':
      return {
        tone: 'warning',
        message: 'Coding sessions are not set up on this deployment yet. Ask an administrator.',
      }
    default:
      return { tone: 'warning', message: error.message }
  }
}

const usd = (microcents: number) => `$${(microcents / 100_000_000).toFixed(2)}`

function SessionRow({ appSlug, session }: { appSlug: string; session: SessionSummary }) {
  const title = session.title?.trim() || `Session ${session.shortId.slice(0, 6)}`
  return (
    <tr>
      <td className="min-w-0">
        <Link
          to={`/apps/${appSlug}/sessions/${session.id}`}
          className="link link-hover font-medium"
        >
          {title}
        </Link>
        {session.branch && (
          <span className="block truncate font-mono text-xs text-muted">{session.branch}</span>
        )}
      </td>
      <td>
        <SessionStatusBadge status={session.status} />
      </td>
      <td className="tabular-nums text-sm">{session.turnCount}</td>
      <td className="tabular-nums text-sm">{usd(session.costMicrocents)}</td>
      <td className="text-sm">
        {session.prUrl ? (
          <a
            href={session.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="link link-hover inline-flex items-center gap-1"
          >
            #{session.prNumber}
            <ArrowTopRightOnSquareIcon className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="text-sm text-muted whitespace-nowrap">
        {timeAgo(session.lastActivityAt ?? session.createdAt)}
      </td>
    </tr>
  )
}

export function SessionsCard({
  appId,
  appSlug,
  canStart,
}: {
  appId: string
  appSlug: string
  /** `create Session` and the app has a repository to work on. */
  canStart: boolean
}) {
  const [showAll, setShowAll] = useState(false)
  const list = useAppSessions(appId, showAll ? 'all' : 'active')
  const start = useStartSession(appId)
  const navigate = useNavigate()
  const items = list.data?.items ?? []
  const refusal = start.isError ? startRefusal(start.error) : null

  const onStart = () =>
    start.mutate(
      {},
      { onSuccess: ({ session }) => navigate(`/apps/${appSlug}/sessions/${session.id}`) }
    )

  return (
    <SectionPanel
      title="Coding sessions"
      description="Change this app by chatting with a coding agent, with a live preview beside you. Each session ends in a pull request."
      actions={
        <>
          <label className="label cursor-pointer gap-2 text-xs">
            <input
              type="checkbox"
              className="toggle toggle-xs"
              checked={showAll}
              onChange={event => setShowAll(event.target.checked)}
            />
            Show finished
          </label>
          {canStart && (
            <button
              type="button"
              className="btn btn-sm btn-primary btn-flame gap-1.5"
              onClick={onStart}
              disabled={start.isPending}
            >
              {start.isPending ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <PlayIcon className="h-4 w-4" />
              )}
              Start session
            </button>
          )}
        </>
      }
    >
      {refusal && (
        <div
          className={`alert alert-soft mb-3 text-sm ${refusal.tone === 'info' ? 'alert-info' : 'alert-warning'}`}
          role="status"
        >
          {refusal.message}
        </div>
      )}
      {list.isLoading ? (
        <SkeletonRows rows={3} />
      ) : list.isError ? (
        <p className="text-sm text-muted">Sessions could not be loaded.</p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={ChatBubbleLeftRightIcon}
          size="sm"
          message={showAll ? 'No sessions yet' : 'No sessions running'}
          description={
            canStart
              ? 'Start one to describe a change in plain words and watch it happen.'
              : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th>Session</th>
                <th>Status</th>
                <th>Turns</th>
                <th>Cost</th>
                <th>PR</th>
                <th>Last active</th>
              </tr>
            </thead>
            <tbody>
              {items.map(session => (
                <SessionRow key={session.id} appSlug={appSlug} session={session} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionPanel>
  )
}
