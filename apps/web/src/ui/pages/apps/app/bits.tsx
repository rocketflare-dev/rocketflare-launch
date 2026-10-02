/**
 * The app page's smallest pieces, shared by its tabs so a time, a version and a run link read the
 * same everywhere (`docs/DESIGN.md`): times relative with the absolute one in `title`, versions in
 * tabular monospace, external links marked.
 */
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { formatDateTime, timeAgo } from '@/ui/lib/format'

/** "3 minutes ago", with the date and time on hover. */
export function Ago({ at, fallback = '—' }: { at: Date | null | undefined; fallback?: string }) {
  if (!at) return <span className="text-muted">{fallback}</span>
  return (
    <time dateTime={at.toISOString()} title={formatDateTime(at)}>
      {timeAgo(at)}
    </time>
  )
}

/** `v1.4.2` (or a short commit) in tabular monospace. */
export function Version({ children, title }: { children: string; title?: string }) {
  return (
    <span className="font-mono tabular-nums text-sm" title={title}>
      {children}
    </span>
  )
}

/** A link that leaves Launch: GitHub, the app itself. */
export function ExternalLink({
  href,
  children,
  className = 'link link-hover',
}: {
  href: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${className} inline-flex items-center gap-1`}
    >
      {children}
      <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
    </a>
  )
}

/** A small state dot; colour for state only (error / warning / success). */
export function StateDot({ tone }: { tone: 'error' | 'warning' | 'success' | 'muted' }) {
  const cls =
    tone === 'error'
      ? 'bg-error'
      : tone === 'warning'
        ? 'bg-warning'
        : tone === 'success'
          ? 'bg-success'
          : 'bg-base-300'
  return <span aria-hidden="true" className={`inline-block w-2 h-2 rounded-full shrink-0 ${cls}`} />
}

/** A section heading inside a tab: plain text and whitespace, no panel around it. */
export function SectionHeading({
  id,
  children,
  actions,
}: {
  id?: string
  children: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
      <h2 id={id} className="text-base font-semibold">
        {children}
      </h2>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
