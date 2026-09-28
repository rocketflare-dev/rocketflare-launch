/**
 * `/approvals/:id` (Launch P4, spec/08) — one request: its context, the N-of-M decisions, and the
 * approve / reject panel with the reason a person may not decide (`ApprovalPanel`, which follows
 * `ActionRequiredPanel`'s rules). Slice 4f builds it; 4a registered the route, which is where every
 * approval notification links (`notificationLink` → `approvalPath(id)`).
 */
import { CheckBadgeIcon } from '@heroicons/react/24/outline'
import { EmptyState, PageHeader } from '@/ui/components/shared'

export default function ApprovalPage() {
  return (
    <div className="max-w-5xl">
      <PageHeader title="Approval" breadcrumbs={[{ label: 'Approvals', to: '/approvals' }]} />
      <EmptyState icon={CheckBadgeIcon} message="This request is not available yet." />
    </div>
  )
}
