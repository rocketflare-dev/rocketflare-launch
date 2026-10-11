/**
 * Settings → Kits (`/settings/kit`): the Kit version card over the DEFAULT kit's pin — what a new
 * app is cut from unless Create app's picker names another — and, below it, the kit catalogue
 * (D36 K1, K5, `KitsCard`: check, re-pin, make default, remove, what each declares, add). Not a
 * connection (it has a default), and Follow latest makes it something an admin comes back to.
 * Reads the same setup overview as the Platform pages; `canAdministerPlatform` (the section's
 * guard).
 */
import { SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useKits } from '@/ui/hooks/useKits'
import { useSetupOverview } from '@/ui/hooks/useSetup'
import { KitsCard } from './kit/KitsCard'
import { KitVersionCard } from './kit/KitVersionCard'

export default function Kit() {
  const { data, isLoading, error } = useSetupOverview()
  const kits = useKits()
  const defaultKit = kits.data?.kits.find(k => k.isDefault)

  if (isLoading) {
    return (
      <SectionPanel>
        <SkeletonRows rows={4} />
      </SectionPanel>
    )
  }
  if (error || !data) {
    return (
      <SectionPanel>
        <p className="text-sm text-error">Could not load the kit version.</p>
      </SectionPanel>
    )
  }
  return (
    <div className="space-y-6">
      <KitVersionCard templatePin={data.templatePin} kitName={defaultKit?.name} />
      <KitsCard />
    </div>
  )
}
