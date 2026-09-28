/**
 * Settings → Approvals (Launch P4, plan §1.5): who approves each kind of request, for the whole
 * organisation and as overrides for one team (group) or one app, over `/api/approval-policies`.
 * `manage ApprovalPolicy` only (the tab is hidden otherwise) — an app owner loosening their own
 * production gate would defeat it.
 *
 * Per kind: what it means, the organisation's policy — its row, or the code default the server
 * reports beside the rows (never a UI copy of `DEFAULT_APPROVAL_POLICIES` that could drift) — and
 * the overrides. A request resolves app → the app's team → organisation → default, and snapshots
 * the result when it opens, so a change here applies to requests made from now on.
 */
import { AdjustmentsHorizontalIcon, PlusIcon } from '@heroicons/react/24/outline'
import {
  type ApprovalKind,
  type ApprovalPolicy,
  type ApprovalPolicyRow,
  BUILT_APPROVAL_KINDS,
  DEFAULT_APPROVAL_POLICIES,
} from '@launch/shared/launch-approvals'
import { useMemo, useRef, useState } from 'react'
import { ConfirmModal, EmptyState, SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useApprovalPolicies, useDeleteApprovalPolicy } from '@/ui/hooks/useApprovalPolicies'
import { useApps } from '@/ui/hooks/useApps'
import { useGroups } from '@/ui/hooks/useGroups'
import { useMembers } from '@/ui/hooks/useMembers'
import {
  autoApproveLabel,
  KIND_DESCRIPTIONS,
  KIND_LABELS,
  policyExpiryLabel,
  policySentence,
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

interface Editing {
  target: PolicyTarget
  initial: ApprovalPolicy
  scopeChoices?: readonly ScopeOption[]
}

function PolicyFacts({
  policy,
  groupNames,
}: {
  policy: ApprovalPolicy
  groupNames: ReadonlyMap<string, string>
}) {
  return (
    <div className="text-sm">
      <p>{policySentence(policy, groupNames)}</p>
      <p className="text-xs text-muted mt-0.5">
        Expires {policyExpiryLabel(policy.expiresAfterMinutes)} ·{' '}
        {policy.allowSelfApproval ? 'self-approval allowed' : 'not self-approved'} · auto-approve:{' '}
        {autoApproveLabel(policy.autoApproveRole).toLowerCase()}
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
  const [editing, setEditing] = useState<Editing | null>(null)
  const [removing, setRemoving] = useState<ApprovalPolicyRow | null>(null)

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
    <div className="space-y-4 max-w-4xl">
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
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted mb-1">
                    Organisation{' '}
                    {!tenantRow && (
                      <span className="status-badge no-dot" data-status="draft">
                        default
                      </span>
                    )}
                  </p>
                  <PolicyFacts policy={current} groupNames={groupNames} />
                </div>
                <div className="flex items-center gap-1">
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
                  {tenantRow && (
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
                    <PolicyFacts policy={row} groupNames={groupNames} />
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
