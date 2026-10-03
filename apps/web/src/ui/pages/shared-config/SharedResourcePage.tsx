/**
 * `/secrets/:id` (Launch P5, spec/09; was `/shared-config/:id`) — one shared resource. The push-failed and
 * rotation-due notifications link here (`sharedResourcePath(id)`).
 *
 * Top to bottom:
 * - the header: name, slug, the owner team, the description;
 * - per environment, what anybody may know of its values — "Set — version 3, rotated 2 days ago
 *   by Carol" or "Not set", the keys a newer item is still missing, secrets due for rotation, how
 *   many apps hold it — and, for the owner team and admins, the VAR values (never a secret), the
 *   values modal (Set / Replace / Rotate — `ValuesModal`, write-only) and the push running now or
 *   just started (`PushProgress`: an N/M bar, the failed apps, Retry);
 * - the items (key, kind, description, rotation period);
 * - for the owner team and admins only (the detail carries `holders` for them alone): the holders
 *   with Revoke (`HoldersTable`) and the push history, each push expandable to its progress;
 * - who approves a grant per environment (`ResourcePolicyForm` — admins edit).
 *
 * A member sees the names, the status and the policy — what they need to ask for it — and a line
 * saying where to ask. Freshness is the `shared_resource` / `grant_push` nudges, plus a poll only
 * while a push is running.
 */
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  KeyIcon,
} from '@heroicons/react/24/outline'
import { APP_ENVIRONMENT_NAMES, type AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  SECRETS_PATH,
  type SharedResourceDetail,
  type SharedResourceEnvironment,
} from '@launch/shared/launch-grants'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  EmptyState,
  EmptyStateCard,
  PageHeader,
  SectionPanel,
  SectionPanelSkeleton,
} from '@/ui/components/shared'
import { useGrantPushes, useSharedResource } from '@/ui/hooks/useSharedResources'
import { ApiError } from '@/ui/lib/api-client'
import { formatDateTime, timeAgo } from '@/ui/lib/format'
import { HoldersTable } from './components/HoldersTable'
import { PushProgress } from './components/PushProgress'
import { ResourcePolicyForm } from './components/ResourcePolicyForm'
import { ValuesModal } from './components/ValuesModal'
import {
  holdersLine,
  missingKeys,
  PUSH_REASON,
  PUSH_STATUS,
  pushProgress,
  valueLine,
} from './sharedConfigModel'

const CRUMB = { label: 'Secrets', to: SECRETS_PATH }

function EnvironmentPanel({
  resource,
  env,
  pushId,
  isOwner,
  onSet,
}: {
  resource: SharedResourceDetail
  env: SharedResourceEnvironment
  /** The push to show: the one running, else the one this tab just started. */
  pushId: string | null
  isOwner: boolean
  onSet: () => void
}) {
  const missing = missingKeys(resource.items, env)
  const vars = env.vars ? Object.entries(env.vars) : []
  const archived = resource.archivedAt !== null
  const action =
    env.version === null ? 'Set values' : env.holderCount > 0 ? 'Rotate' : 'Replace values'

  return (
    <SectionPanel
      title={<span className="capitalize">{env.environment}</span>}
      description={holdersLine(env.holderCount)}
      actions={
        resource.canSetValues &&
        !archived && (
          <button
            type="button"
            className={`btn btn-sm gap-1.5 ${env.version === null ? 'btn-primary' : ''}`}
            onClick={onSet}
          >
            {env.holderCount > 0 && env.version !== null && <ArrowPathIcon className="w-4 h-4" />}
            {action}
          </button>
        )
      }
    >
      <div className="space-y-3" data-env={env.environment}>
        <p
          className={`text-sm ${env.version === null ? 'text-muted' : ''}`}
          title={env.setAt ? formatDateTime(env.setAt) : undefined}
          data-testid={`value-line-${env.environment}`}
        >
          {valueLine(env)}
        </p>

        {missing.length > 0 && (
          <div className="alert alert-warning alert-soft text-sm" role="status">
            <ExclamationTriangleIcon className="w-5 h-5" />
            <span>
              Not set in this version:{' '}
              <span className="font-mono text-xs">{missing.join(', ')}</span>
            </span>
          </div>
        )}
        {env.rotationDue.length > 0 && (
          <div className="alert alert-warning alert-soft text-sm" role="status">
            <span>
              Due for rotation:{' '}
              <span className="font-mono text-xs">{env.rotationDue.join(', ')}</span>
            </span>
          </div>
        )}
        {env.retiringVersions.length > 0 && (
          <p className="text-xs text-muted">
            Still being replaced: version {env.retiringVersions.join(', ')} — some apps have not
            received the new one yet.
          </p>
        )}

        {isOwner && vars.length > 0 && (
          <dl className="surface-inset rounded-md px-3 py-2 text-xs space-y-1" aria-label="Vars">
            {vars.map(([key, value]) => (
              <div key={key} className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-3">
                <dt className="font-mono text-muted">{key}</dt>
                <dd className="font-mono break-all">{value}</dd>
              </div>
            ))}
          </dl>
        )}

        {pushId && (
          <PushProgress resourceId={resource.id} pushId={pushId} canRetry={resource.canSetValues} />
        )}
      </div>
    </SectionPanel>
  )
}

function PushHistory({ resource }: { resource: SharedResourceDetail }) {
  const pushes = useGrantPushes(resource.id, { limit: 20 })
  const [open, setOpen] = useState<string | null>(null)

  return (
    <SectionPanel
      title="Pushes"
      description="Every time values were written to, or removed from, the apps that hold it."
    >
      {pushes.isLoading ? (
        <div className="h-16 rounded surface-inset animate-pulse" />
      ) : !pushes.data || pushes.data.length === 0 ? (
        <EmptyState size="sm" icon={ArrowPathIcon} message="Nothing has been pushed yet." />
      ) : (
        <ul className="divide-y divide-[color:var(--border-subtle)]" aria-label="Push history">
          {pushes.data.map(push => {
            const badge = PUSH_STATUS[push.status]
            return (
              <li key={push.id} className="py-2" data-push-row={push.id}>
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left text-sm"
                  aria-expanded={open === push.id}
                  onClick={() => setOpen(current => (current === push.id ? null : push.id))}
                >
                  <span className="font-medium">{PUSH_REASON[push.reason]}</span>
                  <span className="capitalize text-muted">{push.environment}</span>
                  {push.version && <span className="text-muted">version {push.version}</span>}
                  <span className="text-xs text-muted tabular-nums">
                    {pushProgress(push).label}
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    <span className="text-xs text-muted" title={formatDateTime(push.createdAt)}>
                      {timeAgo(push.createdAt)}
                    </span>
                    <span className="status-badge" data-status={badge.tone}>
                      {badge.label}
                    </span>
                  </span>
                </button>
                {open === push.id && (
                  <div className="mt-2">
                    <PushProgress
                      resourceId={resource.id}
                      pushId={push.id}
                      canRetry={resource.canSetValues}
                    />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </SectionPanel>
  )
}

export default function SharedResourcePage() {
  const { id = '' } = useParams<{ id: string }>()
  const { data: resource, isLoading, error } = useSharedResource(id)
  const [setting, setSetting] = useState<AppEnvironmentName | null>(null)
  // The push this tab started per environment, shown after it settles (the detail's
  // `activePushes` lists only running ones).
  const [started, setStarted] = useState<Partial<Record<AppEnvironmentName, string>>>({})

  if (isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Secrets" breadcrumbs={[CRUMB]} />
        <SectionPanelSkeleton rows={3} />
        <SectionPanelSkeleton rows={4} />
      </div>
    )
  }

  if (error || !resource) {
    const missing = error instanceof ApiError && error.status === 404
    return (
      <div className="max-w-3xl">
        <PageHeader title="Secrets" breadcrumbs={[CRUMB]} />
        <EmptyStateCard
          icon={missing ? KeyIcon : ExclamationTriangleIcon}
          message={missing ? 'No secret here' : 'This secret could not be loaded'}
          description={
            missing ? 'It may have been archived, or the link is wrong.' : error?.message
          }
          action={
            <Link to={SECRETS_PATH} className="btn btn-sm">
              Back to secrets
            </Link>
          }
        />
      </div>
    )
  }

  // `holders` travels only to the owner team and admins: it is the page's "may see more" signal.
  const isOwner = resource.holders !== undefined
  const envs = APP_ENVIRONMENT_NAMES.map(
    name =>
      resource.environments.find(env => env.environment === name) ?? {
        environment: name,
        version: null,
        versionId: null,
        setAt: null,
        setBy: null,
        keysSet: [],
        retiringVersions: [],
        rotationDue: [],
        holderCount: 0,
      }
  )

  return (
    <div className="space-y-6">
      <PageHeader
        className="mb-0"
        title={resource.displayName}
        badge={
          resource.archivedAt && (
            <span className="status-badge" data-status="archived">
              archived
            </span>
          )
        }
        breadcrumbs={[CRUMB, { label: resource.displayName }]}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs">{resource.slug}</span>
            <span aria-hidden="true" className="text-muted">
              ·
            </span>
            <span>
              Owned by <span className="font-medium">{resource.ownerGroup.name}</span>
            </span>
            {resource.description && (
              <>
                <span aria-hidden="true" className="text-muted">
                  ·
                </span>
                <span>{resource.description}</span>
              </>
            )}
          </span>
        }
      />

      {!isOwner && (
        <div className="alert alert-soft text-sm" role="note">
          <InformationCircleIcon className="w-5 h-5" />
          <span>
            The {resource.ownerGroup.name} team sets its values and decides who holds it. To use it
            on an app, request it from the app’s Config page.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {envs.map(env => {
          const running = resource.activePushes.find(p => p.environment === env.environment)
          return (
            <EnvironmentPanel
              key={env.environment}
              resource={resource}
              env={env}
              isOwner={isOwner}
              pushId={running?.id ?? started[env.environment] ?? null}
              onSet={() => setSetting(env.environment)}
            />
          )
        })}
      </div>

      <SectionPanel
        title="Items"
        description="What an app that holds it receives, as Worker secrets."
      >
        <table className="data-table w-full text-sm">
          <thead>
            <tr>
              <th>Key</th>
              <th>Kind</th>
              <th>Description</th>
              <th>Rotate every</th>
            </tr>
          </thead>
          <tbody>
            {resource.items.map(item => (
              <tr key={item.key}>
                <td className="font-mono text-xs">{item.key}</td>
                <td>
                  <span className="status-badge no-dot" data-status="draft">
                    {item.kind}
                  </span>
                </td>
                <td className="text-secondary">{item.description ?? '—'}</td>
                <td className="text-xs">{item.rotationDays ? `${item.rotationDays} days` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionPanel>

      {isOwner && resource.holders && (
        <SectionPanel title="Holders" description="The apps that hold it, per environment.">
          <HoldersTable resource={resource} holders={resource.holders} />
        </SectionPanel>
      )}

      {isOwner && <PushHistory resource={resource} />}

      <SectionPanel
        title="Who approves a grant"
        description="One request per app and environment; the owner team decides."
      >
        <ResourcePolicyForm resource={resource} />
      </SectionPanel>

      {setting && (
        <ValuesModal
          key={setting}
          resource={resource}
          environment={setting}
          open={setting !== null}
          onClose={() => setSetting(null)}
          onSaved={(environment, pushId) => {
            if (pushId) setStarted(current => ({ ...current, [environment]: pushId }))
          }}
        />
      )}
    </div>
  )
}
