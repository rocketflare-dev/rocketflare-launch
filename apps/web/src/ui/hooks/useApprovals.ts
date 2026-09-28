/**
 * Approvals (Launch P4, spec/08) — the TanStack hooks over `/api/approvals`. Every query sits under
 * the `approval` root (`queryKeys.approvals`, = `APPROVAL_REALTIME_ENTITY`), so the engine's
 * `entity.changed` nudge refreshes the inbox, the badge and a request's page with no socket code
 * here.
 *
 * Slice 4f owns this file (the inbox, the request page, decide and cancel); 4a wrote the count
 * the nav badge reads, so `useNavBadges` and `SideNav` never need to change again.
 */
import { approvalCountSchema } from '@launch/shared/launch-approvals'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

/** Pending requests waiting on me — the "Approvals" nav badge. Refreshed by the nudge, not a poll. */
export function useApprovalCount(enabled = true) {
  return useQuery({
    queryKey: queryKeys.approvals.count,
    queryFn: () => api.get('/api/approvals/count', { schema: approvalCountSchema }),
    enabled,
    select: data => data.count,
  })
}
