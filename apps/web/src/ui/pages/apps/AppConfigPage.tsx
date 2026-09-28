/**
 * `/apps/:slug/config` (Launch P5, spec/09) — what the app declares it needs, grouped by plugin,
 * the shared resources those keys match with a status and a Request button per environment, and
 * the keys nothing matches ("ask an admin to add it"). Slice 5f builds it over `useAppConfig`; 5a
 * registered the route, which is where the grant-needed and grant-expiring notifications link
 * (`appConfigPath(slug)`).
 */
import { KeyIcon } from '@heroicons/react/24/outline'
import { useParams } from 'react-router-dom'
import { EmptyState, PageHeader } from '@/ui/components/shared'

export default function AppConfigPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Config"
        breadcrumbs={[
          { label: 'Apps', to: '/apps' },
          { label: slug, to: `/apps/${slug}` },
        ]}
      />
      <EmptyState icon={KeyIcon} message="This app's shared config is not available yet." />
    </div>
  )
}
