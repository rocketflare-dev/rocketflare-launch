/**
 * `/apps/:slug/*` (spec/06, the app page plan's decision 2): one app as an Overview and tabs, each
 * its own sub-route under `AppLayout` (header, tabs, the create/teardown pipelines):
 *
 *   /apps/:slug                      Overview — the flow, Needs you, active sessions
 *   /apps/:slug/sessions             every coding session
 *   /apps/:slug/releases             one row per version   (+ /releases/:version, its page)
 *   /apps/:slug/activity             health, the app's audit log, the operations
 *   /apps/:slug/settings/:section?   general · config · access · shipping · danger
 *
 * The old `/apps/:slug/config` and `/apps/:slug/access` redirect to their Settings sections
 * (notifications and older links still name them), keeping any query and hash. A coding session,
 * `/apps/:slug/sessions/:id`, is NOT here: `App.tsx` ranks that route above this splat and it
 * keeps its own chunk and guard (`read Session`).
 */
import { Route, Routes, useParams } from 'react-router-dom'
import { Moved } from '@/ui/components/Moved'
import ActivityTab from './app/ActivityTab'
import AppLayout from './app/AppLayout'
import AppOverview from './app/AppOverview'
import { appPath, type SettingsSection, settingsPath } from './app/appPageModel'
import ReleasePage from './app/ReleasePage'
import ReleasesTab from './app/ReleasesTab'
import SessionsTab from './app/SessionsTab'
import SettingsTab from './app/SettingsTab'

function MovedToSettings({ section }: { section: SettingsSection }) {
  const { slug = '' } = useParams<{ slug: string }>()
  return <Moved to={settingsPath(slug, section)} />
}

function MovedToOverview() {
  const { slug = '' } = useParams<{ slug: string }>()
  return <Moved to={appPath(slug)} />
}

export default function AppPage() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<AppOverview />} />
        <Route path="sessions" element={<SessionsTab />} />
        <Route path="releases" element={<ReleasesTab />} />
        <Route path="releases/:version" element={<ReleasePage />} />
        <Route path="activity" element={<ActivityTab />} />
        <Route path="settings/:section?" element={<SettingsTab />} />
        <Route path="config" element={<MovedToSettings section="config" />} />
        <Route path="access" element={<MovedToSettings section="access" />} />
        <Route path="*" element={<MovedToOverview />} />
      </Route>
    </Routes>
  )
}
