/**
 * `/shared-config` (Launch P5, spec/09) — the organisation's shared config: each bundle (M365, a
 * company OpenAI key…), its owner team, its items and each environment's value status — "version
 * 3 · 2 apps" or "not set", never a value. Every member reads it (they need the names to ask for
 * one on an app's Config page); admins create a bundle here (`CreateResourceModal`), and its owner
 * team sets the values on the resource's page.
 */
import { KeyIcon, PlusIcon } from '@heroicons/react/24/outline'
import { APP_ENVIRONMENT_NAMES } from '@launch/shared/launch-apps'
import { type SharedResource, sharedResourcePath } from '@launch/shared/launch-grants'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyStateCard, PageHeader, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { useSharedResources } from '@/ui/hooks/useSharedResources'
import { CreateResourceModal } from './components/CreateResourceModal'

function EnvCell({ resource, env }: { resource: SharedResource; env: string }) {
  const state = resource.environments.find(e => e.environment === env)
  if (!state || state.version === null) {
    return <span className="text-xs text-muted">Not set</span>
  }
  return (
    <span className="text-xs">
      <span className="status-badge" data-status="active">
        v{state.version}
      </span>{' '}
      <span className="text-muted">
        · {state.holderCount} app{state.holderCount === 1 ? '' : 's'}
      </span>
      {state.rotationDue.length > 0 && (
        <span
          className="status-badge ml-1"
          data-status="blocked"
          title={state.rotationDue.join(', ')}
        >
          rotation due
        </span>
      )}
    </span>
  )
}

export default function SharedConfigPage() {
  const { can } = usePermissions()
  const canCreate = can('manage', 'SharedResource')
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const {
    data: resources,
    isLoading,
    isError,
    error,
  } = useSharedResources(showArchived ? { archived: true } : {})

  return (
    <div className="max-w-6xl space-y-4">
      <PageHeader
        title="Shared config"
        description="Credentials many apps use, owned by a team and granted per app and environment. Ask for one from an app's Config page."
        actions={
          canCreate && (
            <button
              type="button"
              className="btn btn-sm btn-primary gap-1.5"
              onClick={() => setCreating(true)}
            >
              <PlusIcon className="w-4 h-4" />
              New shared config
            </button>
          )
        }
      />

      {isLoading ? (
        <SectionPanel>
          <SkeletonRows rows={4} />
        </SectionPanel>
      ) : isError ? (
        <EmptyStateCard
          icon={KeyIcon}
          message="Shared config could not be loaded"
          description={error?.message}
        />
      ) : !resources || resources.length === 0 ? (
        <EmptyStateCard
          icon={KeyIcon}
          message="No shared config yet."
          description={
            canCreate
              ? 'Create one for a credential several apps need — its owner team sets the values.'
              : 'An admin creates shared config; its owner team sets the values.'
          }
        />
      ) : (
        <SectionPanel flush>
          <div className="overflow-x-auto">
            <table className="data-table w-full text-sm">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Owner team</th>
                  <th>Items</th>
                  {APP_ENVIRONMENT_NAMES.map(env => (
                    <th key={env} className="capitalize">
                      {env}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {resources.map(resource => (
                  <tr key={resource.id} data-resource={resource.slug}>
                    <td className="min-w-0">
                      <Link
                        to={sharedResourcePath(resource.id)}
                        className="link link-hover font-medium"
                      >
                        {resource.displayName}
                      </Link>
                      {resource.archivedAt && (
                        <span className="status-badge ml-2" data-status="archived">
                          archived
                        </span>
                      )}
                      <span className="block font-mono text-xs text-muted">{resource.slug}</span>
                    </td>
                    <td>{resource.ownerGroup.name}</td>
                    <td className="max-w-xs">
                      <span
                        className="block truncate font-mono text-xs"
                        title={resource.items.map(i => i.key).join(', ')}
                      >
                        {resource.items.map(item => item.key).join(', ')}
                      </span>
                    </td>
                    {APP_ENVIRONMENT_NAMES.map(env => (
                      <td key={env}>
                        <EnvCell resource={resource} env={env} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionPanel>
      )}

      <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
        <input
          type="checkbox"
          className="checkbox checkbox-xs"
          checked={showArchived}
          onChange={event => setShowArchived(event.target.checked)}
        />
        Show archived
      </label>

      {creating && <CreateResourceModal open={creating} onClose={() => setCreating(false)} />}
    </div>
  )
}
