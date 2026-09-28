/**
 * Shared config (Launch P5, spec/09) — the TanStack hooks over `/api/shared-resources`. Keys sit
 * under `queryKeys.sharedResources` (root `shared_resource`) and a push's under
 * `queryKeys.grantPushes` (root `grant_push`), each the realtime entity that nudges it, so a
 * rotation's progress refreshes with no socket code here.
 *
 * Slice 5f owns this file (the detail, create, patch, values, pushes, retry); 5a wrote the list.
 */
import {
  type SharedResourceListQuery,
  sharedResourceListResponseSchema,
} from '@launch/shared/launch-grants'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys, toSearchParams } from '@/ui/lib/query-keys'

/** Every shared resource (members read the list — they need it to ask). */
export function useSharedResources(query: Partial<SharedResourceListQuery> = {}) {
  return useQuery({
    queryKey: queryKeys.sharedResources.list(query),
    queryFn: () =>
      api.get(`/api/shared-resources${toSearchParams(query)}`, {
        schema: sharedResourceListResponseSchema,
      }),
    select: data => data.items,
  })
}
