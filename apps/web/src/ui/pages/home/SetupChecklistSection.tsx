/**
 * Home: "Finish setting up Launch — 5 of 7", for whoever administers the platform, while any
 * connection Launch runs on is not working yet. One line per connection in the Connections menu's
 * order — its dot, its name linking to its Settings page, and its state in words — on one panel.
 * Once every one works the section is gone; the Settings menu keeps the dots.
 *
 * It replaced the seven-step wizard page: the steps are each their own page under Settings →
 * Connections now, and this is where an unfinished one is noticed. It reads the same setup
 * overview (`useSetupOverview`) those pages and the menu read — `canAdministerPlatform` on the
 * server, the `platformAdmin` guard here — and decides nothing itself (`setupChecklist`).
 */
import { Link } from 'react-router-dom'
import { useSetupOverview } from '@/ui/hooks/useSetup'
import { StatusDot, statusLabel } from '../platform/setup/StatusDot'
import { HomeSection } from './HomeSection'
import { setupChecklist } from './homeModel'

export function SetupChecklistSection() {
  const { data } = useSetupOverview()
  // Nothing while loading or on an error: the section is a nudge, and Settings shows the detail.
  if (!data) return null
  const checklist = setupChecklist(data.steps)
  if (checklist.complete) return null

  return (
    <HomeSection
      id="home-setup"
      title={`Finish setting up Launch — ${checklist.done} of ${checklist.total}`}
    >
      <ul className="surface-panel p-0 divide-y divide-base-300" aria-label="Connections">
        {checklist.rows.map(row => (
          <li
            key={row.id}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-5 py-3"
          >
            <span className="flex items-baseline gap-2 min-w-0">
              {/* The state is spelled out on the right; the dot is for the eye only. */}
              <span aria-hidden="true">
                <StatusDot status={row.status} />
              </span>
              <Link to={row.path} className="link link-hover font-medium">
                {row.label}
              </Link>
            </span>
            <span className="text-sm text-secondary">{statusLabel(row.status)}</span>
          </li>
        ))}
      </ul>
    </HomeSection>
  )
}
