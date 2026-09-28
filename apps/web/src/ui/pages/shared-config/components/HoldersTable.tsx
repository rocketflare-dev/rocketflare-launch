/**
 * Who holds a shared resource (Launch P5, plan §1.3, §1.13) — the resource's owners and admins
 * only (the detail carries `holders` for them alone). One row per app × environment: the grant's
 * status, the version its Worker holds (flagged when an older one than the environment's active
 * version), when it was pushed, the push's error, when it lapses — and Revoke, which removes the
 * secrets from that app's Worker (`DELETE /api/apps/:id/grants/:gid`, confirmed first).
 */
import { KeyIcon } from '@heroicons/react/24/outline'
import type { SharedResourceDetail, SharedResourceHolder } from '@launch/shared/launch-grants'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ConfirmModal, EmptyState } from '@/ui/components/shared'
import { useRevokeGrant } from '@/ui/hooks/useAppConfig'
import { formatDate, formatDateTime, timeAgo } from '@/ui/lib/format'
import { HOLDER_STATUS, holderBehind } from '../sharedConfigModel'

export function HoldersTable({
  resource,
  holders,
}: {
  resource: Pick<SharedResourceDetail, 'displayName' | 'environments'>
  holders: readonly SharedResourceHolder[]
}) {
  const revoke = useRevokeGrant()
  const [revoking, setRevoking] = useState<SharedResourceHolder | null>(null)

  if (holders.length === 0) {
    return <EmptyState size="sm" icon={KeyIcon} message="No app holds it yet." />
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="data-table w-full text-sm" aria-label="Holders">
          <thead>
            <tr>
              <th>App</th>
              <th>Environment</th>
              <th>Status</th>
              <th>Holds</th>
              <th>Lapses</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {holders.map(holder => {
              const status = HOLDER_STATUS[holder.status]
              const behind = holderBehind(holder, resource.environments)
              return (
                <tr key={holder.grantId} data-grant={holder.grantId}>
                  <td>
                    <Link to={`/apps/${holder.app.slug}`} className="link link-hover font-medium">
                      {holder.app.displayName}
                    </Link>
                  </td>
                  <td className="capitalize">{holder.environment}</td>
                  <td>
                    <span className="status-badge" data-status={status.tone}>
                      {status.label}
                    </span>
                    {holder.pushError && (
                      <span className="block text-xs text-error mt-0.5">{holder.pushError}</span>
                    )}
                  </td>
                  <td className="text-xs">
                    {holder.pushedVersion ? (
                      <span title={holder.pushedAt ? formatDateTime(holder.pushedAt) : undefined}>
                        version {holder.pushedVersion}
                        {holder.pushedAt && (
                          <span className="text-muted"> · {timeAgo(holder.pushedAt)}</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted">
                        {holder.status === 'active' ? 'not pushed yet' : '—'}
                      </span>
                    )}
                    {behind && (
                      <span className="status-badge ml-1.5" data-status="blocked">
                        behind
                      </span>
                    )}
                  </td>
                  <td className="text-xs">
                    {holder.expiresAt ? formatDate(holder.expiresAt) : 'never'}
                  </td>
                  <td className="text-right">
                    {holder.status === 'active' && (
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost text-error"
                        onClick={() => setRevoking(holder)}
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
      <ConfirmModal
        isOpen={revoking !== null}
        title={revoking ? `Revoke ${revoking.app.displayName}'s grant?` : 'Revoke'}
        message={
          revoking && (
            <p>
              The {resource.displayName} secrets are removed from {revoking.app.displayName}’s{' '}
              {revoking.environment} Worker. Whatever reads them answers “not configured” until it
              is granted again.
            </p>
          )
        }
        confirmText="Revoke"
        confirmButtonClass="btn-error"
        isLoading={revoke.isPending}
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          if (!revoking) return
          revoke.mutate(
            { appId: revoking.app.id, grantId: revoking.grantId },
            { onSettled: () => setRevoking(null) }
          )
        }}
      />
    </>
  )
}
