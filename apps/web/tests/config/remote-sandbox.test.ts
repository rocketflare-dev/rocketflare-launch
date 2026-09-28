/**
 * `RemoteSandbox` (`SESSION_SANDBOX_HOST=remote`) driven END TO END in-process: the adapter talks to
 * the sandbox host Worker's REAL entrypoint (`src/sandbox-host/worker.ts`) through a binding that
 * behaves like RPC — it refuses an `AbortSignal` anywhere in the arguments, as workerd does — and
 * the entrypoint drives a `FakeSandboxNamespace` exactly as Launch's in-process adapter does.
 *
 * What must survive the crossing: every `SandboxPort` call, errors BY NAME (a rollout is still a
 * `SandboxInterruptedError`), the log stream (parsed on Launch's side, the signal never sent), and
 * the preview — plain HTTP through `containerFetch`, the HMR upgrade through `wsConnect`.
 */
import { describe, expect, it } from 'vitest'
import { RemoteSandbox } from '@/api/services/sessions/sandbox/remote-sandbox'
import type { SandboxHostBinding } from '@/api/services/sessions/sandbox-host/protocol'
import { remoteSandboxId } from '@/api/services/sessions/sandbox-host/protocol'
import {
  SandboxBackupUnavailableError,
  SandboxInterruptedError,
  sessionAllowedHosts,
} from '@/api/services/sessions/sandbox-port'
import SandboxHost from '@/sandbox-host/worker'
import { FakeSandboxNamespace } from '../mocks/bindings'

const NAME = '0b7f6a52-3f1c-4a8e-9d0e-5a4b3c2d1e0f'

const carriesSignal = (value: unknown, depth = 0): boolean => {
  if (value instanceof AbortSignal) return true
  if (depth > 3 || !value || typeof value !== 'object') return false
  return Object.values(value).some(v => carriesSignal(v, depth + 1))
}

/** The host's entrypoint behind a binding that, like RPC, cannot carry an AbortSignal. */
function hostOver(ns: FakeSandboxNamespace): SandboxHostBinding {
  const host = new SandboxHost({} as never, { SESSION_SANDBOX: ns as never })
  return new Proxy(host, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (args.some(a => carriesSignal(a))) {
          throw new DOMException('AbortSignal serialization is not enabled.', 'DataCloneError')
        }
        return value.apply(target, args)
      }
    },
  }) as unknown as SandboxHostBinding
}

function sandboxOver(ns = new FakeSandboxNamespace()) {
  return { ns, sandbox: new RemoteSandbox(hostOver(ns), NAME) }
}

const sse = (frames: object[]) => {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(f)}\n\n`))
      controller.close()
    },
  })
}

describe('RemoteSandbox over the sandbox host', () => {
  it('is recorded by name (a laptop cannot compute the host’s Durable Object id)', () => {
    expect(sandboxOver().sandbox.id).toBe(`remote:${NAME}`)
    expect(remoteSandboxId(NAME)).toBe(`remote:${NAME}`)
    expect(sandboxOver().sandbox.backupHosts).toEqual([])
  })

  it('start boots the container, then applies the allow-list, on the named sandbox', async () => {
    const { ns, sandbox } = sandboxOver()
    ns.handlers.exec = () => ({ exitCode: 0, stdout: '', stderr: '' })
    await sandbox.start({ extraAllowedHosts: ['ep-x.us-east-2.aws.neon.tech'] })
    expect(ns.calls.map(c => [c.name, c.method])).toEqual([
      [NAME, 'exec'],
      [NAME, 'setAllowedHosts'],
    ])
    expect(ns.calls[1]?.args[0]).toEqual(sessionAllowedHosts(['ep-x.us-east-2.aws.neon.tech']))
  })

  it('exec, files and processes cross with their results', async () => {
    const { ns, sandbox } = sandboxOver()
    ns.handlers.exec = () => ({ exitCode: 0, stdout: 'hi\n', stderr: '' })
    ns.handlers.startProcess = () => ({ id: 'p-1' })
    ns.handlers.exists = () => ({ exists: true })
    ns.handlers.readFile = () => ({ content: 'boot-1' })
    expect(await sandbox.exec('echo hi', { cwd: '/workspace/app' })).toEqual({
      exitCode: 0,
      stdout: 'hi\n',
      stderr: '',
    })
    expect(await sandbox.startProcess('pnpm dev')).toEqual({ id: 'p-1' })
    expect(await sandbox.readFile('/workspace/.launch/boot-id')).toBe('boot-1')
    await sandbox.writeFile('/workspace/.launch/boot-id', 'boot-2')
    await sandbox.kill('p-1', 'SIGKILL')
    expect(ns.calls.find(c => c.method === 'exec')?.args[0]).toBe("bash -c 'echo hi'")
    expect(ns.calls.find(c => c.method === 'killProcess')?.args).toEqual(['p-1', 'SIGKILL'])
    expect(ns.calls.find(c => c.method === 'writeFile')?.args).toEqual([
      '/workspace/.launch/boot-id',
      'boot-2',
    ])
  })

  it('an interrupted container is still a SandboxInterruptedError on Launch’s side', async () => {
    const { ns, sandbox } = sandboxOver()
    ns.handlers.exec = () => {
      const err = new Error('The container was replaced')
      err.name = 'OperationInterruptedError'
      throw err
    }
    await expect(sandbox.exec('pnpm test')).rejects.toBeInstanceOf(SandboxInterruptedError)
  })

  it('backups are off on the host, and say so by name', async () => {
    const { sandbox } = sandboxOver()
    await expect(sandbox.backup({ dir: '/workspace/app', ttlSeconds: 60 })).rejects.toBeInstanceOf(
      SandboxBackupUnavailableError
    )
  })

  it('streams a process’s logs, parsed here — and the signal never crosses', async () => {
    const { ns, sandbox } = sandboxOver()
    ns.handlers.streamProcessLogs = () =>
      sse([
        { type: 'stdout', data: 'hello ' },
        { type: 'stderr', data: 'warn' },
        { type: 'exit', exitCode: 0 },
      ])
    const abort = new AbortController()
    const seen: unknown[] = []
    for await (const event of sandbox.streamLogs('p-1', { signal: abort.signal })) seen.push(event)
    expect(seen).toEqual([
      { type: 'stdout', data: 'hello ' },
      { type: 'stderr', data: 'warn' },
      { type: 'exit', exitCode: 0 },
    ])
  })

  it('stops reading when the signal aborts', async () => {
    const { ns, sandbox } = sandboxOver()
    const encoder = new TextEncoder()
    ns.handlers.streamProcessLogs = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'stdout', data: 'one' })}\n\n`)
          )
        },
      })
    const abort = new AbortController()
    const seen: unknown[] = []
    for await (const event of sandbox.streamLogs('p-1', { signal: abort.signal })) {
      seen.push(event)
      abort.abort()
    }
    expect(seen).toEqual([{ type: 'stdout', data: 'one' }])
  })
})

describe('the preview through the sandbox host', () => {
  it('plain HTTP goes to containerFetch on the named port, without the routing headers', async () => {
    const { ns, sandbox } = sandboxOver()
    let forwarded: Request | null = null
    ns.respond = (_name, req) => {
      forwarded = req
      return new Response('ok')
    }
    const res = await sandbox.fetch(5173, new Request('https://5173-abc-tok.example/src/main.tsx'))
    expect(await res.text()).toBe('ok')
    expect(ns.calls.map(c => [c.name, c.method, ...c.args])).toEqual([
      [NAME, 'containerFetch', 'https://5173-abc-tok.example/src/main.tsx', 5173],
    ])
    const req = forwarded as Request | null
    expect(req?.headers.get('X-Launch-Sandbox')).toBeNull()
    expect(req?.headers.get('X-Launch-Sandbox-Port')).toBeNull()
  })

  it('the HMR upgrade goes to wsConnect (a service binding’s fetch carries it; RPC could not)', async () => {
    const { ns, sandbox } = sandboxOver()
    ns.respond = () => new Response('switching')
    await sandbox.fetch(
      5173,
      new Request('https://5173-abc-tok.example/?token=t', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      })
    )
    expect(ns.calls.map(c => c.method)).toEqual(['wsConnect'])
  })

  it('refuses the SDK’s own control port and a request that names no sandbox', async () => {
    const ns = new FakeSandboxNamespace()
    const host = hostOver(ns)
    const toPort3000 = new Request('https://x.example/', {
      headers: { 'X-Launch-Sandbox': NAME, 'X-Launch-Sandbox-Port': '3000' },
    })
    expect((await host.fetch(toPort3000)).status).toBe(403)
    expect((await host.fetch(new Request('https://x.example/'))).status).toBe(404)
    const badName = new Request('https://x.example/', {
      headers: { 'X-Launch-Sandbox': '../etc', 'X-Launch-Sandbox-Port': '5173' },
    })
    expect((await host.fetch(badName)).status).toBe(404)
    expect(ns.calls).toEqual([])
  })
})
