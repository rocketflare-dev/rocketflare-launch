/**
 * `/settings/platform/identity` (spec/05): Launch as the company's OIDC issuer — the issuer URL
 * every app is configured with, its discovery and JWKS links, the signing keys (next, active,
 * retiring, retired) and key rotation. `canAdministerPlatform` (the platform layout's guard).
 *
 * Rotation is safe to run at any time: the key that starts signing was already published as
 * `next`, and the one it replaces stays in the JWKS until every token it signed has expired.
 * No key material is ever shown — only key ids and dates.
 */
import { ArrowPathIcon, FingerPrintIcon } from '@heroicons/react/24/outline'
import type { OidcSigningKeyStatus } from '@launch/shared/launch-oidc'
import { useState } from 'react'
import { ConfirmModal, EmptyState, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useOidcKeys, useRotateOidcKeys } from '@/ui/hooks/useOidcAdmin'
import { formatDateTime } from '@/ui/lib/format'

const STATUS: Record<OidcSigningKeyStatus, { dot: string; className: string; label: string }> = {
  active: { dot: '●', className: 'text-success', label: 'Active — signing' },
  next: { dot: '◐', className: 'text-warning', label: 'Next — published, not yet signing' },
  retiring: { dot: '◐', className: 'text-warning', label: 'Retiring — still published' },
  retired: { dot: '○', className: 'text-muted', label: 'Retired' },
}

export default function Identity() {
  const { data, isLoading } = useOidcKeys()
  const rotate = useRotateOidcKeys()
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="space-y-6">
      <SectionPanel
        title="Issuer"
        description="Launch signs every app's users in as the company's OIDC issuer. Each app is configured with this issuer URL."
      >
        {isLoading || !data ? (
          <SkeletonRows rows={2} />
        ) : (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-secondary">Issuer (OIDC_ISSUER)</dt>
            <dd>
              <code className="text-xs break-all">{data.issuer}</code>
            </dd>
            <dt className="text-secondary">Discovery</dt>
            <dd>
              <a className="link link-primary text-xs break-all" href={data.discoveryUrl}>
                {data.discoveryUrl}
              </a>
            </dd>
            <dt className="text-secondary">Signing keys (JWKS)</dt>
            <dd>
              <a className="link link-primary text-xs break-all" href={data.jwksUrl}>
                {data.jwksUrl}
              </a>
            </dd>
          </dl>
        )}
      </SectionPanel>

      <SectionPanel
        title="Signing keys"
        description="ES256. A rotated-out key stays published until the tokens it signed have expired."
        flush
        actions={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setConfirming(true)}
            disabled={rotate.isPending || isLoading}
          >
            <ArrowPathIcon className="w-4 h-4" /> Rotate
          </button>
        }
      >
        {isLoading ? (
          <div className="p-5">
            <SkeletonRows rows={3} />
          </div>
        ) : !data || data.keys.length === 0 ? (
          <EmptyState icon={FingerPrintIcon} message="No signing keys yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Key id</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Activated</th>
                  <th>Leaves the JWKS</th>
                </tr>
              </thead>
              <tbody>
                {data.keys.map(key => {
                  const status = STATUS[key.status]
                  return (
                    <tr key={key.id}>
                      <td>
                        <code className="text-xs" title={key.kid}>
                          {key.kid.slice(0, 16)}…
                        </code>
                      </td>
                      <td className="whitespace-nowrap">
                        <span className={status.className} aria-hidden="true">
                          {status.dot}
                        </span>{' '}
                        {status.label}
                      </td>
                      <td className="text-secondary whitespace-nowrap">
                        {formatDateTime(key.createdAt)}
                      </td>
                      <td className="text-secondary whitespace-nowrap">
                        {formatDateTime(key.activatedAt)}
                      </td>
                      <td className="text-secondary whitespace-nowrap">
                        {key.status === 'retiring' ? formatDateTime(key.retireAfter) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionPanel>

      <ConfirmModal
        isOpen={confirming}
        title="Rotate the signing key"
        message="The published next key starts signing now. The current key keeps verifying the tokens it already signed until they expire, so no one is signed out."
        confirmText="Rotate"
        confirmButtonClass="btn-warning"
        isLoading={rotate.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => rotate.mutate(undefined, { onSettled: () => setConfirming(false) })}
      />
    </div>
  )
}
