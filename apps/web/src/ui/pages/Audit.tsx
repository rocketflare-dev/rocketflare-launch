/**
 * `/audit` (spec/08): the organisation's audit log — every sign-in, access decision, credential
 * change and app event Launch recorded, and every kit activity (`member.*`, `invitation.*`,
 * `api_key.*`, `group.*`, `tenant.*` …) — the ONE log; `/activity` redirects here. Newest first.
 * Admin-level (`read AuditEvent`); read-only, because the log is append-only. Filter by action
 * prefix (`oidc` → every `oidc.*` event, `member` → every `member.*`).
 */
import { ArrowDownTrayIcon, ShieldCheckIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import {
  EmptyState,
  PageHeader,
  SearchInput,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { auditExportUrl, useAudit, useAuditVerify } from '@/ui/hooks/useAudit'
import { formatDateTime } from '@/ui/lib/format'
import { auditActionLabel, auditSummaryText } from './auditModel'

/**
 * P4 (spec/08 "Integrity"): the log is hash-chained by the `audit.seal` cron. Verify recomputes the
 * chain on demand and says, in words, whether it holds — and how many recent events are not sealed
 * yet, which is not a failure (tampering is evident within one five-minute seal). Export downloads
 * the log with each row's `seq` and `hash` for an auditor to check independently.
 */
function Integrity({ action }: { action?: string }) {
  const verify = useAuditVerify()
  const result = verify.data
  return (
    <SectionPanel
      title="Integrity"
      description="Every event is sealed into a hash chain within five minutes."
      actions={
        <>
          <button
            type="button"
            className="btn btn-sm gap-1.5"
            disabled={verify.isFetching}
            onClick={() => void verify.refetch()}
          >
            {verify.isFetching ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <ShieldCheckIcon className="w-4 h-4" />
            )}
            Verify
          </button>
          <a
            className="btn btn-sm btn-ghost gap-1.5"
            href={auditExportUrl('csv', { action })}
            download
          >
            <ArrowDownTrayIcon className="w-4 h-4" />
            CSV
          </a>
          <a
            className="btn btn-sm btn-ghost gap-1.5"
            href={auditExportUrl('json', { action })}
            download
          >
            <ArrowDownTrayIcon className="w-4 h-4" />
            JSON Lines
          </a>
        </>
      }
    >
      {verify.isError ? (
        <p className="text-sm text-error" role="alert">
          The chain could not be checked: {verify.error.message}
        </p>
      ) : !result ? (
        <p className="text-sm text-muted">
          Verify recomputes every sealed hash. Exports carry each row’s place in the chain.
        </p>
      ) : result.ok ? (
        <div className="alert alert-success alert-soft text-sm" role="status">
          <span>
            The chain holds: {result.checked.toLocaleString()} sealed events checked
            {result.sealedThrough !== null ? ` (through #${result.sealedThrough})` : ''}
            {result.unsealed > 0 ? `, ${result.unsealed} newer ones not sealed yet` : ''}. Checked{' '}
            {formatDateTime(result.verifiedAt)}.
          </span>
        </div>
      ) : (
        <div className="alert alert-error alert-soft text-sm" role="alert">
          <span>
            The chain breaks at #{result.firstBrokenSeq}
            {result.firstBrokenEventId ? ` (event ${result.firstBrokenEventId.slice(0, 8)})` : ''}:
            that row, or one before it, was changed after it was sealed.
          </span>
        </div>
      )}
    </SectionPanel>
  )
}

export default function Audit() {
  // SearchInput debounces, so this is the settled value.
  const [search, setSearch] = useState('')
  const action = search.trim().toLowerCase()
  const validAction = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(action) ? action : undefined
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useAudit({
    action: validAction,
  })
  const items = data?.pages.flatMap(page => page.items) ?? []

  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader
        className="mb-0"
        title="Audit"
        description="Who did what — to the organisation, its people and its apps — recorded by Launch, and never edited."
      />
      <Integrity action={validAction} />
      <SectionPanel
        flush
        actions={
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Action, e.g. member or oidc"
            aria-label="Filter by action"
          />
        }
      >
        {isLoading ? (
          <div className="p-5">
            <SkeletonRows rows={5} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={ShieldCheckIcon} message="No audit events yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Target</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {items.map(event => (
                  <tr key={event.id}>
                    <td className="whitespace-nowrap text-secondary">{formatDateTime(event.at)}</td>
                    <td>
                      <code className="text-xs" title={auditActionLabel(event.action)}>
                        {event.action}
                      </code>
                    </td>
                    <td>
                      {event.actorType === 'user' ? (
                        <span title={event.ip ?? undefined}>
                          {event.actorEmail ?? 'unknown user'}
                        </span>
                      ) : (
                        <span className="text-muted">{event.actorType}</span>
                      )}
                    </td>
                    <td className="text-secondary">
                      {event.targetType ? (
                        <>
                          {event.targetType}
                          {event.targetId && (
                            <span className="text-muted font-mono text-xs">
                              {' '}
                              {event.targetId.slice(0, 12)}
                            </span>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="text-secondary text-xs">{auditSummaryText(event.summary)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hasNextPage && (
          <div className="px-5 py-4 text-center">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </SectionPanel>
    </div>
  )
}
