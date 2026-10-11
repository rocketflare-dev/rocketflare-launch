/**
 * Settings → Kits (`/settings/kit/*`, D36 K1, K3, K5): the kit catalogue (`KitList`) at the index
 * — what new apps are cut from, the default first — and one kit's page at `:slug` (`KitDetail`):
 * its pin and the pin editor (the Kit version card's, for any kit), its checks, and what its
 * manifest declares. `canAdministerPlatform` (the section's guard).
 */
import { Navigate, Route, Routes } from 'react-router-dom'
import { SETTINGS_PATHS } from '@/ui/lib/settings-paths'
import { KitDetail } from './kit/KitDetail'
import { KitList } from './kit/KitList'

export default function Kit() {
  return (
    <Routes>
      <Route index element={<KitList />} />
      <Route path=":slug" element={<KitDetail />} />
      <Route path="*" element={<Navigate to={SETTINGS_PATHS.kit} replace />} />
    </Routes>
  )
}
