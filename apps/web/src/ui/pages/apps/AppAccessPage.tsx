/**
 * `/apps/:slug/access` (spec/05): who may sign in to this app through Launch — the access policy
 * (whole company, or restricted to granted groups and people), the grants, and the queue of
 * access requests. For the app's owners and admins.
 *
 * PLACEHOLDER (slice 1a): the route and guard are wired; slice 1b owns this page.
 */
import { KeyIcon } from '@heroicons/react/24/outline'
import { useParams } from 'react-router-dom'
import { EmptyStateCard, PageHeader } from '@/ui/components/shared'

export default function AppAccessPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Access"
        breadcrumbs={[
          { label: 'Apps', to: '/apps' },
          { label: slug, to: `/apps/${encodeURIComponent(slug)}` },
          { label: 'Access' },
        ]}
        description="Who may sign in to this app through Launch."
      />
      <EmptyStateCard
        icon={KeyIcon}
        message="Coming soon"
        description="The access policy, grants and access requests for this app arrive here."
      />
    </div>
  )
}
