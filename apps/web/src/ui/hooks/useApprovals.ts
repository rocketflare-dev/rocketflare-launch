/**
 * Approvals (Launch P4, spec/08) — the TanStack hooks over `/api/approvals`. Every query sits under
 * the `approval` root (`queryKeys.approvals`, = `APPROVAL_REALTIME_ENTITY`), so the engine's
 * `entity.changed` nudge refreshes the inbox, the badge and a request's page with no socket code
 * here.
 *
 * - `useApprovalCount` — the nav badge (4a); never polled.
 * - `useApprovals(filters)` — the inbox (`?box=mine|requested|all&status&kind&appId`).
 * - `useApproval(id)` — one request with its decisions, `canDecide` / `whyNot` / `canCancel`.
 * - `useDecideApproval(id)` / `useCancelApproval(id)` — no optimistic write (a decision has a side
 *   effect at the far end) and no error toast: a 409 is INFORMATION the panel renders in place
 *   (`isApprovalConflict`), and a 403 is the panel's sentence too.
 *
 * Polling (ui.md): a `pending` request waits on a PERSON — the nudge refreshes it, nothing polls.
 * The one state where the SERVER owes an answer is approved-but-not-applied (`applyAfter` runs
 * after commit: the GitHub release, the Workflow start, the session wake), so the page polls then,
 * and stops at `appliedAt` or an `applyError` (the sweep retries that on its own five-minute clock).
 */
import {
  APPROVAL_ERROR_CODES,
  type ApprovalBox,
  type ApprovalDetail,
  type ApprovalKind,
  type ApprovalStatus,
  approvalCountSchema,
  approvalDetailSchema,
  approvalListResponseSchema,
  type CancelApprovalRequest,
  type DecideApprovalRequest,
} from '@launch/shared/launch-approvals'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api } from '@/ui/lib/api-client'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export const APPROVAL_APPLY_POLL_MS = 3000

/** Pending requests waiting on me — the "Approvals" nav badge. Refreshed by the nudge, not a poll. */
export function useApprovalCount(enabled = true) {
  return useQuery({
    queryKey: queryKeys.approvals.count,
    queryFn: () => api.get('/api/approvals/count', { schema: approvalCountSchema }),
    enabled,
    select: data => data.count,
  })
}

export interface ApprovalFilters {
  box?: ApprovalBox
  status?: ApprovalStatus
  kind?: ApprovalKind
  appId?: string
  limit?: number
}

export function useApprovals(filters: ApprovalFilters = {}, enabled = true) {
  const clean = cleanFilters(filters)
  return useQuery({
    queryKey: queryKeys.approvals.list(clean),
    queryFn: () =>
      api.get(`/api/approvals${toSearchParams(clean)}`, { schema: approvalListResponseSchema }),
    enabled,
  })
}

/**
 * The pending request of one kind on one app, as far as THIS reader can see it — the organisation's
 * box for an admin, their own requests otherwise. What an app page asks while the app is
 * `requested`: "is it waiting on a person?" (plan §4c: a member's `POST /api/apps` answers 202
 * with an `approvalId` and the app waits in `requested` until an admin approves).
 */
export function usePendingApproval(
  { kind, appId, box }: { kind: ApprovalKind; appId: string | undefined; box: ApprovalBox },
  enabled: boolean
) {
  const { data, isLoading } = useApprovals(
    { box, kind, appId, status: 'pending' },
    enabled && Boolean(appId)
  )
  return { approval: data?.items[0] ?? null, isLoading: enabled && Boolean(appId) && isLoading }
}

/**
 * Whether the server still owes an answer on this request: approved, and its vendor effect has
 * neither landed nor failed. Pure — the page's `refetchInterval` is exactly this.
 */
export function approvalOwesAnswer(
  detail: Pick<ApprovalDetail, 'status' | 'appliedAt' | 'applyError'> | undefined
): boolean {
  return Boolean(detail && detail.status === 'approved' && !detail.appliedAt && !detail.applyError)
}

export function approvalPollInterval(
  detail: Pick<ApprovalDetail, 'status' | 'appliedAt' | 'applyError'> | undefined
): number | false {
  return approvalOwesAnswer(detail) ? APPROVAL_APPLY_POLL_MS : false
}

export function useApproval(id: string) {
  return useQuery({
    queryKey: queryKeys.approvals.detail(id),
    queryFn: () => api.get(`/api/approvals/${id}`, { schema: approvalDetailSchema }),
    enabled: id !== '',
    refetchInterval: q => approvalPollInterval(q.state.data),
  })
}

const CONFLICT_CODES: readonly string[] = [
  APPROVAL_ERROR_CODES.notPending,
  APPROVAL_ERROR_CODES.alreadyDecided,
  APPROVAL_ERROR_CODES.deployRunGone,
]

/**
 * A 409 from decide or cancel: somebody else decided first, it expired, it was already decided by
 * you in another tab, or a job-originated deploy's run is gone. Information, not an error.
 */
export function isApprovalConflict(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.code === undefined || CONFLICT_CODES.includes(error.code))
  )
}

/** Write the fresh detail into the cache and let every other approval query (inbox, badge) refetch. */
function useSettle(id: string) {
  const queryClient = useQueryClient()
  return {
    onSuccess: (detail: ApprovalDetail) => {
      queryClient.setQueryData(queryKeys.approvals.detail(id), detail)
    },
    // The whole family, the detail included: after a 409 the row on screen is stale by
    // definition, and the inbox and the badge move with every decision.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.approvals.all }),
  }
}

export function useDecideApproval(id: string) {
  const settle = useSettle(id)
  return useMutation({
    mutationFn: (body: DecideApprovalRequest) =>
      api.post(`/api/approvals/${id}/decide`, body, {
        schema: approvalDetailSchema,
        showErrorToast: false,
      }),
    ...settle,
  })
}

export function useCancelApproval(id: string) {
  const settle = useSettle(id)
  return useMutation({
    mutationFn: (body: CancelApprovalRequest = {}) =>
      api.post(`/api/approvals/${id}/cancel`, body, {
        schema: approvalDetailSchema,
        showErrorToast: false,
      }),
    ...settle,
  })
}
