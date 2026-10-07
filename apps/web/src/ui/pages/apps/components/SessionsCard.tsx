/**
 * An app's coding sessions (Launch P3, spec/07) — the app page's Sessions tab: "Start session" (the
 * header's "Build it" does the same, and is the page's hero) and the sessions already running or
 * recently finished.
 *
 * - **Start** posts `POST /api/apps/:id/sessions` WARM (issue #17, `useWarmStartSession`: it boots
 *   while you write; a second press reuses it) and goes straight to the session's page;
 *   there is nothing to fill in first (a title is optional, and the chat is where you say what
 *   you want). The refusals are explained IN PLACE, never toasted: the app's concurrency limit
 *   and a paused deployment (drained for a deploy) are information, a missing budget or backend
 *   is a sentence naming who can fix it.
 * - **The list** is `?scope=active` by default, with a toggle to include finished ones. Each row
 *   is a real `<Link>` to the session page (middle-click works), with its agent and model (the
 *   agent is fixed at create, so this is where you tell them apart), status, turns, cost and PR. Members see their own sessions; the app's owners and admins see everyone's — the route
 *   decides, the card just renders what it gets.
 * - A session whose ship is still in flight (the summary's derived `shipping`) is in the active list
 *   whatever its status — after the merge it is `shipped` while it releases and deploys — and its
 *   row says where the ship stands ("Waiting for a review", "Deploying v1.4.2 to staging").
 * - Freshness is the `['session']` nudge, plus a poll only while a listed session is moving.
 * - §18.22: Start session is the same `StartSessionButton` as the header's Build it — with a
 *   choice to make (more than one coding agent, or a runtime that may bill your own account) a
 *   split button whose caret lists each agent and who pays for it; the choice is remembered and
 *   shared by both buttons. With no choice to make (the default) it is the plain button and
 *   Start sends exactly what it always did. Nothing sits above the list: a picker there read as a
 *   filter on it.
 */
import {
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  PlayIcon,
} from '@heroicons/react/24/outline'
import { AGENT_RUNTIME_LABELS } from '@launch/shared/launch-agents'
import type { SessionSummary } from '@launch/shared/launch-sessions'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { EmptyState, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useAppSessions, useWarmStartSession } from '@/ui/hooks/useSessions'
import { ApiError } from '@/ui/lib/api-client'
import { timeAgo } from '@/ui/lib/format'
import { SessionStatusBadge } from '@/ui/pages/sessions/components/SessionStatusBadge'
import { ShippingLine } from '@/ui/pages/sessions/components/ShippingLine'
import { StartSessionButton } from './StartSessionButton'

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
    case 'agent_credential_required':
      return { tone: 'info', message: error.message }
    case 'warm_session_limit':
      // Issue #17: sessions this person opened and has not written to yet.
      return {
        tone: 'info',
        message:
          'You already have sessions waiting for a first message. Write in one of them, or end it, to start another.',
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
      <td className="text-sm whitespace-nowrap">
        {AGENT_RUNTIME_LABELS[session.runtime]}
        {session.model && (
          <span className="block font-mono text-xs text-muted">{session.model}</span>
        )}
      </td>
      <td>
        <SessionStatusBadge status={session.status} shipping={session.shipping} />
        {session.shipping && <ShippingLine shipping={session.shipping} className="mt-0.5 block" />}
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
  const start = useWarmStartSession(appId)
  const navigate = useNavigate()
  const items = list.data?.items ?? []
  const refusal = start.isError ? startRefusal(start.error) : null

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
            <StartSessionButton
              label="Start session"
              icon={PlayIcon}
              size="sm"
              pending={start.isPending}
              // Issue #17: the session starts warm, so it boots while the person writes on its page.
              onStart={request =>
                start.startWarm(request, session =>
                  navigate(`/apps/${appSlug}/sessions/${session.id}`)
                )
              }
            />
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
                <th>Agent</th>
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
