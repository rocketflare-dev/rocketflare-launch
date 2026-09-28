/**
 * The sign-up review queue (D9, D25): `/api/platform/access-requests` — a global admin's, or in
 * single mode the organisation's owner/admin (`canAdministerPlatform`). List + the one `decide`
 * endpoint (approve/reject).
 */
import {
  type AccessRequestStatus,
  accessRequestSchema,
  type DecideAccessRequest,
} from '@launch/shared/access-requests'
import { paginatedResponse } from '@launch/shared/pagination'
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export const accessRequestsResponseSchema = paginatedResponse(accessRequestSchema)

export interface AccessRequestsFilters {
  page?: number
  pageSize?: number
  status?: AccessRequestStatus
  q?: string
}

export function adminAccessRequestsQueryOptions(filters: AccessRequestsFilters = {}) {
  return queryOptions({
    queryKey: queryKeys.platform.accessRequests.list(cleanFilters(filters)),
    queryFn: () =>
      api.get(`/api/platform/access-requests${toSearchParams(filters)}`, {
        schema: accessRequestsResponseSchema,
      }),
    placeholderData: keepPreviousData,
  })
}

export function useAdminAccessRequests(filters: AccessRequestsFilters = {}) {
  return useQuery(adminAccessRequestsQueryOptions(filters))
}

export function useDecideAccessRequest() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: DecideAccessRequest }) =>
      api.post<unknown>(`/api/platform/access-requests/${id}/decide`, decision, {
        showSuccessToast: true,
        successMessage: decision.decision === 'approve' ? 'Request approved' : 'Request rejected',
      }),
    // An approval adds a membership (and maybe a user or an organisation): the queue, the
    // organisation's people and the operator's lists all move.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.platform.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.members.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.admin.all }),
      ]),
  })
}
