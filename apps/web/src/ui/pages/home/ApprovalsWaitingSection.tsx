/**
 * Home: the requests this reader can decide and has not — the inbox's "Waiting on me" box
 * (`?box=mine`, the same set the nav badge counts), the first few as rows. Each row says what is
 * being approved in plain words (`approvalSummary`), on which app, who asked and how long ago, and
 * links to the request's page, where it is decided. None waiting is one quiet line.
 *
 * Freshness is the `approval` nudge, as for the inbox; nothing here polls.
 */
import { approvalPath } from '@launch/shared/launch-approvals'
import { Link } from 'react-router-dom'
import { SkeletonRows } from '@/ui/components/shared'
import { useApprovalCount, useApprovals } from '@/ui/hooks/useApprovals'
import { useAuth } from '@/ui/hooks/useAuth'
import { approvalSummary, KIND_LABELS, requesterName } from '../approvals/approvalModel'
import { Ago, SectionHeading } from '../apps/app/bits'

/** How many requests Home lists before "All approvals" takes over. */
export const HOME_APPROVALS_LIMIT = 5

export function ApprovalsWaitingSection() {
  const { user } = useAuth()
  const count = useApprovalCount()
  const { data, isLoading, isError } = useApprovals({ box: 'mine', limit: HOME_APPROVALS_LIMIT })
  const rows = data?.items ?? []
  const more = (count.data ?? 0) - rows.length

  const allLink = (
    <Link to="/approvals" className="link link-hover text-sm">
      {more > 0 ? `All approvals (${count.data}) →` : 'All approvals →'}
    </Link>
  )

  // Nothing waiting is one quiet line, not an empty section.
  if (!isLoading && !isError && rows.length === 0) {
    return (
      <p className="text-sm text-muted" data-testid="home-approvals-none">
        Nothing waiting on you. {allLink}
      </p>
    )
  }

  return (
    <section aria-labelledby="home-approvals">
      <SectionHeading id="home-approvals" actions={allLink}>
        Waiting on you
      </SectionHeading>
      {isLoading ? (
        <SkeletonRows rows={2} />
      ) : isError ? (
        <p className="text-sm text-error" role="alert">
          Approvals could not be loaded.
        </p>
      ) : (
        <ul
          className="border-y border-base-300 divide-y divide-base-300"
          aria-label="Approvals waiting on you"
        >
          {rows.map(request => (
            <li
              key={request.id}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5"
            >
              <Link to={approvalPath(request.id)} className="link link-hover font-medium min-w-0">
                {approvalSummary(request)}
              </Link>
              <span className="text-xs text-secondary whitespace-nowrap">
                {request.app ? request.app.displayName : KIND_LABELS[request.kind]}
                <span aria-hidden="true" className="text-muted">
                  {' · '}
                </span>
                {requesterName(request, user?.id)} asked <Ago at={request.createdAt} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
