/**
 * The setup wizard (spec/03, spec/04): `/api/admin/setup`, global admin. Every mutation answers
 * with fresh state, so each one invalidates the one `setup` family and the page re-renders from
 * the overview — there is no second source of truth for a dot. A credential value is sent once, in
 * a PUT body, and never comes back.
 */
import {
  type CredentialKind,
  type CredentialPayload,
  publicUrlCheckResponseSchema,
  type SetupSettingsUpdate,
  setupCheckResponseSchema,
  setupOverviewSchema,
  setupRemoveResponseSchema,
} from '@launch/shared/launch-setup'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

const BASE = '/api/admin/setup'

export function useSetupOverview(enabled = true) {
  return useQuery({
    queryKey: queryKeys.setup.status,
    queryFn: () => api.get(BASE, { schema: setupOverviewSchema }),
    enabled,
  })
}

function useInvalidateSetup() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.setup.all })
}

export function useUpdateSetupSettings() {
  const invalidate = useInvalidateSetup()
  return useMutation({
    mutationFn: (body: SetupSettingsUpdate) =>
      api.put(`${BASE}/settings`, body, { schema: setupOverviewSchema }),
    onSuccess: () => invalidate(),
  })
}

export function usePutCredential<K extends CredentialKind>(kind: K) {
  const invalidate = useInvalidateSetup()
  return useMutation({
    mutationFn: (body: CredentialPayload<K>) =>
      api.put(`${BASE}/credentials/${kind}`, body, { schema: setupCheckResponseSchema }),
    onSuccess: () => invalidate(),
  })
}

export function useCheckCredential(kind: CredentialKind) {
  const invalidate = useInvalidateSetup()
  return useMutation({
    mutationFn: () =>
      api.post(`${BASE}/credentials/${kind}/check`, undefined, {
        schema: setupCheckResponseSchema,
      }),
    onSuccess: () => invalidate(),
  })
}

export function useRemoveCredential(kind: CredentialKind) {
  const invalidate = useInvalidateSetup()
  return useMutation({
    mutationFn: () =>
      api.delete(`${BASE}/credentials/${kind}`, undefined, { schema: setupRemoveResponseSchema }),
    onSuccess: () => invalidate(),
  })
}

/** Probe `APP_URL` from the internet now (step 7); the result is what `POST /api/apps` gates on. */
export function useCheckPublicUrl() {
  const invalidate = useInvalidateSetup()
  return useMutation({
    mutationFn: () =>
      api.post(`${BASE}/public-url/check`, undefined, { schema: publicUrlCheckResponseSchema }),
    onSuccess: () => invalidate(),
  })
}
