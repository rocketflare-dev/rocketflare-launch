/**
 * Shared config (Launch P5, spec/09) — the TanStack hooks over `/api/shared-resources`. Keys sit
 * under `queryKeys.sharedResources` (root `shared_resource`) and a push's under
 * `queryKeys.grantPushes` (root `grant_push`), each the realtime entity that nudges it, so a
 * rotation's progress refreshes with no socket code here.
 *
 * - `useSharedResources(query)` — the list every member reads (they need it to ask);
 * - `useSharedResource(id)` — one resource (`holders` and var values for owners and admins only);
 * - `useCreateSharedResource`, `usePatchSharedResource(id)` — admins create; owners edit items,
 *   admins the owner group and the policies (the server decides, 403 otherwise);
 * - `useSetSharedResourceValues(id)` — `PUT …/values/:env`, WRITE-ONLY: the answer is the new
 *   version and the `rotate` push it started, never a value;
 * - `useGrantPushes(id)`, `useGrantPush(id, pushId)`, `useRetryGrantPush(id)` — the history, one
 *   push with its targets, and a retry of a partial one.
 *
 * Polling (ui.md) is the belt to the nudge's braces, and only while the SERVER owes an answer: a
 * push that is `queued` or `running`. Every other state is settled or waits on a person.
 */

import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  type CreateSharedResourceRequest,
  type GrantPushListQuery,
  type GrantPushStatus,
  grantPushListResponseSchema,
  grantPushSchema,
  isActiveGrantPush,
  type PatchSharedResourceRequest,
  type PutSharedResourceValuesRequest,
  putSharedResourceValuesResponseSchema,
  type SharedResourceDetail,
  type SharedResourceListQuery,
  sharedResourceDetailSchema,
  sharedResourceListResponseSchema,
} from '@launch/shared/launch-grants'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys, toSearchParams } from '@/ui/lib/query-keys'

/** How often a running push is re-read while the socket may be down. */
export const GRANT_PUSH_POLL_MS = 3000

/** Whether the server still owes an answer on a push. Pure. */
export function pushOwesAnswer(status: GrantPushStatus | undefined): boolean {
  return status !== undefined && isActiveGrantPush(status)
}

/** `refetchInterval` for one push: poll only while it is queued or running. Pure. */
export function grantPushPollInterval(status: GrantPushStatus | undefined): number | false {
  return pushOwesAnswer(status) ? GRANT_PUSH_POLL_MS : false
}

/** `refetchInterval` for a resource: poll while one of its environments has a push running. */
export function sharedResourcePollInterval(
  detail: Pick<SharedResourceDetail, 'activePushes'> | undefined
): number | false {
  return detail?.activePushes.some(push => pushOwesAnswer(push.status)) ? GRANT_PUSH_POLL_MS : false
}

const base = '/api/shared-resources'
const resourcePath = (id: string) => `${base}/${id}`

/** Every shared resource (members read the list — they need it to ask). */
export function useSharedResources(query: Partial<SharedResourceListQuery> = {}) {
  return useQuery({
    queryKey: queryKeys.sharedResources.list(query),
    queryFn: () =>
      api.get(`${base}${toSearchParams(query)}`, {
        schema: sharedResourceListResponseSchema,
      }),
    select: data => data.items,
  })
}

/** One resource. `null` id = not wanted (the approval page asks only for a grant request). */
export function useSharedResource(id: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.sharedResources.detail(id ?? ''),
    queryFn: () => api.get(resourcePath(id ?? ''), { schema: sharedResourceDetailSchema }),
    enabled: Boolean(id),
    refetchInterval: q => sharedResourcePollInterval(q.state.data),
  })
}

export function useCreateSharedResource() {
  const queryClient = useQueryClient()
  return useMutation({
    // The modal renders a 409 (slug taken) or a 400 beside the form: no toast.
    mutationFn: (body: CreateSharedResourceRequest) =>
      api.post(base, body, { schema: sharedResourceDetailSchema, showErrorToast: false }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sharedResources.all }),
  })
}

export function usePatchSharedResource(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: PatchSharedResourceRequest) =>
      api.patch(resourcePath(id), body, {
        schema: sharedResourceDetailSchema,
        showErrorToast: false,
      }),
    onSuccess: detail => {
      queryClient.setQueryData(queryKeys.sharedResources.detail(id), detail)
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedResources.all })
    },
  })
}

/**
 * Set one environment's values. A blank key keeps the previous value (the server merges); the
 * answer carries the `rotate` push when the environment has holders. Errors render in the modal.
 */
export function useSetSharedResourceValues(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      environment,
      ...body
    }: PutSharedResourceValuesRequest & { environment: AppEnvironmentName }) =>
      api.put(`${resourcePath(id)}/values/${environment}`, body, {
        schema: putSharedResourceValuesResponseSchema,
        showErrorToast: false,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedResources.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.grantPushes.all })
      // A rotation reaches every holder's config page too.
      void queryClient.invalidateQueries({ queryKey: queryKeys.appConfig.all })
    },
  })
}

/**
 * A resource's pushes, newest first — owners and admins only (the route 404s anybody else), so
 * the page enables it only when the detail carried `holders`.
 */
export function useGrantPushes(
  resourceId: string,
  filters: Partial<GrantPushListQuery> = {},
  enabled = true
) {
  return useQuery({
    queryKey: queryKeys.grantPushes.forResource(resourceId, filters),
    queryFn: () =>
      api.get(`${resourcePath(resourceId)}/pushes${toSearchParams(filters)}`, {
        schema: grantPushListResponseSchema,
      }),
    select: data => data.items,
    enabled: Boolean(resourceId) && enabled,
    refetchInterval: q =>
      q.state.data?.items.some(push => pushOwesAnswer(push.status)) ? GRANT_PUSH_POLL_MS : false,
  })
}

/** One push with every target — the progress bar and the failed apps. */
export function useGrantPush(resourceId: string, pushId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.grantPushes.detail(pushId ?? ''),
    queryFn: () =>
      api.get(`${resourcePath(resourceId)}/pushes/${pushId}`, { schema: grantPushSchema }),
    enabled: Boolean(resourceId && pushId),
    refetchInterval: q => grantPushPollInterval(q.state.data?.status),
  })
}

/** Retry a `partial` / `failed` push: the targets that succeeded are skipped server-side. */
export function useRetryGrantPush(resourceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (pushId: string) =>
      api.post(`${resourcePath(resourceId)}/pushes/${pushId}/retry`, undefined, {
        schema: grantPushSchema,
        showErrorToast: false,
      }),
    onSuccess: push => {
      queryClient.setQueryData(queryKeys.grantPushes.detail(push.id), push)
      void queryClient.invalidateQueries({ queryKey: queryKeys.grantPushes.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedResources.detail(resourceId) })
    },
  })
}
