/**
 * The database relay (`egress/forward-database.ts`). On real Cloudflare containers the passed-through
 * WebSocket first came back with `Upgrade` and `Connection` twice (Node's clients refused it), then
 * never completed a close: the container's socket sat in CLOSING and Node could not exit, so the
 * kit's migrate, db-roles and seed "hung" after doing their work. The handler now terminates the
 * socket itself — a pair towards the container, Neon's socket accepted — and answers every close
 * on both sides. `WebSocketPair` and a 101 `Response` do not exist under Node: fakes stand in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DATABASE_UPGRADE_TIMEOUT_MS,
  forwardDatabase,
  isUpgradeRequest,
  type RelaySocket,
  relaySockets,
  sendableCloseCode,
} from '@/api/services/sessions/egress/forward-database'

afterEach(() => vi.unstubAllGlobals())

type Listener = (event: never) => void

/** A socket that records what it was told, and whose events a test fires. */
class FakeSocket implements RelaySocket {
  sent: unknown[] = []
  closes: [number | undefined, string | undefined][] = []
  accepted = false
  closed = false
  private listeners = new Map<string, Listener[]>()
  accept() {
    this.accepted = true
  }
  send(data: unknown) {
    if (this.closed) throw new TypeError('WebSocket is closed')
    this.sent.push(data)
  }
  close(code?: number, reason?: string) {
    if (this.closed) throw new TypeError('WebSocket is already closed')
    this.closed = true
    this.closes.push([code, reason])
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  fire(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never)
  }
}

const upgrade = () =>
  new Request('https://ep-x.c-5.eu-central-1.aws.neon.tech/v2', {
    headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
  })

describe('the database relay', () => {
  it('relays messages both ways', () => {
    const container = new FakeSocket()
    const neon = new FakeSocket()
    relaySockets(container, neon)
    const startup = new Uint8Array([0, 0, 0, 8]).buffer
    container.fire('message', { data: startup })
    neon.fire('message', { data: 'R' })
    expect(neon.sent).toEqual([startup])
    expect(container.sent).toEqual(['R'])
  })

  it('answers the container’s close on its own side and closes Neon’s — the half the passthrough never did', () => {
    const container = new FakeSocket()
    const neon = new FakeSocket()
    relaySockets(container, neon)
    container.fire('close', { code: 1000, reason: '' })
    expect(container.closes).toEqual([[1000, undefined]])
    expect(neon.closes).toEqual([[1000, undefined]])
    // Neon's answering close then finds both already closed: nothing throws.
    expect(() => neon.fire('close', { code: 1000, reason: '' })).not.toThrow()
  })

  it('passes Neon’s close to the container, and a code a frame may not carry as 1000', () => {
    const container = new FakeSocket()
    const neon = new FakeSocket()
    relaySockets(container, neon)
    neon.fire('close', { code: 1006, reason: '' })
    expect(container.closes).toEqual([[1000, undefined]])
    expect(sendableCloseCode(1005)).toBe(1000)
    expect(sendableCloseCode(1011)).toBe(1011)
    expect(sendableCloseCode(4001)).toBe(4001)
    expect(sendableCloseCode(2000)).toBe(1000)
  })

  it('closes both sides on an error, or when a send fails', () => {
    const a = new FakeSocket()
    const b = new FakeSocket()
    relaySockets(a, b)
    a.fire('error', {})
    expect(a.closes).toEqual([[1011, undefined]])
    expect(b.closes).toEqual([[1011, undefined]])
    const c = new FakeSocket()
    const d = new FakeSocket()
    relaySockets(c, d)
    d.closed = true
    c.fire('message', { data: 'x' })
    expect(c.closes).toEqual([[1011, 'relay failed']])
  })

  it('terminates an upgrade in a pair of its own: both ends accepted, the container given its end', async () => {
    const neon = new FakeSocket()
    const container = new FakeSocket()
    const server = new FakeSocket()
    const answered: unknown[] = []
    const answer = new Response(null, { status: 204 })
    const upstream = { status: 101, webSocket: neon, headers: new Headers() } as unknown as Response
    const result = await forwardDatabase(upgrade(), {
      fetch: async () => upstream,
      pair: () => ({
        client: container as unknown as WebSocket,
        server: server as unknown as WebSocket,
      }),
      answer: (client, protocol) => {
        answered.push(client, protocol)
        return answer
      },
    })
    expect(result).toBe(answer)
    expect(answered).toEqual([container, null])
    expect(neon.accepted).toBe(true)
    expect(server.accepted).toBe(true)
    server.fire('message', { data: 'Q' })
    expect(neon.sent).toEqual(['Q'])
  })

  it('hands back anything but a 101 as it came (a refused upgrade), and the /sql path untouched', async () => {
    const refused = new Response('no', { status: 403 })
    expect(await forwardDatabase(upgrade(), { fetch: async () => refused })).toBe(refused)
    const answer = new Response('{"error":"x"}', { status: 400 })
    const fetchMock = vi.fn(async () => answer)
    vi.stubGlobal('fetch', fetchMock)
    const request = new Request('https://ep-x.c-5.eu-central-1.aws.neon.tech/sql', {
      method: 'POST',
    })
    expect(await forwardDatabase(request)).toBe(answer)
    expect(fetchMock).toHaveBeenCalledWith(request)
  })

  it('answers 504 when Neon does not answer an upgrade in time, and says so once', async () => {
    const hang: typeof fetch = (_req, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    const told: [string, number][] = []
    const request = upgrade()
    expect(isUpgradeRequest(request)).toBe(true)
    const answer = await forwardDatabase(request, {
      fetch: hang,
      upgradeTimeoutMs: 20,
      onUpgradeTimeout: (host, ms) => told.push([host, ms]),
    })
    expect(answer.status).toBe(504)
    expect(told).toEqual([['ep-x.c-5.eu-central-1.aws.neon.tech', 20]])
  })

  it('never times a /sql query; an upgrade’s timer is cleared once Neon answers', async () => {
    expect(DATABASE_UPGRADE_TIMEOUT_MS).toBe(20_000)
    const seen: (RequestInit | undefined)[] = []
    const record: typeof fetch = async (_req, init) => {
      seen.push(init)
      return new Response('ok')
    }
    await forwardDatabase(new Request('https://ep-x.aws.neon.tech/sql', { method: 'POST' }), {
      fetch: record,
    })
    await forwardDatabase(upgrade(), { fetch: record, upgradeTimeoutMs: 10 })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(seen[0]).toBeUndefined()
    // The upgrade's signal never fired: its timer went when Neon answered.
    expect(seen[1]?.signal?.aborted).toBe(false)
  })

  it('lets any other failure of an upgrade through', async () => {
    const broken: typeof fetch = async () => {
      throw new TypeError('network down')
    }
    await expect(forwardDatabase(upgrade(), { fetch: broken })).rejects.toThrow('network down')
  })
})
