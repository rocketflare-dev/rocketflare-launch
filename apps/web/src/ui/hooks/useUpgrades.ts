/**
 * An app's kit upgrades (P6 6c) over `/api/apps/:id/upgrade(s)`: its history, and starting one —
 * `POST /:id/upgrade`, which answers the upgrade and the coding session doing it (the caller
 * navigates to the session, as "Fix in a session" does).
 *
 * Every key sits under the `apps` root (`queryKeys.apps.upgrades`), so the server's
 * `entity.changed { entity: 'apps' }` nudge — sent whenever an upgrade moves — refreshes the
 * history and the detail's kit status together with no socket code here. Nothing polls: the
 * upgrade waits on a session, whose own page polls and nudges.
 */
import {
  appUpgradeListResponseSchema,
  startUpgradeResponseSchema,
} from '@launch/shared/launch-upgrades'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

/** `GET /api/apps/:id/upgrades` — newest first. */
export function useAppUpgrades(appId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.apps.upgrades(appId),
    queryFn: () => api.get(`/api/apps/${appId}/upgrades`, { schema: appUpgradeListResponseSchema }),
    enabled,
  })
}

/** `POST /api/apps/:id/upgrade` — refusals come back to the caller (no toast here). */
export function useStartUpgrade(appId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post(`/api/apps/${appId}/upgrade`, undefined, {
        schema: startUpgradeResponseSchema,
        showErrorToast: false,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all })
    },
  })
}
