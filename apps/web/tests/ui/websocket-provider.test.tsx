/**
 * `WebSocketProvider` (D8): connects only when authenticated with a tenant, reconnects on tenant
 * switch, turns events into `queryKeys` invalidations (`notification.created` → `['notifications']`
 * + a toast) and the invalidation table only names real query-key families. Reconnect/backoff
 * mechanics are covered in websocket-client.test.ts.
 */
import { invalidationsFor, REALTIME_INVALIDATIONS } from '@launch/shared/realtime'
import { act, cleanup, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '@/ui/components/shared/Toast'
import { RESYNC_ON_RECONNECT, WebSocketProvider } from '@/ui/components/WebSocketProvider'
import { WebSocketStatus } from '@/ui/components/WebSocketStatus'
import { queryKeys } from '@/ui/lib/query-keys'
import { websocketClient } from '@/ui/lib/websocketClient'
import { useWebSocketStore } from '@/ui/stores/websocketStore'
import { IDS, makeSession, makeTenant, renderWithProviders } from './helpers/renderWithProviders'

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  closedWith: [number, string] | null = null
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
  send() {}
  close(code: number, reason: string) {
    this.readyState = 3
    this.closedWith = [code, reason]
  }
}

const latest = () => FakeSocket.instances.at(-1) as FakeSocket

/** Every family root in `queryKeys` (the first key element). */
function queryKeyRoots(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    if (typeof node[0] === 'string') out.add(node[0])
  } else if (typeof node === 'function') {
    queryKeyRoots((node as (f?: object) => unknown)(), out)
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) queryKeyRoots(v, out)
  }
  return out
}

describe('REALTIME_INVALIDATIONS', () => {
  it('only names roots that exist in the queryKeys factory', () => {
    const roots = queryKeyRoots(queryKeys)
    for (const keys of Object.values(REALTIME_INVALIDATIONS)) {
      for (const key of keys) expect(roots).toContain(key[0])
    }
    expect(REALTIME_INVALIDATIONS['notification.created']).toEqual([queryKeys.notifications.all])
    expect(REALTIME_INVALIDATIONS['invitation.changed']).toEqual([
      queryKeys.invitations.all,
      queryKeys.pendingInvitations.all,
    ])
  })
})

/** Is `prefix` a prefix of `key` (TanStack's partial match)? */
const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) =>
  prefix.every((part, i) => part === key[i])

describe('targeted shipping invalidations', () => {
  const ID = 'row-1'
  const APP = 'app-1'
  const event = (payload: object) => ({
    type: 'entity.changed' as const,
    tenantId: IDS.tenant,
    at: new Date().toISOString(),
    payload,
  })

  it("cover every key of the session family for the named session — and no other session's detail", () => {
    const targets = invalidationsFor(event({ entity: 'session', id: ID }))
    const mine = [
      queryKeys.sessions.detail(ID),
      queryKeys.sessions.pr(ID),
      queryKeys.sessions.events(ID),
      queryKeys.sessions.forApp(APP, { scope: 'mine' }),
      queryKeys.sessions.admin({ scope: 'live' }),
    ]
    for (const key of mine) expect(targets.some(t => startsWith(key, t))).toBe(true)
    // Every factory of the family is listed above: a new one must be added to the targets too.
    expect(Object.keys(queryKeys.sessions).sort()).toEqual(
      ['admin', 'all', 'detail', 'events', 'forApp', 'pr'].sort()
    )
    expect(targets.some(t => startsWith(queryKeys.sessions.detail('other'), t))).toBe(false)
    expect(targets.some(t => startsWith(queryKeys.sessionAgui.detail(ID), t))).toBe(false)
  })

  it("cover every key of the release family for the named app — and no other app's", () => {
    const targets = invalidationsFor(event({ entity: 'release', id: ID, appId: APP }))
    const mine = [
      queryKeys.releases.forApp(APP),
      queryKeys.releases.promotion(APP),
      queryKeys.releases.compare(APP),
      queryKeys.releases.detail(ID),
      queryKeys.releases.chain(ID),
    ]
    for (const key of mine) expect(targets.some(t => startsWith(key, t))).toBe(true)
    expect(Object.keys(queryKeys.releases).sort()).toEqual(
      ['all', 'chain', 'compare', 'detail', 'forApp', 'promotion'].sort()
    )
    for (const key of [queryKeys.releases.forApp('other'), queryKeys.releases.promotion('other')]) {
      expect(targets.some(t => startsWith(key, t))).toBe(false)
    }
  })
})

describe('WebSocketProvider', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    websocketClient.setFactory(url => new FakeSocket(url) as unknown as WebSocket)
  })
  afterEach(() => {
    // Unmount first so the store reset below is not a state update on a mounted tree.
    cleanup()
    websocketClient.disconnect()
    websocketClient.setFactory(null)
    useWebSocketStore.getState().reset()
    useToastStore.setState({ toasts: [] })
    vi.unstubAllGlobals()
  })

  it('does not connect while signed out', async () => {
    renderWithProviders(
      <WebSocketProvider>
        <WebSocketStatus />
      </WebSocketProvider>,
      { session: null }
    )
    await waitFor(() => expect(document.querySelector('[data-status]')).not.toBeNull())
    expect(FakeSocket.instances).toHaveLength(0)
    expect(document.querySelector('[data-status]')?.getAttribute('data-status')).toBe('closed')
  })

  it('does not connect for a signed-in user with no tenant', async () => {
    renderWithProviders(
      <WebSocketProvider>
        <span />
      </WebSocketProvider>,
      { session: makeSession({ tenant: null }) }
    )
    await act(async () => {})
    expect(FakeSocket.instances).toHaveLength(0)
  })

  it('connects to /ws?tenantId= once authenticated with a tenant and shows the status dot', async () => {
    renderWithProviders(
      <WebSocketProvider>
        <WebSocketStatus />
      </WebSocketProvider>,
      { session: makeSession() }
    )
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
    expect(latest().url).toBe(`ws://localhost:3000/ws?tenantId=${IDS.tenant}`)
    expect(document.querySelector('[data-status]')?.getAttribute('data-status')).toBe('connecting')
    act(() => latest().open())
    await waitFor(() =>
      expect(document.querySelector('[data-status]')?.getAttribute('data-status')).toBe('open')
    )
    expect(document.querySelector('[role="status"]')).toHaveAttribute(
      'aria-label',
      'Realtime connected'
    )
  })

  it('invalidates the mapped query keys and toasts on notification.created', async () => {
    const { queryClient } = renderWithProviders(
      <WebSocketProvider>
        <span />
      </WebSocketProvider>,
      { session: makeSession() }
    )
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    act(() => latest().open())

    act(() =>
      latest().message({
        type: 'notification.created',
        tenantId: IDS.tenant,
        at: new Date().toISOString(),
        payload: { id: 'n1', title: 'Mia joined Acme' },
      })
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.notifications.all })
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'info', message: 'Mia joined Acme' }),
    ])

    invalidate.mockClear()
    act(() =>
      latest().message({
        type: 'invitation.changed',
        tenantId: IDS.tenant,
        at: new Date().toISOString(),
      })
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.invitations.all })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.pendingInvitations.all })
    expect(useToastStore.getState().toasts).toHaveLength(1)

    invalidate.mockClear()
    act(() =>
      latest().message({
        type: 'entity.changed',
        tenantId: IDS.tenant,
        at: new Date().toISOString(),
        payload: { entity: 'activity', id: 'a1' },
      })
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['activity'] })
  })

  it('a session nudge invalidates that session, not the whole family', async () => {
    const { queryClient } = renderWithProviders(
      <WebSocketProvider>
        <span />
      </WebSocketProvider>,
      { session: makeSession() }
    )
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    act(() => latest().open())
    act(() =>
      latest().message({
        type: 'entity.changed',
        tenantId: IDS.tenant,
        at: new Date().toISOString(),
        payload: { entity: 'session', id: 's1' },
      })
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions.detail('s1') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions.pr('s1') })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: queryKeys.sessions.all })
  })

  it('re-reads the slowed families once when the socket comes back after a drop', async () => {
    const { queryClient } = renderWithProviders(
      <WebSocketProvider>
        <span />
      </WebSocketProvider>,
      { session: makeSession() }
    )
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    // The first open is not a resync: the page has just fetched.
    act(() => latest().open())
    expect(invalidate).not.toHaveBeenCalled()

    vi.useFakeTimers()
    try {
      act(() => latest().onclose?.({ code: 1006, reason: '' }))
      expect(useWebSocketStore.getState().status).not.toBe('open')
      act(() => vi.advanceTimersByTime(2_000))
    } finally {
      vi.useRealTimers()
    }
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2))
    act(() => latest().open())
    for (const queryKey of RESYNC_ON_RECONNECT) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey })
    }
    expect(RESYNC_ON_RECONNECT).not.toContainEqual(queryKeys.sessionAgui.all)
  })

  it('reconnects to the new tenant when the session switches', async () => {
    const { queryClient } = renderWithProviders(
      <WebSocketProvider>
        <span />
      </WebSocketProvider>,
      { session: makeSession() }
    )
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
    const first = latest()
    act(() => first.open())
    act(() => {
      queryClient.setQueryData(
        queryKeys.auth.session,
        makeSession({ tenant: makeTenant({ id: IDS.otherTenant, slug: 'other' }) })
      )
    })
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2))
    expect(first.closedWith).toEqual([1000, 'client disconnect'])
    expect(latest().url).toContain(`tenantId=${IDS.otherTenant}`)

    act(() => {
      queryClient.setQueryData(queryKeys.auth.session, null)
    })
    await waitFor(() => expect(latest().closedWith).toEqual([1000, 'client disconnect']))
    expect(useWebSocketStore.getState().status).toBe('closed')
  })
})
