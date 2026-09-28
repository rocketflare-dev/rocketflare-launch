/**
 * Who may sign in to an app through Launch (spec/05): `/api/app-access`. The requester's side (the
 * request-access page) and the owner's side (the app's Access page — policy, grants, requests).
 * `app` is the app's id or slug; the server answers 404 to anyone who may not manage it.
 */
import {
  type AppAccessRequestStatus,
  appAccessGrantListSchema,
  appAccessPolicySchema,
  appAccessRequestContextSchema,
  appAccessRequestListSchema,
  type CreateAppAccessGrant,
  createAppAccessRequestResponseSchema,
  type OidcAccessPolicy,
} from '@launch/shared/launch-oidc'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { cleanFilters, queryKeys, toSearchParams } from '@/ui/lib/query-keys'

const base = (app: string) => `/api/app-access/${encodeURIComponent(app)}`

// ---- The requester -------------------------------------------------------------------------

export function useAppAccessRequestContext(clientId: string | null) {
  return useQuery({
    queryKey: queryKeys.appAccess.requestContext(clientId ?? ''),
    queryFn: () =>
      api.get(`/api/app-access/request-context${toSearchParams({ clientId })}`, {
        schema: appAccessRequestContextSchema,
      }),
    enabled: Boolean(clientId),
    retry: false,
  })
}

export function useRequestAppAccess() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { clientId: string; message?: string }) =>
      api.post('/api/app-access/requests', body, {
        schema: createAppAccessRequestResponseSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.appAccess.all }),
  })
}

// ---- The owner -----------------------------------------------------------------------------

export function useAppAccessPolicy(app: string) {
  return useQuery({
    queryKey: queryKeys.appAccess.policy(app),
    queryFn: () => api.get(`${base(app)}/policy`, { schema: appAccessPolicySchema }),
    enabled: Boolean(app),
    retry: false,
  })
}

export function useUpdateAppAccessPolicy(app: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (accessPolicy: OidcAccessPolicy) =>
      api.put(
        `${base(app)}/policy`,
        { accessPolicy },
        {
          schema: appAccessPolicySchema,
          showSuccessToast: true,
          successMessage: 'Access policy saved',
        }
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.appAccess.all }),
  })
}

export function useAppAccessGrants(app: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.appAccess.grants(app),
    queryFn: () => api.get(`${base(app)}/grants`, { schema: appAccessGrantListSchema }),
    enabled: Boolean(app) && enabled,
  })
}

export function useAddAppAccessGrant(app: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (grant: CreateAppAccessGrant) =>
      api.post(`${base(app)}/grants`, grant, {
        schema: appAccessGrantListSchema,
        showSuccessToast: true,
        successMessage: 'Access granted',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.appAccess.all }),
  })
}

export function useRemoveAppAccessGrant(app: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (grantId: string) =>
      api.delete(`${base(app)}/grants/${grantId}`, undefined, {
        showSuccessToast: true,
        successMessage: 'Access removed',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.appAccess.all }),
  })
}

export function useAppAccessRequests(
  app: string,
  filters: { status?: AppAccessRequestStatus } = {},
  enabled = true
) {
  return useQuery({
    queryKey: queryKeys.appAccess.requests(app, cleanFilters(filters)),
    queryFn: () =>
      api.get(`${base(app)}/requests${toSearchParams(filters)}`, {
        schema: appAccessRequestListSchema,
      }),
    enabled: Boolean(app) && enabled,
  })
}

// P4: a request is decided on its approval's page (`/approvals/:id` — the request id IS the
// approval id); `POST …/requests/:id/decide` answers 410 `access_request_moved`.
