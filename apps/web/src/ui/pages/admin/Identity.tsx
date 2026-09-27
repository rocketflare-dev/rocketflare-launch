/**
 * `/admin/identity` (spec/05): Launch as the company's OIDC issuer — the issuer URL, the signing
 * keys (next, active, retiring) and key rotation. Global admin (the `/admin` layout's guard).
 *
 * PLACEHOLDER (slice 1a): the tab and route are wired; slice 1b owns this page.
 */
import { FingerPrintIcon } from '@heroicons/react/24/outline'
import { EmptyState, SectionPanel } from '@/ui/components/shared'

export default function Identity() {
  return (
    <SectionPanel
      title="Identity"
      description="Launch signs every app's users in as the company's OIDC issuer."
    >
      <EmptyState
        icon={FingerPrintIcon}
        message="Coming soon"
        description="The issuer, its signing keys and key rotation arrive here."
      />
    </SectionPanel>
  )
}
