/**
 * One Home section: a header row — a real heading, a muted count, the section's actions on the
 * right — over its content. The content brings its own surface (a `surface-panel` of rows, or a
 * grid of app cards that are each one), so there is exactly one level: never a panel around cards.
 */
import type { ReactNode } from 'react'

export function HomeSection({
  id,
  title,
  count,
  countLabel,
  actions,
  children,
}: {
  id: string
  title: string
  /** Shown muted beside the heading; omitted while unknown. */
  count?: number
  /** What the count is of, for a screen reader ("3 apps"). */
  countLabel?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex items-baseline gap-2.5 min-w-0">
          <h2 id={id} className="text-xl font-semibold">
            {title}
          </h2>
          {count !== undefined && (
            <span
              className="text-base text-muted font-mono tabular-nums"
              data-testid={`${id}-count`}
            >
              {count}
              {countLabel && <span className="sr-only"> {countLabel}</span>}
            </span>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
      </div>
      {children}
    </section>
  )
}
