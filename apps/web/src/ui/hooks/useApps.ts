/**
 * Launch's app registry (spec/06): `/api/apps`. The catalogue and one app are read by every
 * member; import, edits, "Check now" and the OIDC client are admin-level (the page hides what the
 * server would refuse, `manage App`).
 *
 * Health changes on the server's five-minute cron, not in response to anything the reader does,
 * so health alone never polls (ui.md: never poll a settled row) — a window refocus refetches, and
 * "Check now" writes the fresh result into the cache. The catalogue polls only while a row's
 * `latestDeploy` is in progress (`deployProgressPollInterval`, shared with the overview's
 * stepper). Every mutation invalidates the `apps` root.
 *
 * The OIDC secret exists only in the create / rotate RESPONSE: the mutation hands it to the page,
 * which shows it once, and nothing puts it in the query cache.
 *
 * Issue #5: the app's ship settings (`useUpdateShipSettings` — the detail refetches) and its
 * default branch's protection (`useBranchProtection`, never polled; `useApplyBranchProtection`,
 * admins, writes the answer into the cache).
 */
import {
  type AppDetail,
  type AppHealthCheckRunResponse,
  appBranchProtectionSchema,
  appDetailSchema,
  appHealthCheckRunResponseSchema,
  appHealthResponseSchema,
  appListResponseSchema,
  appOidcClientResponseSchema,
  appOidcClientSecretResponseSchema,
  appOperationListResponseSchema,
  appThumbnailRefreshResponseSchema,
  type ImportAppRequest,
  type PutAppShipSettingsRequest,
  type UpdateAppRedirectUrisRequest,
  type UpdateAppRequest,
} from '@launch/shared/launch-apps'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deployProgressPollInterval } from '@/ui/hooks/useDeploys'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

/** Health is at most five minutes old on the server; refetching sooner shows nothing new. */
const HEALTH_STALE_MS = 60_000

export function useApps() {
  return useQuery({
    queryKey: queryKeys.apps.list(),
    queryFn: () => api.get('/api/apps', { schema: appListResponseSchema }),
    staleTime: HEALTH_STALE_MS,
    refetchInterval: q => deployProgressPollInterval(q.state.data?.items.map(a => a.latestDeploy)),
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
      // The pipeline strip reads staging's health too: a fresh probe may enable Promote.
      void queryClient.invalidateQueries({ queryKey: queryKeys.releases.promotion(app.id) })
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

// ---- Issue #5: where Ship ends, who reviews, and the branch protection the merge needs ------

/**
 * `PUT /api/apps/:id/ship-settings` (the app's owners and admins, `viewerCanDeploy`) → the app
 * detail, as `PATCH /:id` answers. The `apps` family is refetched on success. While an admin
 * policy decides review (`shipReviewSetBy: 'policy'`) the caller sends the stored review back
 * unchanged — changing it is a 409 `ship_review_set_by_policy`; the destination may still change.
 */
export function useUpdateShipSettings(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: PutAppShipSettingsRequest) =>
      api.put(`/api/apps/${appId}/ship-settings`, body, {
        schema: appDetailSchema,
        showSuccessToast: true,
        successMessage: 'Shipping settings saved',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
  })
}

/**
 * `GET /api/apps/:id/branch-protection` — asked of GitHub on each read, so it is never polled and
 * kept for a minute. No toast: a failure is the card's to say in place.
 */
export function useBranchProtection(appId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.apps.branchProtection(appId ?? ''),
    queryFn: () =>
      api.get(`/api/apps/${appId}/branch-protection`, {
        schema: appBranchProtectionSchema,
        showErrorToast: false,
      }),
    enabled: enabled && Boolean(appId),
    staleTime: HEALTH_STALE_MS,
  })
}

/**
 * `POST /api/apps/:id/branch-protection` (admins, `manage App`): apply Launch's ruleset; the answer
 * is a fresh diagnosis (still `blocks` while classic protection remains). A refusal (409
 * `rulesets_unavailable`, 502 `branch_protection_github_failed`) toasts and re-reads the state.
 */
export function useApplyBranchProtection(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post(`/api/apps/${appId}/branch-protection`, undefined, {
        schema: appBranchProtectionSchema,
      }),
    onSuccess: protection =>
      queryClient.setQueryData(queryKeys.apps.branchProtection(appId), protection),
    onError: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.branchProtection(appId) }),
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

/**
 * "Refresh thumbnail" (`manage App`): queues a capture of every environment with a URL. The new
 * picture arrives on its own — the job nudges the `apps` root when it lands — so this only says
 * it was queued. No toast: a 429 (refreshed within the minute) or a 409 is said in place.
 */
export function useRefreshAppThumbnail(appId: string) {
  return useMutation({
    mutationFn: () =>
      api.post(`/api/apps/${appId}/thumbnail/refresh`, undefined, {
        schema: appThumbnailRefreshResponseSchema,
      }),
  })
}
