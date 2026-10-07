/**
 * The session page's header (Launch P3): where you are (breadcrumb back to the app), what state the
 * session is in, what it has cost against its cap, and the lifecycle actions.
 *
 * - **Ship is the page's one hero action** (`.btn-flame`): it appears once there is something to
 *   ship (a turn has run) and the session is idle, and confirms first — shipping runs the gate
 *   (Launch runs it; Claude only fixes what fails) and opens the pull request; then (issue #5,
 *   the app's `sessionShip: 'staging'`, the default) waits for CI and any review, merges and
 *   puts it live on staging — the confirm says which, from the app's ship settings. End stays
 *   available while it ships (the gate stops, a pending review is withdrawn), except while the
 *   merge itself runs (`landing.stage === 'merging'`), which cannot stop half-way.
 * - **End** confirms too, and says what is kept (the branch) and what is not (the sandbox and its
 *   database). **Resume** is offered while the session is asleep.
 * - **Stop** (issue #21) is here only for a kit upgrade session, which has no composer to hold it
 *   (`sessionTakesMessages`): it stops the running turn (`POST /:id/cancel`), as the composer's
 *   Stop does for an ordinary session.
 * - **The cost meter** is spent / cap with a bar that turns amber past 80 % and red at the cap;
 *   the person who may extend the budget (the app's owners and admins) gets "Extend" beside it;
 *   the session's creator without that right gets "Ask for more" (a `session.budget` approval,
 *   P4), and while that request is open a link to it instead.
 * - Only the people who may act on the session (`viewerCanManage`) see the buttons at all.
 * - §18.22: a session on another runtime, or billed to a personal account, says so in one muted
 *   line beside the branch (`sessionRuntimeLine`) — nothing for Claude Code on Launch's key, the
 *   default. A personal-account session has no money budget, so its header shows no meter.
 */
import {
  ArrowPathIcon,
  ChevronLeftIcon,
  RocketLaunchIcon,
  StopCircleIcon,
  StopIcon,
} from '@heroicons/react/24/outline'
import { AGENT_RUNTIME_LABELS, agentAccountLabel } from '@launch/shared/launch-agents'
import { approvalPath } from '@launch/shared/launch-approvals'
import type { AppShipSettings } from '@launch/shared/launch-apps'
import {
  type Session,
  SHIP_GATE_ATTEMPTS,
  sessionTakesMessages,
} from '@launch/shared/launch-sessions'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { formatCost } from '@/ui/components/ai/StatRows'
import { ConfirmModal } from '@/ui/components/shared'
import {
  turnInProgress,
  useCancelTurn,
  useEndSession,
  useResumeSession,
  useShipSession,
} from '@/ui/hooks/useSessions'
import type { BudgetAccess } from './budgetAccess'
import { SessionStatusBadge } from './SessionStatusBadge'

/** Spent as a fraction of the cap, and the tone of the bar. Pure. */
export function budgetMeter(budget: Session['budget']): {
  fraction: number
  tone: 'ok' | 'warning' | 'error'
} {
  const fraction =
    budget.capMicrocents > 0 ? Math.min(1, budget.spentMicrocents / budget.capMicrocents) : 1
  return { fraction, tone: fraction >= 1 ? 'error' : fraction >= 0.8 ? 'warning' : 'ok' }
}

const METER_CLASS = { ok: 'progress-primary', warning: 'progress-warning', error: 'progress-error' }

/**
 * §18.22: what the header says about the session's agent and billing — null for the default
 * (Claude Code on Launch's key), so nothing changes for the sessions everyone already has. Pure.
 */
export function sessionRuntimeLine(
  session: Pick<Session, 'runtime' | 'credentialSource'>
): string | null {
  const runtime = session.runtime ?? 'claude_code'
  const personal = session.credentialSource === 'user'
  if (runtime === 'claude_code' && !personal) return null
  const parts = [AGENT_RUNTIME_LABELS[runtime]]
  if (personal) parts.push(`billed to the creator’s ${agentAccountLabel(runtime)}`)
  return parts.join(' · ')
}

/** The session's display name: its title, else "Session <short id>". Pure. */
export function sessionName(session: Pick<Session, 'title' | 'shortId'>): string {
  return session.title?.trim() || `Session ${session.shortId.slice(0, 6)}`
}

/** Whether Ship is offered now. Pure. */
export function canShipNow(session: Session): boolean {
  return (
    session.viewerCanManage &&
    session.status === 'ready' &&
    session.turnCount > 0 &&
    !turnInProgress(session) &&
    session.requestedAction === null
  )
}

/**
 * What pressing Ship will do, in plain words, from the app's ship settings (issue #5) — unknown
 * settings read as the default, `staging`. Pure.
 */
export function shipPlanSentences(shipSettings: AppShipSettings | undefined): {
  what: string
  after: string
} {
  if (shipSettings?.sessionShip === 'pr') {
    return {
      what: 'when they pass, Launch opens a pull request for review on GitHub.',
      after: 'The session ends once the pull request is open.',
    }
  }
  const review =
    shipSettings?.review.mode === 'app_owners'
      ? ' waits for one of the app’s owners to approve it,'
      : shipSettings?.review.mode === 'groups'
        ? ' waits for an approval from the reviewing team,'
        : ''
  return {
    what: `when they pass, Launch opens a pull request, waits for CI,${review} merges it and puts it live on staging.`,
    after:
      'If CI fails or a reviewer sends it back, the session opens again so you can fix it. Production stays a separate step, from the app’s page.',
  }
}

export function SessionHeader({
  session,
  appSlug,
  appName,
  budget,
  onExtend,
  shipSettings,
}: {
  session: Session
  appSlug: string
  appName: string
  budget: BudgetAccess
  onExtend: () => void
  /** The app's ship settings (issue #5), for the confirm's wording; undefined while it loads. */
  shipSettings?: AppShipSettings
}) {
  const [confirm, setConfirm] = useState<'ship' | 'end' | null>(null)
  const ship = useShipSession(session.id)
  const end = useEndSession(session.id)
  const resume = useResumeSession(session.id)
  const cancel = useCancelTurn(session.id)
  const stopping = session.cancelRequested || cancel.isPending
  const meter = budgetMeter(session.budget)
  const plan = shipPlanSentences(shipSettings)
  const settled =
    session.status === 'shipped' || session.status === 'ended' || session.status === 'failed'
  // Issue #5: once the merge has started it cannot be stopped half-way (the route answers 409).
  const merging = session.landing?.stage === 'merging'
  const endable = session.viewerCanManage && !settled && session.status !== 'ending' && !merging
  const runtimeLine = sessionRuntimeLine(session)
  const metered = session.credentialSource !== 'user'

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <nav aria-label="Breadcrumb" className="text-xs text-muted">
          <Link
            to={`/apps/${appSlug}`}
            className="inline-flex items-center gap-0.5 hover:underline"
          >
            <ChevronLeftIcon className="h-3 w-3" />
            {appName}
          </Link>
        </nav>
        <div className="mt-0.5 flex min-w-0 items-center gap-2.5">
          <h1 className="truncate text-lg font-semibold tracking-tight">{sessionName(session)}</h1>
          <SessionStatusBadge status={session.status} shipping={session.shipping} />
          {session.branch && (
            <span className="hidden truncate font-mono text-xs text-muted md:inline">
              {session.branch}
            </span>
          )}
          {runtimeLine && (
            <span className="truncate text-xs text-muted" data-testid="session-runtime">
              {runtimeLine}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {metered && (
          <div className="flex items-center gap-2" data-testid="session-cost">
            <div className="text-right leading-tight">
              <p className="text-xs tabular-nums">
                <span className="font-medium">{formatCost(session.budget.spentMicrocents)}</span>
                <span className="text-muted"> of {formatCost(session.budget.capMicrocents)}</span>
              </p>
              <progress
                className={`progress h-1.5 w-28 ${METER_CLASS[meter.tone]}`}
                value={Math.round(meter.fraction * 100)}
                max={100}
                aria-label="Budget used"
              />
            </div>
            {!settled && budget.pendingApprovalId ? (
              <Link
                to={approvalPath(budget.pendingApprovalId)}
                className="btn btn-ghost btn-xs text-warning"
              >
                Budget request pending
              </Link>
            ) : (
              budget.mode &&
              !settled && (
                <button type="button" className="btn btn-ghost btn-xs" onClick={onExtend}>
                  {budget.mode === 'extend' ? 'Extend' : 'Ask for more'}
                </button>
              )
            )}
          </div>
        )}

        {session.viewerCanManage && session.status === 'suspended' && (
          <button
            type="button"
            className="btn btn-sm btn-primary gap-1.5"
            onClick={() => resume.mutate()}
            disabled={resume.isPending || session.requestedAction === 'resume'}
          >
            <ArrowPathIcon className="h-4 w-4" />
            {session.requestedAction === 'resume' ? 'Waking…' : 'Resume'}
          </button>
        )}
        {session.viewerCanManage &&
          !sessionTakesMessages(session) &&
          session.status === 'working' && (
            <button
              type="button"
              className="btn btn-sm btn-ghost gap-1.5"
              onClick={() => cancel.mutate()}
              disabled={stopping}
              aria-label={stopping ? 'Stopping' : 'Stop this turn'}
            >
              {stopping ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <StopIcon className="h-4 w-4" />
              )}
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          )}
        {endable && (
          <button
            type="button"
            className="btn btn-sm btn-ghost gap-1.5"
            onClick={() => setConfirm('end')}
            disabled={session.requestedAction === 'end'}
          >
            {session.requestedAction === 'end' ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <StopCircleIcon className="h-4 w-4" />
            )}
            {session.requestedAction === 'end' ? 'Ending…' : 'End'}
          </button>
        )}
        {session.viewerCanManage &&
          (session.status === 'ready' || session.status === 'shipping') && (
            <button
              type="button"
              className="btn btn-sm btn-primary btn-flame gap-1.5"
              onClick={() => setConfirm('ship')}
              disabled={!canShipNow(session) || ship.isPending}
              title={
                session.turnCount === 0
                  ? 'Make a change first'
                  : turnInProgress(session)
                    ? 'Wait for the current turn to finish'
                    : undefined
              }
            >
              {session.status === 'shipping' || session.requestedAction === 'ship' ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <RocketLaunchIcon className="h-4 w-4" />
              )}
              {session.status === 'shipping' ? 'Shipping…' : 'Ship'}
            </button>
          )}
      </div>

      <ConfirmModal
        isOpen={confirm === 'ship'}
        title="Ship these changes?"
        message={
          <div className="space-y-2 text-sm">
            <p>
              Launch runs lint, typecheck and the tests on{' '}
              <span className="font-mono text-xs">{session.branch ?? 'its branch'}</span>. If one
              fails, Claude fixes it and Launch runs them again (up to {SHIP_GATE_ATTEMPTS} tries);{' '}
              {plan.what}
            </p>
            <p className="text-secondary">{plan.after}</p>
          </div>
        }
        confirmText="Ship"
        isLoading={ship.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => ship.mutate(undefined, { onSettled: () => setConfirm(null) })}
      />
      <ConfirmModal
        isOpen={confirm === 'end'}
        title="End this session?"
        message={
          <div className="space-y-2 text-sm">
            <p>The sandbox and its database are deleted, and the chat can no longer continue.</p>
            {session.branch && (
              <p className="text-secondary">
                Every change so far stays on the branch{' '}
                <span className="font-mono text-xs">{session.branch}</span>.
              </p>
            )}
          </div>
        }
        confirmText="End session"
        confirmButtonClass="btn-error"
        isLoading={end.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => end.mutate(undefined, { onSettled: () => setConfirm(null) })}
      />
    </header>
  )
}
