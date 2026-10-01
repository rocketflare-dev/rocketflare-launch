/**
 * The app page's pipeline strip (rocketflare-launch#5 part 8): `Staging: v1.4.2 (healthy,
 * deployed 10 minutes ago)` → [Promote to production] → `Production: v1.4.1`, and below it, in
 * plain words, what the promotion ships — the sessions and pull requests between the two versions.
 *
 * - One read, `useAppPromotion` (`GET /api/apps/:id/promotion`); every state and sentence comes
 *   from the pure `promotionModel.ts`.
 * - Promote opens the same confirmation as a release row (`PromoteDialog`) and the same route
 *   (`POST …/releases/:rid/promote`). The strip then STAYS: "Waiting for approval from …" with the
 *   request's link to share, "Deploying to production…", then "Live in production" with its link.
 * - Promoting is for the app's owners and admins (`viewerCanDeploy`, the server's own rule).
 *   Everybody else reads the same strip, with who can promote instead of the button.
 */
import {
  ArrowRightIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  LinkIcon,
  RocketLaunchIcon,
  ShieldExclamationIcon,
} from '@heroicons/react/24/outline'
import { approvalPath } from '@launch/shared/launch-approvals'
import type { AppPromotion, PromotionEnvironment } from '@launch/shared/launch-promotion'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { showToast } from '@/ui/components/shared'
import { useAppPromotion } from '@/ui/hooks/useReleases'
import { formatDateTime, timeAgo } from '@/ui/lib/format'
import { HealthDot } from './HealthDot'
import { PromoteDialog } from './PromoteButton'
import {
  changesTitle,
  type PromotionState,
  peopleSentence,
  promotersSentence,
  promotionState,
  STAGING_HEALTH_WORD,
  v,
} from './promotionModel'

function EnvironmentBox({
  label,
  env,
  showHealth,
}: {
  label: string
  env: PromotionEnvironment | null
  showHealth: boolean
}) {
  const version = env?.version ?? null
  return (
    <div className="min-w-0 flex-1 rounded-box border border-base-300 px-4 py-3">
      <p className="text-sm font-semibold flex items-center gap-2">
        {showHealth && env && <HealthDot status={env.healthStatus} />}
        <span>
          {label}: {version ? v(version) : 'nothing yet'}
        </span>
      </p>
      {env && version && (
        <p className="text-xs text-secondary mt-0.5">
          {showHealth ? `${STAGING_HEALTH_WORD[env.healthStatus]}, ` : ''}
          <span title={formatDateTime(env.deployedAt)}>
            deployed {timeAgo(env.deployedAt, 'some time ago')}
          </span>
          {env.url && (
            <>
              {' · '}
              <a
                href={env.url}
                target="_blank"
                rel="noopener noreferrer"
                className="link link-hover"
              >
                Open
              </a>
            </>
          )}
        </p>
      )}
    </div>
  )
}

function Arrow() {
  return (
    <ArrowRightIcon
      aria-hidden="true"
      className="w-5 h-5 text-muted shrink-0 self-center rotate-90 md:rotate-0"
    />
  )
}

/** The middle of the strip: the button, or where the promotion has got to. */
function Action({
  state,
  canPromote,
  onPromote,
}: {
  state: PromotionState
  canPromote: boolean
  onPromote: () => void
}) {
  if (state.kind === 'awaiting') {
    return (
      <span className="status-badge" data-status="awaiting-review">
        Waiting for approval
      </span>
    )
  }
  if (state.kind === 'deploying') {
    return (
      <span className="flex items-center gap-2 text-sm font-medium">
        <span className="loading loading-spinner loading-xs text-primary" />
        Deploying to production…
      </span>
    )
  }
  // Live: the status line says so, with its link — nothing to press.
  if (state.kind === 'live') return null
  if (!canPromote) {
    return state.kind === 'ready' ? (
      <span className="status-badge" data-status="active">
        Ready to promote
      </span>
    ) : null
  }
  const enabled = state.kind === 'ready'
  return (
    <button
      type="button"
      className="btn btn-primary gap-1.5"
      disabled={!enabled}
      aria-describedby={enabled ? undefined : 'pipeline-reason'}
      onClick={onPromote}
    >
      <RocketLaunchIcon className="w-4 h-4" />
      Promote to production
    </button>
  )
}

/** The line under the strip: why not, who it waits on, or that it is live. */
function StatusLine({
  state,
  production,
  canPromote,
  ownerTeam,
}: {
  state: PromotionState
  production: PromotionEnvironment | null
  canPromote: boolean
  ownerTeam: string | null
}) {
  const promoters = canPromote ? null : (
    <p className="text-sm text-secondary">{promotersSentence(ownerTeam)}</p>
  )
  if (state.kind === 'awaiting') {
    const approvers = state.approval?.approvers ?? []
    const id = state.approval?.id ?? state.release.approvalId
    const copy = async () => {
      if (!id) return
      try {
        await navigator.clipboard.writeText(`${window.location.origin}${approvalPath(id)}`)
        showToast('Link to the request copied', 'success')
      } catch {
        showToast('Could not copy the link', 'error')
      }
    }
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" role="status">
        <ShieldExclamationIcon className="w-5 h-5 text-warning shrink-0" />
        <p className="text-sm min-w-0 flex-1">
          {approvers.length > 0
            ? `Waiting for approval from ${peopleSentence(approvers)}.`
            : `${v(state.release.version)} is waiting for approval.`}{' '}
          <span className="text-secondary">Nothing reaches production until they approve it.</span>
        </p>
        {id && (
          <span className="flex gap-2">
            <Link to={approvalPath(id)} className="btn btn-sm">
              See the request
            </Link>
            <button type="button" className="btn btn-sm btn-ghost gap-1" onClick={copy}>
              <LinkIcon className="w-4 h-4" />
              Copy link
            </button>
          </span>
        )}
      </div>
    )
  }
  if (state.kind === 'deploying') {
    return (
      <p className="text-sm text-secondary" role="status">
        Approved. {v(state.release.version)} is on its way to production.
      </p>
    )
  }
  if (state.kind === 'live') {
    return (
      <div className="space-y-1">
        <p className="text-sm font-medium flex flex-wrap items-center gap-2" role="status">
          <CheckCircleIcon className="w-5 h-5 text-success shrink-0" />
          Live in production: {v(state.release.version)}
          {production?.url && (
            <a
              href={production.url}
              target="_blank"
              rel="noopener noreferrer"
              className="link link-hover inline-flex items-center gap-1 font-normal"
            >
              Open production
              <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
            </a>
          )}
        </p>
      </div>
    )
  }
  if (state.kind === 'blocked') {
    return (
      <div className="space-y-1">
        <p id="pipeline-reason" className="text-sm text-secondary">
          {state.reason}.
        </p>
        {promoters}
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <p className="text-sm text-secondary">
        {v(state.release.version)} is healthy on staging and ready for production.
        {state.askedBefore ? ' The last request was turned down; you can ask again.' : ''}
      </p>
      {promoters}
    </div>
  )
}

/** In plain words: each session (or pull request) the promotion carries. */
function Changes({ view, state }: { view: AppPromotion; state: PromotionState }) {
  const title = changesTitle(state)
  if (!title) return null
  const versions = new Set(view.changes.map(c => c.version))
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {view.changes.length === 0 ? (
        <p className="text-sm text-secondary mt-1">No changes were recorded for this release.</p>
      ) : (
        <ul className="mt-2 space-y-1.5" aria-label={title}>
          {view.changes.map(change => {
            const headline = change.sessionTitle?.trim() || change.title
            const detail = change.sessionTitle && change.title !== headline ? change.title : null
            return (
              <li key={`${change.version}-${change.number}`} className="text-sm flex gap-2">
                <span aria-hidden="true" className="text-muted">
                  •
                </span>
                <span className="min-w-0">
                  <span>{headline}</span>
                  {detail && <span className="text-secondary"> — {detail}</span>}
                  <span className="text-xs text-muted">
                    {' '}
                    {change.url ? (
                      <a
                        href={change.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="link link-hover"
                      >
                        change #{change.number}
                      </a>
                    ) : (
                      `change #${change.number}`
                    )}
                    {versions.size > 1 ? ` · in ${v(change.version)}` : ''}
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {view.changesTruncated && (
        <p className="text-xs text-muted mt-1">
          And more — open the release history below for the rest.
        </p>
      )}
    </div>
  )
}

export function PipelineStrip({
  appId,
  canPromote,
  ownerTeam,
}: {
  appId: string
  canPromote: boolean
  /** The app's owner team, to say who can promote. */
  ownerTeam: string | null
}) {
  const { data, isLoading, isError } = useAppPromotion(appId)
  const [open, setOpen] = useState(false)

  if (isLoading) {
    return (
      <section className="surface-panel" aria-label="Staging to production">
        <span className="loading loading-dots loading-sm text-muted" />
      </section>
    )
  }
  if (isError || !data) {
    return (
      <section className="surface-panel" aria-label="Staging to production">
        <p className="text-sm text-error" role="alert">
          Where staging and production stand could not be loaded.
        </p>
      </section>
    )
  }

  const state = promotionState(data)
  return (
    <section className="surface-panel space-y-4" aria-labelledby="pipeline-title">
      <h2 id="pipeline-title" className="text-base font-semibold">
        Staging to production
      </h2>
      <div className="flex flex-col md:flex-row md:items-stretch gap-3">
        <EnvironmentBox label="Staging" env={data.staging} showHealth />
        <Arrow />
        <div className="flex items-center justify-center shrink-0">
          <Action state={state} canPromote={canPromote} onPromote={() => setOpen(true)} />
        </div>
        <Arrow />
        <EnvironmentBox label="Production" env={data.production} showHealth={false} />
      </div>
      <StatusLine
        state={state}
        production={data.production}
        canPromote={canPromote}
        ownerTeam={ownerTeam}
      />
      <Changes view={data} state={state} />
      {open && state.release && (
        <PromoteDialog
          appId={appId}
          release={state.release}
          open={open}
          onClose={() => setOpen(false)}
          // The strip stays: the refetch the promote's invalidation starts shows who it waits on.
          onPromoted={() => undefined}
        />
      )}
    </section>
  )
}
