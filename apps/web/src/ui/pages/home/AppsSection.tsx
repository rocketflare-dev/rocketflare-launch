/**
 * Home: the company's apps as large cards in a responsive grid (1 → 2 → 3 → 4 columns), each card
 * one link to the app — its screenshot filling the card's width (`AppThumbnail size="fill"`, or the
 * app's initial, large, on `bg-base-200`), the name, one word when something needs a look
 * (`appAttention`, in its state colour), and a compact line: the version Live runs with its health
 * dot, and the version on Staging. Apps that need somebody come first; the full list, search and
 * the table are the catalogue's (`/apps`).
 *
 * The cards are the surface — there is no panel around them (one level, docs/DESIGN.md). Reads
 * only the catalogue (`useApps`, `GET /api/apps` — the list polls while a deploy runs); no per-app
 * request. "New app" is offered to whoever the catalogue offers "Create app" (`manage App`), as a
 * plain button: Home has no hero action.
 */

import { PlusIcon } from '@heroicons/react/24/outline'
import type { AppCatalogueItem } from '@launch/shared/launch-apps'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApps } from '@/ui/hooks/useApps'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { appPath } from '../apps/app/appPageModel'
import { Version } from '../apps/app/bits'
import { AppThumbnail } from '../apps/components/AppThumbnail'
import { CreateAppModal } from '../apps/components/CreateAppModal'
import { HealthDot } from '../apps/components/HealthDot'
import { HomeSection } from './HomeSection'
import { type Attention, environmentOf, homeAppRows, runningVersion } from './homeModel'

/** How many apps Home shows before "All apps" takes over: two full rows of the widest grid. */
export const HOME_APPS_LIMIT = 8

/** Literal classes, so Tailwind's scanner sees every one. */
const ATTENTION_TONE: Record<Attention['tone'], string> = {
  error: 'text-error',
  warning: 'text-warning',
  muted: 'text-muted',
}

const GRID = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-5'

const CARD =
  'surface-panel p-0 overflow-hidden group flex flex-col transition-[border-color,box-shadow] duration-200 hover:border-primary hover:[box-shadow:var(--shadow-popover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'

function VersionValue({ version }: { version: string | null }) {
  return version ? <Version>{version}</Version> : <span className="text-sm text-muted">—</span>
}

function AppCard({ app, attention }: { app: AppCatalogueItem; attention: Attention | null }) {
  const live = environmentOf(app, 'production')
  const nameId = `home-app-${app.id}-name`
  const detailsId = `home-app-${app.id}-details`
  return (
    <li className="flex">
      <Link
        to={appPath(app.slug)}
        className={`${CARD} w-full`}
        aria-labelledby={nameId}
        aria-describedby={detailsId}
        data-testid="home-app-card"
      >
        <AppThumbnail app={app} size="fill" />
        <div className="flex flex-1 flex-col gap-1 px-4 pt-3 pb-4 min-w-0">
          <span id={nameId} className="text-base font-semibold truncate">
            {app.displayName}
          </span>
          <div id={detailsId} className="flex flex-1 flex-col gap-3">
            {attention && (
              <span className={`text-sm ${ATTENTION_TONE[attention.tone]}`}>{attention.word}</span>
            )}
            <dl className="mt-auto flex flex-wrap items-baseline gap-x-5 gap-y-1">
              <div className="flex items-baseline gap-1.5">
                <dt className="text-xs text-muted">Live</dt>
                <dd className="inline-flex items-center gap-1.5">
                  {live && <HealthDot status={live.healthStatus} className="text-xs" />}
                  <VersionValue version={runningVersion(live)} />
                </dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-xs text-muted">Staging</dt>
                <dd>
                  <VersionValue version={runningVersion(environmentOf(app, 'staging'))} />
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </Link>
    </li>
  )
}

/** Card-shaped placeholders, so the grid does not jump when the catalogue arrives. */
function CardsSkeleton() {
  return (
    <div className={GRID} aria-busy="true" aria-live="polite">
      {['a', 'b', 'c', 'd'].map(key => (
        <div key={key} className="surface-panel p-0 overflow-hidden animate-pulse">
          <div className="aspect-[16/10] bg-base-200 border-b border-base-300" />
          <div className="space-y-3 px-4 pt-3 pb-4">
            <div className="h-4 w-1/2 rounded surface-inset border-0" />
            <div className="h-3 w-2/3 rounded surface-inset border-0" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function AppsSection() {
  const { can } = usePermissions()
  const canCreate = can('manage', 'App')
  const { data, isLoading, error } = useApps()
  const [creating, setCreating] = useState(false)
  const rows = homeAppRows(data?.items ?? [])
  const shown = rows.slice(0, HOME_APPS_LIMIT)
  const loaded = !isLoading && !error

  return (
    <HomeSection
      id="home-apps"
      title="Apps"
      count={loaded ? rows.length : undefined}
      countLabel={rows.length === 1 ? 'app' : 'apps'}
      actions={
        <>
          {canCreate && (
            <button type="button" className="btn btn-sm gap-1.5" onClick={() => setCreating(true)}>
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
      {isLoading ? (
        <CardsSkeleton />
      ) : error ? (
        <div className="surface-panel">
          <p className="text-sm text-error" role="alert">
            Apps could not be loaded.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="surface-panel">
          <p className="text-sm text-muted">
            {canCreate ? 'No apps yet.' : 'No apps yet. An administrator creates or imports them.'}
          </p>
        </div>
      ) : (
        <ul className={GRID} aria-label="Apps">
          {shown.map(({ app, attention }) => (
            <AppCard key={app.id} app={app} attention={attention} />
          ))}
        </ul>
      )}

      {canCreate && <CreateAppModal open={creating} onClose={() => setCreating(false)} />}
    </HomeSection>
  )
}
