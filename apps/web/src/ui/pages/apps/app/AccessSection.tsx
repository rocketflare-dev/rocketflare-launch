/**
 * `/apps/:slug/access` (spec/05): who may sign in to this app through Launch — the access policy
 * (the whole organisation, or only the groups and people granted), the grants, and the queue of
 * access requests — each an `app.access` approval, decided on its own page (P4). For the app's
 * owners and the organisation's admins; the server answers 404 to anyone else, which this page
 * shows as "not yours to manage".
 *
 * The app's owners can always sign in, whatever the policy says — restricting an app can never
 * lock its owners out.
 */
import { InboxIcon, KeyIcon, TrashIcon, UserGroupIcon } from '@heroicons/react/24/outline'
import { approvalPath } from '@launch/shared/launch-approvals'
import type { AppAccessRequestStatus, OidcAccessPolicy } from '@launch/shared/launch-oidc'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ConfirmModal,
  EmptyState,
  EmptyStateCard,
  PageHeader,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import {
  useAddAppAccessGrant,
  useAppAccessGrants,
  useAppAccessPolicy,
  useAppAccessRequests,
  useRemoveAppAccessGrant,
  useUpdateAppAccessPolicy,
} from '@/ui/hooks/useAppAccess'
import { useGroups } from '@/ui/hooks/useGroups'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { formatDateTime } from '@/ui/lib/format'

const POLICIES: { value: OidcAccessPolicy; label: string; description: string }[] = [
  {
    value: 'company',
    label: 'Everyone in the organisation',
    description: 'Any member can sign in.',
  },
  {
    value: 'restricted',
    label: 'Only the groups and people granted below',
    description: 'Everyone else is offered a way to request access.',
  },
]

function PolicyPanel({ app, policy }: { app: string; policy: OidcAccessPolicy }) {
  const update = useUpdateAppAccessPolicy(app)
  return (
    <SectionPanel
      title="Who can sign in"
      description="The app's owners can always sign in, whatever is chosen here."
    >
      <fieldset className="space-y-3" disabled={update.isPending}>
        <legend className="sr-only">Access policy</legend>
        {POLICIES.map(option => (
          <label key={option.value} className="flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              name="access-policy"
              className="radio radio-primary radio-sm mt-0.5"
              checked={policy === option.value}
              onChange={() => update.mutate(option.value)}
            />
            <span>
              <span className="font-medium">{option.label}</span>
              <span className="block text-sm text-secondary">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </SectionPanel>
  )
}

function GrantsPanel({ app, restricted }: { app: string; restricted: boolean }) {
  const { data, isLoading } = useAppAccessGrants(app)
  const add = useAddAppAccessGrant(app)
  const remove = useRemoveAppAccessGrant(app)
  const { isAdminLevel } = usePermissions()
  // Listing the organisation's groups is an admin read; an owner who is not an admin grants by email.
  const canPickGroups = isAdminLevel()
  const { data: groups } = useGroups(undefined, canPickGroups)
  const [email, setEmail] = useState('')
  const [groupId, setGroupId] = useState('')
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null)
  const items = data?.items ?? []
  const grantedGroups = new Set(items.map(g => g.groupId).filter(Boolean))

  return (
    <SectionPanel
      title="Grants"
      description={
        restricted
          ? 'Members of these groups, and these people, can sign in.'
          : 'Kept for when the app is restricted; today everyone in the organisation can sign in.'
      }
      flush
    >
      <div className="px-5 py-4 flex flex-wrap gap-3 items-end border-b border-base-300">
        {canPickGroups && (
          <form
            className="flex gap-2 items-end"
            onSubmit={e => {
              e.preventDefault()
              if (groupId) add.mutate({ groupId }, { onSuccess: () => setGroupId('') })
            }}
          >
            <label className="form-control">
              <span className="label-text text-xs mb-1">Group</span>
              <select
                className="select select-bordered select-sm"
                value={groupId}
                onChange={e => setGroupId(e.target.value)}
              >
                <option value="">Choose a group…</option>
                {(groups?.items ?? [])
                  .filter(g => !grantedGroups.has(g.id))
                  .map(g => (
                    <option key={g.id} value={g.id}>
                      {g.typeName ? `${g.typeName} · ${g.name}` : g.name}
                    </option>
                  ))}
              </select>
            </label>
            <button type="submit" className="btn btn-sm" disabled={!groupId || add.isPending}>
              Grant
            </button>
          </form>
        )}
        <form
          className="flex gap-2 items-end"
          onSubmit={e => {
            e.preventDefault()
            const value = email.trim()
            if (value) add.mutate({ email: value }, { onSuccess: () => setEmail('') })
          }}
        >
          <label className="form-control">
            <span className="label-text text-xs mb-1">Person</span>
            <input
              type="email"
              className="input input-bordered input-sm w-64"
              placeholder="name@company.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-sm" disabled={!email.trim() || add.isPending}>
            Grant
          </button>
        </form>
      </div>
      {isLoading ? (
        <div className="p-5">
          <SkeletonRows rows={3} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={UserGroupIcon} message="No grants yet" size="sm" />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Granted</th>
                <th>Kind</th>
                <th>Since</th>
                <th className="w-12">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map(grant => (
                <tr key={grant.id}>
                  <td>
                    {grant.name}
                    {grant.email && grant.email !== grant.name && (
                      <span className="text-muted text-xs"> · {grant.email}</span>
                    )}
                  </td>
                  <td className="text-secondary">{grant.kind === 'group' ? 'Group' : 'Person'}</td>
                  <td className="text-secondary whitespace-nowrap">
                    {formatDateTime(grant.createdAt)}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      aria-label={`Remove ${grant.name}`}
                      onClick={() => setRemoving({ id: grant.id, name: grant.name })}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmModal
        isOpen={removing !== null}
        title="Remove access"
        message={`${removing?.name ?? ''} will no longer be able to sign in through this grant.`}
        confirmText="Remove"
        confirmButtonClass="btn-error"
        isLoading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id, { onSettled: () => setRemoving(null) })
        }}
      />
    </SectionPanel>
  )
}

const STATUS_LABEL: Record<AppAccessRequestStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
}

function RequestsPanel({ app }: { app: string }) {
  const [showAll, setShowAll] = useState(false)
  const { data, isLoading } = useAppAccessRequests(app, showAll ? {} : { status: 'pending' })
  const items = data?.items ?? []

  return (
    <SectionPanel
      title="Access requests"
      description="People who were turned away at sign-in and asked for access."
      flush
      actions={
        <label className="label cursor-pointer gap-2">
          <span className="label-text text-sm">Show decided</span>
          <input
            type="checkbox"
            className="toggle toggle-sm"
            checked={showAll}
            onChange={e => setShowAll(e.target.checked)}
          />
        </label>
      }
    >
      {isLoading ? (
        <div className="p-5">
          <SkeletonRows rows={3} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={InboxIcon}
          message={showAll ? 'No requests yet' : 'No pending requests'}
          size="sm"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Message</th>
                <th>Asked</th>
                <th>Status</th>
                <th className="w-40">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map(request => (
                <tr key={request.id}>
                  <td>
                    {request.userName}
                    <span className="block text-muted text-xs">{request.userEmail}</span>
                  </td>
                  <td className="text-secondary text-sm">{request.message ?? '—'}</td>
                  <td className="text-secondary whitespace-nowrap">
                    {formatDateTime(request.createdAt)}
                  </td>
                  <td>
                    <span
                      className={`badge badge-sm ${
                        request.status === 'approved'
                          ? 'badge-success'
                          : request.status === 'rejected'
                            ? 'badge-ghost'
                            : 'badge-warning'
                      }`}
                    >
                      {STATUS_LABEL[request.status]}
                    </span>
                  </td>
                  <td className="text-right">
                    {/* P4: a request is an `app.access` approval (same id) — decided on its page,
                        where the policy, the progress and who else may decide are. */}
                    <Link
                      to={approvalPath(request.id)}
                      className={`btn btn-xs ${request.status === 'pending' ? 'btn-primary' : 'btn-ghost'}`}
                    >
                      {request.status === 'pending' ? 'Review' : 'View'}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionPanel>
  )
}

export default function AppAccessPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const { data, isLoading, isError } = useAppAccessPolicy(slug)
  const appPath = `/apps/${encodeURIComponent(slug)}`

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="Access"
        breadcrumbs={[
          { label: 'Apps', to: '/apps' },
          { label: data?.app.displayName ?? slug, to: appPath },
          { label: 'Access' },
        ]}
        description="Who may sign in to this app through Launch."
      />
      {isLoading ? (
        <SectionPanel>
          <SkeletonRows rows={4} />
        </SectionPanel>
      ) : isError || !data ? (
        <EmptyStateCard
          icon={KeyIcon}
          message="Not available"
          description="Only this app's owners and your organisation's admins manage who can sign in to it."
        />
      ) : !data.hasClient || !data.accessPolicy ? (
        <EmptyStateCard
          icon={KeyIcon}
          message="This app does not sign in through Launch yet"
          description="Register its OIDC client on the app's page; its access policy is managed here afterwards."
          action={
            <Link to={appPath} className="btn btn-sm">
              Go to the app
            </Link>
          }
        />
      ) : (
        <>
          <PolicyPanel app={data.app.id} policy={data.accessPolicy} />
          <GrantsPanel app={data.app.id} restricted={data.accessPolicy === 'restricted'} />
          <RequestsPanel app={data.app.id} />
        </>
      )}
    </div>
  )
}
