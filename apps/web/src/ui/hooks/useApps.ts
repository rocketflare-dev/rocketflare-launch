/**
 * Launch's app registry (spec/06): `/api/apps`. The catalogue and one app are read by every
 * member; import, edits, "Check now" and the OIDC client are admin-level (the page hides what the
 * server would refuse, `manage App`).
 *
 * Health changes on the server's five-minute cron, not in response to anything the reader does,
 * so nothing here polls (ui.md: never poll a settled row) — a window refocus refetches, and
 * "Check now" writes the fresh result into the cache. Every mutation invalidates the `apps` root.
 *
 * The OIDC secret exists only in the create / rotate RESPONSE: the mutation hands it to the page,
 * which shows it once, and nothing puts it in the query cache.
 */
import {
  type AppDetail,
  type AppHealthCheckRunResponse,
  appDetailSchema,
  appHealthCheckRunResponseSchema,
  appHealthResponseSchema,
  appListResponseSchema,
  appOidcClientResponseSchema,
  appOidcClientSecretResponseSchema,
  appOperationListResponseSchema,
  type ImportAppRequest,
  type UpdateAppRedirectUrisRequest,
  type UpdateAppRequest,
} from '@launch/shared/launch-apps'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

/** Health is at most five minutes old on the server; refetching sooner shows nothing new. */
const HEALTH_STALE_MS = 60_000

export function useApps() {
  return useQuery({
    queryKey: queryKeys.apps.list(),
    queryFn: () => api.get('/api/apps', { schema: appListResponseSchema }),
    staleTime: HEALTH_STALE_MS,
  })
}

export function useApp(slug: string) {
  return useQuery({
    queryKey: queryKeys.apps.detail(slug),
    queryFn: () => api.get(`/api/apps/${encodeURIComponent(slug)}`, { schema: appDetailSchema }),
    enabled: slug !== '',
    staleTime: HEALTH_STALE_MS,
  })
}

export function useAppHealth(appId: string | undefined, hours = 24) {
  return useQuery({
    queryKey: [...queryKeys.apps.health(appId ?? ''), hours] as const,
    queryFn: () =>
      api.get(`/api/apps/${appId}/health?hours=${hours}`, { schema: appHealthResponseSchema }),
    enabled: Boolean(appId),
    staleTime: HEALTH_STALE_MS,
  })
}

export function useAppOperations(appId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.apps.operations(appId ?? ''),
    queryFn: () =>
      api.get(`/api/apps/${appId}/operations`, { schema: appOperationListResponseSchema }),
    enabled: Boolean(appId),
  })
}

export function useAppOidcClient(appId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.apps.oidcClient(appId ?? ''),
    queryFn: () =>
      api.get(`/api/apps/${appId}/oidc-client`, { schema: appOidcClientResponseSchema }),
    enabled: Boolean(appId),
  })
}

export function useImportApp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: ImportAppRequest) =>
      // The modal renders the failure itself (a 422 names the missing file), so no toast.
      api.post('/api/apps/import', body, { schema: appDetailSchema, showErrorToast: false }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
  })
}

export function useUpdateApp(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateAppRequest) =>
      api.patch(`/api/apps/${appId}`, body, {
        schema: appDetailSchema,
        showSuccessToast: true,
        successMessage: 'App updated',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
  })
}

/** Probe now; the answer goes straight into the detail cache, then the family refreshes. */
export function useCheckAppHealth(app: Pick<AppDetail, 'id' | 'slug'>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post(`/api/apps/${app.id}/health-check`, undefined, {
        schema: appHealthCheckRunResponseSchema,
      }),
    onSuccess: (result: AppHealthCheckRunResponse) => {
      queryClient.setQueryData<AppDetail>(queryKeys.apps.detail(app.slug), prev =>
        prev
          ? {
              ...prev,
              environments: prev.environments.map(env => {
                const fresh = result.environments.find(e => e.id === env.id)
                return fresh ? { ...env, ...fresh } : env
              }),
            }
          : prev
      )
      return queryClient.invalidateQueries({ queryKey: queryKeys.apps.all })
    },
  })
}

export function useCreateOidcClient(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post(`/api/apps/${appId}/oidc-client`, undefined, {
        schema: appOidcClientSecretResponseSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.oidcClient(appId) }),
  })
}

export function useRotateOidcSecret(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post(`/api/apps/${appId}/oidc-client/rotate-secret`, undefined, {
        schema: appOidcClientSecretResponseSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.oidcClient(appId) }),
  })
}

export function useUpdateRedirectUris(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateAppRedirectUrisRequest) =>
      api.patch(`/api/apps/${appId}/oidc-client/redirect-uris`, body, {
        schema: appOidcClientResponseSchema,
        showSuccessToast: true,
        successMessage: 'Redirect URIs saved',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.oidcClient(appId) }),
  })
}
