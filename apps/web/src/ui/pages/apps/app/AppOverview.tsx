/**
 * `/apps/:slug` — the Overview (decision 5): "use it, change it, is my change live?".
 *
 * Until the first build is live it is the takeover (decision 10): the launch as it happens
 * (`PipelineProgress` — retry from the failed step, re-scaffold, stop) or the create-approval
 * notice. After that, top to bottom:
 *
 * - **Needs you** — only when something needs a person (`NeedsYou`);
 * - **the flow**, one row per hop: Staging (version, health dot, age, Open), then "N changes not
 *   live" with Ship, then Live. A release in flight shows as ONE line on the row it is changing
 *   ("→ v1.4.2 · uploading · started 48 seconds ago", "→ v1.4.2 · Waiting for approval from Bob ·
 *   Copy link") — read from each environment's latest deploy (`useDeployProgress`) and the
 *   promotion view (`useAppPromotion`). Health is the dot only, kept apart from the deploy result;
 * - **active sessions**, with "All sessions →".
 *
 * A release in flight's line carries Details and a ⋯ with Cancel release (app page P2); a stuck
 * one is a Needs-you item with its stage-aware Retry and "Fix in a session" (`ReleaseActions`).
 *
 * Ship is the view's hero (`.btn-flame`) while it is on offer; it opens `ShipDialog` and the page
 * stays, its Live row then naming who the request waits on. Shipping is for the app's owners and
 * admins (`viewerCanDeploy`); everybody else reads who can.
 *
 * P3 seam: the `main  N commits ahead  [Release to staging ▸]` row belongs above Staging once
 * `GET /:id/releases/compare` exists. Until then "New release" lives on the Releases tab.
 */
import { LinkIcon, ShieldExclamationIcon } from '@heroicons/react/24/outline'
import { approvalPath } from '@launch/shared/launch-approvals'
import type { AppEnvironment } from '@launch/shared/launch-apps'
import type { AppPromotion } from '@launch/shared/launch-promotion'
import type { Release } from '@launch/shared/launch-releases'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { showToast } from '@/ui/components/shared'
import { useAppConfig } from '@/ui/hooks/useAppConfig'
import { useAuth } from '@/ui/hooks/useAuth'
import { useDeployProgress, useDeploys } from '@/ui/hooks/useDeploys'
import { useAppPromotion } from '@/ui/hooks/useReleases'
import { useAppSessions } from '@/ui/hooks/useSessions'
import { SessionStatusBadge } from '@/ui/pages/sessions/components/SessionStatusBadge'
import { HEALTH_LABEL, HealthDot } from '../components/HealthDot'
import { PipelineProgress } from '../components/PipelineProgress'
import {
  changesNotLive,
  type PromotionState,
  promotersSentence,
  promotionState,
  summaryLine,
  v,
} from '../components/promotionModel'
import { ShipDialog } from '../components/ShipDialog'
import {
  ENV_LABEL,
  type InFlight,
  liveInFlight,
  needsYou,
  notDeployedYet,
  releasePath,
  stagingInFlight,
} from './appPageModel'
import { Ago, ExternalLink, MoreMenu, SectionHeading, Version } from './bits'
import { type AppPageContext, useAppPage } from './context'
import { NeedsYou } from './NeedsYou'
import { useReleaseMenu } from './ReleaseActions'

/** A new app waiting on an admin's approval (P4 `app.create`): say so, and link to the request. */
function AwaitingCreateApproval({ approvalId }: { approvalId: string }) {
  return (
    <section className="space-y-2" aria-label="Waiting for approval">
      <h2 className="text-base font-semibold flex items-center gap-2">
        <ShieldExclamationIcon className="w-5 h-5 text-warning shrink-0" />
        This app is waiting for approval
      </h2>
      <p className="text-sm text-secondary">
        Nothing is created until an administrator approves it; the launch then starts on its own.
      </p>
      <Link to={approvalPath(approvalId)} className="btn btn-sm">
        See the request
      </Link>
    </section>
  )
}

/** The first build takes the Overview over until it is live. */
function FirstBuild({ ctx }: { ctx: AppPageContext }) {
  const { app, pipeline, canManage, createApprovalId } = ctx
  if (createApprovalId) return <AwaitingCreateApproval approvalId={createApprovalId} />
  const stagingHost = app.environments
    .find(env => env.name === 'staging')
    ?.url?.replace(/^https?:\/\//, '')
  return (
    <PipelineProgress
      view={
        pipeline.create ?? {
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
      onRetry={pipeline.onRetry('create')}
      retrying={pipeline.retrying}
      onRescaffold={pipeline.onRescaffold}
      rescaffolding={pipeline.rescaffolding}
      onCancel={pipeline.onCancel}
      cancelling={pipeline.cancelling}
      subject={stagingHost && <span className="font-mono text-xs">{stagingHost}</span>}
    />
  )
}

/** A release in flight's Details and ⋯ (Cancel release), on its environment's line. */
function InFlightActions({ release, slug }: { release: Release; slug: string }) {
  const { items, dialog } = useReleaseMenu(release)
  return (
    <>
      <Link to={releasePath(slug, release.version)} className="link link-hover">
        Details
      </Link>
      <MoreMenu items={items} label={`Actions for v${release.version}`} />
      {dialog}
    </>
  )
}

/** The line under an environment row while a release is on its way to it. */
function InFlightLine({ line, slug }: { line: InFlight; slug: string }) {
  if (line.kind === 'moving') {
    return (
      <div className="text-sm text-secondary flex flex-wrap items-center gap-x-2">
        <span className="loading loading-spinner loading-xs text-primary" aria-hidden="true" />
        <span role="status">
          → {line.version && <Version>{line.version}</Version>} · {line.what}
          {line.since && (
            <>
              {' '}
              · started <Ago at={line.since} />
            </>
          )}
        </span>
        {line.runUrl && <ExternalLink href={line.runUrl}>View run</ExternalLink>}
        {line.release && <InFlightActions release={line.release} slug={slug} />}
      </div>
    )
  }
  const copy = async () => {
    if (!line.approvalId) return
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${approvalPath(line.approvalId)}`
      )
      showToast('Link to the request copied', 'success')
    } catch {
      showToast('Could not copy the link', 'error')
    }
  }
  return (
    <p className="text-sm flex flex-wrap items-center gap-x-2 gap-y-1" role="status">
      <span>
        → {line.version && <Version>{line.version}</Version>} ·{' '}
        {line.approvers ? `Waiting for approval from ${line.approvers}` : 'Waiting for approval'}
      </span>
      {line.approvalId && (
        <>
          <Link to={approvalPath(line.approvalId)} className="link link-hover">
            See the request
          </Link>
          <button type="button" className="btn btn-ghost btn-xs gap-1" onClick={copy}>
            <LinkIcon className="w-3.5 h-3.5" />
            Copy link
          </button>
        </>
      )}
    </p>
  )
}

function EnvRow({ env, line, slug }: { env: AppEnvironment; line: InFlight | null; slug: string }) {
  const empty = notDeployedYet(env)
  const version = env.lastDeployVersion
  return (
    <li className="py-3 space-y-1" data-testid={`env-${env.name}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="w-16 shrink-0 text-sm font-medium">{ENV_LABEL[env.name]}</span>
        {empty ? (
          <span className="text-sm text-muted" data-testid="not-deployed">
            Not deployed yet
          </span>
        ) : (
          <>
            {version ? <Version>{v(version)}</Version> : <span className="text-muted">—</span>}
            <span className="inline-flex items-center gap-1.5 text-xs text-secondary">
              <HealthDot status={env.healthStatus} />
              <span>{HEALTH_LABEL[env.healthStatus]}</span>
            </span>
            {env.lastDeployAt && (
              <span className="text-xs text-secondary">
                <Ago at={env.lastDeployAt} />
              </span>
            )}
          </>
        )}
        {env.url && !empty && (
          <a
            href={env.url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-xs btn-ghost ml-auto"
            aria-label={`Open ${ENV_LABEL[env.name]}`}
          >
            Open ↗
          </a>
        )}
      </div>
      {line && (
        <div className="sm:pl-20">
          <InFlightLine line={line} slug={slug} />
        </div>
      )}
    </li>
  )
}

/** Between Staging and Live: what is waiting, and Ship. */
function ShipRow({
  ctx,
  view,
  state,
}: {
  ctx: AppPageContext
  view: AppPromotion
  state: PromotionState
}) {
  const [open, setOpen] = useState(false)
  const { app } = ctx
  const changes = changesNotLive(view, state)
  const ready = state.kind === 'ready'
  // Why Ship is not on offer, when that is news (not "nothing yet", not on its way, not done).
  const blocked =
    state.kind === 'blocked' && !state.progress && !state.productionAhead && view.staging?.version
      ? state.reason
      : null
  const reason = blocked && !/[.…!?]$/.test(blocked) ? `${blocked}.` : blocked
  if (!changes && !ready && !reason) return null
  return (
    <li className="py-3 sm:pl-20 space-y-2" aria-label="Changes not live">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {changes ? (
          <details className="min-w-0">
            <summary className="cursor-pointer text-sm font-medium">{changes}</summary>
            <ul className="mt-2 space-y-1.5" aria-label="What Ship puts live">
              {view.changes.map(change => {
                const headline = change.sessionTitle?.trim() || change.title
                const line = summaryLine(change.summary)
                return (
                  <li key={`${change.version}-${change.number}`} className="text-sm">
                    {headline}{' '}
                    <span className="text-xs text-muted">
                      {change.url ? (
                        <a
                          href={change.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link link-hover"
                        >
                          #{change.number}
                        </a>
                      ) : (
                        `#${change.number}`
                      )}
                    </span>
                    {line && (
                      <span className="block text-xs text-secondary" data-change-summary>
                        {line}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </details>
        ) : reason ? (
          <span className="text-sm text-secondary" role="status">
            {reason}
          </span>
        ) : null}
        {ready && app.viewerCanDeploy && (
          <button
            type="button"
            className="btn btn-sm btn-primary btn-flame ml-auto"
            onClick={() => setOpen(true)}
          >
            Ship {v(state.release.version)} live
          </button>
        )}
      </div>
      {changes && reason && <p className="text-sm text-secondary">{reason}</p>}
      {ready && !app.viewerCanDeploy && (
        <p className="text-sm text-secondary">
          {v(state.release.version)} is ready to ship.{' '}
          {promotersSentence(app.ownerGroup?.name ?? null)}
        </p>
      )}
      {ready && state.askedBefore && app.viewerCanDeploy && (
        <p className="text-xs text-muted">The last request was turned down; you can ask again.</p>
      )}
      {open && state.release && (
        <ShipDialog
          appId={app.id}
          release={state.release}
          changes={view.changes}
          open={open}
          onClose={() => setOpen(false)}
          // The page stays: the refetch the ship's invalidation starts shows who it waits on.
          onShipped={() => undefined}
        />
      )}
    </li>
  )
}

function ActiveSessions({ appId, slug }: { appId: string; slug: string }) {
  const { data, isLoading } = useAppSessions(appId, 'active')
  const items = data?.items ?? []
  return (
    <section aria-labelledby="active-sessions-title">
      <SectionHeading
        id="active-sessions-title"
        actions={
          <Link
            to={`/apps/${encodeURIComponent(slug)}/sessions`}
            className="link link-hover text-sm"
          >
            All sessions →
          </Link>
        }
      >
        Active sessions
      </SectionHeading>
      {isLoading ? (
        <span className="loading loading-dots loading-sm text-muted" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">No sessions running.</p>
      ) : (
        <ul className="divide-y divide-base-300 border-y border-base-300">
          {items.slice(0, 5).map(session => (
            <li key={session.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
              <Link
                to={`/apps/${encodeURIComponent(slug)}/sessions/${session.id}`}
                className="link link-hover text-sm font-medium min-w-0 truncate"
              >
                {session.title?.trim() || `Session ${session.shortId.slice(0, 6)}`}
              </Link>
              <SessionStatusBadge status={session.status} />
              <span className="text-xs text-secondary ml-auto">
                <Ago at={session.lastActivityAt ?? session.createdAt} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function LiveOverview({ ctx }: { ctx: AppPageContext }) {
  const { app, hasRepo } = ctx
  const { user } = useAuth()
  const running = app.status !== 'requested' && app.status !== 'archived'
  const promotion = useAppPromotion(app.id, hasRepo && running)
  const latest = useDeployProgress(app.id, app.status !== 'requested')
  const tickets = useDeploys(app.id, running)
  const config = useAppConfig(app.id, hasRepo && app.status !== 'archived')

  const state = promotion.data ? promotionState(promotion.data) : null
  const latestItems = latest.data?.items ?? []
  const latestFor = (name: AppEnvironment['name']) =>
    latestItems.find(deploy => deploy.environment === name)
  const items = needsYou({
    state,
    latest: latestItems,
    tickets: tickets.data?.items ?? [],
    config: config.data ?? null,
    viewerId: user?.id ?? null,
    viewerCanDeploy: app.viewerCanDeploy,
  })
  const staging = app.environments.find(env => env.name === 'staging')
  const live = app.environments.find(env => env.name === 'production')

  return (
    <div className="space-y-8">
      <NeedsYou items={items} appId={app.id} slug={app.slug} />

      <section aria-labelledby="flow-title">
        <SectionHeading id="flow-title">Where it runs</SectionHeading>
        {app.environments.length === 0 ? (
          <p className="text-sm text-muted">No environments recorded.</p>
        ) : (
          <ul className="divide-y divide-base-300 border-y border-base-300">
            {staging && (
              <EnvRow
                env={staging}
                line={stagingInFlight(latestFor('staging'), state)}
                slug={app.slug}
              />
            )}
            {promotion.data && state && <ShipRow ctx={ctx} view={promotion.data} state={state} />}
            {live && (
              <EnvRow
                env={live}
                line={liveInFlight(latestFor('production'), state)}
                slug={app.slug}
              />
            )}
          </ul>
        )}
      </section>

      {hasRepo && app.status !== 'archived' && <ActiveSessions appId={app.id} slug={app.slug} />}
    </div>
  )
}

export default function AppOverview() {
  const ctx = useAppPage()
  if (ctx.stage.holding) return <FirstBuild ctx={ctx} />
  return <LiveOverview ctx={ctx} />
}
