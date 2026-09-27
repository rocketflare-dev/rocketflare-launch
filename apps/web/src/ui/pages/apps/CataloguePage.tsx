/**
 * `/apps` (spec/06): the catalogue — every registered app with its team, kit version and the live
 * health of staging and production, plus "Import app". Every member may read it (`read App`).
 *
 * PLACEHOLDER (slice 1a): the route, nav entry and guard are wired; slice 1d owns this page.
 */
import { Squares2X2Icon } from '@heroicons/react/24/outline'
import { EmptyStateCard, PageHeader } from '@/ui/components/shared'

export default function CataloguePage() {
  return (
    <div className="max-w-5xl">
      <PageHeader title="Apps" description="Every Rocketflare app the company runs." />
      <EmptyStateCard
        icon={Squares2X2Icon}
        message="Coming soon"
        description="The app catalogue, with live health for staging and production, arrives here."
      />
    </div>
  )
}
