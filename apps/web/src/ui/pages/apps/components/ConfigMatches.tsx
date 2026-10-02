/**
 * An app's shared config on its detail page (Launch P5, spec/09): what the last scan found the app
 * declares, the shared resources those keys match, and per environment whether the app holds each
 * one — held, pushing, requested (with the request's link), or missing (with a Request button for
 * the app's owners and admins). Re-scan reads the repository again. The whole story — keys grouped
 * by plugin, keys nothing matches, every grant with Revoke — is the Config page
 * (`/apps/:slug/config`); `MatchList` and `ScanLine` are shared with it.
 *
 * Never a value: an app's page shows item NAMES and states only.
 */
import { ArrowPathIcon, KeyIcon } from '@heroicons/react/24/outline'
import { approvalPath } from '@launch/shared/launch-approvals'
import { APP_ENVIRONMENT_NAMES } from '@launch/shared/launch-apps'
import {
  type AppConfigMatch,
  type AppConfigView,
  appConfigPath,
  sharedResourcePath,
} from '@launch/shared/launch-grants'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useAppConfig, useRescanAppConfig } from '@/ui/hooks/useAppConfig'
import { formatDateTime, timeAgo } from '@/ui/lib/format'
import { ENV_STATE, envGrantState, lastOutcome, missingEnvironments } from './configModel'
import { RequestGrantModal } from './RequestGrantModal'

/** One environment's chip, with the request's link while it waits on the owner team. */
export function EnvStatus({
  match,
  env,
}: {
  match: AppConfigMatch
  env: (typeof APP_ENVIRONMENT_NAMES)[number]
}) {
  const grant = match.grants[env]
  const state = envGrantState(grant)
  const badge = ENV_STATE[state]
  const outcome = state === 'missing' ? lastOutcome(grant) : null
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs" data-env={env}>
      <span className="text-muted capitalize">{env}</span>
      <span
        className="status-badge"
        data-status={badge.tone}
        data-state={state}
        title={grant?.pushError ?? outcome ?? undefined}
      >
        {badge.label}
        {state === 'met' && grant?.pushedVersion ? ` · v${grant.pushedVersion}` : ''}
      </span>
      {state === 'requested' && grant?.approvalId && (
        <Link to={approvalPath(grant.approvalId)} className="link link-hover">
          View request
        </Link>
      )}
    </span>
  )
}

/** The matched resources, one row each, with the per-environment states and Request. */
export function MatchList({
  view,
  appId,
  appName,
}: {
  view: AppConfigView
  appId: string
  appName: string
}) {
  const [requesting, setRequesting] = useState<AppConfigMatch | null>(null)
  return (
    <>
      <ul className="divide-y divide-[color:var(--border-subtle)]" aria-label="Shared config">
        {view.matched.map(match => {
          const canAsk =
            view.canRequest && !match.resource.archived && missingEnvironments(match).length > 0
          return (
            <li
              key={match.resource.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5"
              data-resource={match.resource.slug}
            >
              <div className="min-w-0 flex-1">
                <Link
                  to={sharedResourcePath(match.resource.id)}
                  className="link link-hover font-medium text-sm"
                >
                  {match.resource.displayName}
                </Link>
                {match.resource.archived && (
                  <span className="status-badge ml-2" data-status="archived">
                    archived
                  </span>
                )}
                <span className="block truncate font-mono text-xs text-muted">
                  {match.keys.join(', ')}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {APP_ENVIRONMENT_NAMES.map(env => (
                  <EnvStatus key={env} match={match} env={env} />
                ))}
              </div>
              {canAsk && (
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  onClick={() => setRequesting(match)}
                >
                  Request
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {requesting && (
        <RequestGrantModal
          key={requesting.resource.id}
          appId={appId}
          appName={appName}
          match={requesting}
          open={Boolean(requesting)}
          onClose={() => setRequesting(null)}
        />
      )}
    </>
  )
}

/** "Scanned main @ abc1234 2 hours ago", or the scan's error. */
export function ScanLine({ view }: { view: AppConfigView }) {
  if (!view.scan) {
    return <p className="text-xs text-muted">Not scanned yet.</p>
  }
  const where = [view.scan.ref, view.scan.sha?.slice(0, 7)].filter(Boolean).join(' @ ')
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted" title={formatDateTime(view.scan.scannedAt)}>
        Scanned {where && <span className="font-mono">{where}</span>} {timeAgo(view.scan.scannedAt)}
      </p>
      {view.scan.error && (
        <div className="alert alert-warning alert-soft text-sm" role="status">
          <span>The last scan failed: {view.scan.error}</span>
        </div>
      )}
    </div>
  )
}

export function RescanButton({ appId }: { appId: string }) {
  const rescan = useRescanAppConfig(appId)
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost gap-1.5"
      disabled={rescan.isPending}
      onClick={() => rescan.mutate()}
    >
      {rescan.isPending ? (
        <span className="loading loading-spinner loading-xs" />
      ) : (
        <ArrowPathIcon className="w-4 h-4" />
      )}
      Re-scan
    </button>
  )
}

export function ConfigCard({
  appId,
  appSlug,
  appName,
}: {
  appId: string
  appSlug: string
  appName: string
}) {
  const { data: view, isLoading, isError } = useAppConfig(appId)
  const unmatched = view?.unmatched.length ?? 0

  return (
    <SectionPanel
      title="Config"
      description="Shared config this app declares, and whether it holds it."
      actions={
        <>
          {view?.canRequest && <RescanButton appId={appId} />}
          <Link to={appConfigPath(appSlug)} className="btn btn-sm btn-ghost">
            Open config
          </Link>
        </>
      }
    >
      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : isError || !view ? (
        <p className="text-sm text-muted">This app’s config could not be loaded.</p>
      ) : (
        <div className="space-y-3">
          <ScanLine view={view} />
          {view.matched.length === 0 && unmatched === 0 ? (
            <EmptyState
              size="sm"
              icon={KeyIcon}
              message={
                view.scan ? 'This app declares no shared config.' : 'Nothing is known about it yet.'
              }
            />
          ) : (
            <>
              {view.matched.length > 0 && <MatchList view={view} appId={appId} appName={appName} />}
              {unmatched > 0 && (
                <p className="text-xs text-muted">
                  {unmatched === 1
                    ? 'One declared key matches'
                    : `${unmatched} declared keys match`}{' '}
                  no shared config —{' '}
                  <Link to={appConfigPath(appSlug)} className="link link-hover">
                    see which
                  </Link>
                  .
                </p>
              )}
            </>
          )}
        </div>
      )}
    </SectionPanel>
  )
}
