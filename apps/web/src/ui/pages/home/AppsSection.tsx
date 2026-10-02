/**
 * Home: the company's apps, one row each — name, the version Live runs with its health dot, the
 * version on Staging, and one word when something needs a look (`appAttention`). Apps that need
 * somebody come first; the full list, search and the table are the catalogue's (`/apps`).
 *
 * Reads only the catalogue (`useApps`, `GET /api/apps` — the list polls while a deploy runs); no
 * per-app request. "New app" is offered to whoever the catalogue offers "Create app" (`manage App`),
 * as a plain button: Home has no hero action.
 */
import { PlusIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { SkeletonRows } from '@/ui/components/shared'
import { useApps } from '@/ui/hooks/useApps'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { appPath } from '../apps/app/appPageModel'
import { SectionHeading, Version } from '../apps/app/bits'
import { CreateAppModal } from '../apps/components/CreateAppModal'
import { HealthDot } from '../apps/components/HealthDot'
import { type Attention, environmentOf, homeAppRows, runningVersion } from './homeModel'

/** How many apps Home lists before "All apps" takes over. */
export const HOME_APPS_LIMIT = 8

/** Literal classes, so Tailwind's scanner sees every one. */
const ATTENTION_TONE: Record<Attention['tone'], string> = {
  error: 'text-error',
  warning: 'text-warning',
  muted: 'text-muted',
}

function VersionCell({ version }: { version: string | null }) {
  return version ? <Version>{version}</Version> : <span className="text-muted">—</span>
}

export function AppsSection() {
  const { can } = usePermissions()
  const canCreate = can('manage', 'App')
  const { data, isLoading, error } = useApps()
  const [creating, setCreating] = useState(false)
  const rows = homeAppRows(data?.items ?? [])
  const shown = rows.slice(0, HOME_APPS_LIMIT)

  return (
    <section aria-labelledby="home-apps">
      <SectionHeading
        id="home-apps"
        actions={
          <>
            {canCreate && (
              <button
                type="button"
                className="btn btn-sm gap-1.5"
                onClick={() => setCreating(true)}
              >
                <PlusIcon className="w-4 h-4" />
                New app
              </button>
            )}
            <Link to="/apps" className="link link-hover text-sm">
              {rows.length > shown.length ? `All ${rows.length} apps →` : 'All apps →'}
            </Link>
          </>
        }
      >
        Apps
      </SectionHeading>

      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : error ? (
        <p className="text-sm text-error" role="alert">
          Apps could not be loaded.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">
          {canCreate ? 'No apps yet.' : 'No apps yet. An administrator creates or imports them.'}
        </p>
      ) : (
        <table className="w-full text-sm border-b border-base-300" aria-label="Apps">
          <thead>
            <tr className="text-xs text-muted text-left">
              <th className="font-normal py-2 pr-4">App</th>
              <th className="font-normal py-2 pr-4">Live</th>
              <th className="font-normal py-2 pr-4">Staging</th>
              <th className="font-normal py-2">
                <span className="sr-only">Needs</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-base-300 border-t border-base-300">
            {shown.map(({ app, attention }) => {
              const live = environmentOf(app, 'production')
              return (
                <tr key={app.id} data-testid="home-app-row">
                  <td className="py-2.5 pr-4 min-w-0">
                    <Link to={appPath(app.slug)} className="link link-hover font-medium">
                      {app.displayName}
                    </Link>
                  </td>
                  <td className="py-2.5 pr-4 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      {live && <HealthDot status={live.healthStatus} className="text-xs" />}
                      <VersionCell version={runningVersion(live)} />
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 whitespace-nowrap">
                    <VersionCell version={runningVersion(environmentOf(app, 'staging'))} />
                  </td>
                  <td className="py-2.5 text-right whitespace-nowrap">
                    {attention && (
                      <span className={`text-xs ${ATTENTION_TONE[attention.tone]}`}>
                        {attention.word}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {canCreate && <CreateAppModal open={creating} onClose={() => setCreating(false)} />}
    </section>
  )
}
