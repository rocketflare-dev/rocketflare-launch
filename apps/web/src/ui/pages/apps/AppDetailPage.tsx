/**
 * `/apps/:slug` (spec/06): one app — its environments with URLs, health and declared resources,
 * twenty-four hours of health history, its sign-in through Launch (the OIDC client, with the secret
 * shown once), the operations log, and a link to who may sign in (`/apps/:slug/access`). Every
 * member reads it; "Check now", Edit and the OIDC actions are for admins (`manage App`).
 *
 * P2: an app Launch created also shows its launch as it happens (`PipelineProgress`, polled only
 * while a run is owed — `usePipeline`), its deploys (`DeploysCard`), and a danger zone whose
 * Archive runs the teardown, which then shows here the same way. Approving, rejecting and starting
 * a production deploy is for the app's owners as well as admins — the detail's `viewerCanDeploy`,
 * the server's own rule; retry, re-scaffold (a failed launch that never deployed, from the current
 * kit pin) and archive stay `manage App`.
 *
 * Any app that has deployed shows each environment's latest deploy near the top
 * (`DeployProgressPanel`): while one runs, its stepper — dispatched → approved → uploaded →
 * migrating → activating → live — polled until it settles, with its GitHub run.
 *
 * P4: an app with a repository carries its releases (`ReleasesCard`) — cut one, watch it reach
 * staging, promote it to production through an approval — and a pending production deploy links
 * to its approval instead of being decided in place. Above everything that follows, its pipeline
 * strip (`PipelineStrip`, rocketflare-launch#5): staging → Promote to production → production, what
 * the promotion ships, and who it waits on — the page's primary action.
 *
 * P5: an app with a repository carries its shared config (`ConfigCard`) — what it declares, the
 * shared resources that match, and per environment whether it holds each one, with Request.
 *
 * P3: an app with a repository also carries its coding sessions (`SessionsCard`) — "Start session"
 * and the sessions running on it. While the launch is under way the
 * parts that only make sense for a running app — health history, "Check now", the sign-in card the
 * pipeline itself registers — wait for it.
 */
import {
  ArchiveBoxIcon,
  ArrowPathIcon,
  CodeBracketIcon,
  ExclamationTriangleIcon,
  PencilSquareIcon,
  ShieldExclamationIcon,
  Squares2X2Icon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { approvalPath } from '@launch/shared/launch-approvals'
import type { AppDetail } from '@launch/shared/launch-apps'
import type { PipelineKind, PipelineView } from '@launch/shared/launch-pipeline'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  EmptyStateCard,
  PageHeader,
  SectionPanel,
  SectionPanelSkeleton,
} from '@/ui/components/shared'
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
import { ApiError } from '@/ui/lib/api-client'
import { formatDate, formatDateTime } from '@/ui/lib/format'
import { ConfigCard } from './components/ConfigCard'
import { DeployProgressPanel } from './components/DeployProgressPanel'
import { DeploysCard } from './components/DeploysCard'
import { EditAppModal } from './components/EditAppModal'
import { EnvironmentCard } from './components/EnvironmentCard'
import { HealthHistory } from './components/HealthHistory'
import { OidcClientCard } from './components/OidcClientCard'
import { OperationsLog } from './components/OperationsLog'
import { PipelineProgress } from './components/PipelineProgress'
import { PipelineStrip } from './components/PipelineStrip'
import { ReleasesCard } from './components/ReleasesCard'
import { SessionsCard } from './components/SessionsCard'
import { ShipSettingsCard } from './components/ShipSettingsCard'
import { TeardownModal } from './components/TeardownModal'

function About({ app }: { app: AppDetail }) {
  const repo = app.repoOwner && app.repoName ? `${app.repoOwner}/${app.repoName}` : null
  return (
    <SectionPanel title="About">
      <dl className="space-y-3 text-sm">
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
        <AboutRow label="Team">
          {app.ownerGroup?.name ?? <span className="text-muted italic">No team</span>}
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
    </SectionPanel>
  )
}

function AboutRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted shrink-0">{label}</dt>
      <dd className="text-right min-w-0 truncate">{children}</dd>
    </div>
  )
}

function CheckNowButton({ app }: { app: AppDetail }) {
  const check = useCheckAppHealth(app)
  return (
    <button
      type="button"
      className="btn btn-sm gap-1.5"
      disabled={check.isPending}
      onClick={() => check.mutate()}
      title="Probe /api/health and /api/ready on every environment now"
    >
      <ArrowPathIcon className={`w-4 h-4 ${check.isPending ? 'animate-spin' : ''}`} />
      {check.isPending ? 'Checking…' : 'Check now'}
    </button>
  )
}

function DangerZone({
  onArchive,
  busy,
}: {
  onArchive: () => void
  /** A launch or teardown is still running: another run now would race it. */
  busy: boolean
}) {
  return (
    <section className="surface-panel border-error/40" aria-labelledby="danger-zone-title">
      <h2 id="danger-zone-title" className="text-base font-semibold text-error">
        Danger zone
      </h2>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">Archive this app</p>
          <p className="text-sm text-secondary mt-0.5">
            Deletes its Workers, database, storage and email keys, disables its sign-in and archives
            the repository. The catalogue keeps the app, marked archived.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-error btn-outline gap-1.5 shrink-0"
          onClick={onArchive}
          disabled={busy}
          title={busy ? 'Wait for the running pipeline to finish or stop first' : undefined}
        >
          <TrashIcon className="w-4 h-4" />
          Archive app…
        </button>
      </div>
    </section>
  )
}

/** A new app waiting on an admin's approval (P4 `app.create`): say so, and link to the request. */
function AwaitingCreateApproval({ approvalId }: { approvalId: string }) {
  return (
    <section
      className="surface-panel border-l-4 border-l-warning flex flex-wrap items-center gap-3"
      aria-label="Waiting for approval"
    >
      <ShieldExclamationIcon className="w-5 h-5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">This app is waiting for approval</p>
        <p className="text-sm text-secondary">
          Nothing is created until an administrator approves it; the launch then starts on its own.
        </p>
      </div>
      <Link to={approvalPath(approvalId)} className="btn btn-sm">
        See the request
      </Link>
    </section>
  )
}

/** App status → the `.status-badge` vocabulary in `index.css`. */
const STATUS_TONE: Record<AppDetail['status'], string> = {
  live: 'active',
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

export default function AppDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const { data: app, isLoading, error } = useApp(slug)
  const { can, isAdminLevel } = usePermissions()
  const canManage = can('manage', 'App')
  const [editOpen, setEditOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
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
  const startWatching = (kind: PipelineKind) =>
    setKick({ kind, until: Date.now() + PIPELINE_KICK_GRACE_MS })
  const onRetry = (kind: PipelineKind) => () =>
    retry.mutate({ kind }, { onSuccess: () => startWatching(kind) })

  // The run we were waiting for has shown up: from here its own status decides the polling.
  const kickedStatus = kick ? (kick.kind === 'create' ? create.data : teardown.data)?.status : null
  useEffect(() => {
    if (kickedStatus === 'running') setKick(null)
  }, [kickedStatus])

  if (isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader title={slug} breadcrumbs={[{ label: 'Apps', to: '/apps' }, { label: slug }]} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SectionPanelSkeleton rows={5} />
          <SectionPanelSkeleton rows={5} />
        </div>
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

  const createView = create.data
  const teardownView = teardown.data
  // The launch panel stays until the run succeeds and the app is live: while the row says a run
  // is owed, or while the latest run has not succeeded.
  const launching =
    created &&
    app.status !== 'live' &&
    app.status !== 'archived' &&
    !waitingForApproval &&
    (appBusy || (createView !== undefined && createView.status !== 'succeeded'))
  const stagingHost = app.environments
    .find(env => env.name === 'staging')
    ?.url?.replace(/^https?:\/\//, '')
  const hasRepo = Boolean(app.repoOwner && app.repoName)
  // Launching, or not yet approved to launch: either way the running-app panels wait.
  const holding = launching || waitingForApproval
  const archivedAt = teardownView?.status === 'succeeded' ? lastFinished(teardownView) : null

  return (
    <div className="space-y-6">
      <PageHeader
        className="mb-0"
        title={app.displayName}
        badge={
          app.status === 'live' ? null : (
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
          canManage && (
            <>
              {!launching && app.status !== 'archived' && <CheckNowButton app={app} />}
              <button
                type="button"
                className="btn btn-sm btn-ghost gap-1.5"
                onClick={() => setEditOpen(true)}
              >
                <PencilSquareIcon className="w-4 h-4" />
                Edit
              </button>
            </>
          )
        }
      />

      {teardownView && teardownView.status !== 'none' && teardownView.status !== 'succeeded' && (
        <PipelineProgress
          view={teardownView}
          canRetry={canManage}
          onRetry={onRetry('teardown')}
          retrying={retry.isPending}
        />
      )}

      {app.status === 'archived' && (
        <div className="alert alert-soft text-sm">
          <ArchiveBoxIcon className="w-5 h-5" />
          <span>
            Archived{archivedAt ? ` ${formatDateTime(archivedAt)}` : ''}. Its resources are deleted;
            the history below is kept.
          </span>
        </div>
      )}

      {pendingCreate.approval && <AwaitingCreateApproval approvalId={pendingCreate.approval.id} />}

      {launching && (
        <PipelineProgress
          view={
            createView ?? {
              appId: app.id,
              runId: null,
              kind: 'create',
              status: 'none',
              steps: [],
              canRescaffold: false,
              rescaffoldChecksDatabase: false,
              templateTag: null,
            }
          }
          canRetry={canManage}
          onRetry={onRetry('create')}
          retrying={retry.isPending}
          onRescaffold={() =>
            rescaffold.mutate(undefined, { onSuccess: () => startWatching('create') })
          }
          rescaffolding={rescaffold.isPending}
          onCancel={() => cancel.mutate()}
          cancelling={cancel.isPending}
          subject={stagingHost && <span className="font-mono text-xs">{stagingHost}</span>}
        />
      )}

      {/* rocketflare-launch#5: staging → [Promote to production] → production, and what it ships —
          the page's primary action, for the app's owners and admins; read-only for everyone else. */}
      {hasRepo && !holding && app.status !== 'requested' && app.status !== 'archived' && (
        <PipelineStrip
          appId={app.id}
          canPromote={app.viewerCanDeploy}
          ownerTeam={app.ownerGroup?.name ?? null}
        />
      )}

      {/* Each environment's latest deploy, as it runs: dispatched → … → live, or failed. */}
      {app.status !== 'requested' && <DeployProgressPanel appId={app.id} />}

      {app.environments.length === 0 ? (
        <EmptyStateCard icon={Squares2X2Icon} message="No environments recorded" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {app.environments.map(env => (
            <EnvironmentCard key={env.id} env={env} />
          ))}
        </div>
      )}

      {created && app.status !== 'requested' && app.status !== 'archived' && (
        <DeploysCard
          appId={app.id}
          canDecide={app.viewerCanDeploy}
          canDeployProduction={app.viewerCanDeploy && app.status === 'live'}
        />
      )}

      {/* Launch P4: releases — tag, staging, then production through an approval. For an app with
          a repository Launch can tag; cutting and promoting is for its owners and admins. */}
      {hasRepo && !holding && app.status !== 'requested' && app.status !== 'archived' && (
        <ReleasesCard appId={app.id} canRelease={app.viewerCanDeploy} />
      )}

      {/* Launch P5: the shared config the app declares, and whether it holds it — read from the
          repository, so for an app with one. */}
      {hasRepo && !holding && app.status !== 'archived' && (
        <ConfigCard appId={app.id} appSlug={app.slug} appName={app.displayName} />
      )}

      {/* Launch P3: the way into a coding session — for an app with a repository to work on. */}
      {hasRepo && !holding && app.status !== 'archived' && (
        <SessionsCard appId={app.id} appSlug={app.slug} canStart={can('create', 'Session')} />
      )}
      {/* Issue #5: what Ship does on this app — a summary; owners and admins change it in a modal. */}
      {hasRepo && !holding && <ShipSettingsCard app={app} canApplyProtection={canManage} />}

      {app.environments.length > 0 && !holding && (
        <HealthHistory appId={app.id} environments={app.environments} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <div className="lg:col-span-2">
          {holding ? (
            <SectionPanel title="Sign-in through Launch">
              <p className="text-sm text-secondary">
                The launch registers this app’s sign-in client itself; it appears here once the app
                is live.
              </p>
            </SectionPanel>
          ) : (
            <OidcClientCard appId={app.id} slug={app.slug} canManage={canManage} />
          )}
        </div>
        <About app={app} />
      </div>

      <OperationsLog appId={app.id} />

      {canManage && created && app.status !== 'archived' && (
        <DangerZone
          onArchive={() => setArchiveOpen(true)}
          busy={createView?.status === 'running' || teardownView?.status === 'running'}
        />
      )}

      {editOpen && <EditAppModal app={app} open={editOpen} onClose={() => setEditOpen(false)} />}
      {archiveOpen && (
        <TeardownModal
          app={app}
          open={archiveOpen}
          onClose={() => setArchiveOpen(false)}
          onStarted={() => startWatching('teardown')}
          view={teardownView}
          onRetry={canManage ? onRetry('teardown') : undefined}
          retrying={retry.isPending}
        />
      )}
    </div>
  )
}
