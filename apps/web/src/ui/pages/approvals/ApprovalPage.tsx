/**
 * `/approvals/:id` (Launch P4, spec/08) — one request, where every approval notification and email
 * links (`approvalPath`). It is a PAGE, not a modal (ui.md): arrived at from a notification, read
 * before deciding (the PRs, staging's health), left and returned to.
 *
 * Top to bottom:
 * - the heading says what is being approved in plain words (`approvalSummary`), who asked and when;
 * - the decision panel is pinned above everything (`ApprovalPanel` — focus on its heading, one
 *   sentence for somebody who may not decide, 409 as information, the expiry ticking at the rate
 *   `expiryState` chooses), or the outcome once settled (`ApprovalOutcome`);
 * - the requester's reason, verbatim;
 * - the context per kind (`ApprovalContext`) and, for a production deploy of a release, the
 *   release's whole chain (`ReleaseChain`) — PRs → tag → staging → this approval;
 * - beside it: the policy the request was opened under (who may decide, N of M, expiry) and the
 *   decisions so far (`DecisionList`).
 *
 * Freshness: the `approval` nudge refetches the detail; it polls only while approved-but-applying.
 */
import { CheckBadgeIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { Link, useParams } from 'react-router-dom'
import {
  EmptyStateCard,
  PageHeader,
  SectionPanel,
  SectionPanelSkeleton,
} from '@/ui/components/shared'
import { useApproval } from '@/ui/hooks/useApprovals'
import { useAuth } from '@/ui/hooks/useAuth'
import { releaseOfApproval } from '@/ui/hooks/useReleases'
import { useSharedResource } from '@/ui/hooks/useSharedResources'
import { ApiError } from '@/ui/lib/api-client'
import { formatDateTime, timeAgo } from '@/ui/lib/format'
import { ReleaseChain } from '@/ui/pages/apps/components/ReleaseChain'
import {
  approvalSummary,
  autoApproveLabel,
  KIND_LABELS,
  policyExpiryLabel,
  progressLabel,
  requestApproversSentence,
  requesterName,
  STATUS_BADGE,
  waitingOn,
} from './approvalModel'
import { ApprovalContext } from './components/ApprovalContext'
import { ApprovalOutcome, ApprovalPanel } from './components/ApprovalPanel'
import { DecisionList } from './components/DecisionList'
import { useGroupNames } from './components/useApprovalHelpers'

const CRUMB = { label: 'Approvals', to: '/approvals' }

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1.5 text-sm">
      <dt className="text-muted text-xs">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}

export default function ApprovalPage() {
  const { id = '' } = useParams<{ id: string }>()
  const { data: detail, isLoading, error } = useApproval(id)
  const { user } = useAuth()
  const groupNames = useGroupNames()
  // P5: a grant request is decided by the resource's owner team, named from the resource (every
  // member may read it) — the policy snapshot lists nobody.
  const grantResourceId =
    detail?.context.kind === 'grant.request' ? detail.context.resourceId : null
  const ownerTeam = useSharedResource(grantResourceId).data?.ownerGroup.name ?? null

  if (isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Approval" breadcrumbs={[CRUMB]} />
        <SectionPanelSkeleton rows={3} />
        <SectionPanelSkeleton rows={5} />
      </div>
    )
  }

  if (error || !detail) {
    const missing = error instanceof ApiError && error.status === 404
    return (
      <div className="max-w-3xl">
        <PageHeader title="Approval" breadcrumbs={[CRUMB]} />
        <EmptyStateCard
          icon={missing ? CheckBadgeIcon : ExclamationTriangleIcon}
          message={missing ? 'No request here' : 'This request could not be loaded'}
          description={
            missing
              ? 'It may be one you are not involved in, or the link is wrong.'
              : (error?.message ?? undefined)
          }
          action={
            <Link to="/approvals" className="btn btn-sm">
              Back to approvals
            </Link>
          }
        />
      </div>
    )
  }

  const badge = STATUS_BADGE[detail.status]
  const asker = requesterName(detail, user?.id)
  const release = releaseOfApproval(detail)
  const policy = detail.policy

  return (
    <div className="space-y-6">
      <PageHeader
        className="mb-0"
        title={approvalSummary(detail)}
        badge={
          <span className="status-badge" data-status={badge.tone}>
            {badge.label}
          </span>
        }
        breadcrumbs={[CRUMB, { label: KIND_LABELS[detail.kind] }]}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              Asked by <span className="font-medium">{asker}</span>{' '}
              <span title={formatDateTime(detail.createdAt)}>{timeAgo(detail.createdAt)}</span>
            </span>
            {detail.app && (
              <>
                <span aria-hidden="true" className="text-muted">
                  ·
                </span>
                <Link to={`/apps/${detail.app.slug}`} className="link link-hover">
                  {detail.app.displayName}
                </Link>
              </>
            )}
          </span>
        }
      />

      {detail.status === 'pending' ? (
        <ApprovalPanel
          key={detail.id}
          detail={detail}
          groupNames={groupNames}
          viewerIsRequester={Boolean(user?.id) && detail.requestedByUserId === user?.id}
        />
      ) : (
        <ApprovalOutcome detail={detail} />
      )}

      {detail.reason && (
        <SectionPanel title="Why they asked">
          <p className="text-sm whitespace-pre-wrap break-words">{detail.reason}</p>
        </SectionPanel>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <div className="lg:col-span-2 space-y-4">
          <ApprovalContext detail={detail} requesterName={asker} groupNames={groupNames} />
          {release && (
            <SectionPanel
              title="How this release got here"
              description="Every recorded step, from the pull requests to this approval."
            >
              <ReleaseChain appId={release.appId} releaseId={release.releaseId} />
            </SectionPanel>
          )}
        </div>
        <div className="space-y-4">
          <SectionPanel title="Who decides">
            <dl>
              <Fact label="Approvers">
                {requestApproversSentence(detail, groupNames, ownerTeam)}
              </Fact>
              {detail.status === 'pending' && detail.eligible && (
                <Fact label="Waiting on">
                  {detail.eligible.length > 0 ? (
                    waitingOn(detail, groupNames).who
                  ) : (
                    <span className="text-warning">
                      Nobody — everyone the policy names is excluded or has decided
                    </span>
                  )}
                </Fact>
              )}
              <Fact label="Needs">
                {progressLabel(detail)}
                {detail.requiredApprovals > 1 && (
                  <span className="text-muted"> — one rejection is final</span>
                )}
              </Fact>
              <Fact label="Self-approval">
                {policy.allowSelfApproval
                  ? 'Allowed'
                  : 'Not allowed — the requester, and anyone whose work is in it, can’t decide'}
              </Fact>
              <Fact label="Expires">
                {detail.expiresAt
                  ? formatDateTime(detail.expiresAt)
                  : `Never (${policyExpiryLabel(policy.expiresAfterMinutes)})`}
              </Fact>
              {policy.autoApproveRole && (
                <Fact label="Auto-approved">{autoApproveLabel(policy.autoApproveRole)}</Fact>
              )}
            </dl>
          </SectionPanel>
          <SectionPanel title="Decisions">
            <DecisionList decisions={detail.decisions} viewerId={user?.id} />
          </SectionPanel>
        </div>
      </div>
    </div>
  )
}
