/**
 * Edit one approval policy — at organisation scope, or as an override for a team (group) or an app.
 * Validated with `putApprovalPolicySchema`, the same schema the route applies, so a green form
 * can never be a 400; `PUT` upserts on `(kind, scopeType, scopeId)`.
 *
 * The fields are the policy's own (plan §1.5): who may approve (app owners, the organisation's
 * admins, teams, named people), how many approvals it needs, whether the requester may approve
 * their own, when it expires, and which requester role is auto-approved. Setting is a modal
 * because it is configuration, not a decision somebody is asked to act on.
 */
import {
  type ApprovalKind,
  type ApprovalPolicy,
  type ApprovalPolicyScope,
  AUTO_APPROVE_ROLES,
  type AutoApproveRole,
  hasImplicitApprovers,
  putApprovalPolicySchema,
} from '@launch/shared/launch-approvals'
import { useState } from 'react'
import { FieldError, Modal } from '@/ui/components/shared'
import { usePutApprovalPolicy } from '@/ui/hooks/useApprovalPolicies'
import { autoApproveLabel, KIND_LABELS } from '../approvals/approvalModel'

export interface ScopeOption {
  id: string
  name: string
}

export interface PolicyTarget {
  kind: ApprovalKind
  scopeType: ApprovalPolicyScope
  scopeId: string | null
}

type ExpiryUnit = 'hours' | 'days'

function splitExpiry(minutes: number | null): { never: boolean; amount: string; unit: ExpiryUnit } {
  if (minutes === null) return { never: true, amount: '7', unit: 'days' }
  if (minutes % (24 * 60) === 0)
    return { never: false, amount: String(minutes / 1440), unit: 'days' }
  return { never: false, amount: String(Math.max(1, Math.round(minutes / 60))), unit: 'hours' }
}

function Checkbox({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: string
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer text-sm">
      <input
        type="checkbox"
        className="checkbox checkbox-sm mt-0.5"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
      />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  )
}

function toggle(list: readonly string[], id: string, on: boolean): string[] {
  return on ? [...new Set([...list, id])] : list.filter(x => x !== id)
}

export function ApprovalPolicyModal({
  open,
  onClose,
  initial,
  target,
  scopeChoices,
  groups,
  people,
}: {
  open: boolean
  onClose: () => void
  /** The policy to start from: the row being edited, else what applies today. */
  initial: ApprovalPolicy
  /** Fixed when editing; `scopeId` null while choosing an override's team or app. */
  target: PolicyTarget
  /** When adding an override: the teams or apps it may be for. */
  scopeChoices?: readonly ScopeOption[]
  groups: readonly ScopeOption[]
  people: readonly ScopeOption[]
}) {
  const put = usePutApprovalPolicy()
  const [scopeId, setScopeId] = useState<string | null>(target.scopeId)
  const [approvers, setApprovers] = useState(initial.approvers)
  const [minApprovals, setMinApprovals] = useState(String(initial.minApprovals))
  const [allowSelf, setAllowSelf] = useState(initial.allowSelfApproval)
  const startExpiry = splitExpiry(initial.expiresAfterMinutes)
  const [never, setNever] = useState(startExpiry.never)
  const [expiryAmount, setExpiryAmount] = useState(startExpiry.amount)
  const [expiryUnit, setExpiryUnit] = useState<ExpiryUnit>(startExpiry.unit)
  const [autoRole, setAutoRole] = useState<AutoApproveRole | null>(initial.autoApproveRole)
  const [error, setError] = useState<string | null>(null)

  const scopeWord =
    target.scopeType === 'tenant'
      ? 'the organisation'
      : target.scopeType === 'group'
        ? 'a team'
        : 'an app'

  const submit = () => {
    const amount = Number(expiryAmount)
    const parsed = putApprovalPolicySchema.safeParse({
      kind: target.kind,
      scopeType: target.scopeType,
      scopeId: target.scopeType === 'tenant' ? null : scopeId,
      approvers,
      minApprovals: Number(minApprovals),
      allowSelfApproval: allowSelf,
      expiresAfterMinutes: never ? null : amount * (expiryUnit === 'days' ? 1440 : 60),
      autoApproveRole: autoRole,
    })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const path = issue?.path.join('.')
      setError(
        path === 'scopeId'
          ? `Choose ${target.scopeType === 'group' ? 'a team' : 'an app'}`
          : path === 'expiresAfterMinutes'
            ? 'An expiry is between five minutes and 90 days'
            : path === 'minApprovals'
              ? 'Between 1 and 10 approvals'
              : (issue?.message ?? 'Check the form')
      )
      return
    }
    const none =
      !parsed.data.approvers.appOwners &&
      !parsed.data.approvers.admins &&
      parsed.data.approvers.groupIds.length === 0 &&
      parsed.data.approvers.userIds.length === 0
    // A shared resource's owner team always decides a grant request, so "nobody" is fine there.
    if (none && parsed.data.autoApproveRole === null && !hasImplicitApprovers(target.kind)) {
      setError('Name at least one approver, or nothing could ever be approved')
      return
    }
    setError(null)
    put.mutate(parsed.data, { onSuccess: onClose })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${KIND_LABELS[target.kind]} — ${scopeWord}`}
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={submit}
            disabled={put.isPending}
          >
            {put.isPending ? <span className="loading loading-spinner loading-xs" /> : 'Save'}
          </button>
        </>
      }
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={event => {
          event.preventDefault()
          submit()
        }}
      >
        {scopeChoices && (
          <div>
            <label htmlFor="policy-scope" className="text-xs text-muted">
              {target.scopeType === 'group' ? 'Team' : 'App'}
            </label>
            <select
              id="policy-scope"
              className="select select-sm w-full mt-1"
              value={scopeId ?? ''}
              onChange={event => setScopeId(event.target.value || null)}
            >
              <option value="">Choose…</option>
              {scopeChoices.map(choice => (
                <option key={choice.id} value={choice.id}>
                  {choice.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <fieldset className="space-y-2">
          <legend className="text-xs text-muted mb-1">Who may approve</legend>
          {hasImplicitApprovers(target.kind) && (
            <p className="text-xs text-muted">
              The shared resource’s owner team always may; anyone chosen here is added to it.
            </p>
          )}
          <Checkbox
            label="The app’s owners"
            hint="Its named owners and its team’s members, checked when they decide."
            checked={approvers.appOwners}
            onChange={on => setApprovers({ ...approvers, appOwners: on })}
          />
          <Checkbox
            label="The organisation’s admins"
            checked={approvers.admins}
            onChange={on => setApprovers({ ...approvers, admins: on })}
          />
          {groups.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer select-none text-secondary">
                Teams ({approvers.groupIds.length} chosen)
              </summary>
              <div className="mt-2 max-h-40 overflow-y-auto space-y-1.5 pl-1">
                {groups.map(group => (
                  <Checkbox
                    key={group.id}
                    label={group.name}
                    checked={approvers.groupIds.includes(group.id)}
                    onChange={on =>
                      setApprovers({
                        ...approvers,
                        groupIds: toggle(approvers.groupIds, group.id, on),
                      })
                    }
                  />
                ))}
              </div>
            </details>
          )}
          {people.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer select-none text-secondary">
                Named people ({approvers.userIds.length} chosen)
              </summary>
              <div className="mt-2 max-h-40 overflow-y-auto space-y-1.5 pl-1">
                {people.map(person => (
                  <Checkbox
                    key={person.id}
                    label={person.name}
                    checked={approvers.userIds.includes(person.id)}
                    onChange={on =>
                      setApprovers({
                        ...approvers,
                        userIds: toggle(approvers.userIds, person.id, on),
                      })
                    }
                  />
                ))}
              </div>
            </details>
          )}
        </fieldset>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="policy-min" className="text-xs text-muted">
              Approvals needed
            </label>
            <input
              id="policy-min"
              type="number"
              min={1}
              max={10}
              className="input input-sm w-full mt-1"
              value={minApprovals}
              onChange={event => setMinApprovals(event.target.value)}
            />
            <span className="text-xs text-muted">One rejection is always final.</span>
          </div>
          <div>
            <span className="text-xs text-muted">Expires</span>
            <div className="flex items-center gap-2 mt-1">
              <input
                type="number"
                min={1}
                aria-label="Expires after"
                className="input input-sm w-20"
                value={expiryAmount}
                disabled={never}
                onChange={event => setExpiryAmount(event.target.value)}
              />
              <select
                aria-label="Expiry unit"
                className="select select-sm"
                value={expiryUnit}
                disabled={never}
                onChange={event => setExpiryUnit(event.target.value as ExpiryUnit)}
              >
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </div>
            <label className="flex items-center gap-2 mt-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                className="checkbox checkbox-xs"
                checked={never}
                onChange={event => setNever(event.target.checked)}
              />
              Never expires
            </label>
          </div>
        </div>

        <Checkbox
          label="Let the requester approve their own request"
          hint="Off by default: whoever asked, and anyone whose work is in a release, can’t approve it."
          checked={allowSelf}
          onChange={setAllowSelf}
        />

        <div>
          <label htmlFor="policy-auto" className="text-xs text-muted">
            Approve automatically
          </label>
          <select
            id="policy-auto"
            className="select select-sm w-full mt-1"
            value={autoRole ?? ''}
            onChange={event => setAutoRole((event.target.value || null) as AutoApproveRole | null)}
          >
            <option value="">{autoApproveLabel(null)}</option>
            {AUTO_APPROVE_ROLES.map(role => (
              <option key={role} value={role}>
                {autoApproveLabel(role)}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">
            An automatic approval is still recorded and audited.
          </span>
        </div>

        <FieldError message={error} />
      </form>
    </Modal>
  )
}
