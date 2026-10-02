/**
 * `/apps/:slug/activity` — what happened to the app: health over the last 24 hours (with Check now
 * for `manage App`), the audit log filtered to this app (`GET /api/audit?appId=`, admin+, the
 * same guard as `/audit`), and every pipeline run Launch made against it (`OperationsLog`).
 *
 * Known gap: the plan's ONE merged feed (releases, deploys, sessions, approvals, config, pipeline
 * operations, audit) is not built — the audit log already carries most of it, but only an admin
 * may read it, so a member sees health and the operations only.
 */
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import type { AuditEvent } from '@launch/shared/launch-audit'
import { SkeletonRows } from '@/ui/components/shared'
import { useCheckAppHealth } from '@/ui/hooks/useApps'
import { useAudit } from '@/ui/hooks/useAudit'
import { useNavGuard } from '@/ui/hooks/useNavGuard'
import { HealthHistory } from '../components/HealthHistory'
import { OperationsLog } from '../components/OperationsLog'
import { chainEntry } from '../components/releaseModel'
import { Ago, SectionHeading } from './bits'
import { type AppPageContext, useAppPage } from './context'

function CheckNowButton({ app }: { app: AppPageContext['app'] }) {
  const check = useCheckAppHealth(app)
  return (
    <button
      type="button"
      className="btn btn-sm gap-1.5"
      disabled={check.isPending}
      onClick={() => check.mutate()}
      title="Probe /api/health and /api/ready on every environment now"
    >
      <ArrowPathIcon className={`w-4 h-4 ${check.isPending ? 'animate-spin' : ''}`} />
      {check.isPending ? 'Checking…' : 'Check now'}
    </button>
  )
}

function actorOf(event: AuditEvent): string {
  if (event.actorType === 'system') return 'Launch'
  if (event.actorType === 'app') return 'the deploy job'
  return event.actorEmail ?? 'someone'
}

function AppAudit({ appId }: { appId: string }) {
  const audit = useAudit({ appId })
  const events = audit.data?.pages.flatMap(page => page.items) ?? []
  return (
    <section aria-labelledby="app-audit-title">
      <SectionHeading id="app-audit-title">Audit log</SectionHeading>
      {audit.isLoading ? (
        <SkeletonRows rows={3} />
      ) : audit.isError ? (
        <p className="text-sm text-error" role="alert">
          The audit log could not be loaded.
        </p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted">Nothing recorded for this app yet.</p>
      ) : (
        <>
          <ul className="divide-y divide-base-300 border-y border-base-300" aria-label="Audit log">
            {events.map(event => {
              const entry = chainEntry(event)
              return (
                <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 py-2 text-sm">
                  <span className="font-medium">{entry.label}</span>
                  {entry.detail && (
                    <span className="font-mono text-xs text-secondary">{entry.detail}</span>
                  )}
                  <span className="text-xs text-muted ml-auto">
                    {actorOf(event)} · <Ago at={event.at} />
                  </span>
                </li>
              )
            })}
          </ul>
          {audit.hasNextPage && (
            <button
              type="button"
              className="btn btn-ghost btn-xs mt-2"
              disabled={audit.isFetchingNextPage}
              onClick={() => void audit.fetchNextPage()}
            >
              Load more
            </button>
          )}
        </>
      )}
    </section>
  )
}

export default function ActivityTab() {
  const { app, stage, canManage } = useAppPage()
  const canAccess = useNavGuard()
  const showHealth = app.environments.length > 0 && !stage.holding
  return (
    <div className="space-y-8">
      {showHealth && (
        <HealthHistory
          appId={app.id}
          environments={app.environments}
          actions={canManage && app.status !== 'archived' && <CheckNowButton app={app} />}
        />
      )}
      {canAccess('admin') && <AppAudit appId={app.id} />}
      <OperationsLog appId={app.id} />
    </div>
  )
}
