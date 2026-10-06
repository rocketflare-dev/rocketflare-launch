/**
 * Shipping, in words a non-engineer can follow (issue #22): one ordered timeline — checking the
 * change → the pull request → the automatic checks → a review, only when one is required → merging
 * → releasing → live on staging → ready to promote — each stage done, now, next, needs you or
 * failed, from the pure `shipTimeline` (`shipTimelineModel.ts`, worded by
 * `@launch/shared/launch-ship-progress`, which the CLI and the app page's lists share).
 *
 * - **Now** is the one prominent row: what is happening, a ticking elapsed time and, when this
 *   session has timed the step before, how long it usually takes. The current stage's sentence is
 *   announced once (`aria-live="polite"`, a visually hidden line that changes only with the stage);
 *   the clock is outside it, so it is never re-announced.
 * - **Needs you** is the only loud state — a review to give, a failure Claude couldn't fix, a stall
 *   — with the one button that does the next thing (Review the change, Ask Claude to fix it, Re-run
 *   CI, Release by hand on the app's page).
 * - A red step being fixed reads as a problem being dealt with ("The tests found a problem. Claude
 *   is fixing it (try 2 of 3)."), and earlier tries collapse to one line each.
 * - **Details** (one disclosure) keeps everything an engineer wants: each try's steps with their
 *   commands, times, the test target line (which Neon branch) and output; the checks by name; a red
 *   check's log tail; the landing's own error.
 *
 * While the ship is under way the page puts this panel IN PLACE of the preview (`fill`, with a
 * small "Show preview" link — `onShowPreview`); once it ends it sits above the preview again.
 * Every fact is a selector over rows the page already holds plus the one PR read and the review
 * request; nothing is inferred.
 *
 * P5: a `ship.config_needs` row (shared config the app does not hold) is one line with a link to
 * the app's Config page, where it is requested.
 */
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'
import { approvalPath } from '@launch/shared/launch-approvals'
import { appConfigPath } from '@launch/shared/launch-grants'
import {
  type LandingRetryRequest,
  type LandingReviewMode,
  type PrCheckState,
  type Session,
  type SessionEvent,
  type SessionShipConfigNeedsData,
  SHIP_GATE_STEP_LABELS,
  sessionShipConfigNeedsDataSchema,
} from '@launch/shared/launch-sessions'
import { shipDurationText } from '@launch/shared/launch-ship-progress'
import { type ReactNode, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApproval } from '@/ui/hooks/useApprovals'
import { turnInProgress, useRetryLanding, useSendTurn, useSessionPr } from '@/ui/hooks/useSessions'
import { ApiError } from '@/ui/lib/api-client'
import { waitingOn } from '@/ui/pages/approvals/approvalModel'
import { ciFixMessage, type ShipGate, shipGateAttempts } from '../sessionChatModel'
import {
  gateFixMessage,
  type ShipNeedsYou,
  type ShipTimelineStage,
  type ShipTimelineView,
  shipTimeline,
} from '../shipTimelineModel'
import { FirstReplyWait } from './FirstReplyWait'
import { agentName } from './SessionComposer'
import { useElapsed } from './useElapsed'

/** The fix message stays well under `SESSION_MESSAGE_MAX`: the turn also gets the failure itself. */
const FIX_MESSAGE_MAX = 6000

/** The latest `ship.config_needs` row's data, or null (none, or nothing needed). Pure. */
export function shipConfigNeeds(
  events: readonly SessionEvent[]
): SessionShipConfigNeedsData | null {
  let latest: { seq: number; data: SessionShipConfigNeedsData } | null = null
  for (const event of events) {
    if (event.type !== 'ship.config_needs') continue
    const parsed = sessionShipConfigNeedsDataSchema.safeParse(event.data)
    if (parsed.success && (!latest || event.seq > latest.seq))
      latest = { seq: event.seq, data: parsed.data }
  }
  if (!latest || latest.data.needs.length === 0) return null
  return latest.data
}

/** "M365 (M365_TENANT_ID, M365_CLIENT_SECRET)" joined with "and". Pure. */
export function configNeedsSentence(needs: SessionShipConfigNeedsData['needs']): string {
  const parts = needs.map(need =>
    need.keys.length ? `${need.displayName} (${need.keys.join(', ')})` : need.displayName
  )
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/** "12 s", "3 min 4 s". Pure. */
export function gateDuration(ms: number | undefined): string | null {
  return ms === undefined ? null : shipDurationText(ms)
}

/** One step row's text in Details: "Lint passed" / "Tests failed"; a step-less (old) row is the gate. */
export function gateStepText(gate: Pick<ShipGate, 'passed' | 'step'>): string {
  if (!gate.step) return gate.passed ? 'Lint, typecheck and tests passed' : 'Something failed'
  return `${SHIP_GATE_STEP_LABELS[gate.step]} ${gate.passed ? 'passed' : 'failed'}`
}

/** The host of a URL, for a link's text ("expenses-staging.apps.example"); the URL if unparseable. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const CHECK_LABEL: Record<PrCheckState, string> = {
  success: 'passed',
  failure: 'failed',
  pending: 'running',
  none: 'no result',
}

/** The stage's mark: a tick, the one accent's spinner for now, an open circle for next. */
function StageMark({ stage }: { stage: ShipTimelineStage }) {
  switch (stage.state) {
    case 'done':
      return <CheckCircleIcon className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
    case 'now':
      return stage.fixing ? (
        <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
      ) : (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
          <span className="loading loading-spinner loading-sm text-primary" />
        </span>
      )
    case 'needs_you':
      return <ExclamationCircleIcon className="h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
    case 'failed':
      return <XCircleIcon className="h-5 w-5 shrink-0 text-error" aria-hidden="true" />
    case 'next':
      return (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
          <span className="h-3 w-3 rounded-full border-2 border-base-300" />
        </span>
      )
  }
}

/** The current stage's clock: time so far, and how long it usually takes when known. */
function StageClock({ since, typical }: { since: Date; typical?: string }) {
  const elapsed = useElapsed(since)
  return (
    <p className="mt-0.5 text-xs text-muted">
      <span data-testid="stage-elapsed" className="tabular-nums">
        {shipDurationText(elapsed)}
      </span>{' '}
      so far{typical ? <span data-testid="stage-typical"> · {typical}</span> : null}
    </p>
  )
}

const STATE_WORD: Record<ShipTimelineStage['state'], string> = {
  done: 'Done',
  now: 'Now',
  next: 'Next',
  needs_you: 'Needs you',
  failed: 'Stopped',
}

function StageRow({
  stage,
  current,
  view,
  agent,
}: {
  stage: ShipTimelineStage
  current: boolean
  view: ShipTimelineView
  agent: string
}) {
  const muted = stage.state === 'next'
  return (
    <li
      className="flex gap-3"
      data-ship-stage={stage.key}
      data-stage-state={stage.fixing ? 'fixing' : stage.state}
      aria-current={current ? 'step' : undefined}
    >
      <StageMark stage={stage} />
      <div className="min-w-0 flex-1">
        <p
          className={
            current
              ? 'text-base font-semibold'
              : muted
                ? 'text-sm text-muted'
                : stage.state === 'needs_you'
                  ? 'text-sm font-medium'
                  : 'text-sm'
          }
        >
          <span className="sr-only">{STATE_WORD[stage.state]}: </span>
          {stage.text}
        </p>
        {stage.detail && (
          <p className="mt-0.5 text-sm text-secondary" data-testid="stage-detail">
            {stage.detail}
          </p>
        )}
        {current && stage.since && <StageClock since={stage.since} typical={stage.typical} />}
        {current && stage.fixing && view.fixTurn && (
          <FirstReplyWait agent={agent} turn={view.fixTurn} className="mt-0.5" />
        )}
        {stage.history && stage.history.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs text-muted" aria-label="Earlier tries">
            {stage.history.map(line => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {stage.link &&
          (stage.link.href.startsWith('/') ? (
            <Link to={stage.link.href} className="link link-hover mt-0.5 inline-block text-sm">
              {stage.link.label}
            </Link>
          ) : (
            <a
              href={stage.link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="link link-hover mt-0.5 inline-block text-sm"
            >
              {stage.key === 'staging' ? urlHost(stage.link.href) : stage.link.label}
            </a>
          ))}
      </div>
    </li>
  )
}

/** "Ask Claude to fix it": sends the fix as an ordinary turn (the composer's route). */
function AskToFix({ session, message }: { session: Session; message: string }) {
  const send = useSendTurn(session.id)
  const [refused, setRefused] = useState<string | null>(null)
  const agent = agentName(session.runtime)
  const canAsk =
    session.viewerCanManage &&
    (session.status === 'ready' || session.status === 'suspended') &&
    !turnInProgress(session)
  if (!canAsk) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={send.isPending}
        onClick={() => {
          setRefused(null)
          send.mutate(
            { message },
            {
              onError: error =>
                setRefused(
                  error instanceof ApiError && error.status === 409
                    ? `${agent} is busy with another message — try again when it finishes.`
                    : error.message
                ),
            }
          )
        }}
      >
        {send.isPending && <span className="loading loading-spinner loading-xs" />}
        Ask {agent} to fix it
      </button>
      {refused && <span className="text-xs">{refused}</span>}
    </div>
  )
}

/**
 * Issue #21: a landing that stalled before its release (`main_ci_failed`, `release_failed`) goes
 * round again from here — Retry re-runs the merge commit's failed checks (or the release), and on
 * red main checks, Release anyway cuts the release regardless (its deploy runs the full gate).
 */
function StallRetry({ session }: { session: Session }) {
  const retry = useRetryLanding(session.id)
  const [refused, setRefused] = useState<string | null>(null)
  const mainCi = session.landing?.stalledReason === 'main_ci_failed'
  const press = (action: LandingRetryRequest['action']) => {
    setRefused(null)
    retry.mutate({ action }, { onError: error => setRefused(error.message) })
  }
  const pending = retry.isPending ? retry.variables?.action : null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn btn-sm btn-primary gap-1.5"
        disabled={retry.isPending}
        onClick={() => press('retry')}
        data-testid="ship-stall-retry"
      >
        {pending === 'retry' ? (
          <span className="loading loading-spinner loading-xs" />
        ) : (
          <ArrowPathIcon className="h-4 w-4" />
        )}
        {mainCi ? 'Re-run main’s checks' : 'Retry the release'}
      </button>
      {mainCi && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={retry.isPending}
          onClick={() => press('release_anyway')}
          title="Cut the release without main’s checks passing; its deploy checks it again"
          data-testid="ship-stall-release-anyway"
        >
          {pending === 'release_anyway' && <span className="loading loading-spinner loading-xs" />}
          Release anyway
        </button>
      )}
      {refused && <span className="text-xs">{refused}</span>}
    </div>
  )
}

/** The loud block: what needs a person, and the one action that moves it on. */
function NeedsYouBlock({
  needsYou,
  session,
  appSlug,
}: {
  needsYou: ShipNeedsYou
  session: Session
  appSlug?: string
}) {
  const action = needsYou.action
  let button: ReactNode = null
  switch (action.kind) {
    case 'review':
      button = action.approvalId ? (
        <Link to={approvalPath(action.approvalId)} className="btn btn-sm btn-primary mt-2">
          Review the change
        </Link>
      ) : null
      break
    case 'fix_gate':
      button = (
        <AskToFix
          session={session}
          message={gateFixMessage(action.step, action.output, FIX_MESSAGE_MAX)}
        />
      )
      break
    case 'fix_ci':
      button = <AskToFix session={session} message={ciFixMessage(action.check, FIX_MESSAGE_MAX)} />
      break
    case 'retry_stall':
      button = <StallRetry session={session} />
      break
    case 'app_page':
      button = appSlug ? (
        <Link to={`/apps/${appSlug}`} className="btn btn-sm btn-primary mt-2">
          Release by hand on the app’s page
        </Link>
      ) : null
      break
    case 'ship_again':
      button = null
      break
  }
  const reopened = action.kind === 'fix_ci' || action.kind === 'ship_again'
  const handedBack = reopened || action.kind === 'fix_gate'
  return (
    <div className="alert alert-warning alert-soft block text-sm" data-testid="ship-needs-you">
      <p className="font-medium" data-testid="needs-you-text">
        {needsYou.text}
      </p>
      {needsYou.note && <p className="mt-1 whitespace-pre-wrap">{needsYou.note}</p>}
      {handedBack && (
        <p className="mt-1 text-xs">
          The session is open again: change what’s needed, then press Ship.
          {session.status === 'suspended' && ' It’s asleep — your next message wakes it.'}
        </p>
      )}
      {(action.kind === 'retry_stall' || action.kind === 'app_page') && (
        <p className="mt-1 text-xs">Nothing is lost — the change is in the main branch.</p>
      )}
      {button}
    </div>
  )
}

/** Everything an engineer wants, behind one disclosure. */
function ShipDetails({
  view,
  session,
  checks,
}: {
  view: ShipTimelineView
  session: Session
  checks: NonNullable<Session['prChecks']> | null
}) {
  const attempts = shipGateAttempts(view.gates)
  const running = view.running
  if (running && !attempts.some(a => a.attempt === running.attempt)) {
    attempts.push({ attempt: running.attempt, passed: false, steps: [] })
  }
  const failedCheck = view.needsYou?.action.kind === 'fix_ci' ? view.needsYou.action.check : null
  const landingError = session.landing?.error ?? null
  const prUrl = session.prUrl ?? view.landing?.prUrl ?? null
  const empty =
    attempts.length === 0 && !checks?.checks.length && !failedCheck && !landingError && !prUrl
  if (empty) return null
  return (
    <details
      className="border-t border-[color:var(--border-subtle)] pt-3"
      data-testid="ship-details"
    >
      <summary className="cursor-pointer select-none text-sm text-secondary">Details</summary>
      <div className="mt-3 space-y-4 text-sm">
        {prUrl && (
          <p>
            <a href={prUrl} target="_blank" rel="noopener noreferrer" className="link">
              Pull request #{session.prNumber ?? view.landing?.prNumber}
            </a>
          </p>
        )}
        {attempts.length > 0 && (
          <ol className="space-y-2" aria-label="Checks before shipping">
            {attempts.map(attempt => (
              <li
                key={attempt.attempt}
                data-gate={
                  running?.attempt === attempt.attempt
                    ? 'running'
                    : attempt.passed
                      ? 'passed'
                      : 'failed'
                }
              >
                <p className="text-xs font-medium text-muted">Try {attempt.attempt}</p>
                <ul className="mt-1 space-y-1">
                  {attempt.steps.map(gate => (
                    <li key={gate.id} data-gate-step={gate.step ?? 'gate'}>
                      <div className="flex flex-wrap items-center gap-x-2">
                        <span>{gateStepText(gate)}</span>
                        {gate.command && (
                          <span className="font-mono text-xs text-muted">{gate.command}</span>
                        )}
                        {gateDuration(gate.durationMs) && (
                          <span className="ml-auto text-xs text-muted tabular-nums">
                            {gateDuration(gate.durationMs)}
                          </span>
                        )}
                      </div>
                      {gate.target && (
                        <p className="mt-0.5 font-mono text-xs text-muted" data-gate-target>
                          {gate.target}
                        </p>
                      )}
                      {gate.output && (
                        <pre className="surface-inset mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 text-xs">
                          {gate.output}
                        </pre>
                      )}
                    </li>
                  ))}
                  {running?.attempt === attempt.attempt && (
                    <li data-gate-step={running.step} data-gate-running>
                      Running {SHIP_GATE_STEP_LABELS[running.step].toLowerCase()}{' '}
                      <span className="font-mono text-xs text-muted">{running.command}</span>
                    </li>
                  )}
                </ul>
              </li>
            ))}
          </ol>
        )}
        {checks && checks.checks.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted">Checks on the pull request</p>
            <ul className="mt-1 space-y-1" aria-label="CI checks">
              {checks.checks.map(check => (
                <li
                  key={`${check.source}:${check.name}`}
                  className="flex items-center gap-2"
                  data-check-state={check.state}
                >
                  {check.url ? (
                    <a
                      href={check.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="link link-hover truncate"
                    >
                      {check.name}
                    </a>
                  ) : (
                    <span className="truncate">{check.name}</span>
                  )}
                  <span className="ml-auto shrink-0 text-xs text-muted">
                    {check.queued ? 'waiting to start' : CHECK_LABEL[check.state]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {failedCheck && (
          <div data-testid="ci-failure">
            <p>
              Failing check:{' '}
              {failedCheck.url ? (
                <a
                  href={failedCheck.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link font-medium"
                >
                  {failedCheck.name}
                </a>
              ) : (
                <span className="font-medium">{failedCheck.name}</span>
              )}
            </p>
            {failedCheck.logTail && (
              <pre className="surface-inset mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 text-xs">
                {failedCheck.logTail}
              </pre>
            )}
          </div>
        )}
        {landingError && view.needsYou?.note !== landingError && (
          <p className="text-secondary" data-testid="landing-error">
            {landingError}
          </p>
        )}
      </div>
    </details>
  )
}

export function ShipPanel({
  session,
  events = [],
  configNeeds = null,
  appSlug,
  plan = null,
  onShowPreview,
  fill = false,
}: {
  session: Session
  /** The session's rows: the timeline is read from them. */
  events?: readonly SessionEvent[]
  configNeeds?: SessionShipConfigNeedsData | null
  appSlug?: string
  /** The app's ship mode and review, before the landing snapshots them. */
  plan?: { mode: 'staging' | 'pr'; review: LandingReviewMode } | null
  /** Set while the panel stands in for the preview: the small link that brings it back. */
  onShowPreview?: () => void
  /** Fill the pane it replaces (the preview's). */
  fill?: boolean
}) {
  const agent = agentName(session.runtime)
  // A first pass without the PR read decides whether the PR's checks are worth reading.
  const draft = useMemo(
    () => shipTimeline({ events, session, agent, plan }),
    [events, session, agent, plan]
  )
  const hasPr = session.prNumber !== null
  const checksStage = draft?.stages.find(s => s.key === 'checks')
  const showChecks =
    hasPr && Boolean(checksStage && (checksStage.state === 'now' || draft?.outcome === 'pr'))
  const pr = useSessionPr(session.id, showChecks)
  const checks = pr.data?.checks ?? session.prChecks ?? null
  const reviewing = draft?.landing?.outcome === 'moving' && draft.landing.stage === 'approval'
  const approvalId = reviewing ? (draft?.landing?.approvalId ?? '') : ''
  const approval = useApproval(approvalId)
  const pending = approval.data?.status === 'pending' ? approval.data : null
  const reviewWaitingOn = pending ? waitingOn(pending).who || null : null
  const reviewCanDecide = pending ? pending.canDecide : null
  const view = useMemo(
    () =>
      shipTimeline({
        events,
        session,
        agent,
        plan,
        checks: showChecks ? checks : null,
        review:
          reviewCanDecide === null
            ? null
            : { waitingOn: reviewWaitingOn, canDecide: reviewCanDecide },
        ...(appSlug ? { appPath: `/apps/${appSlug}` } : {}),
      }),
    [events, session, agent, plan, showChecks, checks, reviewWaitingOn, reviewCanDecide, appSlug]
  )
  if (!view) return null
  const current = view.current

  return (
    <section
      className={`surface-panel space-y-4 ${fill ? 'h-full overflow-y-auto' : ''}`}
      aria-labelledby="ship-panel-title"
      data-testid="ship-panel"
      data-ship-outcome={view.outcome}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="ship-panel-title" className="text-base font-semibold">
          {view.headline}
        </h2>
        {onShowPreview && (
          <button
            type="button"
            className="link link-hover text-sm text-secondary"
            onClick={onShowPreview}
          >
            Show preview
          </button>
        )}
      </div>

      {/* Said once per stage; the clock below is not in here, so it is never re-announced. */}
      <p className="sr-only" aria-live="polite" data-testid="ship-announce">
        {current ? current.text : view.headline}
      </p>

      {view.needsYou && (
        <NeedsYouBlock needsYou={view.needsYou} session={session} appSlug={appSlug} />
      )}

      <ol className="space-y-3" aria-label="Shipping steps">
        {view.stages.map(stage => (
          <StageRow
            key={stage.key}
            stage={stage}
            current={stage === current}
            view={view}
            agent={agent}
          />
        ))}
      </ol>

      {configNeeds && (
        <div
          className="alert alert-info alert-soft text-sm"
          role="status"
          data-testid="config-needs"
        >
          <span>
            This change needs secrets the app doesn’t hold yet:{' '}
            {configNeedsSentence(configNeeds.needs)}. The preview answers “not configured” for it
            until it is granted.
            {appSlug && (
              <>
                {' '}
                <Link to={appConfigPath(appSlug)} className="link font-medium">
                  Request it
                </Link>
              </>
            )}
          </span>
        </div>
      )}

      <ShipDetails view={view} session={session} checks={checks} />
    </section>
  )
}
