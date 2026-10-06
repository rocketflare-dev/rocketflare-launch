/**
 * One connection (or one credential that is not a step — the Anthropic and OpenAI keys, §18.22-B):
 * a card with its title, what it is for and its status dot. Each connection is its own page under
 * Settings → Connections; the `id` stays an anchor (`setup-<id>`) so a card can still be linked.
 */
import type { SetupStepId, SetupStepStatus } from '@launch/shared/launch-setup'
import type { ReactNode } from 'react'
import { StatusDot } from './StatusDot'

export const stepAnchor = (id: SetupStepId | string) => `setup-${id}`

export function StepCard({
  id,
  title,
  description,
  status,
  children,
}: {
  id: SetupStepId | string
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
