/**
 * `/apps/:slug/settings/:section?` (decision 9): one section at a time, picked from the list on the
 * left — General (About, Edit, each environment's Worker and declared resources, the thumbnail and
 * "Refresh thumbnail") · Config & secrets
 * (`ConfigSection`) · Access & sign-in (`OidcClientCard` + `AccessSection`) · Shipping
 * (`ShipSettingsCard`) · Danger zone (Archive, `TeardownModal`).
 *
 * Settings is read-only for whoever may not change it — each section hides the actions the
 * server would refuse — and the Danger zone is not listed at all for them (decision 11). A
 * section that does not apply (no repository, already archived) is not listed either; a URL that
 * names one lands on General.
 */
import { CodeBracketIcon } from '@heroicons/react/24/outline'
import type { AppDetail } from '@launch/shared/launch-apps'
import { useState } from 'react'
import { Navigate, NavLink, useParams } from 'react-router-dom'
import { useRefreshAppThumbnail } from '@/ui/hooks/useApps'
import { ApiError } from '@/ui/lib/api-client'
import { formatDate } from '@/ui/lib/format'
import { AppThumbnail } from '../components/AppThumbnail'
import { EditAppModal } from '../components/EditAppModal'
import { OidcClientCard } from '../components/OidcClientCard'
import { v } from '../components/promotionModel'
import { ShipSettingsCard } from '../components/ShipSettingsCard'
import { TeardownModal } from '../components/TeardownModal'
import { AccessSection } from './AccessSection'
import {
  ENV_LABEL,
  isSettingsSection,
  resourceRows,
  type SettingsSection,
  settingsPath,
} from './appPageModel'
import { Ago, SectionHeading } from './bits'
import { ConfigSection } from './ConfigSection'
import { type AppPageContext, useAppPage } from './context'

const SECTION_LABEL: Record<SettingsSection, string> = {
  general: 'General',
  config: 'Config & secrets',
  access: 'Access & sign-in',
  shipping: 'Shipping',
  danger: 'Danger zone',
}

/** The sections this reader sees on this app, in order. Pure. */
export function visibleSections(
  ctx: Pick<AppPageContext, 'hasRepo' | 'canManage'> & {
    app: Pick<AppDetail, 'source' | 'status'>
  }
): SettingsSection[] {
  const archived = ctx.app.status === 'archived'
  return [
    'general',
    ...(ctx.hasRepo && !archived ? (['config'] as const) : []),
    'access',
    ...(ctx.hasRepo ? (['shipping'] as const) : []),
    ...(ctx.canManage && ctx.app.source === 'created' && !archived ? (['danger'] as const) : []),
  ]
}

function AboutRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 py-2">
      <dt className="w-28 shrink-0 text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm truncate">{children}</dd>
    </div>
  )
}

function General({ app, canManage }: { app: AppDetail; canManage: boolean }) {
  const [editOpen, setEditOpen] = useState(false)
  const repo = app.repoOwner && app.repoName ? `${app.repoOwner}/${app.repoName}` : null
  return (
    <div className="space-y-8">
      <section aria-labelledby="about-title">
        <SectionHeading
          id="about-title"
          actions={
            canManage && (
              <button type="button" className="btn btn-sm" onClick={() => setEditOpen(true)}>
                Edit
              </button>
            )
          }
        >
          About
        </SectionHeading>
        <dl className="divide-y divide-base-300 border-y border-base-300">
          <AboutRow label="Name">{app.displayName}</AboutRow>
          <AboutRow label="Description">
            {app.description ?? <span className="text-muted">None</span>}
          </AboutRow>
          <AboutRow label="Team">
            {app.ownerGroup?.name ?? <span className="text-muted">No team</span>}
          </AboutRow>
          <AboutRow label="Repository">
            {repo ? (
              <a
                href={`https://github.com/${repo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="link link-hover font-mono text-xs inline-flex items-center gap-1"
              >
                <CodeBracketIcon className="w-3.5 h-3.5" />
                {repo}
              </a>
            ) : (
              '—'
            )}
          </AboutRow>
          <AboutRow label="Branch">
            <span className="font-mono text-xs">{app.defaultBranch ?? '—'}</span>
          </AboutRow>
          <AboutRow label="Template">
            <span className="font-mono text-xs">
              {app.template} {app.templateVersion ?? ''}
              {app.templateContractVersion ? ` · contract v${app.templateContractVersion}` : ''}
            </span>
          </AboutRow>
          <AboutRow label="Registered">
            {app.source === 'imported' ? 'Imported' : 'Created'} {formatDate(app.createdAt)}
          </AboutRow>
        </dl>
      </section>

      <section aria-labelledby="environments-title">
        <SectionHeading id="environments-title">Environments</SectionHeading>
        {app.environments.length === 0 ? (
          <p className="text-sm text-muted">No environments recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table" aria-label="Environments">
              <thead>
                <tr>
                  <th>Environment</th>
                  <th>Address</th>
                  <th>Worker</th>
                  <th>Declared resources</th>
                </tr>
              </thead>
              <tbody>
                {app.environments.map(env => {
                  const resources = resourceRows(env.resources)
                  return (
                    <tr key={env.id}>
                      <td className="font-medium">{ENV_LABEL[env.name]}</td>
                      <td className="text-sm">
                        {env.url ? (
                          <a
                            href={env.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="link link-hover"
                          >
                            {env.url.replace(/^https?:\/\//, '')}
                          </a>
                        ) : (
                          <span className="text-muted">No URL in its toml</span>
                        )}
                      </td>
                      <td className="font-mono text-xs">{env.workerName ?? '—'}</td>
                      <td>
                        {resources.length === 0 ? (
                          <span className="text-muted text-sm">None recorded</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {resources.map(r => (
                              <li key={`${r.kind}:${r.binding}`} className="text-xs">
                                <span className="text-muted">{r.kind}</span>{' '}
                                <span className="font-mono">{r.binding}</span>{' '}
                                <span className="font-mono text-secondary" title={r.value}>
                                  {r.value}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ThumbnailSection app={app} canManage={canManage} />

      {editOpen && <EditAppModal app={app} open={editOpen} onClose={() => setEditOpen(false)} />}
    </div>
  )
}

/** What the refresh's failure says, in a sentence. Pure. */
export function refreshRefusal(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) {
    return 'The thumbnail was refreshed less than a minute ago. Try again shortly.'
  }
  return error instanceof Error ? error.message : 'The thumbnail could not be refreshed.'
}

/**
 * The app's thumbnail: what it shows (Live's screenshot, else Staging's), when it was taken, and —
 * for whoever may manage the app — "Refresh thumbnail", which only queues a capture: the picture
 * replaces itself when the job's nudge lands. Hidden for an archived app or one with no address.
 */
function ThumbnailSection({ app, canManage }: { app: AppDetail; canManage: boolean }) {
  const refresh = useRefreshAppThumbnail(app.id)
  const canRefresh =
    canManage && app.status !== 'archived' && app.environments.some(env => env.url !== null)
  const thumbnail = app.thumbnail
  return (
    <section aria-labelledby="thumbnail-title">
      <SectionHeading
        id="thumbnail-title"
        actions={
          canRefresh && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              {refresh.isPending && <span className="loading loading-spinner loading-xs" />}
              Refresh thumbnail
            </button>
          )
        }
      >
        Thumbnail
      </SectionHeading>
      <div className="flex flex-wrap items-start gap-4">
        <AppThumbnail app={app} size="lg" />
        <div className="text-sm space-y-1 min-w-0">
          {thumbnail ? (
            <p>
              A screenshot of {ENV_LABEL[thumbnail.env]}
              {thumbnail.version ? (
                <>
                  {' at '}
                  <span className="font-mono tabular-nums">{v(thumbnail.version)}</span>
                </>
              ) : null}
              , taken <Ago at={thumbnail.capturedAt} />.
            </p>
          ) : (
            <p className="text-muted">No screenshot yet.</p>
          )}
          <p className="text-muted">
            Taken after each deploy goes live, without signing in — an app behind sign-in shows its
            login page.
          </p>
          {refresh.isSuccess && (
            <p role="status">Capture queued. The thumbnail updates when it is taken.</p>
          )}
          {refresh.isError && (
            <p role="alert" className="text-error">
              {refreshRefusal(refresh.error)}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

function DangerZone({ ctx }: { ctx: AppPageContext }) {
  const { app, pipeline, canManage } = ctx
  const [open, setOpen] = useState(false)
  // A launch or teardown is still running: another run now would race it.
  const busy = pipeline.create?.status === 'running' || pipeline.teardown?.status === 'running'
  return (
    <section aria-labelledby="danger-zone-title" className="space-y-2">
      <h2 id="danger-zone-title" className="text-base font-semibold">
        Danger zone
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-4 border-y border-base-300 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Archive this app</p>
          <p className="text-sm text-secondary mt-0.5">
            Deletes its Workers, database, storage and email keys, disables its sign-in and archives
            the repository. The catalogue keeps the app, marked archived.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-error btn-outline shrink-0"
          onClick={() => setOpen(true)}
          disabled={busy}
          title={busy ? 'Wait for the running pipeline to finish or stop first' : undefined}
        >
          Archive app…
        </button>
      </div>
      {open && (
        <TeardownModal
          app={app}
          open={open}
          onClose={() => setOpen(false)}
          onStarted={() => pipeline.startWatching('teardown')}
          view={pipeline.teardown}
          onRetry={canManage ? pipeline.onRetry('teardown') : undefined}
          retrying={pipeline.retrying}
        />
      )}
    </section>
  )
}

export default function SettingsTab() {
  const ctx = useAppPage()
  const { app, canManage, stage } = ctx
  const { section } = useParams<{ section?: string }>()
  const sections = visibleSections(ctx)
  const current: SettingsSection | null = section === undefined ? 'general' : null
  const active =
    current ?? (isSettingsSection(section) && sections.includes(section) ? section : null)
  if (!active) return <Navigate to={settingsPath(app.slug)} replace />

  return (
    <div className="grid gap-6 lg:grid-cols-[12rem_1fr]">
      <nav aria-label="Settings sections">
        <ul className="flex flex-wrap gap-1 lg:flex-col">
          {sections.map(id => (
            <li key={id}>
              <NavLink
                to={settingsPath(app.slug, id)}
                className={({ isActive }) =>
                  `block rounded px-2.5 py-1.5 text-sm ${
                    isActive || (id === 'general' && section === undefined)
                      ? 'bg-base-200 font-medium'
                      : 'text-secondary hover:bg-base-200'
                  }`
                }
              >
                {SECTION_LABEL[id]}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="min-w-0">
        {active === 'general' && <General app={app} canManage={canManage} />}
        {active === 'config' && <ConfigSection app={app} />}
        {active === 'access' && (
          <div className="space-y-8">
            {stage.holding ? (
              <p className="text-sm text-secondary">
                The launch registers this app’s sign-in client itself; it appears here once the app
                is live.
              </p>
            ) : (
              <OidcClientCard appId={app.id} canManage={canManage} />
            )}
            <AccessSection slug={app.slug} />
          </div>
        )}
        {active === 'shipping' && <ShipSettingsCard app={app} canApplyProtection={canManage} />}
        {active === 'danger' && <DangerZone ctx={ctx} />}
      </div>
    </div>
  )
}
