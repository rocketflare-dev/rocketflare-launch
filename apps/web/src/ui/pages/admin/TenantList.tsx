/**
 * Settings → Organisations (D25; the Operator group): search + status filter over
 * `/api/admin/tenants`. Multi mode only — the route answers 404 `tenancy_mode_single` in single
 * mode, where the one organisation's settings are Settings → General and this section is not
 * listed. A failed load says so: it used to read as "No organisations match", which is how a 404
 * looked exactly like an empty search.
 */

import { BuildingOffice2Icon, ChevronRightIcon } from '@heroicons/react/24/outline'
import type { TenantStatus } from '@launch/shared/tenants'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  EmptyState,
  PaginationControls,
  SearchInput,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useAdminTenants } from '@/ui/hooks/useAdminTenants'
import { timeAgo } from '@/ui/lib/format'
import { organisationPath } from '@/ui/lib/settings-paths'

const FILTERS: { value: TenantStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
]

export default function TenantList() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<TenantStatus | 'all'>('all')
  const [page, setPage] = useState(1)
  const { data, isLoading, isError, isFetching } = useAdminTenants({
    q,
    page,
    status: status === 'all' ? undefined : status,
  })
  const items = data?.items ?? []

  return (
    <SectionPanel
      flush
      title="Organisations"
      description={data ? `${data.pagination.total} total` : undefined}
      actions={
        <>
          <div role="tablist" className="tabs tabs-box tabs-sm">
            {FILTERS.map(f => (
              <button
                key={f.value}
                type="button"
                role="tab"
                className={`tab ${status === f.value ? 'tab-active' : ''}`}
                onClick={() => {
                  setStatus(f.value)
                  setPage(1)
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <SearchInput
            value={q}
            onChange={v => {
              setQ(v)
              setPage(1)
            }}
            size="sm"
            placeholder="Search name or slug"
          />
        </>
      }
    >
      {isLoading ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={3} />
        </div>
      ) : isError && !data ? (
        <div className="px-5 pb-5">
          <p role="alert" className="text-sm text-error">
            The organisations could not be loaded.
          </p>
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={BuildingOffice2Icon} message="No organisations match" />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Organisation</th>
                <th>Members</th>
                <th>Last active</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map(t => (
                <tr key={t.id}>
                  <td>
                    <div className="font-medium flex items-center gap-2">
                      {t.name}
                      {t.status === 'suspended' && (
                        <span className="badge badge-sm badge-error">suspended</span>
                      )}
                    </div>
                    <div className="text-xs text-muted font-mono">@{t.slug}</div>
                  </td>
                  <td className="tabular-nums">{t.memberCount}</td>
                  <td className="text-secondary whitespace-nowrap">{timeAgo(t.lastAccessedAt)}</td>
                  <td className="text-secondary whitespace-nowrap">{timeAgo(t.createdAt)}</td>
                  <td className="text-right">
                    <Link to={organisationPath(t.id)} className="btn btn-ghost btn-xs gap-1">
                      Open <ChevronRightIcon className="w-3.5 h-3.5" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <div className="px-5 pb-5">
          <PaginationControls
            pagination={data.pagination}
            onPageChange={setPage}
            isLoading={isFetching}
          />
        </div>
      )}
    </SectionPanel>
  )
}
