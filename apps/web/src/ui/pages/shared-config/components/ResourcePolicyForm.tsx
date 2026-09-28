/**
 * Who approves a grant of this resource, per environment (Launch P5, plan §1.8–§1.9). Everyone
 * reads it — a member asking needs to know who decides and how long it takes; only admins edit
 * it (`canManage`, the P4 rule: policies are admins'), with a `PATCH { policies }`.
 *
 * The approvers are ALWAYS the owner team (the kind's `eligibleExtra`); a policy adds to them —
 * the organisation's admins, the app's owners — and sets N, the expiry, self-approval and the
 * staging self-serve (`autoApproveRole: 'member'`). "Use the default" removes the environment's
 * policy, so any `approval_policies` row for `grant.request`, then the code default, applies.
 * Validated with `sharedResourcePoliciesSchema`, the route's own.
 */

import { type ApprovalPolicy, DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { APP_ENVIRONMENT_NAMES, type AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  type SharedResourceDetail,
  type SharedResourcePolicies,
  sharedResourcePoliciesSchema,
} from '@launch/shared/launch-grants'
import { useState } from 'react'
import { FieldError } from '@/ui/components/shared'
import { usePatchSharedResource } from '@/ui/hooks/useSharedResources'
import {
  autoApproveLabel,
  extraApprovers,
  policyExpiryLabel,
  policySentence,
} from '@/ui/pages/approvals/approvalModel'

const DAY = 24 * 60

function PolicyEditor({
  initial,
  onCancel,
  onSave,
  saving,
  error,
}: {
  initial: ApprovalPolicy
  onCancel: () => void
  onSave: (policy: ApprovalPolicy) => void
  saving: boolean
  error: string | null
}) {
  const [min, setMin] = useState(String(initial.minApprovals))
  const [admins, setAdmins] = useState(initial.approvers.admins)
  const [appOwners, setAppOwners] = useState(initial.approvers.appOwners)
  const [selfServe, setSelfServe] = useState(initial.autoApproveRole === 'member')
  const [selfApproval, setSelfApproval] = useState(initial.allowSelfApproval)
  const [days, setDays] = useState(
    initial.expiresAfterMinutes === null
      ? ''
      : String(Math.round(initial.expiresAfterMinutes / DAY))
  )
  const [localError, setLocalError] = useState<string | null>(null)

  const submit = () => {
    const minApprovals = Number(min)
    const expiresDays = days.trim() === '' ? null : Number(days)
    if (!Number.isInteger(minApprovals) || minApprovals < 1 || minApprovals > 10) {
      setLocalError('Approvals needed is a whole number from 1 to 10')
      return
    }
    if (
      expiresDays !== null &&
      (!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > 90)
    ) {
      setLocalError('Expiry is 1 to 90 days, or blank for never')
      return
    }
    setLocalError(null)
    onSave({
      ...initial,
      approvers: { ...initial.approvers, admins, appOwners },
      minApprovals,
      allowSelfApproval: selfApproval,
      expiresAfterMinutes: expiresDays === null ? null : expiresDays * DAY,
      autoApproveRole: selfServe ? 'member' : null,
    })
  }

  return (
    <form
      className="space-y-3 mt-2"
      noValidate
      onSubmit={event => {
        event.preventDefault()
        submit()
      }}
    >
      <p className="text-xs text-muted">The owner team always decides; these add to it.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs text-muted">
          Approvals needed
          <input
            type="number"
            min={1}
            max={10}
            className="input input-sm w-full mt-1"
            value={min}
            onChange={event => setMin(event.target.value)}
          />
        </label>
        <label className="text-xs text-muted">
          Expires after (days, blank = never)
          <input
            type="number"
            min={1}
            max={90}
            className="input input-sm w-full mt-1"
            value={days}
            onChange={event => setDays(event.target.value)}
          />
        </label>
      </div>
      <div className="space-y-1.5 text-sm">
        {(
          [
            ['The organisation’s admins may approve too', admins, setAdmins],
            ['The app’s owners may approve too', appOwners, setAppOwners],
            ['Self-serve: approve at once when any member asks', selfServe, setSelfServe],
            ['The requester may approve their own request', selfApproval, setSelfApproval],
          ] as const
        ).map(([label, checked, set]) => (
          <label key={label} className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="checkbox checkbox-sm"
              checked={checked}
              onChange={event => set(event.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
      <FieldError message={localError ?? error} />
      <div className="flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={saving}>
          {saving && <span className="loading loading-spinner loading-xs" />}
          Save policy
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

export function ResourcePolicyForm({ resource }: { resource: SharedResourceDetail }) {
  const patch = usePatchSharedResource(resource.id)
  const [editing, setEditing] = useState<AppEnvironmentName | null>(null)
  const team = extraApprovers('grant.request', resource.ownerGroup.name)

  const save = (policies: SharedResourcePolicies) => {
    const parsed = sharedResourcePoliciesSchema.safeParse(policies)
    if (!parsed.success) return
    patch.mutate({ policies: parsed.data }, { onSuccess: () => setEditing(null) })
  }

  return (
    <ul className="divide-y divide-[color:var(--border-subtle)]" aria-label="Approval policy">
      {APP_ENVIRONMENT_NAMES.map(env => {
        const own = resource.policies[env]
        const policy = own ?? DEFAULT_APPROVAL_POLICIES['grant.request']
        return (
          <li key={env} className="py-2.5" data-env={env}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 text-sm">
                <p>
                  <span className="capitalize font-medium">{env}</span>
                  {!own && <span className="text-xs text-muted"> (the default)</span>}
                </p>
                <p className="text-secondary">{policySentence(policy, undefined, team)}</p>
                <p className="text-xs text-muted">
                  Expires {policyExpiryLabel(policy.expiresAfterMinutes)} · auto-approve:{' '}
                  {autoApproveLabel(policy.autoApproveRole).toLowerCase()}
                </p>
              </div>
              {resource.canManage && editing !== env && (
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => setEditing(env)}
                  >
                    Edit
                  </button>
                  {own && (
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      disabled={patch.isPending}
                      onClick={() => {
                        const { [env]: _dropped, ...rest } = resource.policies
                        save(rest)
                      }}
                    >
                      Use the default
                    </button>
                  )}
                </div>
              )}
            </div>
            {editing === env && (
              <PolicyEditor
                initial={policy}
                saving={patch.isPending}
                error={patch.error?.message ?? null}
                onCancel={() => setEditing(null)}
                onSave={next => save({ ...resource.policies, [env]: next })}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
