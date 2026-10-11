/**
 * The kit catalogue (D36 K1): `/api/platform/kits` (`canAdministerPlatform`). Every mutation
 * answers with the kit, and invalidates the catalogue AND the setup overview — the default kit's
 * pin is the Kit version card's template pin. K5 adds the member-level list Create app's picker
 * reads (`GET /api/kits`, `useKitOptions`), one kit's detail, re-pin and remove.
 */
import {
  type KitAddRequest,
  type KitPinRequest,
  kitDetailSchema,
  kitListResponseSchema,
  kitOptionsResponseSchema,
  kitRemoveResponseSchema,
} from '@launch/shared/kits'
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

/** One kit with its manifest snapshot — Platform → Kits' details. */
export function useKit(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.kits.detail(id),
    queryFn: () => api.get(`${BASE}/${id}`, { schema: kitDetailSchema }),
    enabled,
  })
}

/**
 * D36 K5: the kits a new app may be cut from — verified ones and the default, the default first
 * (`GET /api/kits`, any member). Create app shows its picker only when there are two or more.
 */
export function useKitOptions(enabled = true) {
  return useQuery({
    queryKey: queryKeys.kits.options,
    queryFn: () => api.get('/api/kits', { schema: kitOptionsResponseSchema }),
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

/** Re-pin a kit (a release tag, a commit or Follow latest); the server checks it at the new pin. */
export function usePinKit() {
  const invalidate = useInvalidateKits()
  return useMutation({
    mutationFn: ({ id, pin }: { id: string; pin: KitPinRequest }) =>
      api.put(`${BASE}/${id}/pin`, pin, { schema: kitDetailSchema }),
    onSuccess: () => invalidate(),
  })
}

/** Remove a kit nothing was made from (never the default). */
export function useRemoveKit() {
  const invalidate = useInvalidateKits()
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`${BASE}/${id}`, undefined, { schema: kitRemoveResponseSchema }),
    onSuccess: () => invalidate(),
  })
}
