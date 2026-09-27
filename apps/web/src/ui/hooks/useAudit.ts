/**
 * Launch audit log (spec/08): `GET /api/audit`, admin+, newest first and CURSOR-paged — the log
 * only grows at the head, so "Load more" follows `nextCursor` rather than a page number that would
 * shift under the reader.
 */
import { type AuditListResponse, auditListResponseSchema } from '@launch/shared/launch-audit'
import { useInfiniteQuery } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

export interface AuditFilters {
  appId?: string
  /** The action or anything beneath it: `oidc` matches `oidc.signin`. */
  action?: string
}

export function useAudit(filters: AuditFilters = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.audit.list(cleanFilters(filters)),
    queryFn: ({ pageParam }) =>
      api.get(`/api/audit${toSearchParams({ ...filters, cursor: pageParam })}`, {
        schema: auditListResponseSchema,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AuditListResponse) => last.nextCursor ?? undefined,
  })
}
