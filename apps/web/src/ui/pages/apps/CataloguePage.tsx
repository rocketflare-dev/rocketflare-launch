/**
 * `/apps` (spec/06): the catalogue — Launch's main screen. Every registered app with its team, kit
 * version and the live health of staging and production, as cards (the default) or a dense table,
 * with a fleet summary above and "Import app" for admins. Every member may read it (`read App`).
 *
 * Search filters the list client-side: the catalogue is one company's apps and arrives whole.
 */
import {
  ArrowDownTrayIcon,
  ExclamationTriangleIcon,
  ListBulletIcon,
  RocketLaunchIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline'
import type { AppSummary, HealthStatus } from '@launch/shared/launch-apps'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  EmptyStateCard,
  PageHeader,
  SearchInput,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useApps } from '@/ui/hooks/useApps'
import { useLocalStoragePreference } from '@/ui/hooks/useLocalStoragePreference'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { EnvironmentHealth } from './components/HealthDot'
import { ImportAppModal } from './components/ImportAppModal'

type View = 'cards' | 'table'

/** Literal classes for the monogram tile, picked by slug so an app keeps its colour. */
const MONOGRAM_TONES = ['tone-primary', 'tone-accent', 'tone-warning'] as const

function monogramTone(slug: string): string {
  let hash = 0
  for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return MONOGRAM_TONES[hash % MONOGRAM_TONES.length] ?? MONOGRAM_TONES[0]
}

function monogram(name: string): string {
  const words = name.split(/[\s-]+/).filter(Boolean)
  const letters = words.length >= 2 ? `${words[0]?.[0]}${words[1]?.[0]}` : name.slice(0, 2)
  return letters.toUpperCase()
}

/** The worst status across an app's environments — what "needs attention" means. */
const SEVERITY: Record<HealthStatus, number> = { unknown: 0, up: 1, degraded: 2, down: 3 }

export function worstHealth(app: Pick<AppSummary, 'environments'>): HealthStatus {
  return app.environments.reduce<HealthStatus>(
    (worst, env) => (SEVERITY[env.healthStatus] > SEVERITY[worst] ? env.healthStatus : worst),
    'unknown'
  )
}

/** Case-insensitive match on name, slug, team and repo. Pure. */
export function matchesSearch(app: AppSummary, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [app.displayName, app.slug, app.ownerGroup?.name, app.repoOwner, app.repoName]
    .filter((v): v is string => Boolean(v))
    .some(v => v.toLowerCase().includes(q))
}

function Monogram({ app }: { app: AppSummary }) {
  return (
    <span
      aria-hidden="true"
      className={`grid place-items-center w-10 h-10 shrink-0 rounded-lg border text-sm font-semibold tracking-wide ${monogramTone(app.slug)}`}
    >
      {monogram(app.displayName)}
    </span>
  )
}

function StatusTag({ app }: { app: AppSummary }) {
  if (app.status === 'live') return null
  const tone: Record<AppSummary['status'], string> = {
    live: 'active',
    requested: 'pending',
    provisioning: 'running',
    failed: 'failed',
    archived: 'archived',
  }
  return (
    <span className="status-badge" data-status={tone[app.status]}>
      {app.status}
    </span>
  )
}

function Meta({ app }: { app: AppSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary">
      <span className={app.ownerGroup ? '' : 'text-muted italic'}>
        {app.ownerGroup?.name ?? 'No team'}
      </span>
      <span aria-hidden="true" className="text-muted">
        ·
      </span>
      <span className="font-mono">
        {app.templateVersion ? `kit ${app.templateVersion}` : 'kit unknown'}
      </span>
    </div>
  )
}

function environmentOf(app: AppSummary, name: 'staging' | 'production') {
  return app.environments.find(e => e.name === name)
}

function EnvCell({ app, name }: { app: AppSummary; name: 'staging' | 'production' }) {
  const env = environmentOf(app, name)
  if (!env) return <span className="text-xs text-muted">—</span>
  return <EnvironmentHealth env={env} showName={false} />
}

function AppCard({ app }: { app: AppSummary }) {
  const attention = ['down', 'degraded'].includes(worstHealth(app))
  return (
    <Link
      to={`/apps/${encodeURIComponent(app.slug)}`}
      className={`surface-panel group flex flex-col gap-4 transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-primary ${
        attention ? 'border-l-4 border-l-error' : ''
      }`}
    >
      <div className="flex items-start gap-3 min-w-0">
        <Monogram app={app} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold truncate group-hover:text-primary transition-colors">
              {app.displayName}
            </h2>
            <StatusTag app={app} />
          </div>
          <p className="font-mono text-xs text-muted truncate">{app.slug}</p>
        </div>
      </div>
      {app.description && <p className="text-sm text-secondary line-clamp-2">{app.description}</p>}
      <Meta app={app} />
      <div className="grid grid-cols-2 gap-3 pt-3 mt-auto border-t border-base-300">
        {(['staging', 'production'] as const).map(name => {
          const env = environmentOf(app, name)
          return env ? (
            <EnvironmentHealth key={name} env={env} />
          ) : (
            <div key={name} className="text-sm text-muted capitalize">
              {name}
              <div className="text-xs">not set up</div>
            </div>
          )
        })}
      </div>
    </Link>
  )
}

function AppTable({ apps }: { apps: AppSummary[] }) {
  return (
    <SectionPanel flush>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>App</th>
              <th>Team</th>
              <th>Kit</th>
              <th>Staging</th>
              <th>Production</th>
            </tr>
          </thead>
          <tbody>
            {apps.map(app => (
              <tr key={app.id}>
                <td className="py-2">
                  <Link
                    to={`/apps/${encodeURIComponent(app.slug)}`}
                    className="flex items-center gap-3 min-w-0 group"
                  >
                    <Monogram app={app} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="font-medium group-hover:text-primary truncate">
                          {app.displayName}
                        </span>
                        <StatusTag app={app} />
                      </span>
                      <span className="block font-mono text-xs text-muted truncate">
                        {app.slug}
                      </span>
                    </span>
                  </Link>
                </td>
                <td className={app.ownerGroup ? 'text-secondary' : 'text-muted italic'}>
                  {app.ownerGroup?.name ?? 'No team'}
                </td>
                <td className="font-mono text-xs text-secondary">{app.templateVersion ?? '—'}</td>
                <td>
                  <EnvCell app={app} name="staging" />
                </td>
                <td>
                  <EnvCell app={app} name="production" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionPanel>
  )
}

/** The fleet at a glance: how many apps, and how many production environments answer. */
function FleetSummary({ apps }: { apps: AppSummary[] }) {
  const production = apps.flatMap(a => a.environments.filter(e => e.name === 'production'))
  const up = production.filter(e => e.healthStatus === 'up').length
  const attention = apps.filter(a => ['down', 'degraded'].includes(worstHealth(a))).length
  const tiles = [
    { label: 'Apps', value: String(apps.length), tone: '' },
    {
      label: 'Production up',
      value: production.length ? `${up}/${production.length}` : '—',
      tone: production.length && up === production.length ? 'text-success' : '',
    },
    {
      label: 'Need attention',
      value: String(attention),
      tone: attention > 0 ? 'text-error' : 'text-muted',
    },
  ]
  return (
    <dl className="grid grid-cols-3 gap-3 mb-5">
      {tiles.map(tile => (
        <div key={tile.label} className="surface-panel py-3">
          <dt className="text-xs text-muted uppercase tracking-wide">{tile.label}</dt>
          <dd className={`text-2xl font-semibold tabular-nums mt-0.5 ${tile.tone}`}>
            {tile.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function CardSkeletons() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" aria-busy="true">
      {['a', 'b', 'c'].map(key => (
        <div key={key} className="surface-panel">
          <SkeletonRows rows={4} />
        </div>
      ))}
    </div>
  )
}

export default function CataloguePage() {
  const { can } = usePermissions()
  const canManage = can('manage', 'App')
  const { data, isLoading, error } = useApps()
  const [importOpen, setImportOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [view, setView] = useLocalStoragePreference<View>('launch.apps.view', 'cards')
  const apps = data?.items ?? []
  const shown = useMemo(() => apps.filter(app => matchesSearch(app, search)), [apps, search])

  const importButton = canManage && (
    <button
      type="button"
      className="btn btn-primary btn-flame gap-1.5"
      onClick={() => setImportOpen(true)}
    >
      <ArrowDownTrayIcon className="w-4 h-4" />
      Import app
    </button>
  )

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Apps"
        description="Every Rocketflare app the company runs, and whether it is answering."
        actions={apps.length > 0 ? importButton : undefined}
      />

      {error ? (
        <div className="alert alert-error alert-soft" role="alert">
          <ExclamationTriangleIcon className="w-5 h-5" />
          <span>The catalogue could not be loaded: {error.message}</span>
        </div>
      ) : isLoading ? (
        <CardSkeletons />
      ) : apps.length === 0 ? (
        <EmptyStateCard
          size="lg"
          icon={RocketLaunchIcon}
          message="No apps in the catalogue yet"
          description={
            canManage
              ? 'Import an existing Rocketflare app from GitHub. Launch reads its config, then watches staging and production every five minutes.'
              : 'An administrator imports the company’s Rocketflare apps; they appear here with their live health.'
          }
          action={importButton || undefined}
        />
      ) : (
        <>
          <FleetSummary apps={apps} />
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <SearchInput
              value={search}
              onChange={setSearch}
              debounceMs={0}
              size="sm"
              placeholder="Find an app, team or repo"
              aria-label="Find an app"
              className="w-full sm:w-72"
            />
            <div className="join" role="group" aria-label="Layout">
              {(
                [
                  ['cards', Squares2X2Icon, 'Cards'],
                  ['table', ListBulletIcon, 'Table'],
                ] as const
              ).map(([value, Icon, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`btn btn-sm join-item ${view === value ? 'btn-active' : 'btn-ghost'}`}
                  aria-pressed={view === value}
                  aria-label={label}
                  title={label}
                  onClick={() => setView(value)}
                >
                  <Icon className="w-4 h-4" />
                </button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <EmptyStateCard
              icon={Squares2X2Icon}
              message={`No apps match “${search.trim()}”`}
              description="Search looks at the name, slug, team and repository."
            />
          ) : view === 'table' ? (
            <AppTable apps={shown} />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {shown.map(app => (
                <AppCard key={app.id} app={app} />
              ))}
            </div>
          )}
        </>
      )}

      <ImportAppModal open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  )
}
