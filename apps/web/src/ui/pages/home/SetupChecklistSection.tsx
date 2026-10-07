/**
 * Home: "Finish setting up Launch", for whoever administers the platform, while any connection
 * Launch runs on is not ready. One compact panel: the heading and a segmented bar of the seven
 * connections in the Platform menu's order (one segment each, coloured by its state, "6 of 7
 * ready" spelled out beside it), then a row for each one that is NOT ready — its dot, its name,
 * what is wrong in the words of its worst probe, and one Fix link to its Settings page. A ready
 * connection gets no row: the bar already says it works. Once all seven are ready the panel is gone.
 *
 * It replaced the seven-step wizard page: the steps are each their own page under Settings →
 * Platform now, and this is where an unfinished one is noticed. It reads the same setup
 * overview (`useSetupOverview`) those pages and the menu read — `canAdministerPlatform` on the
 * server, the `platformAdmin` guard here — and decides nothing itself (`setupChecklist`).
 */
import type { SetupStepStatus } from '@launch/shared/launch-setup'
import { Link } from 'react-router-dom'
import { useSetupOverview } from '@/ui/hooks/useSetup'
import { StatusDot, statusLabel } from '../platform/setup/StatusDot'
import { connectionChecks, setupChecklist } from './homeModel'

/** A segment's fill — state colour only, the same vocabulary as `StatusDot`. */
const SEGMENT: Record<SetupStepStatus, string> = {
  ok: 'bg-success',
  warning: 'bg-warning',
  failed: 'bg-error',
  unchecked: 'bg-base-300',
  todo: 'bg-base-300',
}

export function SetupChecklistSection() {
  const { data } = useSetupOverview()
  // Nothing while loading or on an error: the section is a nudge, and Settings shows the detail.
  if (!data) return null
  const checklist = setupChecklist(data.steps, connectionChecks(data))
  if (checklist.complete) return null
  const open = checklist.rows.filter(row => !row.done)

  return (
    <section aria-labelledby="home-setup" className="surface-panel p-0">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3">
        <h2 id="home-setup" className="font-semibold">
          Finish setting up Launch
        </h2>
        <div className="flex items-center gap-3">
          <ol className="flex gap-1" aria-hidden="true">
            {checklist.rows.map(row => (
              <li
                key={row.id}
                className={`h-1.5 w-6 rounded-full ${SEGMENT[row.status]}`}
                title={`${row.label}: ${statusLabel(row.status)}`}
              />
            ))}
          </ol>
          <span className="text-sm text-secondary tabular-nums" data-testid="home-setup-count">
            {checklist.done} of {checklist.total} ready
          </span>
        </div>
      </div>
      <ul className="border-t border-base-300 divide-y divide-base-300" aria-label="Not ready yet">
        {open.map(row => (
          <li key={row.id} className="flex items-center gap-4 px-5 py-2.5">
            <span className="flex flex-1 items-baseline gap-2 min-w-0">
              <StatusDot status={row.status} />
              <span className="min-w-0 text-sm">
                <span className="font-medium">{row.label}</span>
                <span className="text-secondary">
                  {' · '}
                  {row.reason ?? statusLabel(row.status)}
                </span>
              </span>
            </span>
            <Link
              to={row.path}
              className="btn btn-ghost btn-sm shrink-0"
              aria-label={`Fix ${row.label}`}
            >
              Fix
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
