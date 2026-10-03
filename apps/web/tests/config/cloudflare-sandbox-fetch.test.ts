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

/** A log stream that sends `frames`, then stays open until cancelled. */
function openStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
    },
  })
}

describe('CloudflareSandbox.streamLogs', () => {
  // A turn's log read failed on its first real run: the signal went into the RPC call.
  it('never hands its AbortSignal to the SDK, and stops reading when it is aborted', async () => {
    const ns = new FakeSandboxNamespace()
    ns.handlers.streamProcessLogs = () =>
      openStream([`data: ${JSON.stringify({ type: 'stdout', data: 'hello' })}\n\n`])
    const abort = new AbortController()
    const seen: unknown[] = []
    for await (const event of sandboxOver(ns).streamLogs('p1', { signal: abort.signal })) {
      seen.push(event)
      abort.abort()
    }
    expect(seen).toEqual([{ type: 'stdout', data: 'hello' }])
    expect(ns.calls.map(c => [c.method, ...c.args])).toEqual([['streamProcessLogs', 'p1']])
  })
})

describe('CloudflareSandbox.readFile', () => {
  // Live: the Claude sign-in's terminal output came back base64, and its token was never found.
  it('decodes what the SDK sends as base64, and passes text through', async () => {
    const screen = '\u001b[2G\u2713 token sk-ant-oat01-abc \u2593\u2593\r\n'
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(screen)))
    const ns = new FakeSandboxNamespace()
    ns.handlers.exists = () => ({ exists: true })
    ns.handlers.readFile = (_name, path) =>
      path === '/b' ? { content: b64, encoding: 'base64', isBinary: true } : { content: 'plain' }
    const sandbox = sandboxOver(ns)
    expect(await sandbox.readFile('/b')).toBe(screen)
    expect(await sandbox.readFile('/t')).toBe('plain')
  })
})
