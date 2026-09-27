/**
 * The issuer's signing keys (spec/05): `/api/admin/oidc`, global admin. Rotation starts signing
 * with the key already published as `next`; the old key stays in the JWKS while it is `retiring`.
 */
import { oidcKeysResponseSchema, oidcRotateResponseSchema } from '@launch/shared/launch-oidc'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

export function useOidcKeys() {
  return useQuery({
    queryKey: queryKeys.oidcAdmin.keys,
    queryFn: () => api.get('/api/admin/oidc/keys', { schema: oidcKeysResponseSchema }),
  })
}

export function useRotateOidcKeys() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post('/api/admin/oidc/keys/rotate', undefined, {
        schema: oidcRotateResponseSchema,
        showSuccessToast: true,
        successMessage: 'Signing key rotated',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.oidcAdmin.all }),
  })
}
