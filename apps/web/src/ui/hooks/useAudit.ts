/**
 * Launch audit log (spec/08): `GET /api/audit`, admin+, newest first and CURSOR-paged — the log
 * only grows at the head, so "Load more" follows `nextCursor` rather than a page number that would
 * shift under the reader.
 *
 * P4: the hash chain's Verify and the Export download (plan §1.12 / §4e — the routes are 4e's).
 */
import {
  type AuditExportFormat,
  type AuditListResponse,
  auditListResponseSchema,
  auditVerifySchema,
} from '@launch/shared/launch-audit'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
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

/**
 * `GET /api/audit/verify` — recompute the hash chain the `audit.seal` cron appends. Run when
 * somebody presses Verify (not on page load: it walks every sealed row), so it is a query with
 * `enabled: false` driven by `refetch()`; the answer stays cached under `audit.verify`.
 */
export function useAuditVerify() {
  return useQuery({
    queryKey: queryKeys.audit.verify,
    queryFn: () => api.get('/api/audit/verify', { schema: auditVerifySchema }),
    enabled: false,
    retry: false,
  })
}

/** `GET /api/audit/export` — a download link, so the browser streams it straight to a file. */
export function auditExportUrl(format: AuditExportFormat, filters: AuditFilters = {}): string {
  return `/api/audit/export${toSearchParams({ format, ...filters })}`
}
