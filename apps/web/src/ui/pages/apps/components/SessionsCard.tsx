/**
 * An app's coding sessions (Launch P3, spec/07) — the app page's Sessions tab: "Start session" (the
 * header's "Change it" does the same, and is the page's hero) and the sessions already running or
 * recently finished.
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
 * - §18.22: when the deployment offers a CHOICE — more than one coding agent, or a runtime that may
 *   bill your own account — a compact picker sits above the list (`agentPickerVisible`): the agent,
 *   and "Bill to: Launch / my <account>". With no choice to make (the default) there is no picker
 *   and Start sends exactly what it always did.
 */
import {
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  PlayIcon,
} from '@heroicons/react/24/outline'
import {
  type AgentAccountsResponse,
  type AgentRuntimeId,
  agentPickerVisible,
  type SessionCredentialSource,
} from '@launch/shared/launch-agents'
import type { CreateSessionRequest, SessionSummary } from '@launch/shared/launch-sessions'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { EmptyState, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useAgentAccounts } from '@/ui/hooks/useAgentAccounts'
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
    case 'agent_credential_required':
      return { tone: 'info', message: error.message }
    default:
      return { tone: 'warning', message: error.message }
  }
}

const usd = (microcents: number) => `$${(microcents / 100_000_000).toFixed(2)}`

/** The picker's choice, when there is one to make. */
interface StartChoice {
  runtime: AgentRuntimeId
  credential: SessionCredentialSource
}

/**
 * The start request for the picker's choice — `{}` when there is no picker (the P3 request,
 * unchanged), else the runtime and, when the person may choose, whose account. Pure.
 */
export function startRequestFor(
  accounts: AgentAccountsResponse | undefined,
  choice: StartChoice | null
): CreateSessionRequest {
  if (!accounts || !choice || !agentPickerVisible(accounts.runtimes)) return {}
  const option = accounts.runtimes.find(r => r.runtime === choice.runtime && r.enabled)
  if (!option) return {}
  if (option.credentialMode === 'platform') return { runtime: option.runtime }
  if (option.credentialMode === 'user') return { runtime: option.runtime, credential: 'user' }
  return { runtime: option.runtime, credential: choice.credential }
}

function StartPicker({
  accounts,
  choice,
  onChange,
}: {
  accounts: AgentAccountsResponse
  choice: StartChoice
  onChange: (choice: StartChoice) => void
}) {
  const enabled = accounts.runtimes.filter(r => r.enabled)
  const option = enabled.find(r => r.runtime === choice.runtime) ?? enabled[0]
  if (!option) return null
  const connected = accounts.credentials.some(
    c => c.runtime === option.runtime && c.status === 'active'
  )
  return (
    <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
      {enabled.length > 1 && (
        <div className="flex flex-col gap-1">
          <label htmlFor="session-start-runtime" className="text-xs text-muted">
            Coding agent
          </label>
          <select
            id="session-start-runtime"
            className="select select-sm"
            value={option.runtime}
            onChange={e => onChange({ ...choice, runtime: e.target.value as AgentRuntimeId })}
          >
            {enabled.map(r => (
              <option key={r.runtime} value={r.runtime}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {option.credentialMode === 'user_or_platform' && (
        <div className="flex flex-col gap-1">
          <label htmlFor="session-start-billing" className="text-xs text-muted">
            Bill to
          </label>
          <select
            id="session-start-billing"
            className="select select-sm"
            value={choice.credential}
            onChange={e =>
              onChange({ ...choice, credential: e.target.value as SessionCredentialSource })
            }
          >
            <option value="platform">Launch</option>
            <option value="user">My {option.accountLabel}</option>
          </select>
        </div>
      )}
      {option.credentialMode === 'user' && (
        <span className="text-xs text-muted">Billed to your {option.accountLabel}</span>
      )}
      {option.credentialMode !== 'platform' &&
        (choice.credential === 'user' || option.credentialMode === 'user') &&
        !connected && (
          <span className="text-xs text-warning">
            Connect your {option.accountLabel} on{' '}
            <Link to="/" className="link">
              Home
            </Link>{' '}
            first.
          </span>
        )}
    </div>
  )
}

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
  const accounts = useAgentAccounts(canStart)
  const [choice, setChoice] = useState<StartChoice | null>(null)
  const navigate = useNavigate()
  const items = list.data?.items ?? []
  const refusal = start.isError ? startRefusal(start.error) : null
  const picker = canStart && accounts.data && agentPickerVisible(accounts.data.runtimes)
  const firstEnabled = accounts.data?.runtimes.find(r => r.enabled)?.runtime ?? 'claude_code'
  const current: StartChoice = choice ?? { runtime: firstEnabled, credential: 'platform' }

  const onStart = () =>
    start.mutate(startRequestFor(accounts.data, picker ? current : null), {
      onSuccess: ({ session }) => navigate(`/apps/${appSlug}/sessions/${session.id}`),
    })

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
              className="btn btn-sm gap-1.5"
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
      {picker && accounts.data && (
        <StartPicker accounts={accounts.data} choice={current} onChange={setChoice} />
      )}
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
