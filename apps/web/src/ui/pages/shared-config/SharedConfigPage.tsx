/**
 * `/shared-config` (Launch P5, spec/09) — the organisation's shared config: each bundle (M365, a
 * company OpenAI key…), its owner group and each environment's value status, never a value.
 * Every member reads it (they need the names to ask); admins create. Slice 5f builds it over
 * `useSharedResources`; 5a registered the route and the nav entry so nothing else in the shell
 * changes. Until then it says so.
 */
import { KeyIcon } from '@heroicons/react/24/outline'
import { EmptyState, PageHeader } from '@/ui/components/shared'

export default function SharedConfigPage() {
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Shared config"
        description="Credentials many apps use, owned by a team and granted per app."
      />
      <EmptyState icon={KeyIcon} message="No shared config yet." />
    </div>
  )
}
