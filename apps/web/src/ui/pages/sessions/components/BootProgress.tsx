/**
 * What the preview pane shows while a session's sandbox boots (Launch P3): the boot's `step` rows
 * as a checklist, in the words the Workflow wrote them (`bootSteps` — the CURRENT boot only, so a
 * resume never draws over the first boot's ticks), and how long it has been going.
 *
 * It lists what HAS happened rather than a fixed script of what will: the step keys belong to the
 * Workflow, and a checklist that guesses them goes stale the day a step is added. A boot is short
 * (S7 measured 24–57 s), so a one-second tick here is cheap and bounded — it stops with the boot.
 */
import { CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/24/outline'
import { useEffect, useState } from 'react'
import { formatDuration } from '@/ui/lib/format'
import type { BootStep } from '../sessionChatModel'

export function BootProgress({
  steps,
  since,
  resuming = false,
}: {
  steps: readonly BootStep[]
  /** When the boot started — the session's `createdAt`, or when it was asked to resume. */
  since: Date
  resuming?: boolean
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const elapsed = Math.max(0, now - since.getTime())
  const failed = steps.some(s => s.status === 'error')

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-sm">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold" id="boot-progress-title">
            {resuming ? 'Waking the session up' : 'Starting your sandbox'}
          </h2>
          <span className="text-xs text-muted tabular-nums" title="Elapsed">
            {formatDuration(elapsed)}
          </span>
        </div>
        <p className="mt-1 text-sm text-secondary">
          A copy of the app with its own database and a live preview. Usually under a minute.
        </p>
        <ol className="mt-5 space-y-2.5" aria-labelledby="boot-progress-title">
          {steps.map(step => (
            <li key={step.key} className="flex items-start gap-2.5 text-sm" data-step={step.key}>
              {step.status === 'running' ? (
                <span className="loading loading-spinner loading-xs mt-0.5 shrink-0 text-primary" />
              ) : step.status === 'error' ? (
                <ExclamationCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-error" />
              ) : (
                <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              )}
              <span className="min-w-0">
                <span className={step.status === 'done' ? 'text-secondary' : ''}>{step.label}</span>
                {step.detail && (
                  <span className="block text-xs text-muted truncate">{step.detail}</span>
                )}
              </span>
            </li>
          ))}
          {!failed && (steps.length === 0 || steps.every(s => s.status !== 'running')) && (
            <li className="flex items-center gap-2.5 text-sm text-muted">
              <span className="loading loading-dots loading-xs shrink-0" />
              {steps.length === 0 ? 'Getting a sandbox…' : 'Next step…'}
            </li>
          )}
        </ol>
      </div>
    </div>
  )
}
