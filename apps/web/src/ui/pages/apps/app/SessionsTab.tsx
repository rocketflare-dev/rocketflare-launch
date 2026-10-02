/** `/apps/:slug/sessions` — every coding session on the app, active or all, with Start session. */
import { usePermissions } from '@/ui/hooks/usePermissions'
import { SessionsCard } from '../components/SessionsCard'
import { useAppPage } from './context'

export default function SessionsTab() {
  const { app, hasRepo, stage } = useAppPage()
  const { can } = usePermissions()
  if (stage.holding) {
    return <p className="text-sm text-muted">Sessions open once the first version is live.</p>
  }
  if (!hasRepo) {
    return <p className="text-sm text-muted">Coding sessions need the app’s GitHub repository.</p>
  }
  return (
    <SessionsCard
      appId={app.id}
      appSlug={app.slug}
      canStart={can('create', 'Session') && app.status !== 'archived'}
    />
  )
}
