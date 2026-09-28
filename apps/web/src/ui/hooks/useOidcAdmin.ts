/**
 * The issuer's signing keys (spec/05): `/api/platform/oidc` (`canAdministerPlatform`). Rotation
 * starts signing with the key already published as `next`; the old key stays in the JWKS while it is `retiring`.
 */
import { oidcKeysResponseSchema, oidcRotateResponseSchema } from '@launch/shared/launch-oidc'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

export function useOidcKeys() {
  return useQuery({
    queryKey: queryKeys.oidcAdmin.keys,
    queryFn: () => api.get('/api/platform/oidc/keys', { schema: oidcKeysResponseSchema }),
  })
}

export function useRotateOidcKeys() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post('/api/platform/oidc/keys/rotate', undefined, {
        schema: oidcRotateResponseSchema,
        showSuccessToast: true,
        successMessage: 'Signing key rotated',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.oidcAdmin.all }),
  })
}
