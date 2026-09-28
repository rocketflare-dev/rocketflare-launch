/**
 * An app's shared config and grants (Launch P5, spec/09) — the TanStack hooks over
 * `/api/apps/:id/config` and `/api/apps/:id/grants`. Keys sit under `queryKeys.appConfig` (root
 * `app_config`, = `APP_CONFIG_REALTIME_ENTITY`), so a scan, a grant decision or a push landing
 * refreshes the page with no socket code here.
 *
 * - `useAppConfig(appId)` — declared keys, the resources they match, what the app needs, its
 *   grants; polled only while a push is landing on one of them (an approved grant not yet pushed,
 *   or one being revoked) — a `requested` grant waits on a PERSON and is left to the nudge;
 * - `useRequestGrant(appId)` — one grant and one `grant.request` approval per environment (202);
 * - `useRevokeGrant()` (the app travels with the call), `useRepushGrant(appId)` — both answer
 *   the grant and the push that carries it out;
 * - `useRescanAppConfig(appId)` — read the repository again and answer the new view.
 */
import {
  type AppConfigView,
  type AppGrant,
  appConfigSchema,
  grantActionResponseSchema,
  type RequestGrantRequest,
  type RevokeGrantRequest,
  requestGrantResponseSchema,
} from '@launch/shared/launch-grants'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

export const APP_CONFIG_POLL_MS = 3000

/** A grant whose push the server still owes: approved and not yet written, or being revoked. */
export function grantOwesPush(grant: Pick<AppGrant, 'status' | 'pushedVersion' | 'pushError'>) {
  if (grant.status === 'revoking') return true
  return grant.status === 'active' && grant.pushedVersion === null && grant.pushError === null
}

/** `refetchInterval` for the config view. Pure. */
export function appConfigPollInterval(view: Pick<AppConfigView, 'grants'> | undefined) {
  return view?.grants.some(grantOwesPush) ? APP_CONFIG_POLL_MS : false
}

const base = (appId: string) => `/api/apps/${appId}`

/** The app's declared config, matched resources, needs and grants (`null` id = not loaded yet). */
export function useAppConfig(appId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.appConfig.detail(appId ?? ''),
    queryFn: () => api.get(`${base(appId ?? '')}/config`, { schema: appConfigSchema }),
    enabled: Boolean(appId) && enabled,
    refetchInterval: q => appConfigPollInterval(q.state.data),
  })
}

export function useRequestGrant(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    // The modal renders the refusal (already held, values not set, not configured): no toast.
    mutationFn: (body: RequestGrantRequest) =>
      api.post(`${base(appId)}/grants`, body, {
        schema: requestGrantResponseSchema,
        showErrorToast: false,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.appConfig.detail(appId) })
      // The request opened approvals somebody is now waiting on: the inbox and the badge move.
      void queryClient.invalidateQueries({ queryKey: queryKeys.approvals.all })
    },
  })
}

/**
 * Revoke a grant. The app travels with the call (not the hook) because the resource page's
 * holders table revokes across many apps; the app's owners, the resource's owners and admins may.
 */
export function useRevokeGrant() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      appId,
      grantId,
      ...body
    }: RevokeGrantRequest & { appId: string; grantId: string }) =>
      api.delete(`${base(appId)}/grants/${grantId}`, body, {
        schema: grantActionResponseSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.appConfig.all })
      // The resource's holders and its push history change too.
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedResources.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.grantPushes.all })
    },
  })
}

export function useRepushGrant(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (grantId: string) =>
      api.post(`${base(appId)}/grants/${grantId}/repush`, undefined, {
        schema: grantActionResponseSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.appConfig.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.grantPushes.all })
    },
  })
}

export function useRescanAppConfig(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post(`${base(appId)}/config/scan`, undefined, { schema: appConfigSchema }),
    onSuccess: view => queryClient.setQueryData(queryKeys.appConfig.detail(appId), view),
  })
}
