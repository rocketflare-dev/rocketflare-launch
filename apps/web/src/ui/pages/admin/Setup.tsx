/**
 * `/admin/setup` (spec/03, spec/04): the setup wizard — domain and zone, then the Cloudflare,
 * Neon, Resend and GitHub App credentials Launch acts with, then the upstream IdP. Secrets are
 * write-only. Global admin (the `/admin` layout's guard).
 *
 * PLACEHOLDER (slice 1a): the tab and route are wired; slice 1c owns this page.
 */
import { WrenchScrewdriverIcon } from '@heroicons/react/24/outline'
import { EmptyState, SectionPanel } from '@/ui/components/shared'

export default function Setup() {
  return (
    <SectionPanel title="Setup" description="The platform credentials and settings Launch runs on.">
      <EmptyState
        icon={WrenchScrewdriverIcon}
        message="Coming soon"
        description="Domain, Cloudflare, Neon, Resend, the GitHub App and the upstream IdP arrive here."
      />
    </SectionPanel>
  )
}
