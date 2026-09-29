/**
 * The database passthrough (`egress/forward-database.ts`): on real Cloudflare containers an
 * allow-listed host's WebSocket 101 came back with `Upgrade` and `Connection` twice (the origin's
 * and the runtime's), and Node's clients refused it — so the neon driver's pool never connected
 * from a remote sandbox. Both sandbox classes map `*.neon.tech` to a handler that drops the
 * origin's copies. (A 101 `Response` cannot be built under Node, so the header half is tested.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DATABASE_UPGRADE_TIMEOUT_MS,
  forwardDatabase,
  isUpgradeRequest,
  upgradeAnswerHeaders,
  withoutDuplicateUpgradeHeaders,
} from '@/api/services/sessions/egress/forward-database'

afterEach(() => vi.unstubAllGlobals())

describe('the database passthrough', () => {
  it("drops the origin's Upgrade and Connection from a 101 and keeps everything else", () => {
    const upstream = new Headers({
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Accept': 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
      'neon-request-id': 'abc',
    })
    const headers = upgradeAnswerHeaders(upstream)
    expect(headers.get('upgrade')).toBeNull()
    expect(headers.get('connection')).toBeNull()
    expect(headers.get('sec-websocket-accept')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
    expect(headers.get('neon-request-id')).toBe('abc')
    expect(upstream.get('upgrade')).toBe('websocket')
  })

  it('passes an ordinary answer (the /sql HTTP path) through untouched', async () => {
    const answer = new Response('{"error":"x"}', { status: 400, headers: { Connection: 'close' } })
    expect(withoutDuplicateUpgradeHeaders(answer)).toBe(answer)
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
    const request = new Request('https://ep-x.c-5.eu-central-1.aws.neon.tech/v2', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    })
    expect(isUpgradeRequest(request)).toBe(true)
    const answer = await forwardDatabase(request, {
      fetch: hang,
      upgradeTimeoutMs: 20,
      onUpgradeTimeout: (host, ms) => told.push([host, ms]),
    })
    expect(answer.status).toBe(504)
    expect(told).toEqual([['ep-x.c-5.eu-central-1.aws.neon.tech', 20]])
  })

  it('never times a /sql query, and gives an upgrade the default limit', async () => {
    expect(DATABASE_UPGRADE_TIMEOUT_MS).toBe(20_000)
    const seen: (RequestInit | undefined)[] = []
    const record: typeof fetch = async (_req, init) => {
      seen.push(init)
      return new Response('ok')
    }
    const base = 'https://ep-x.c-5.eu-central-1.aws.neon.tech'
    await forwardDatabase(new Request(`${base}/sql`, { method: 'POST' }), { fetch: record })
    await forwardDatabase(new Request(`${base}/v2`, { headers: { Upgrade: 'websocket' } }), {
      fetch: record,
    })
    expect(seen[0]).toBeUndefined()
    expect(seen[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('lets any other failure of an upgrade through', async () => {
    const broken: typeof fetch = async () => {
      throw new TypeError('network down')
    }
    const request = new Request('https://ep-x.c-5.eu-central-1.aws.neon.tech/v2', {
      headers: { Upgrade: 'websocket' },
    })
    await expect(forwardDatabase(request, { fetch: broken })).rejects.toThrow('network down')
  })
})
