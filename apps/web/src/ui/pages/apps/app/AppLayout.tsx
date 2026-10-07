/**
 * `/apps/:slug/*` — the frame of one app's page (decisions 2, 5, 10, 11 of the app page plan):
 *
 * - the header: thumbnail · name · `v1.4.2 live` · Open Live ↗ · Build it (start a coding session) · ⋯
 *   (edit, check health, the repository, archive — each only for whoever may use it);
 * - the tabs, each its own sub-route: Overview · Sessions · Releases · Activity · Settings. Until
 *   the first build is live, Sessions and Releases are disabled with a hint, and the Overview is
 *   the takeover (`AppOverview`);
 * - the create and teardown pipelines, owned HERE (`usePipeline`, polled only while a run is owed)
 *   so every tab reads one query: a teardown in progress shows above whatever tab is open.
 *
 * One hero action per view (`docs/DESIGN.md`): Build it carries `.btn-flame`, except on the
 * Overview while Ship is on offer — then Ship does. Everybody sees the same page; an action the
 * reader cannot use is hidden, never disabled.
 */
import {
  ArchiveBoxIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  RocketLaunchIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline'
import type { PipelineKind, PipelineView } from '@launch/shared/launch-pipeline'
import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { EmptyStateCard, PageHeader, SectionPanelSkeleton } from '@/ui/components/shared'
import { usePendingApproval } from '@/ui/hooks/useApprovals'
import { useApp, useCheckAppHealth } from '@/ui/hooks/useApps'
import { usePermissions } from '@/ui/hooks/usePermissions'
import {
  appAwaitsPipeline,
  PIPELINE_KICK_GRACE_MS,
  useCancelPipeline,
  usePipeline,
  useRescaffoldPipeline,
  useRetryPipeline,
} from '@/ui/hooks/usePipeline'
import { useAppPromotion } from '@/ui/hooks/useReleases'
import { useWarmStartSession } from '@/ui/hooks/useSessions'
import { ApiError } from '@/ui/lib/api-client'
import { formatDateTime } from '@/ui/lib/format'
import { AppThumbnail } from '../components/AppThumbnail'
import { EditAppModal } from '../components/EditAppModal'
import { PipelineProgress } from '../components/PipelineProgress'
import { promotionState, v } from '../components/promotionModel'
import { startRefusal } from '../components/SessionsCard'
import {
  APP_TABS,
  type AppTab,
  appPath,
  appStage,
  appTabPath,
  liveVersion,
  settingsPath,
} from './appPageModel'
import { type MenuItem, MoreMenu } from './bits'
import type { AppPageContext } from './context'

const TAB_LABEL: Record<AppTab, string> = {
  overview: 'Overview',
  sessions: 'Sessions',
  releases: 'Releases',
  activity: 'Activity',
  settings: 'Settings',
}

/** App status → the `.status-badge` vocabulary in `index.css`. Live says its version instead. */
const STATUS_TONE: Record<string, string> = {
  requested: 'pending',
  provisioning: 'running',
  failed: 'failed',
  archived: 'archived',
}

/** When a run finished: its last step's end. Pure. */
function lastFinished(view: Pick<PipelineView, 'steps'>): Date | null {
  const ends = view.steps.flatMap(step => (step.finishedAt ? [step.finishedAt.getTime()] : []))
  return ends.length ? new Date(Math.max(...ends)) : null
}

/** A run this tab just started, awaited until it shows up or the grace window ends. */
interface Kick {
  kind: PipelineKind
  until: number
}

export default function AppLayout() {
  const { slug = '' } = useParams<{ slug: string }>()
  const { data: app, isLoading, error } = useApp(slug)
  const { can, isAdminLevel } = usePermissions()
  const canManage = can('manage', 'App')
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [editOpen, setEditOpen] = useState(false)
  const [kick, setKick] = useState<Kick | null>(null)

  const created = app?.source === 'created'
  // P4: a member's new app waits in `requested` on an `app.create` approval. That waits on a
  // PERSON — so no launch panel and no pipeline poll, just the request and a link to it.
  const pendingCreate = usePendingApproval(
    { kind: 'app.create', appId: app?.id, box: isAdminLevel() ? 'all' : 'requested' },
    app?.status === 'requested'
  )
  const waitingForApproval = pendingCreate.approval !== null
  const appBusy = appAwaitsPipeline(app?.status) && !waitingForApproval
  const create = usePipeline(app?.id, 'create', {
    enabled: created && app?.status !== 'live' && app?.status !== 'archived' && !waitingForApproval,
    appBusy,
    expectUntil: kick?.kind === 'create' ? kick.until : null,
  })
  const teardown = usePipeline(app?.id, 'teardown', {
    enabled: created,
    expectUntil: kick?.kind === 'teardown' ? kick.until : null,
  })
  const retry = useRetryPipeline(app?.id ?? '')
  const cancel = useCancelPipeline(app?.id ?? '')
  const rescaffold = useRescaffoldPipeline(app?.id ?? '')
  const startSession = useWarmStartSession(app?.id ?? '')
  const check = useCheckAppHealth({ id: app?.id ?? '', slug })
  const startWatching = (kind: PipelineKind) =>
    setKick({ kind, until: Date.now() + PIPELINE_KICK_GRACE_MS })
  const onRetry = (kind: PipelineKind) => () =>
    retry.mutate({ kind }, { onSuccess: () => startWatching(kind) })

  // The run we were waiting for has shown up: from here its own status decides the polling.
  const kickedStatus = kick ? (kick.kind === 'create' ? create.data : teardown.data)?.status : null
  useEffect(() => {
    if (kickedStatus === 'running') setKick(null)
  }, [kickedStatus])

  const hasRepo = Boolean(app?.repoOwner && app?.repoName)
  const stage = app
    ? appStage(app, { waitingForApproval, appBusy, createStatus: create.data?.status })
    : { launching: false, holding: false }
  const settled = Boolean(app) && !stage.holding
  const promotion = useAppPromotion(
    app?.id,
    hasRepo && settled && app?.status !== 'requested' && app?.status !== 'archived'
  )

  // The first build went live while this tab watched: say so, once.
  const wasHolding = useRef(stage.holding)
  const [justLive, setJustLive] = useState(false)
  useEffect(() => {
    if (wasHolding.current && !stage.holding && app?.status === 'live') setJustLive(true)
    wasHolding.current = stage.holding
  }, [stage.holding, app?.status])

  if (isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader title={slug} breadcrumbs={[{ label: 'Apps', to: '/apps' }, { label: slug }]} />
        <SectionPanelSkeleton rows={5} />
      </div>
    )
  }

  if (error || !app) {
    const missing = error instanceof ApiError && error.status === 404
    return (
      <div>
        <PageHeader title={slug} breadcrumbs={[{ label: 'Apps', to: '/apps' }, { label: slug }]} />
        <EmptyStateCard
          icon={missing ? Squares2X2Icon : ExclamationTriangleIcon}
          message={missing ? 'No app by that name' : 'This app could not be loaded'}
          description={missing ? undefined : error?.message}
          action={
            <Link to="/apps" className="btn btn-sm">
              Back to the catalogue
            </Link>
          }
        />
      </div>
    )
  }

  const archived = app.status === 'archived'
  const live = liveVersion(app)
  const liveUrl = app.environments.find(env => env.name === 'production')?.url ?? null
  const stagingUrl = app.environments.find(env => env.name === 'staging')?.url ?? null
  const canStart = hasRepo && can('create', 'Session') && !stage.holding && !archived
  const onOverview = pathname.replace(/\/+$/, '') === appPath(slug)
  const shipOffered =
    app.viewerCanDeploy && promotion.data ? promotionState(promotion.data).kind === 'ready' : false
  const heroHere = !(onOverview && shipOffered)
  const refusal = startSession.isError ? startRefusal(startSession.error) : null
  const teardownView = teardown.data
  const archivedAt = teardownView?.status === 'succeeded' ? lastFinished(teardownView) : null

  const menu: MenuItem[] = [
    ...(canManage ? [{ label: 'Edit details', onSelect: () => setEditOpen(true) }] : []),
    ...(canManage && !stage.launching && !archived && app.environments.length > 0
      ? [{ label: 'Check health now', onSelect: () => check.mutate() }]
      : []),
    ...(stagingUrl && !stage.holding ? [{ label: 'Open Staging', href: stagingUrl }] : []),
    ...(hasRepo
      ? [
          {
            label: 'View repository',
            href: `https://github.com/${app.repoOwner}/${app.repoName}`,
          },
        ]
      : []),
    ...(canManage && created && !archived
      ? [{ label: 'Archive app…', to: settingsPath(slug, 'danger') }]
      : []),
  ]

  // Sessions and Releases need a repository, and a running app: before the first build is live
  // they are disabled with the reason, never hidden — the reader learns they are coming.
  const disabledReason = (tab: AppTab): string | null => {
    if (tab !== 'sessions' && tab !== 'releases') return null
    if (stage.holding) return 'Available once the first version is live'
    if (!hasRepo) return 'Needs a GitHub repository'
    return null
  }

  const context: AppPageContext = {
    app,
    stage,
    canManage,
    hasRepo,
    createApprovalId: pendingCreate.approval?.id ?? null,
    pipeline: {
      create: create.data,
      teardown: teardownView,
      onRetry,
      retrying: retry.isPending,
      onRescaffold: () =>
        rescaffold.mutate(undefined, { onSuccess: () => startWatching('create') }),
      rescaffolding: rescaffold.isPending,
      onCancel: () => cancel.mutate(),
      cancelling: cancel.isPending,
      startWatching,
    },
  }

  return (
    <div className="space-y-6">
      <div>
        <PageHeader
          className="mb-0"
          leading={<AppThumbnail app={app} size="md" />}
          title={app.displayName}
          badge={
            app.status === 'live' ? (
              live && (
                <span className="font-mono tabular-nums text-sm text-secondary">
                  {v(live)} live
                </span>
              )
            ) : (
              <span className="status-badge" data-status={STATUS_TONE[app.status]}>
                {app.status}
              </span>
            )
          }
          breadcrumbs={[{ label: 'Apps', to: '/apps' }, { label: app.displayName }]}
          description={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-mono text-xs">{app.slug}</span>
              {app.description && (
                <>
                  <span aria-hidden="true" className="text-muted">
                    ·
                  </span>
                  <span>{app.description}</span>
                </>
              )}
            </span>
          }
          actions={
            <>
              {live && liveUrl && (
                <a
                  href={liveUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-outline gap-1.5"
                >
                  Open Live
                  <ArrowTopRightOnSquareIcon className="w-4 h-4" aria-hidden="true" />
                </a>
              )}
              {canStart && (
                <button
                  type="button"
                  className={`btn gap-1.5 ${heroHere ? 'btn-primary btn-flame' : ''}`}
                  disabled={startSession.isPending}
                  onClick={() =>
                    startSession.startWarm({}, session =>
                      navigate(`${appPath(slug)}/sessions/${session.id}`)
                    )
                  }
                >
                  {startSession.isPending ? (
                    <span className="loading loading-spinner loading-xs" />
                  ) : (
                    <RocketLaunchIcon className="w-4 h-4" aria-hidden="true" />
                  )}
                  Build it
                </button>
              )}
              <MoreMenu items={menu} size="md" />
            </>
          }
        />
        {refusal && (
          <p className="text-sm text-secondary mt-2" role="status">
            {refusal.message}
          </p>
        )}
      </div>

      <nav aria-label="App sections" className="tabs tabs-border -mt-2">
        {APP_TABS.map(tab => {
          const reason = disabledReason(tab)
          if (reason) {
            return (
              <span
                key={tab}
                className="tab tab-disabled"
                aria-disabled="true"
                title={reason}
                data-testid={`tab-${tab}`}
              >
                {TAB_LABEL[tab]}
              </span>
            )
          }
          return (
            <NavLink
              key={tab}
              to={appTabPath(slug, tab)}
              end={tab === 'overview'}
              className={({ isActive }) => `tab ${isActive ? 'tab-active' : ''}`}
              data-testid={`tab-${tab}`}
            >
              {TAB_LABEL[tab]}
            </NavLink>
          )
        })}
      </nav>

      {justLive && (
        <p className="flex flex-wrap items-center gap-2 text-sm" role="status">
          <CheckCircleIcon className="w-5 h-5 text-success shrink-0" />
          {app.displayName} is live{live ? ` at ${v(live)}` : ''}.
          {liveUrl && (
            <a href={liveUrl} target="_blank" rel="noopener noreferrer" className="link">
              Open it
            </a>
          )}
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setJustLive(false)}>
            Dismiss
          </button>
        </p>
      )}

      {teardownView && teardownView.status !== 'none' && teardownView.status !== 'succeeded' && (
        <PipelineProgress
          view={teardownView}
          canRetry={canManage}
          onRetry={onRetry('teardown')}
          retrying={retry.isPending}
        />
      )}

      {archived && (
        <p className="flex items-center gap-2 text-sm text-secondary">
          <ArchiveBoxIcon className="w-5 h-5 shrink-0" />
          Archived{archivedAt ? ` ${formatDateTime(archivedAt)}` : ''}. Its resources are deleted;
          the history is kept.
        </p>
      )}

      <Outlet context={context} />

      {editOpen && <EditAppModal app={app} open={editOpen} onClose={() => setEditOpen(false)} />}
    </div>
  )
}
