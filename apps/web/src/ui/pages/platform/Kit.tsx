/**
 * Settings → Kit version (`/settings/kit`): the kit every new app (and every re-scaffold) is cut
 * from — the Kit version card over `launch_settings.template_pin`. Not a connection (it has a
 * default), and Follow latest makes it something an admin comes back to. Reads the same setup
 * overview as the Platform pages; `canAdministerPlatform` (the section's guard).
 */
import { SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useSetupOverview } from '@/ui/hooks/useSetup'
import { KitVersionCard } from './kit/KitVersionCard'

export default function Kit() {
  const { data, isLoading, error } = useSetupOverview()

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
  return <KitVersionCard templatePin={data.templatePin} />
}
