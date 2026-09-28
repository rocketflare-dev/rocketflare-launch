/**
 * Who decided what, oldest first — `approval_decisions` is append-only, so this list only ever
 * grows. A comment renders verbatim (`whitespace-pre-wrap`): it is a person's words, not markdown.
 */
import { CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/outline'
import type { ApprovalDecision } from '@launch/shared/launch-approvals'
import { formatDateTime, timeAgo } from '@/ui/lib/format'

export function DecisionList({
  decisions,
  viewerId,
}: {
  decisions: readonly ApprovalDecision[]
  viewerId?: string | null
}) {
  if (decisions.length === 0) {
    return <p className="text-sm text-muted">Nobody has decided yet.</p>
  }
  return (
    <ol className="space-y-3" aria-label="Decisions">
      {decisions.map(decision => {
        const approved = decision.decision === 'approve'
        const Icon = approved ? CheckCircleIcon : XCircleIcon
        const who =
          viewerId && decision.userId === viewerId
            ? 'You'
            : decision.userName?.trim() || decision.userEmail
        return (
          <li key={decision.id} className="flex items-start gap-2 text-sm">
            <Icon
              className={`w-4 h-4 mt-0.5 shrink-0 ${approved ? 'text-success' : 'text-error'}`}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p>
                <span className="font-medium">{who}</span> {approved ? 'approved' : 'rejected'}{' '}
                <span className="text-muted" title={formatDateTime(decision.at)}>
                  {timeAgo(decision.at)}
                </span>
              </p>
              {decision.comment && (
                <p className="text-secondary whitespace-pre-wrap break-words mt-0.5">
                  {decision.comment}
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
