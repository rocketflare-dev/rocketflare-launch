/**
 * **The reason the approval page exists.** Pinned above the context, because somebody arriving
 * from a notification is here to DECIDE. It follows `ActionRequiredPanel`'s rules (ui.md):
 *
 * - **Focus lands on the heading on mount, never on Approve.** An autofocused button plus a stray
 *   Enter is how a production deploy gets approved by accident.
 * - **A person who may not decide sees one sentence, not disabled buttons** — `whyNotSentence`
 *   from the server's `whyNot` (not an approver, it is their own request, they already decided).
 * - **409 is information.** Somebody else decided first, it expired, or a job-originated deploy's
 *   run is gone: `alert-info` and a refetch (the mutation invalidates the family) — no toast, no red.
 * - **No optimistic write.** The decision has a side effect at the far end (a GitHub release, a
 *   Workflow, a grant); the panel shows what the server answered.
 * - **Expiry ticks at the rate `expiryState` chooses**, never a naive one-second interval.
 *
 * It also shows N-of-M progress, since one approval of two is not "approved", and an optional
 * comment validated with the same `decideApprovalSchema` the route applies.
 *
 * Once the request is settled the panel becomes its outcome (`ApprovalOutcome`), including the
 * after-commit half: approved → applying → done, or the `applyError` the sweep is retrying.
 */
import {
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  ShieldExclamationIcon,
  XCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import {
  APPROVAL_COMMENT_MAX,
  APPROVAL_ERROR_CODES,
  APPROVAL_MAX_APPLY_ATTEMPTS,
  type ApprovalDecisionValue,
  type ApprovalDetail,
  type ApprovalWhyNot,
  decideApprovalSchema,
} from '@launch/shared/launch-approvals'
import { useEffect, useRef, useState } from 'react'
import { ConfirmModal, FieldError } from '@/ui/components/shared'
import {
  approvalOwesAnswer,
  isApprovalConflict,
  useCancelApproval,
  useDecideApproval,
} from '@/ui/hooks/useApprovals'
import { ApiError } from '@/ui/lib/api-client'
import { formatDateTime, timeAgo } from '@/ui/lib/format'
import { progressLabel, whyNotSentence } from '../approvalModel'
import { useExpiry } from './useApprovalHelpers'

/** The confirm button's words: a production deploy says what it does. */
function approveLabel(detail: Pick<ApprovalDetail, 'kind'>): string {
  switch (detail.kind) {
    case 'deploy.production':
      return 'Approve production deploy'
    case 'app.create':
      return 'Approve and create'
    case 'app.access':
      return 'Grant access'
    case 'session.budget':
      return 'Approve budget'
    default:
      return 'Approve'
  }
}

/** What rejecting does, in one line under the buttons. */
function rejectConsequence(detail: Pick<ApprovalDetail, 'kind'>): string {
  switch (detail.kind) {
    case 'deploy.production':
      return 'Rejecting stops this release here; nothing reaches production.'
    case 'app.create':
      return 'Rejecting archives the requested app; nothing is created.'
    case 'app.access':
      return 'Rejecting leaves their access as it is.'
    case 'session.budget':
      return 'Rejecting leaves the session paused at its budget.'
    default:
      return 'One rejection is final.'
  }
}

/** A 403 from decide carries the same codes as `whyNot` (the engine re-checks at decide time). */
function forbiddenWhyNot(error: unknown): ApprovalWhyNot | null {
  if (!(error instanceof ApiError) || error.status !== 403) return null
  if (error.code === APPROVAL_ERROR_CODES.selfApproval) return 'self_approval'
  if (error.code === APPROVAL_ERROR_CODES.notAnApprover) return 'not_an_approver'
  return null
}

function Progress({ detail }: { detail: ApprovalDetail }) {
  if (detail.requiredApprovals <= 1) return null
  return (
    <div className="flex items-center gap-2" data-testid="approval-progress">
      <progress
        className="progress progress-primary h-1.5 w-28"
        value={Math.min(detail.approvals, detail.requiredApprovals)}
        max={detail.requiredApprovals}
        aria-label="Approvals so far"
      />
      <span className="text-xs text-secondary tabular-nums">{progressLabel(detail)}</span>
    </div>
  )
}

export function ApprovalPanel({
  detail,
  groupNames,
  viewerIsRequester = true,
}: {
  detail: ApprovalDetail
  groupNames?: ReadonlyMap<string, string>
  /** False for an admin withdrawing somebody else's request — the copy says so. */
  viewerIsRequester?: boolean
}) {
  const decide = useDecideApproval(detail.id)
  const cancel = useCancelApproval(detail.id)
  const [comment, setComment] = useState('')
  const [commentError, setCommentError] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const expiry = useExpiry(detail.expiresAt)

  // The heading, never a button: this panel arrives under somebody's cursor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the request, not its contents
  useEffect(() => {
    headingRef.current?.focus()
  }, [detail.id])

  const conflict = isApprovalConflict(decide.error) || isApprovalConflict(cancel.error)
  const refused = forbiddenWhyNot(decide.error)
  const otherError =
    !conflict && !refused ? (decide.error ?? cancel.error ?? null) : (null as Error | null)
  const whyNot = refused ?? detail.whyNot
  const mayDecide = detail.canDecide && !refused
  const sentence = mayDecide ? null : whyNotSentence(whyNot, detail, groupNames)
  const busy = decide.isPending || cancel.isPending

  const submit = (decision: ApprovalDecisionValue) => {
    const parsed = decideApprovalSchema.safeParse({
      decision,
      ...(comment.trim() ? { comment } : {}),
    })
    if (!parsed.success) {
      setCommentError(parsed.error.issues[0]?.message ?? 'Check the comment')
      return
    }
    setCommentError(null)
    decide.mutate(parsed.data)
  }

  return (
    <section className="surface-panel" aria-label="Decision" aria-live="polite">
      <div className="flex items-start gap-2.5">
        <ShieldExclamationIcon className="w-5 h-5 shrink-0 text-warning mt-0.5" />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            {/* `tabIndex={-1}` so it holds focus without becoming a tab stop. */}
            <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
              {mayDecide ? 'Your decision' : 'Waiting for a decision'}
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              <Progress detail={detail} />
              {expiry && (
                <span
                  className={`inline-flex items-center gap-1 text-xs ${expiry.urgent ? 'text-error' : 'text-muted'}`}
                  title={formatDateTime(detail.expiresAt)}
                >
                  <ClockIcon className="w-3.5 h-3.5" />
                  {expiry.label}
                </span>
              )}
            </div>
          </div>

          {conflict ? (
            <div className="alert alert-info alert-soft text-sm" role="status">
              <InformationCircleIcon className="w-5 h-5" />
              <span>
                <strong>Someone else got there first.</strong> This request was decided, withdrawn
                or has expired — the page now shows where it stands.
              </span>
            </div>
          ) : otherError ? (
            <div className="alert alert-error alert-soft text-sm" role="alert">
              <span>{otherError.message}</span>
            </div>
          ) : null}

          {sentence && <p className="text-sm text-secondary">{sentence}</p>}

          {mayDecide && !conflict && (
            <form
              className="space-y-3"
              noValidate
              onSubmit={event => {
                event.preventDefault()
                submit('approve')
              }}
            >
              <div>
                <label htmlFor="approval-comment" className="text-xs text-muted">
                  Comment (optional — recorded with your decision and shown to the requester)
                </label>
                <textarea
                  id="approval-comment"
                  className="textarea w-full text-sm mt-1"
                  rows={2}
                  maxLength={APPROVAL_COMMENT_MAX}
                  value={comment}
                  disabled={busy}
                  aria-invalid={Boolean(commentError)}
                  aria-describedby="approval-comment-error"
                  onChange={event => {
                    setComment(event.target.value)
                    setCommentError(null)
                  }}
                />
                <FieldError id="approval-comment-error" message={commentError} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="submit" className="btn btn-sm btn-primary gap-1.5" disabled={busy}>
                  {decide.isPending && decide.variables?.decision === 'approve' ? (
                    <span className="loading loading-spinner loading-xs" />
                  ) : (
                    <CheckIcon className="w-4 h-4" />
                  )}
                  {approveLabel(detail)}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost gap-1.5"
                  disabled={busy}
                  onClick={() => submit('reject')}
                >
                  <XMarkIcon className="w-4 h-4" />
                  Reject
                </button>
                <span className="text-xs text-muted">{rejectConsequence(detail)}</span>
              </div>
            </form>
          )}

          {detail.canCancel && !conflict && (
            <div className="border-t border-[color:var(--border-subtle)] pt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted">
                {viewerIsRequester
                  ? 'Changed your mind? Withdrawing closes the request without a decision.'
                  : 'As an admin you may withdraw this request: it closes without a decision.'}
              </p>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                disabled={busy}
                onClick={() => setConfirmCancel(true)}
              >
                Withdraw request
              </button>
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={confirmCancel}
        title="Withdraw this request?"
        message={<p>Nobody will be asked to decide it any more. You can ask again later.</p>}
        confirmText="Withdraw"
        cancelText="Keep it"
        isLoading={cancel.isPending}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => cancel.mutate({}, { onSettled: () => setConfirmCancel(false) })}
      />
    </section>
  )
}

/** A settled request: what happened, and — for an approval — whether its effect has landed. */
export function ApprovalOutcome({ detail }: { detail: ApprovalDetail }) {
  const when = detail.decidedAt ?? detail.updatedAt
  switch (detail.status) {
    case 'pending':
      return null
    case 'approved': {
      if (detail.applyError) {
        return (
          <div className="alert alert-warning alert-soft text-sm" role="status">
            <ExclamationTriangleIcon className="w-5 h-5" />
            <div>
              <p className="font-medium">Approved {timeAgo(when)}, but applying it failed.</p>
              <p className="text-xs mt-0.5 break-words">{detail.applyError}</p>
              <p className="text-xs mt-0.5">
                Launch retries every five minutes, up to {APPROVAL_MAX_APPLY_ATTEMPTS} attempts, and
                tells the requester if it gives up.
              </p>
            </div>
          </div>
        )
      }
      if (approvalOwesAnswer(detail)) {
        return (
          <div className="alert alert-info alert-soft text-sm" role="status">
            <span className="loading loading-spinner loading-sm" />
            <span>Approved {timeAgo(when)} — Launch is carrying it out now.</span>
          </div>
        )
      }
      return (
        <div className="alert alert-success alert-soft text-sm" role="status">
          <CheckCircleIcon className="w-5 h-5" />
          <span>
            Approved {timeAgo(when)}
            {detail.appliedAt ? ' and carried out.' : '.'}
          </span>
        </div>
      )
    }
    case 'rejected':
      return (
        <div className="alert alert-error alert-soft text-sm" role="status">
          <XCircleIcon className="w-5 h-5" />
          <span>Rejected {timeAgo(when)}. Nothing was changed.</span>
        </div>
      )
    case 'expired':
      return (
        <div className="alert alert-warning alert-soft text-sm" role="status">
          <ClockIcon className="w-5 h-5" />
          <span>Expired {timeAgo(when)} without a decision. Nothing was changed.</span>
        </div>
      )
    case 'cancelled':
      return (
        <div className="alert alert-soft text-sm" role="status">
          <InformationCircleIcon className="w-5 h-5" />
          <span>Withdrawn {timeAgo(when)}. Nothing was changed.</span>
        </div>
      )
  }
}
