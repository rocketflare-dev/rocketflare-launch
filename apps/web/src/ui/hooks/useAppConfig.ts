/**
 * An app's shared config and grants (Launch P5, spec/09) — the TanStack hooks over
 * `/api/apps/:id/config` and `/api/apps/:id/grants`. Keys sit under `queryKeys.appConfig` (root
 * `app_config`, = `APP_CONFIG_REALTIME_ENTITY`), so a scan, a grant decision or a push landing
 * refreshes the page with no socket code here.
 *
 * Slice 5f owns this file (request, revoke, re-push, re-scan); 5a wrote the read.
 */
import { appConfigSchema } from '@launch/shared/launch-grants'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

/** The app's declared config, matched resources, needs and grants (`null` id = not loaded yet). */
export function useAppConfig(appId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.appConfig.detail(appId ?? ''),
    queryFn: () => api.get(`/api/apps/${appId}/config`, { schema: appConfigSchema }),
    enabled: Boolean(appId),
  })
}
