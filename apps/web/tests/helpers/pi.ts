/**
 * An in-process Pi session object (rocketflare-launch#14) for tests: `PiSessionCore` — the very
 * logic `PiSessionAgent` hosts — over pi-durable's `MemoryStorage`, with pi-ai's faux provider
 * registered as `cloudflare` ("fake Workers AI") and the real `launch-workspace` tools running
 * against a `FakeSandbox`. What `PiHarness` adds on a Durable Object (its SQLite and its wake
 * after an eviction) is the one thing not here.
 *
 * ```ts
 * const pi = await createFakePi({ sandbox: () => sandbox })
 * pi.faux.setResponses([fauxAssistantMessage('Done.')])
 * const ports = { ...fakePorts, piAgent: () => pi.port }
 * ```
 *
 * `port` is the `PiAgentPort` the runtime is handed; `failNextStart(err)` makes its next
 * `startTurn` throw, `failDrains(n)` its next `n` drains (the object restarting under a turn).
 * `hangUntilAborted()` is a faux response that streams nothing until the turn is aborted.
 */
import { type FauxProviderHandle, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { AGENT_RUNTIME_MODELS } from '@launch/shared/launch-agents'
import { SESSION_WORKDIR } from '@/api/services/sessions/claude-stream'
import type { SandboxPort } from '@/api/services/sessions/ports'
import {
  memoryTurnStore,
  PI_BACKGROUND_CONTEXT,
  PI_HARNESS_SETTINGS,
  PI_WORKERS_AI_PROVIDER,
  PiSessionCore,
} from '@/api/services/sessions/runtimes/pi/core'
import type { PiAgentPort } from '@/api/services/sessions/runtimes/pi/protocol'
import {
  createWorkspaceGate,
  launchWorkspaceExtension,
} from '@/api/services/sessions/runtimes/pi/workspace'

export interface FakePi {
  core: PiSessionCore
  /** The port a runtime is handed: the core, with failures to inject. */
  port: PiAgentPort
  faux: FauxProviderHandle
  harness: Harness
  /** Every `startTurn` / `drain` / `abort` call, in order. */
  calls: string[]
  failNextStart(error: Error): void
  failDrains(count: number): void
  close(): Promise<void>
}

export interface FakePiOptions {
  /** The session's container, for the tools. */
  sandbox: () => SandboxPort
  /** The readiness poll's wait (tests: none). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export async function createFakePi(options: FakePiOptions): Promise<FakePi> {
  const faux = fauxProvider({
    provider: PI_WORKERS_AI_PROVIDER,
    models: AGENT_RUNTIME_MODELS.pi.map(id => ({ id })),
  })
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  let core: PiSessionCore | null = null
  const host = {
    sandbox: options.sandbox,
    cwd: () => core?.currentTurn()?.cwd ?? SESSION_WORKDIR,
    sleep: options.sleep ?? (async () => {}),
  }
  const gate = createWorkspaceGate(host)
  registry.install(launchWorkspaceExtension(host, gate))
  const storage = new MemoryStorage()
  const harness = await Harness.open(
    storage,
    { models, registry, settings: { ...PI_HARNESS_SETTINGS, retry: { enabled: false } } },
    PI_BACKGROUND_CONTEXT
  )
  const BG = PI_BACKGROUND_CONTEXT
  core = new PiSessionCore({
    store: memoryTurnStore(),
    onTurnStart: () => gate.reset(),
    driver: {
      harness: async () => harness,
      storage: async () => storage,
      async submit(message, operationId) {
        const root = await harness.root(BG)
        await root.submit({ type: 'input', content: message, requestId: operationId }, BG)
      },
      async abort() {
        await (await harness.root(BG)).abort(BG)
      },
    },
  })
  const calls: string[] = []
  let startFailure: Error | null = null
  let drainFailures = 0
  const live = core
  const port: PiAgentPort = {
    async startTurn(request) {
      calls.push('startTurn')
      if (startFailure) {
        const error = startFailure
        startFailure = null
        throw error
      }
      return live.startTurn(request)
    },
    async drain(operationId, afterSeq) {
      calls.push('drain')
      if (drainFailures > 0) {
        drainFailures -= 1
        throw new Error('Durable Object reset because its code was updated')
      }
      return live.drain(operationId, afterSeq)
    },
    async abort() {
      calls.push('abort')
      return live.abort()
    },
    exportTranscript: () => live.exportTranscript(),
    importTranscript: text => live.importTranscript(text),
  }
  return {
    core: live,
    port,
    faux,
    harness,
    calls,
    failNextStart(error) {
      startFailure = error
    },
    failDrains(count) {
      drainFailures = count
    },
    close: () => harness.close(BG),
  }
}

/** A faux response that streams nothing until the run is aborted, then ends `aborted`. */
export function hangUntilAborted() {
  return (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
    new Promise<ReturnType<typeof fauxAssistantMessage>>(resolve => {
      const done = () => resolve(fauxAssistantMessage('…', { stopReason: 'aborted' }))
      if (options?.signal?.aborted) return done()
      options?.signal?.addEventListener('abort', done, { once: true })
    })
}

/** Make `sandbox` answer the tools' readiness check: the checkout is there. */
export function checkoutReady(sandbox: {
  onExec(match: RegExp, script: { exitCode: number }): unknown
}): void {
  sandbox.onExec(/^test -d '.*\/\.git'$/, { exitCode: 0 })
}
