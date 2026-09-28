/**
 * `/approvals` (Launch P4, spec/08) — the approvals inbox. Three boxes as URL tabs (`?box=`):
 *
 * - **Waiting on me** (default): pending requests this person may decide and has not — the same
 *   count as the nav badge, which the tab repeats;
 * - **Requested by me**: what I asked for, in any state, so "where is my deploy?" has an answer;
 * - **All**: every request in the organisation, for admins only (the server answers `mine` to
 *   anyone else, so the tab is not offered).
 *
 * Filters (`?kind=`, `?status=`) live in the URL too, so a filtered inbox is a link. Every row is a
 * real `<Link>` to the request's page (middle-click works) and says what is being approved in plain
 * words (`approvalSummary`), not a kind code.
 *
 * Freshness is the `approval` nudge; nothing here polls — a pending request waits on a person.
 */
import { CheckBadgeIcon } from '@heroicons/react/24/outline'
import {
  type ApprovalBox,
  type ApprovalKind,
  type ApprovalRequest,
  type ApprovalStatus,
  approvalKindSchema,
  approvalPath,
  approvalStatusSchema,
} from '@launch/shared/launch-approvals'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState, PageHeader, SectionPanel, SkeletonRows, URLTabs } from '@/ui/components/shared'
import { useApprovalCount, useApprovals } from '@/ui/hooks/useApprovals'
import { useAuth } from '@/ui/hooks/useAuth'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { formatDateTime, timeAgo } from '@/ui/lib/format'
import { expiryState } from '@/ui/pages/agents/run/interrupts/expiry'
import {
  approvalSummary,
  FILTER_KINDS,
  KIND_LABELS,
  progressLabel,
  requesterName,
  STATUS_BADGE,
} from './approvalModel'

const EMPTY: Record<ApprovalBox, { message: string; description: string }> = {
  mine: {
    message: 'Nothing is waiting on you',
    description: 'Requests you can decide appear here, and in the bell, as soon as they are made.',
  },
  requested: {
    message: 'You haven’t asked for anything',
    description: 'Promoting a release, asking for app access or more session budget lands here.',
  },
  all: {
    message: 'No requests yet',
    description: 'Every approval in the organisation lands here.',
  },
}

function useInboxFilters() {
  const [params, setParams] = useSearchParams()
  const kind = approvalKindSchema.safeParse(params.get('kind'))
  const status = approvalStatusSchema.safeParse(params.get('status'))
  const patch = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key)
      else next.set(key, value)
    }
    setParams(next, { replace: true })
  }
  return {
    kind: kind.success ? kind.data : undefined,
    status: status.success ? status.data : undefined,
    patch,
  }
}

/** The "when" column: how long is left while waiting, when it settled otherwise. */
function When({ request }: { request: ApprovalRequest }) {
  if (request.status === 'pending') {
    const expiry = expiryState(request.expiresAt, new Date())
    return (
      <span
        className={expiry?.urgent ? 'text-error' : 'text-secondary'}
        title={formatDateTime(request.expiresAt)}
      >
        {expiry ? expiry.label : `asked ${timeAgo(request.createdAt)}`}
      </span>
    )
  }
  const at = request.decidedAt ?? request.updatedAt
  return (
    <span className="text-secondary" title={formatDateTime(at)}>
      {timeAgo(at)}
    </span>
  )
}

function InboxTable({
  box,
  kind,
  status,
}: {
  box: ApprovalBox
  kind?: ApprovalKind
  status?: ApprovalStatus
}) {
  const { user } = useAuth()
  // "Waiting on me" is pending by definition; the status filter applies to the other boxes.
  const { data, isLoading, isError } = useApprovals({
    box,
    kind,
    status: box === 'mine' ? undefined : status,
  })
  const rows = data?.items ?? []

  if (isLoading) {
    return (
      <div className="p-5">
        <SkeletonRows rows={4} />
      </div>
    )
  }
  if (isError) {
    return (
      <p className="p-5 text-sm text-error" role="alert">
        Approvals could not be loaded.
      </p>
    )
  }
  if (rows.length === 0) {
    const empty = EMPTY[box]
    return (
      <EmptyState
        icon={CheckBadgeIcon}
        message={kind || status ? 'Nothing matches these filters' : empty.message}
        description={kind || status ? undefined : empty.description}
      />
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="data-table" aria-label="Approval requests">
        <thead>
          <tr>
            <th>Request</th>
            <th>Asked by</th>
            <th>Progress</th>
            <th>Status</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(request => {
            const badge = STATUS_BADGE[request.status]
            return (
              <tr key={request.id}>
                <td className="min-w-[16rem]">
                  {/* A real link, so middle-click and open-in-new-tab work. */}
                  <Link to={approvalPath(request.id)} className="link link-hover font-medium">
                    {approvalSummary(request)}
                  </Link>
                  <p className="text-xs text-muted mt-0.5">
                    {KIND_LABELS[request.kind]}
                    {request.app ? ` · ${request.app.displayName}` : ''}
                  </p>
                </td>
                <td className="text-sm">{requesterName(request, user?.id)}</td>
                <td className="text-sm text-secondary tabular-nums whitespace-nowrap">
                  {progressLabel(request)}
                </td>
                <td>
                  <span className="status-badge" data-status={badge.tone}>
                    {badge.label}
                  </span>
                </td>
                <td className="text-sm whitespace-nowrap">
                  <When request={request} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function InboxPage() {
  const { isAdminLevel } = usePermissions()
  const count = useApprovalCount()
  const { kind, status, patch } = useInboxFilters()
  const [params] = useSearchParams()

  const tab = (id: ApprovalBox, label: string, badge?: number) => ({
    id,
    label,
    badge,
    content: (
      <SectionPanel flush>
        <InboxTable box={id} kind={kind} status={status} />
      </SectionPanel>
    ),
  })

  const tabs = [
    tab('mine', 'Waiting on me', count.data ? count.data : undefined),
    tab('requested', 'Requested by me'),
    ...(isAdminLevel() ? [tab('all', 'All')] : []),
  ]
  // The box URLTabs will actually show: an unknown `?box=` (or `all` for a member) falls back.
  const box = tabs.find(t => t.id === params.get('box'))?.id ?? 'mine'

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Approvals"
        description="Requests waiting on your decision, and the ones you asked for."
      />
      <URLTabs
        param="box"
        tabs={tabs}
        defaultTab="mine"
        actions={
          <div className="flex items-center gap-2">
            <label htmlFor="approvals-kind" className="sr-only">
              Kind
            </label>
            <select
              id="approvals-kind"
              className="select select-xs"
              value={kind ?? ''}
              onChange={event => patch({ kind: event.target.value })}
            >
              <option value="">All kinds</option>
              {FILTER_KINDS.map(k => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
            {box !== 'mine' && (
              <>
                <label htmlFor="approvals-status" className="sr-only">
                  Status
                </label>
                <select
                  id="approvals-status"
                  className="select select-xs"
                  value={status ?? ''}
                  onChange={event => patch({ status: event.target.value })}
                >
                  <option value="">Any status</option>
                  {approvalStatusSchema.options.map(s => (
                    <option key={s} value={s}>
                      {STATUS_BADGE[s].label}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        }
      />
    </div>
  )
}
