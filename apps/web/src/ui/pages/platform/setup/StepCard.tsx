/**
 * One step of the setup stepper: a numbered card with its status dot. The `id` is the anchor the
 * stepper at the top of the page links to. A card that is not a step (the OpenAI key, §18.22-B)
 * has no `number`.
 */
import type { SetupStepId, SetupStepStatus } from '@launch/shared/launch-setup'
import type { ReactNode } from 'react'
import { StatusDot } from './StatusDot'

export const stepAnchor = (id: SetupStepId | string) => `setup-${id}`

export function StepCard({
  id,
  number,
  title,
  description,
  status,
  children,
}: {
  id: SetupStepId | string
  number?: number
  title: string
  description: ReactNode
  status: SetupStepStatus
  children: ReactNode
}) {
  const headingId = `${stepAnchor(id)}-title`
  return (
    <section
      id={stepAnchor(id)}
      aria-labelledby={headingId}
      className="surface-panel p-5 space-y-4 scroll-mt-6"
    >
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={headingId} className="text-base font-semibold leading-6">
            {number !== undefined && (
              <span className="text-muted tabular-nums mr-2">{number}.</span>
            )}
            {title}
          </h2>
          <div className="text-sm text-secondary mt-0.5">{description}</div>
        </div>
        <StatusDot status={status} withLabel />
      </header>
      {children}
    </section>
  )
}
