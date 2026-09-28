/**
 * `/approvals` (Launch P4, spec/08) — the approvals inbox: Waiting on me / Requested by me / All
 * (admins), over `useApprovals`. Slice 4f builds it; 4a registered the route and the nav entry so
 * nothing else in the shell changes. Until then it says so.
 */
import { CheckBadgeIcon } from '@heroicons/react/24/outline'
import { EmptyState, PageHeader } from '@/ui/components/shared'

export default function InboxPage() {
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Approvals"
        description="Requests waiting on you, and the ones you asked for."
      />
      <EmptyState icon={CheckBadgeIcon} message="Nothing is waiting on you." />
    </div>
  )
}
