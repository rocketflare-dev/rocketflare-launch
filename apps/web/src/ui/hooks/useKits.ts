/**
 * The kit catalogue (D36 K1): `/api/platform/kits` (`canAdministerPlatform`). Every mutation
 * answers with the kit, and invalidates the catalogue AND the setup overview — the default kit's
 * pin is the template pin. K5 adds the member-level list Create app's picker
 * reads (`GET /api/kits`, `useKitOptions`), one kit's detail, re-pin and remove. K3's dynamic
 * (scaffold) check is `dynamic: true` on add, check and re-pin (`?dynamic=1`); while a kit is
 * `checking` the list re-reads every {@link KITS_POLL_MS} (no realtime event carries it).
 */
import {
  type Kit,
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

/** How often the catalogue re-reads while a dynamic check runs (its job polls GitHub each minute). */
export const KITS_POLL_MS = 15_000

/** Is a dynamic (scaffold) check of this kit still running? Pure. */
export function kitCheckRunning(kit: Pick<Kit, 'status' | 'dynamicCheck'>): boolean {
  const dynamic = kit.dynamicCheck?.status
  return kit.status === 'checking' || dynamic === 'queued' || dynamic === 'running'
}

/** `refetchInterval` for the catalogue: poll while any kit's dynamic check runs. Pure. */
export function kitsPollInterval(
  kits: readonly Pick<Kit, 'status' | 'dynamicCheck'>[] | undefined
): number | false {
  return kits?.some(kitCheckRunning) ? KITS_POLL_MS : false
}

/** `?dynamic=1` when the scaffold check is asked for too. */
const dynamicQuery = (dynamic: boolean | undefined) => (dynamic ? '?dynamic=1' : '')

export function useKits(enabled = true) {
  return useQuery({
    queryKey: queryKeys.kits.list,
    queryFn: () => api.get(BASE, { schema: kitListResponseSchema }),
    enabled,
    refetchInterval: q => kitsPollInterval(q.state.data?.kits),
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

/** Register a kit: the server resolves the pin and runs the conformance check (`dynamic`: both). */
export function useAddKit() {
  const invalidate = useInvalidateKits()
  return useMutation({
    mutationFn: ({ dynamic, ...body }: KitAddRequest & { dynamic?: boolean }) =>
      api.post(`${BASE}${dynamicQuery(dynamic)}`, body, { schema: kitDetailSchema }),
    onSuccess: () => invalidate(),
  })
}

/**
 * Re-read the manifest and re-run the check at the kit's pin; `dynamic` also starts the scaffold
 * check (enqueued — the kit answers `checking`, and the list polls until it settles).
 */
export function useCheckKit() {
  const invalidate = useInvalidateKits()
  return useMutation({
    mutationFn: ({ id, dynamic }: { id: string; dynamic?: boolean }) =>
      api.post(`${BASE}/${id}/check${dynamicQuery(dynamic)}`, undefined, {
        schema: kitDetailSchema,
      }),
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
    mutationFn: ({ id, pin, dynamic }: { id: string; pin: KitPinRequest; dynamic?: boolean }) =>
      api.put(`${BASE}/${id}/pin${dynamicQuery(dynamic)}`, pin, { schema: kitDetailSchema }),
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
