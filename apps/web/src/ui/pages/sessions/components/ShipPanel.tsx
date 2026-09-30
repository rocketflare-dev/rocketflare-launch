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
 */
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  MinusCircleIcon,
} from '@heroicons/react/24/outline'
import { appConfigPath } from '@launch/shared/launch-grants'
import {
  type PrCheckState,
  type Session,
  type SessionEvent,
  type SessionShipConfigNeedsData,
  SHIP_GATE_STEP_LABELS,
  sessionShipConfigNeedsDataSchema,
} from '@launch/shared/launch-sessions'
import { Link } from 'react-router-dom'
import { useSessionPr } from '@/ui/hooks/useSessions'
import { type ShipGate, shipGateAttempts } from '../sessionChatModel'

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

export function ShipPanel({
  session,
  gates,
  configNeeds = null,
  appSlug,
}: {
  session: Session
  gates: readonly ShipGate[]
  configNeeds?: SessionShipConfigNeedsData | null
  appSlug?: string
}) {
  const hasPr = session.prNumber !== null
  const pr = useSessionPr(session.id, hasPr)
  const checks = pr.data?.checks ?? session.prChecks
  const prUrl = pr.data?.prUrl ?? session.prUrl
  const shipping = session.status === 'shipping'

  return (
    <section className="surface-panel space-y-3" aria-labelledby="ship-panel-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="ship-panel-title" className="flex items-center gap-2 text-base font-semibold">
          {shipping ? (
            <>
              <span className="loading loading-spinner loading-xs text-primary" />
              Shipping
            </>
          ) : hasPr ? (
            <>
              <CheckCircleIcon className="h-5 w-5 text-success" />
              Shipped
            </>
          ) : (
            'Ship'
          )}
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

      {hasPr && (
        <div>
          <p className="text-sm font-medium" data-testid="checks-summary">
            {checks ? checksSummary(checks) : 'Waiting for CI to report…'}
          </p>
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
