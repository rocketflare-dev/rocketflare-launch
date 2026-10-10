/**
 * The kit catalogue (D36 K1): `/api/platform/kits` (`canAdministerPlatform`). Every mutation
 * answers with the kit, and invalidates the catalogue AND the setup overview — the default kit's
 * pin is the Kit version card's template pin.
 */
import { type KitAddRequest, kitDetailSchema, kitListResponseSchema } from '@launch/shared/kits'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

const BASE = '/api/platform/kits'

export function useKits(enabled = true) {
  return useQuery({
    queryKey: queryKeys.kits.list,
    queryFn: () => api.get(BASE, { schema: kitListResponseSchema }),
    enabled,
  })
}

function useInvalidateKits() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.kits.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.setup.all }),
    ])
}

/** Register a kit: the server resolves the pin and runs the conformance check. */
export function useAddKit() {
  const invalidate = useInvalidateKits()
  return useMutation({
    mutationFn: (body: KitAddRequest) => api.post(BASE, body, { schema: kitDetailSchema }),
    onSuccess: () => invalidate(),
  })
}

/** Re-read the manifest and re-run the check at the kit's pin. */
export function useCheckKit() {
  const invalidate = useInvalidateKits()
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`${BASE}/${id}/check`, undefined, { schema: kitDetailSchema }),
    onSuccess: () => invalidate(),
  })
}

/** Make a kit the one new apps are cut from. */
export function useMakeDefaultKit() {
  const invalidate = useInvalidateKits()
  return useMutation({
    mutationFn: (id: string) =>
      api.put(`${BASE}/${id}/default`, undefined, { schema: kitDetailSchema }),
    onSuccess: () => invalidate(),
  })
}
