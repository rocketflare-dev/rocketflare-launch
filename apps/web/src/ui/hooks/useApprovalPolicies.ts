/**
 * Approval policies (Launch P4, plan §1.5) — Settings → Approvals over `/api/approval-policies`.
 * `manage ApprovalPolicy` (the organisation's admins) at every scope; the tab is hidden otherwise,
 * so these hooks are only mounted for someone whose save would succeed.
 *
 * The list answers the rows AND the code defaults, so the page shows what applies when there is no
 * row without a second copy of `DEFAULT_APPROVAL_POLICIES` drifting from the server's. Not nudged:
 * the one writer is this page, which invalidates on save.
 */
import {
  type ApprovalPolicyListQuery,
  approvalPolicyListResponseSchema,
  approvalPolicyRowSchema,
  type PutApprovalPolicyRequest,
} from '@launch/shared/launch-approvals'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

const BASE = '/api/approval-policies'

export function useApprovalPolicies(filters: ApprovalPolicyListQuery = {}, enabled = true) {
  const clean = cleanFilters(filters)
  return useQuery({
    queryKey: queryKeys.approvalPolicies.list(clean),
    queryFn: () =>
      api.get(`${BASE}${toSearchParams(clean)}`, { schema: approvalPolicyListResponseSchema }),
    enabled,
  })
}

export function usePutApprovalPolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: PutApprovalPolicyRequest) =>
      api.put(BASE, body, {
        schema: approvalPolicyRowSchema,
        showSuccessToast: true,
        successMessage: 'Approval policy saved',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.approvalPolicies.all }),
  })
}

export function useDeleteApprovalPolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`${BASE}/${id}`, undefined, {
        showSuccessToast: true,
        successMessage: 'Back to the default',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.approvalPolicies.all }),
  })
}
