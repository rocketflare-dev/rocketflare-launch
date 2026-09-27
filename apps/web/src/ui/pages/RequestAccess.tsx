/**
 * `/request-access?client_id=…&return=…` (spec/05): where `/oidc/authorize` sends a signed-in
 * person the app's access policy does not admit. They ask for access; the app's owners decide.
 *
 * PLACEHOLDER (slice 1a): the route is wired; slice 1b owns this page.
 */
import { LockClosedIcon } from '@heroicons/react/24/outline'
import { EmptyStateCard, PageHeader } from '@/ui/components/shared'

export default function RequestAccess() {
  return (
    <div className="max-w-2xl">
      <PageHeader title="Request access" description="You do not have access to this app yet." />
      <EmptyStateCard
        icon={LockClosedIcon}
        message="Coming soon"
        description="Asking an app's owners for access arrives here."
      />
    </div>
  )
}
