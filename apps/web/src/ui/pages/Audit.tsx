/**
 * `/audit` (spec/08): the organisation's audit log — every sign-in, access decision, credential
 * change and app event Launch recorded, newest first. Admin-level (`read AuditEvent`); read-only,
 * because the log is append-only. Filter by action prefix (`oidc` → every `oidc.*` event).
 */
import { ShieldCheckIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import {
  EmptyState,
  PageHeader,
  SearchInput,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useAudit } from '@/ui/hooks/useAudit'
import { formatDateTime } from '@/ui/lib/format'

/** `{ after: { token: 'set' } }` → `token: set`. The summary never carries a secret value. */
function summaryText(summary: {
  before?: Record<string, unknown>
  after?: Record<string, unknown>
}) {
  const facts = summary.after ?? summary.before
  if (!facts) return ''
  return Object.entries(facts)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' · ')
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
    <div className="max-w-5xl">
      <PageHeader
        title="Audit"
        description="Who did what to which app — recorded by Launch, and never edited."
      />
      <SectionPanel
        flush
        actions={
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Filter by action, e.g. oidc"
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
                      <code className="text-xs">{event.action}</code>
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
                    <td className="text-secondary text-xs">{summaryText(event.summary)}</td>
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
