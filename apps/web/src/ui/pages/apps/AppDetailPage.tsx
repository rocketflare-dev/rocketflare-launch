/**
 * `/apps/:slug` (spec/06): one app — its environments and resources, health history, the
 * operations log, its OIDC client and a link to who may sign in.
 *
 * PLACEHOLDER (slice 1a): the route and guard are wired; slice 1d owns this page.
 */
import { Squares2X2Icon } from '@heroicons/react/24/outline'
import { useParams } from 'react-router-dom'
import { EmptyStateCard, PageHeader } from '@/ui/components/shared'

export default function AppDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  return (
    <div className="max-w-5xl">
      <PageHeader
        title={slug}
        breadcrumbs={[{ label: 'Apps', to: '/apps' }, { label: slug }]}
        description="Environments, health and sign-in for this app."
      />
      <EmptyStateCard
        icon={Squares2X2Icon}
        message="Coming soon"
        description="Environments, health history, the operations log and the OIDC client arrive here."
      />
    </div>
  )
}
