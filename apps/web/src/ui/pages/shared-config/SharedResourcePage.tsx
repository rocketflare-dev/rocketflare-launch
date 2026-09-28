/**
 * `/shared-config/:id` (Launch P5, spec/09) — one shared resource: its items, each environment's
 * version ("set, version N, rotated <date> by <who>"), the values form for its owners (password
 * inputs, never pre-filled), the holders and the running push. Slice 5f builds it; 5a registered
 * the route, which is where the push-failed and rotation-due notifications link
 * (`sharedResourcePath(id)`).
 */
import { KeyIcon } from '@heroicons/react/24/outline'
import { EmptyState, PageHeader } from '@/ui/components/shared'

export default function SharedResourcePage() {
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Shared config"
        breadcrumbs={[{ label: 'Shared config', to: '/shared-config' }]}
      />
      <EmptyState icon={KeyIcon} message="This resource is not available yet." />
    </div>
  )
}
