/**
 * Settings → Approval policies (Launch P4, plan §1.5): who approves each kind of request, for the whole
 * organisation and as overrides for one team (group) or one app, over `/api/approval-policies`.
 * `manage ApprovalPolicy` only (the tab is hidden otherwise) — an app owner loosening their own
 * production gate would defeat it.
 *
 * Per kind: what it means, the organisation's policy — its row, or the code default the server
 * reports beside the rows (never a UI copy of `DEFAULT_APPROVAL_POLICIES` that could drift) — and
 * the overrides. A request resolves app → the app's team → organisation → default, and snapshots
 * the result when it opens, so a change here applies to requests made from now on.
 *
 * Issue #22: each kind says plainly whether approval is REQUIRED, with an explicit Required / Not
 * required choice for the organisation (`approvalRequirement`), because "a missing row means off"
 * was invisible. For `session.merge`, Not required is no organisation row — each app's Ship
 * settings decide (default: no review) — and Required creates one (the editor opens on the
 * default). For every other kind a request always opens, so Not required saves the row with
 * auto-approval for everyone (`autoApproveRole: 'member'`), and Required takes that back.
 */
import { AdjustmentsHorizontalIcon, PlusIcon } from '@heroicons/react/24/outline'
import {
  type ApprovalKind,
  type ApprovalPolicy,
  type ApprovalPolicyRow,
  BUILT_APPROVAL_KINDS,
  DEFAULT_APPROVAL_POLICIES,
} from '@launch/shared/launch-approvals'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { ConfirmModal, EmptyState, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import {
  useApprovalPolicies,
  useDeleteApprovalPolicy,
  usePutApprovalPolicy,
} from '@/ui/hooks/useApprovalPolicies'
import { useApps } from '@/ui/hooks/useApps'
import { useGroups } from '@/ui/hooks/useGroups'
import { useMembers } from '@/ui/hooks/useMembers'
import {
  type ApprovalRequirement,
  AUTO_APPROVAL_NOTE,
  approvalRequirement,
  autoApproveLabel,
  extraApprovers,
  KIND_DESCRIPTIONS,
  KIND_LABELS,
  policyExpiryLabel,
  policySentence,
  requirementSentence,
} from '../approvals/approvalModel'
import { ApprovalPolicyModal, type PolicyTarget, type ScopeOption } from './ApprovalPolicyModal'

/** "Override" → for a team / for an app. A `<details>` dropdown, closed on pick. */
function OverrideMenu({ onPick }: { onPick: (scopeType: 'group' | 'app') => void }) {
  const ref = useRef<HTMLDetailsElement>(null)
  const pick = (scopeType: 'group' | 'app') => () => {
    ref.current?.removeAttribute('open')
    onPick(scopeType)
  }
  return (
    <details ref={ref} className="dropdown dropdown-end">
      <summary className="btn btn-xs btn-ghost gap-1 list-none">
        <PlusIcon className="w-3.5 h-3.5" />
        Override
      </summary>
      <ul className="dropdown-content menu bg-base-100 rounded-box z-10 w-40 p-1 shadow">
        <li>
          <button type="button" onClick={pick('group')}>
            For a team
          </button>
        </li>
        <li>
          <button type="button" onClick={pick('app')}>
            For an app
          </button>
        </li>
      </ul>
    </details>
  )
}

/** The organisation's Required / Not required choice for one kind. */
function RequirementChoice({
  kind,
  requirement,
  disabled,
  onChoose,
}: {
  kind: ApprovalKind
  requirement: ApprovalRequirement
  disabled: boolean
  onChoose: (next: 'required' | 'not_required') => void
}) {
  const required = requirement !== 'not_required'
  const name = `approval-${kind}`
  return (
    <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1" disabled={disabled}>
      <legend className="sr-only">Approval for {KIND_LABELS[kind]}</legend>
      <span className="text-sm font-medium" aria-hidden="true">
        Approval:
      </span>
      {(
        [
          ['required', 'Required'],
          ['not_required', 'Not required'],
        ] as const
      ).map(([value, label]) => (
        <label key={value} className="flex cursor-pointer items-center gap-1.5 text-sm">
          <input
            type="radio"
            className="radio radio-sm"
            name={name}
            checked={value === 'required' ? required : !required}
            onChange={() => onChoose(value)}
          />
          {label}
        </label>
      ))}
    </fieldset>
  )
}

/** A confirmation the Required / Not required choice asks before it loosens a gate. */
interface Confirming {
  kind: ApprovalKind
  title: string
  message: ReactNode
  confirmText: string
  run: () => void
}

interface Editing {
  target: PolicyTarget
  initial: ApprovalPolicy
  scopeChoices?: readonly ScopeOption[]
}

function PolicyFacts({
  kind,
  policy,
  groupNames,
}: {
  kind: ApprovalKind
  policy: ApprovalPolicy
  groupNames: ReadonlyMap<string, string>
}) {
  return (
    <div className="text-sm">
      <p>{policySentence(policy, groupNames, extraApprovers(kind))}</p>
      <p className="text-xs text-muted mt-0.5">
        Expires {policyExpiryLabel(policy.expiresAfterMinutes)} ·{' '}
        {policy.allowSelfApproval ? 'self-approval allowed' : 'not self-approved'} · approved
        automatically: {autoApproveLabel(policy.autoApproveRole).toLowerCase()}
        {policy.autoApproveRole && <> · {AUTO_APPROVAL_NOTE}</>}
      </p>
    </div>
  )
}

export default function ApprovalPoliciesSettings() {
  const { data, isLoading, isError } = useApprovalPolicies()
  const groups = useGroups()
  const apps = useApps()
  const members = useMembers({ pageSize: 200 })
  const remove = useDeleteApprovalPolicy()
  const put = usePutApprovalPolicy()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [removing, setRemoving] = useState<ApprovalPolicyRow | null>(null)
  const [confirming, setConfirming] = useState<Confirming | null>(null)

  const groupOptions: ScopeOption[] = useMemo(
    () => (groups.data?.items ?? []).map(g => ({ id: g.id, name: `${g.name} (${g.typeName})` })),
    [groups.data]
  )
  const appOptions: ScopeOption[] = useMemo(
    () => (apps.data?.items ?? []).map(a => ({ id: a.id, name: a.displayName })),
    [apps.data]
  )
  const people: ScopeOption[] = useMemo(
    () => (members.data?.items ?? []).map(m => ({ id: m.userId, name: `${m.name} · ${m.email}` })),
    [members.data]
  )
  const groupNames = useMemo(
    () => new Map((groups.data?.items ?? []).map(g => [g.id, g.name] as const)),
    [groups.data]
  )
  const scopeName = (row: ApprovalPolicyRow): string => {
    if (row.scopeType === 'tenant') return 'Organisation'
    const list = row.scopeType === 'group' ? groupOptions : appOptions
    const name = list.find(o => o.id === row.scopeId)?.name
    return `${row.scopeType === 'group' ? 'Team' : 'App'}: ${name ?? 'no longer exists'}`
  }

  if (isLoading) return <SkeletonRows rows={6} />
  if (isError || !data) {
    return (
      <p className="text-sm text-error" role="alert">
        Approval policies could not be loaded.
      </p>
    )
  }

  const rowsFor = (kind: ApprovalKind) => data.items.filter(row => row.kind === kind)

  return (
    <div className="space-y-4">
      <p className="text-sm text-secondary">
        Who approves each kind of request. An app’s own policy wins, then its team’s, then the
        organisation’s, then Launch’s default. Changes apply to requests made from now on.
      </p>
      {BUILT_APPROVAL_KINDS.map(kind => {
        const rows = rowsFor(kind)
        const tenantRow = rows.find(r => r.scopeType === 'tenant') ?? null
        const overrides = rows.filter(r => r.scopeType !== 'tenant')
        // The server's defaults, else the shared code default (the record is partial in zod's types).
        const fallback = data.defaults[kind] ?? DEFAULT_APPROVAL_POLICIES[kind]
        const current: ApprovalPolicy = tenantRow ?? fallback
        const requirement = approvalRequirement(kind, tenantRow, fallback)
        const tenantPolicy = (policy: ApprovalPolicy) => ({
          kind,
          scopeType: 'tenant' as const,
          scopeId: null,
          approvers: policy.approvers,
          minApprovals: policy.minApprovals,
          allowSelfApproval: policy.allowSelfApproval,
          expiresAfterMinutes: policy.expiresAfterMinutes,
          autoApproveRole: policy.autoApproveRole,
        })
        const choose = (next: 'required' | 'not_required') => {
          if ((next === 'not_required') === (requirement === 'not_required')) return
          if (kind === 'session.merge') {
            if (next === 'required') {
              // Who reviews is the point of the row: the editor opens on the default.
              setEditing({
                target: { kind, scopeType: 'tenant', scopeId: null },
                initial: fallback,
              })
              return
            }
            if (!tenantRow) return
            setConfirming({
              kind,
              title: 'Make review not required?',
              message: (
                <p>
                  Each app decides in its own Ship settings again (the default is no review). Apps
                  that ask for a review keep asking. Requests already open keep the policy they were
                  opened with.
                </p>
              ),
              confirmText: 'Make it not required',
              run: () => remove.mutate(tenantRow.id, { onSettled: () => setConfirming(null) }),
            })
            return
          }
          if (next === 'not_required') {
            setConfirming({
              kind,
              title: `Approve every ${KIND_LABELS[kind].toLowerCase()} request at once?`,
              message: (
                <p>
                  Nobody is asked: every request made from now on is approved as soon as it is made.{' '}
                  {AUTO_APPROVAL_NOTE}
                </p>
              ),
              confirmText: 'Approve automatically',
              run: () =>
                put.mutate(tenantPolicy({ ...current, autoApproveRole: 'member' }), {
                  onSettled: () => setConfirming(null),
                }),
            })
            return
          }
          put.mutate(
            tenantPolicy({
              ...current,
              autoApproveRole:
                fallback.autoApproveRole === 'member' ? null : fallback.autoApproveRole,
            })
          )
        }
        return (
          <SectionPanel
            key={kind}
            title={KIND_LABELS[kind]}
            description={KIND_DESCRIPTIONS[kind]}
            actions={
              <OverrideMenu
                onPick={scopeType =>
                  setEditing({
                    target: { kind, scopeType, scopeId: null },
                    initial: current,
                    scopeChoices: scopeType === 'group' ? groupOptions : appOptions,
                  })
                }
              />
            }
          >
            <div className="divide-y divide-[color:var(--border-subtle)]">
              <div className="flex flex-wrap items-start justify-between gap-3 pb-3">
                <div className="min-w-0 space-y-1.5" data-requirement={requirement}>
                  <p className="text-xs font-medium text-muted">
                    Organisation{' '}
                    {!tenantRow && kind !== 'session.merge' && (
                      <span className="status-badge no-dot" data-status="draft">
                        default
                      </span>
                    )}
                  </p>
                  <RequirementChoice
                    kind={kind}
                    requirement={requirement}
                    disabled={put.isPending || remove.isPending}
                    onChoose={choose}
                  />
                  <p className="text-sm" data-testid={`requirement-${kind}`}>
                    {requirementSentence(kind, requirement)}
                  </p>
                  {requirement !== 'not_required' && (
                    <PolicyFacts kind={kind} policy={current} groupNames={groupNames} />
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {(kind !== 'session.merge' || tenantRow) && (
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost gap-1"
                      onClick={() =>
                        setEditing({
                          target: { kind, scopeType: 'tenant', scopeId: null },
                          initial: current,
                        })
                      }
                    >
                      <AdjustmentsHorizontalIcon className="w-3.5 h-3.5" />
                      Edit
                    </button>
                  )}
                  {tenantRow && kind !== 'session.merge' && (
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      onClick={() => setRemoving(tenantRow)}
                    >
                      Use default
                    </button>
                  )}
                </div>
              </div>
              {overrides.map(row => (
                <div key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-muted mb-1">{scopeName(row)}</p>
                    <PolicyFacts kind={kind} policy={row} groupNames={groupNames} />
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      onClick={() =>
                        setEditing({
                          target: { kind, scopeType: row.scopeType, scopeId: row.scopeId },
                          initial: row,
                        })
                      }
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      onClick={() => setRemoving(row)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </SectionPanel>
        )
      })}
      {data.items.length === 0 && (
        <EmptyState size="sm" message="Every kind uses Launch’s defaults." />
      )}

      {editing && (
        <ApprovalPolicyModal
          open
          onClose={() => setEditing(null)}
          initial={editing.initial}
          target={editing.target}
          scopeChoices={editing.scopeChoices}
          groups={groupOptions}
          people={people}
        />
      )}
      <ConfirmModal
        isOpen={confirming !== null}
        title={confirming?.title ?? ''}
        message={confirming?.message}
        confirmText={confirming?.confirmText ?? 'Confirm'}
        isLoading={put.isPending || remove.isPending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => confirming?.run()}
      />
      <ConfirmModal
        isOpen={removing !== null}
        title={
          removing?.scopeType === 'tenant' ? 'Go back to the default?' : 'Remove this override?'
        }
        message={
          <p>
            Requests made from now on follow{' '}
            {removing?.scopeType === 'tenant'
              ? 'Launch’s default'
              : removing?.scopeType === 'app'
                ? 'the app’s team, or the organisation'
                : 'the organisation'}{' '}
            policy. Requests already open keep the policy they were opened with.
          </p>
        }
        confirmText={removing?.scopeType === 'tenant' ? 'Use default' : 'Remove'}
        isLoading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id, { onSettled: () => setRemoving(null) })
        }}
      />
    </div>
  )
}
