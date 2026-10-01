/**
 * Shipping, as it happens and after (Launch P3, plan §1.10; issue #1): the gate's attempts —
 * `ship.gate` rows, one per step Launch ran (lint, typecheck, the tests on a throwaway database),
 * grouped by attempt, with a Claude fix turn between a red attempt and the next — the pull request
 * once it is open, and its CI — `GET /:id/pr`, check runs plus commit statuses folded into one
 * verdict, polled while anything is still running.
 *
 * Every fact here is a selector over rows the page already holds (`shipGates`) or the one PR read;
 * nothing is inferred. The tests row shows the target line the kit's `pnpm test` printed (kit
 * 0.16.0: which Neon branch, under which driver), so a reader sees WHERE the tests ran. A gate's output tail sits behind a disclosure: it is the evidence, not the
 * headline.
 *
 * P5 (plan §1.14–§1.15): ship scans the PR head for declared config and reports the shared config
 * the app does not hold as a `ship.config_needs` row (`shipConfigNeeds`, the latest one). The panel
 * says so in one line, with a link to the app's Config page where it is requested — a session never
 * receives a grant's values, so this is WHY the preview answers "not configured".
 *
 * Issue #5 (`docs/plans/i5-ship-to-staging.md`): after the PR the panel walks the landing —
 * gate → PR → CI → [review, naming who it waits on] → merged → released vX.Y.Z → live on staging —
 * from the pure `landingTimeline(events, session.landing, session.status)`, and ends on one of four sentences:
 * "Live on staging: <link>"; a reopen's reason (for red CI: the check, its link, the redacted log
 * tail and "Ask Claude to fix it", which sends the fix as an ordinary turn through `POST /turns` —
 * the composer's own route); a stall's reason and a link to the app page, where release, retry and
 * production live; or, in `pr` mode, today's "PR opened" with its CI.
 */
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  MinusCircleIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline'
import { approvalPath } from '@launch/shared/launch-approvals'
import { appConfigPath } from '@launch/shared/launch-grants'
import {
  type PrCheckState,
  type Session,
  type SessionEvent,
  type SessionShipConfigNeedsData,
  SHIP_GATE_STEP_LABELS,
  sessionShipConfigNeedsDataSchema,
} from '@launch/shared/launch-sessions'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApproval } from '@/ui/hooks/useApprovals'
import { turnInProgress, useSendTurn, useSessionPr } from '@/ui/hooks/useSessions'
import { ApiError } from '@/ui/lib/api-client'
import { waitingOn } from '@/ui/pages/approvals/approvalModel'
import {
  ciFixMessage,
  type LandingStep,
  type LandingStepStatus,
  type LandingView,
  landingTimeline,
  type ShipGate,
  shipGateAttempts,
  versionLabel,
} from '../sessionChatModel'

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

const CHECK_ICON: Record<
  PrCheckState,
  { icon: typeof CheckCircleIcon; className: string; label: string }
> = {
  success: { icon: CheckCircleIcon, className: 'text-success', label: 'passed' },
  failure: { icon: ExclamationCircleIcon, className: 'text-error', label: 'failed' },
  pending: { icon: ClockIcon, className: 'text-info', label: 'running' },
  none: { icon: MinusCircleIcon, className: 'text-muted', label: 'no checks' },
}

/** "12 s", "3 min 4 s". Pure. */
export function gateDuration(ms: number | undefined): string | null {
  if (ms === undefined) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
}

/** One step row's text: "Lint passed" / "Tests failed"; a step-less (old) row is the whole gate. */
export function gateStepText(gate: Pick<ShipGate, 'passed' | 'step'>): string {
  if (!gate.step) return gate.passed ? 'Lint, typecheck and tests passed' : 'Something failed'
  return `${SHIP_GATE_STEP_LABELS[gate.step]} ${gate.passed ? 'passed' : 'failed'}`
}

/** "3 of 4 checks passed · 1 running". Pure. */
export function checksSummary(checks: {
  total: number
  passed: number
  failed: number
  pending: number
}): string {
  if (checks.total === 0) return 'No CI checks reported yet'
  const parts = [`${checks.passed} of ${checks.total} checks passed`]
  if (checks.failed) parts.push(`${checks.failed} failed`)
  if (checks.pending) parts.push(`${checks.pending} running`)
  return parts.join(' · ')
}

const STEP_ICON: Record<LandingStepStatus, { icon: typeof CheckCircleIcon; className: string }> = {
  done: { icon: CheckCircleIcon, className: 'text-success' },
  failed: { icon: ExclamationCircleIcon, className: 'text-error' },
  active: { icon: ClockIcon, className: 'text-info' },
  pending: { icon: MinusCircleIcon, className: 'text-muted' },
}

/** The host of a URL, for a link's text ("expenses-staging.apps.example"); the URL if unparseable. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The panel's heading, from the landing (or the gate, before one). Pure. */
export function shipHeading(
  session: Pick<Session, 'status' | 'prNumber'>,
  view: LandingView | null
): { text: string; tone: 'moving' | 'done' | 'warning' | 'idle' } {
  if (view) {
    switch (view.outcome) {
      case 'live':
        return { text: 'Live on staging', tone: 'done' }
      case 'stalled':
        return { text: 'Merged, not live yet', tone: 'warning' }
      case 'reopened':
        return { text: 'Not shipped yet', tone: 'warning' }
      case 'pr':
        return { text: 'Shipped', tone: 'done' }
      case 'moving':
        return { text: 'Shipping', tone: 'moving' }
    }
  }
  if (session.status === 'shipping') return { text: 'Shipping', tone: 'moving' }
  if (session.prNumber !== null) return { text: 'Shipped', tone: 'done' }
  return { text: 'Ship', tone: 'idle' }
}

function StepRow({
  step,
  waiting,
  approvalId,
}: {
  step: LandingStep
  waiting: string | null
  approvalId: string | null
}) {
  const tone = STEP_ICON[step.status]
  const Icon = tone.icon
  return (
    <li className="text-sm" data-landing-step={step.key} data-step-status={step.status}>
      <div className="flex items-center gap-2">
        {step.status === 'active' ? (
          <span className="loading loading-spinner loading-xs shrink-0 text-info" />
        ) : (
          <Icon className={`h-4 w-4 shrink-0 ${tone.className}`} aria-hidden="true" />
        )}
        <span className={step.status === 'pending' ? 'text-muted' : undefined}>{step.label}</span>
        {step.url && step.key !== 'staging' && (
          <a
            href={step.url}
            target="_blank"
            rel="noopener noreferrer"
            className="link link-hover text-xs text-muted"
            aria-label={`Open ${step.label}`}
          >
            <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
      {step.detail && <p className="ml-6 mt-0.5 text-xs text-muted">{step.detail}</p>}
      {step.key === 'approval' && step.status === 'active' && (
        <p className="ml-6 mt-0.5 text-xs text-secondary" data-testid="review-waiting">
          {waiting ? `Waiting on ${waiting}.` : 'Waiting for an approver in Launch.'}
          {approvalId && (
            <>
              {' '}
              <Link to={approvalPath(approvalId)} className="link font-medium">
                Open the request
              </Link>
            </>
          )}
        </p>
      )}
    </li>
  )
}

/** A reopen: the reason, and for red CI the check, its log and "Ask Claude to fix it". */
function ReopenNotice({ session, view }: { session: Session; view: LandingView }) {
  const send = useSendTurn(session.id)
  const [refused, setRefused] = useState<string | null>(null)
  const reopen = view.reopen
  if (!reopen) return null
  const check = view.failedCheck
  const canAsk =
    check !== null &&
    session.viewerCanManage &&
    (session.status === 'ready' || session.status === 'suspended') &&
    !turnInProgress(session)

  return (
    <div className="alert alert-warning alert-soft block text-sm" role="status">
      <p className="font-medium" data-testid="ship-reopened">
        {reopen.text}
      </p>
      {reopen.note && <p className="mt-1 whitespace-pre-wrap">{reopen.note}</p>}
      {check && (
        <div className="mt-2 space-y-1" data-testid="ci-failure">
          <p>
            Failing check:{' '}
            {check.url ? (
              <a
                href={check.url}
                target="_blank"
                rel="noopener noreferrer"
                className="link font-medium"
              >
                {check.name}
              </a>
            ) : (
              <span className="font-medium">{check.name}</span>
            )}
          </p>
          {check.logTail && (
            <details open>
              <summary className="cursor-pointer select-none text-xs">The end of its log</summary>
              <pre className="surface-inset mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 text-xs">
                {check.logTail}
              </pre>
            </details>
          )}
        </div>
      )}
      <p className="mt-2 text-xs">
        The session is open again: change what’s needed, then press Ship.
        {session.status === 'suspended' && ' It’s asleep — your next message wakes it.'}
      </p>
      {canAsk && check && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-sm btn-primary gap-1.5"
            disabled={send.isPending}
            onClick={() => {
              setRefused(null)
              send.mutate(
                { message: ciFixMessage(check, FIX_MESSAGE_MAX) },
                {
                  onError: error =>
                    setRefused(
                      error instanceof ApiError && error.status === 409
                        ? 'Claude is busy with another message — try again when it finishes.'
                        : error.message
                    ),
                }
              )
            }}
          >
            {send.isPending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <SparklesIcon className="h-4 w-4" />
            )}
            Ask Claude to fix it
          </button>
          {refused && <span className="text-xs">{refused}</span>}
        </div>
      )}
    </div>
  )
}

export function ShipPanel({
  session,
  gates,
  events = [],
  configNeeds = null,
  appSlug,
}: {
  session: Session
  gates: readonly ShipGate[]
  /** The session's rows: the landing's steps are read from them. */
  events?: readonly SessionEvent[]
  configNeeds?: SessionShipConfigNeedsData | null
  appSlug?: string
}) {
  const view = useMemo(
    () => landingTimeline(events, session.landing, session.status),
    [events, session.landing, session.status]
  )
  const hasPr = session.prNumber !== null
  // The gate is running (before the PR, or a re-ship's after a reopen).
  const shipping = session.status === 'shipping' && !view
  // Today's PR/CI view: before issue #5's landing, in `pr` mode, and while CI is the stage.
  const showChecks = hasPr && (!view || view.outcome === 'pr' || view.stage === 'ci')
  const pr = useSessionPr(session.id, showChecks)
  const checks = pr.data?.checks ?? session.prChecks
  const prUrl = pr.data?.prUrl ?? session.prUrl ?? view?.prUrl ?? null
  const reviewing = view?.outcome === 'moving' && view.stage === 'approval'
  const approval = useApproval(reviewing && view.approvalId ? view.approvalId : '')
  const waiting =
    reviewing && approval.data?.status === 'pending' ? waitingOn(approval.data).who || null : null
  const heading = shipHeading(session, view)

  return (
    <section className="surface-panel space-y-3" aria-labelledby="ship-panel-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="ship-panel-title" className="flex items-center gap-2 text-base font-semibold">
          {heading.tone === 'moving' && (
            <span className="loading loading-spinner loading-xs text-primary" />
          )}
          {heading.tone === 'done' && <CheckCircleIcon className="h-5 w-5 text-success" />}
          {heading.tone === 'warning' && (
            <ExclamationTriangleIcon className="h-5 w-5 text-warning" />
          )}
          {heading.text}
        </h2>
        {hasPr && prUrl && (
          <a href={prUrl} target="_blank" rel="noopener noreferrer" className="btn btn-sm gap-1.5">
            Pull request #{session.prNumber}
            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
          </a>
        )}
      </div>

      {shipping && gates.length === 0 && (
        <p className="text-sm text-secondary">
          Launch is running lint, typecheck and the tests (on a throwaway copy of the database). If
          a step fails, Claude gets one turn to fix it and Launch runs the checks again; when they
          pass, Launch opens a pull request.
        </p>
      )}

      {gates.length > 0 && (
        <ol className="space-y-2" aria-label="Checks before shipping">
          {shipGateAttempts(gates).map(attempt => (
            <li
              key={attempt.attempt}
              className="text-sm"
              data-gate={attempt.passed ? 'passed' : 'failed'}
            >
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Attempt {attempt.attempt}
              </p>
              <ul className="mt-1 space-y-1">
                {attempt.steps.map(gate => (
                  <li key={gate.id} data-gate-step={gate.step ?? 'gate'}>
                    <div className="flex items-center gap-2">
                      {gate.passed ? (
                        <CheckCircleIcon className="h-4 w-4 shrink-0 text-success" />
                      ) : (
                        <ExclamationCircleIcon className="h-4 w-4 shrink-0 text-warning" />
                      )}
                      <span>{gateStepText(gate)}</span>
                      {gate.command && (
                        <span className="font-mono text-xs text-muted">{gate.command}</span>
                      )}
                      {gateDuration(gate.durationMs) && (
                        <span className="ml-auto shrink-0 text-xs text-muted">
                          {gateDuration(gate.durationMs)}
                        </span>
                      )}
                    </div>
                    {gate.target && (
                      <p className="ml-6 mt-0.5 font-mono text-xs text-muted" data-gate-target>
                        {gate.target}
                      </p>
                    )}
                    {gate.output && (
                      <details className="ml-6 mt-1">
                        <summary className="cursor-pointer select-none text-xs text-muted">
                          Output
                        </summary>
                        <pre className="surface-inset mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 text-xs">
                          {gate.output}
                        </pre>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
          {shipping && gates.at(-1)?.passed === false && (
            <li className="flex items-center gap-2 text-sm text-muted">
              <span className="loading loading-dots loading-xs" />
              Claude is fixing it…
            </li>
          )}
          {shipping && gates.at(-1)?.passed === true && gates.at(-1)?.step !== 'test' && (
            <li className="flex items-center gap-2 text-sm text-muted">
              <span className="loading loading-dots loading-xs" />
              Running the next check…
            </li>
          )}
        </ol>
      )}

      {configNeeds && (
        <div
          className="alert alert-info alert-soft text-sm"
          role="status"
          data-testid="config-needs"
        >
          <span>
            This pull request needs shared config the app doesn’t hold yet:{' '}
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

      {view && view.outcome !== 'pr' && (
        <ol className="space-y-1.5" aria-label="After the checks">
          {view.steps.map(step => (
            <StepRow key={step.key} step={step} waiting={waiting} approvalId={view.approvalId} />
          ))}
        </ol>
      )}

      {view?.outcome === 'live' && (
        <div className="alert alert-success alert-soft text-sm" role="status">
          <CheckCircleIcon className="h-5 w-5" />
          <span data-testid="ship-live">
            Live on staging:{' '}
            {view.stagingUrl ? (
              <a
                href={view.stagingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="link font-medium"
              >
                {urlHost(view.stagingUrl)}
              </a>
            ) : (
              'the staging environment'
            )}
            {view.version && <>, version {versionLabel(view.version)}</>}
          </span>
        </div>
      )}

      {view?.outcome === 'reopened' && <ReopenNotice session={session} view={view} />}

      {view?.outcome === 'stalled' && view.stalled && (
        <div className="alert alert-warning alert-soft block text-sm" role="status">
          <p className="font-medium" data-testid="ship-stalled">
            {view.stalled.text}
          </p>
          {view.stalled.note && view.stalled.note !== view.stalled.text && (
            <p className="mt-1">{view.stalled.note}</p>
          )}
          <p className="mt-1 text-xs">
            Nothing is lost — the change is in the main branch. Release, retry and production are on{' '}
            {appSlug ? (
              <Link to={`/apps/${appSlug}`} className="link font-medium">
                the app’s page
              </Link>
            ) : (
              'the app’s page'
            )}
            .
          </p>
        </div>
      )}

      {view?.outcome === 'pr' && (
        <p className="text-sm text-secondary" data-testid="ship-pr-mode">
          The pull request is open for review on GitHub; Launch leaves merging it to you.
        </p>
      )}

      {showChecks && (
        <div>
          {/* While CI is the landing's stage, the CI step already says the round in words. */}
          {(!view || view.outcome === 'pr') && (
            <p className="text-sm font-medium" data-testid="checks-summary">
              {checks ? checksSummary(checks) : 'Waiting for CI to report…'}
            </p>
          )}
          {checks && checks.checks.length > 0 && (
            <ul className="mt-2 space-y-1" aria-label="CI checks">
              {checks.checks.map(check => {
                const tone = CHECK_ICON[check.state]
                const Icon = tone.icon
                return (
                  <li
                    key={`${check.source}:${check.name}`}
                    className="flex items-center gap-2 text-sm"
                    data-check-state={check.state}
                  >
                    <Icon
                      className={`h-4 w-4 shrink-0 ${tone.className}`}
                      aria-label={tone.label}
                    />
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
                    <span className="ml-auto shrink-0 text-xs text-muted">{tone.label}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
