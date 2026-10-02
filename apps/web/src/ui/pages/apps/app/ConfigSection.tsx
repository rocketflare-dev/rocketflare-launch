/**
 * Settings → Config & secrets (`/apps/:slug/settings/config`; Launch P5, spec/09) — what the app
 * declares it needs, grouped by plugin, the shared resources those keys match with a status and a
 * Request button per environment, and the keys nothing matches ("ask an admin to add it"). The
 * grant-needed and grant-expiring notifications link to `/apps/:slug/config` (`appConfigPath`),
 * which redirects here.
 *
 * Top to bottom:
 * - the last scan (ref, sha, when, or its error) and Re-scan — the app's owners and admins;
 * - the matched resources (`MatchList`): held / pushing / requested with the request's link /
 *   missing with Request;
 * - the declared keys by plugin, each with the resource it matched or the hint;
 * - every grant of the app, declared or not, with Revoke (an active grant) and Re-push (one whose
 *   push failed) for the app's owners and admins.
 *
 * Every reader of the app may read it (the server decides `canRequest`). It never shows a value —
 * the app's owners hold a grant, they never see what is in it.
 */
import { ArrowPathIcon, KeyIcon } from '@heroicons/react/24/outline'
import { approvalPath } from '@launch/shared/launch-approvals'
import type { AppDetail } from '@launch/shared/launch-apps'
import { type AppConfigView, type AppGrant, sharedResourcePath } from '@launch/shared/launch-grants'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ConfirmModal,
  EmptyState,
  SectionPanel,
  SectionPanelSkeleton,
} from '@/ui/components/shared'
import { useAppConfig, useRepushGrant, useRevokeGrant } from '@/ui/hooks/useAppConfig'
import { formatDate, timeAgo } from '@/ui/lib/format'
import { MatchList, RescanButton, ScanLine } from '../components/ConfigMatches'
import { declaredByPlugin, ENV_STATE, envGrantState } from '../components/configModel'

const GRANT_STATUS_TONE: Record<AppGrant['status'], string> = {
  requested: 'awaiting-review',
  active: 'active',
  revoking: 'running',
  revoked: 'revoked',
  rejected: 'rejected',
  expired: 'expired',
}

function DeclaredKeys({ view }: { view: AppConfigView }) {
  const groups = declaredByPlugin(view)
  if (groups.length === 0) {
    return (
      <SectionPanel title="Declared keys">
        <p className="text-sm text-muted">
          {view.scan
            ? 'The app’s plugins declare no config keys.'
            : 'Re-scan to read what the app’s plugins declare.'}
        </p>
      </SectionPanel>
    )
  }
  return (
    <SectionPanel
      title="Declared keys"
      description="What each plugin in the repository says it reads from the environment."
    >
      <div className="space-y-4">
        {groups.map(group => (
          <div key={group.pluginId}>
            <h3 className="text-sm font-semibold mb-1">{group.label}</h3>
            <table className="data-table w-full text-sm">
              <tbody>
                {group.keys.map(({ item, resource }) => (
                  <tr key={item.key} data-key={item.key}>
                    <td className="font-mono text-xs w-1/3">{item.key}</td>
                    <td className="w-20">
                      <span className="status-badge no-dot" data-status="draft">
                        {item.secret ? 'secret' : 'var'}
                      </span>
                    </td>
                    <td>
                      {resource ? (
                        <Link to={sharedResourcePath(resource.id)} className="link link-hover">
                          {resource.displayName}
                        </Link>
                      ) : (
                        <span className="text-muted text-xs">
                          No shared config matches — ask an admin to add it, or set it on the app
                          yourself.
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </SectionPanel>
  )
}

function GrantsTable({ view, appId }: { view: AppConfigView; appId: string }) {
  const revoke = useRevokeGrant()
  const repush = useRepushGrant(appId)
  const [revoking, setRevoking] = useState<AppGrant | null>(null)

  return (
    <SectionPanel title="Grants" description="Every grant this app has asked for, newest first.">
      {view.grants.length === 0 ? (
        <EmptyState size="sm" icon={KeyIcon} message="No grants yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table w-full text-sm">
            <thead>
              <tr>
                <th>Resource</th>
                <th>Environment</th>
                <th>Status</th>
                <th>Holds</th>
                <th>Lapses</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view.grants.map(grant => {
                const state = envGrantState(grant)
                return (
                  <tr key={grant.id} data-grant={grant.id}>
                    <td>
                      <Link to={sharedResourcePath(grant.resource.id)} className="link link-hover">
                        {grant.resource.displayName}
                      </Link>
                    </td>
                    <td className="capitalize">{grant.environment}</td>
                    <td>
                      <span className="status-badge" data-status={GRANT_STATUS_TONE[grant.status]}>
                        {grant.status}
                      </span>
                      {grant.status === 'requested' && grant.approvalId && (
                        <Link
                          to={approvalPath(grant.approvalId)}
                          className="link link-hover text-xs ml-2"
                        >
                          View request
                        </Link>
                      )}
                      {grant.pushError && (
                        <span className="block text-xs text-error">{grant.pushError}</span>
                      )}
                    </td>
                    <td className="text-xs">
                      {grant.pushedVersion ? (
                        <span title={grant.pushedAt ? `Pushed ${timeAgo(grant.pushedAt)}` : ''}>
                          version {grant.pushedVersion}
                        </span>
                      ) : grant.status === 'active' ? (
                        <span className="text-muted">{ENV_STATE[state].label}…</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="text-xs">
                      {grant.expiresAt ? formatDate(grant.expiresAt) : 'never'}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {view.canRequest && grant.status === 'active' && grant.pushError && (
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost gap-1"
                          disabled={repush.isPending}
                          onClick={() => repush.mutate(grant.id)}
                        >
                          <ArrowPathIcon className="w-3.5 h-3.5" />
                          Re-push
                        </button>
                      )}
                      {view.canRequest && grant.status === 'active' && (
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost text-error"
                          onClick={() => setRevoking(grant)}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmModal
        isOpen={revoking !== null}
        title="Revoke this grant?"
        message={
          revoking && (
            <p>
              The {revoking.resource.displayName} secrets are removed from the app’s{' '}
              {revoking.environment} Worker. Anything that reads them answers “not configured” until
              it is granted again.
            </p>
          )
        }
        confirmText="Revoke"
        confirmButtonClass="btn-error"
        isLoading={revoke.isPending}
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          if (!revoking) return
          revoke.mutate({ appId, grantId: revoking.id }, { onSettled: () => setRevoking(null) })
        }}
      />
    </SectionPanel>
  )
}

export function ConfigSection({ app }: { app: Pick<AppDetail, 'id' | 'displayName'> }) {
  const config = useAppConfig(app.id)

  if (config.isLoading) {
    return (
      <div className="space-y-4">
        <SectionPanelSkeleton rows={3} />
        <SectionPanelSkeleton rows={4} />
      </div>
    )
  }

  if (config.error || !config.data) {
    return (
      <p className="text-sm text-error" role="alert">
        This app’s config could not be loaded{config.error ? `: ${config.error.message}` : '.'}
      </p>
    )
  }

  const view = config.data
  const appData = app
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-secondary">
          The shared config this app declares, and the grants that give it.
        </p>
        {view.canRequest && <RescanButton appId={appData.id} />}
      </div>
      <ScanLine view={view} />

      <SectionPanel
        title="Shared config it needs"
        description="Resources whose keys the app declares. The team that owns each one decides who holds it."
      >
        {view.matched.length === 0 ? (
          <EmptyState
            size="sm"
            icon={KeyIcon}
            message="None of the declared keys match shared config."
          />
        ) : (
          <MatchList view={view} appId={appData.id} appName={appData.displayName} />
        )}
      </SectionPanel>

      <DeclaredKeys view={view} />
      <GrantsTable view={view} appId={appData.id} />
    </div>
  )
}
