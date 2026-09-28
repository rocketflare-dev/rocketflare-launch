/**
 * The session page's header (Launch P3): where you are (breadcrumb back to the app), what state the
 * session is in, what it has cost against its cap, and the lifecycle actions.
 *
 * - **Ship is the page's one hero action** (`.btn-flame`): it appears once there is something to
 *   ship (a turn has run) and the session is idle, and confirms first — shipping runs the gate,
 *   lets Claude fix what fails, opens the pull request and ENDS the session.
 * - **End** confirms too, and says what is kept (the branch) and what is not (the sandbox and its
 *   database). **Resume** is offered while the session is asleep.
 * - **The cost meter** is spent / cap with a bar that turns amber past 80 % and red at the cap;
 *   the person who may extend the budget (the app's owners and admins) gets "Extend" beside it;
 *   the session's creator without that right gets "Ask for more" (a `session.budget` approval,
 *   P4), and while that request is open a link to it instead.
 * - Only the people who may act on the session (`viewerCanManage`) see the buttons at all.
 */
import {
  ArrowPathIcon,
  ChevronLeftIcon,
  RocketLaunchIcon,
  StopCircleIcon,
} from '@heroicons/react/24/outline'
import { approvalPath } from '@launch/shared/launch-approvals'
import type { Session } from '@launch/shared/launch-sessions'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { formatCost } from '@/ui/components/ai/StatRows'
import { ConfirmModal } from '@/ui/components/shared'
import {
  turnInProgress,
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

export function SessionHeader({
  session,
  appSlug,
  appName,
  budget,
  onExtend,
}: {
  session: Session
  appSlug: string
  appName: string
  budget: BudgetAccess
  onExtend: () => void
}) {
  const [confirm, setConfirm] = useState<'ship' | 'end' | null>(null)
  const ship = useShipSession(session.id)
  const end = useEndSession(session.id)
  const resume = useResumeSession(session.id)
  const meter = budgetMeter(session.budget)
  const settled =
    session.status === 'shipped' || session.status === 'ended' || session.status === 'failed'
  const endable = session.viewerCanManage && !settled && session.status !== 'ending'

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
          <SessionStatusBadge status={session.status} />
          {session.branch && (
            <span className="hidden truncate font-mono text-xs text-muted md:inline">
              {session.branch}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
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
          {!settled && budget.pendingApprovalId && budget.mode !== 'extend' ? (
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
        {endable && (
          <button
            type="button"
            className="btn btn-sm btn-ghost gap-1.5"
            onClick={() => setConfirm('end')}
            disabled={session.requestedAction === 'end'}
          >
            <StopCircleIcon className="h-4 w-4" />
            End
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
              Claude runs lint, typecheck and the tests, fixes anything that fails, and opens a pull
              request from{' '}
              <span className="font-mono text-xs">{session.branch ?? 'its branch'}</span> for
              review.
            </p>
            <p className="text-secondary">The session ends once the pull request is open.</p>
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
