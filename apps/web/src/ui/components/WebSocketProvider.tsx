/**
 * Realtime bridge (D8, 06 §b): connects the singleton `websocketClient` once `useAuth()` is
 * authenticated AND has a tenant, reconnects when the tenant changes, disconnects on sign-out.
 * Every event becomes query invalidations through `invalidationsFor` (`@launch/shared/realtime`) —
 * the client re-queries, it never applies a payload as state — and a `notification.created` shows
 * a toast. Components subscribe to query state, never to the socket.
 *
 * While the socket is open the shipping views poll only as a slow fallback (`useRealtimeConnected`
 * in their hooks), so an outage can hide a move: when the socket comes back after a drop, the
 * families those hooks slowed (`RESYNC_ON_RECONNECT`) are re-read once.
 */
import { invalidationsFor, type RealtimeEvent } from '@launch/shared/realtime'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect } from 'react'
import { useAuth } from '@/ui/hooks/useAuth'
import { queryKeys } from '@/ui/lib/query-keys'
import { websocketClient } from '@/ui/lib/websocketClient'
import { useWebSocketStore } from '@/ui/stores/websocketStore'
import { showToast } from './shared/Toast'

/**
 * The query-key families whose polling slows while the socket is open — re-read on a REconnect,
 * since a nudge sent while the socket was down is lost. Not the first open: the page has just
 * fetched them. Never the chat timelines (`session-agui`): a re-read there drops the live list.
 */
export const RESYNC_ON_RECONNECT = [
  queryKeys.sessions.all,
  queryKeys.releases.all,
  queryKeys.approvals.all,
] as const

function notificationTitle(event: RealtimeEvent): string {
  const payload = event.payload as { title?: unknown } | undefined
  return typeof payload?.title === 'string' && payload.title ? payload.title : 'New notification'
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const { status, tenant } = useAuth()
  const queryClient = useQueryClient()
  const tenantId = status === 'authenticated' ? (tenant?.id ?? null) : null

  useEffect(() => {
    if (!tenantId) {
      websocketClient.disconnect()
      return
    }
    websocketClient.connect(tenantId)
    // Sign-out / tenant loss disconnects via the branch above; a tenant switch reconnects in place.
  }, [tenantId])

  useEffect(
    () =>
      websocketClient.onEvent(event => {
        for (const queryKey of invalidationsFor(event)) {
          void queryClient.invalidateQueries({ queryKey })
        }
        if (event.type === 'notification.created') showToast(notificationTitle(event), 'info')
      }),
    [queryClient]
  )

  useEffect(() => {
    let wasOpen = useWebSocketStore.getState().status === 'open'
    let dropped = false
    return useWebSocketStore.subscribe(state => {
      if (state.status === 'open') {
        if (dropped) {
          for (const queryKey of RESYNC_ON_RECONNECT)
            void queryClient.invalidateQueries({ queryKey })
        }
        wasOpen = true
        dropped = false
      } else if (wasOpen) {
        dropped = true
      }
    })
  }, [queryClient])

  return <>{children}</>
}
