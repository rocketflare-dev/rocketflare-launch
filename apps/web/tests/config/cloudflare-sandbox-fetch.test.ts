/**
 * `CloudflareSandbox.fetch` — the preview's way into the container. Plain HTTP goes through
 * `containerFetch`; a WebSocket upgrade (Vite HMR) through `wsConnect`, because `containerFetch`
 * is an RPC and cannot carry a socket (the HMR socket failed on the first real session).
 */
import { describe, expect, it } from 'vitest'
import { CloudflareSandbox } from '@/api/services/sessions/sandbox/cloudflare-sandbox'
import type { AppConfig } from '@/config'
import { FakeSandboxNamespace } from '../mocks/bindings'

function sandboxOver(ns: FakeSandboxNamespace): CloudflareSandbox {
  return new CloudflareSandbox(
    ns as unknown as ConstructorParameters<typeof CloudflareSandbox>[0],
    's-preview',
    { cfg: {} as AppConfig }
  )
}

describe('CloudflareSandbox.fetch', () => {
  it('sends plain HTTP through containerFetch', async () => {
    const ns = new FakeSandboxNamespace()
    ns.respond = () => new Response('ok')
    const res = await sandboxOver(ns).fetch(5173, new Request('https://p.example/'))
    expect(await res.text()).toBe('ok')
    expect(ns.calls.map(c => [c.method, ...c.args])).toEqual([
      ['containerFetch', 'https://p.example/', 5173],
    ])
  })

  it('sends a WebSocket upgrade through wsConnect', async () => {
    const ns = new FakeSandboxNamespace()
    ns.respond = () => new Response('switching')
    const req = new Request('https://p.example/?token=t', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    })
    await sandboxOver(ns).fetch(5173, req)
    expect(ns.calls.map(c => [c.method, ...c.args])).toEqual([
      ['wsConnect', 'https://p.example/?token=t', 5173],
    ])
  })
})
