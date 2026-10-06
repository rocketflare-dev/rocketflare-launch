/**
 * The title row of a Settings section that is a page of its own rather than a panel — Audit, one
 * user, one organisation. `PageHeader`'s shape one level down: the layout's "Settings" is the
 * page's `h1`, so a section's title is an `h2`.
 */
import type { ReactNode } from 'react'

export function SectionHeader({
  title,
  description,
  badge,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  badge?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight truncate">{title}</h2>
          {badge}
        </div>
        {description && <p className="text-sm text-secondary mt-1">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
