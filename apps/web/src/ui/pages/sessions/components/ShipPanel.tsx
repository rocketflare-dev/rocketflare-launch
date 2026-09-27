/**
 * Shipping, as it happens and after (Launch P3, plan §1.10): the gate's attempts (`ship.gate`
 * rows — lint, typecheck and tests, with Claude fixing failures between tries), the pull request
 * once it is open, and its CI — `GET /:id/pr`, check runs plus commit statuses folded into one
 * verdict, polled while anything is still running.
 *
 * Every fact here is a selector over rows the page already holds (`shipGates`) or the one PR read;
 * nothing is inferred. A gate's output tail sits behind a disclosure: it is the evidence, not the
 * headline.
 */
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  MinusCircleIcon,
} from '@heroicons/react/24/outline'
import type { PrCheckState, Session } from '@launch/shared/launch-sessions'
import { useSessionPr } from '@/ui/hooks/useSessions'
import type { ShipGate } from '../sessionChatModel'

const CHECK_ICON: Record<
  PrCheckState,
  { icon: typeof CheckCircleIcon; className: string; label: string }
> = {
  success: { icon: CheckCircleIcon, className: 'text-success', label: 'passed' },
  failure: { icon: ExclamationCircleIcon, className: 'text-error', label: 'failed' },
  pending: { icon: ClockIcon, className: 'text-info', label: 'running' },
  none: { icon: MinusCircleIcon, className: 'text-muted', label: 'no checks' },
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

export function ShipPanel({ session, gates }: { session: Session; gates: readonly ShipGate[] }) {
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
          Running lint, typecheck and the tests. Claude fixes anything that fails, then opens a pull
          request.
        </p>
      )}

      {gates.length > 0 && (
        <ol className="space-y-1.5" aria-label="Checks before shipping">
          {gates.map(gate => (
            <li key={gate.id} className="text-sm" data-gate={gate.passed ? 'passed' : 'failed'}>
              <div className="flex items-center gap-2">
                {gate.passed ? (
                  <CheckCircleIcon className="h-4 w-4 shrink-0 text-success" />
                ) : (
                  <ExclamationCircleIcon className="h-4 w-4 shrink-0 text-warning" />
                )}
                <span>
                  Attempt {gate.attempt}:{' '}
                  {gate.passed ? 'lint, typecheck and tests passed' : 'something failed'}
                </span>
              </div>
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
          {shipping && gates.at(-1)?.passed === false && (
            <li className="flex items-center gap-2 text-sm text-muted">
              <span className="loading loading-dots loading-xs" />
              Claude is fixing it…
            </li>
          )}
        </ol>
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
