/**
 * `PiSessionAgent` (rocketflare-launch#14): the Durable Object a Pi session's agent loop runs in —
 * ONE per session (`idFromName(session.id)`, `PI_SESSION_AGENT`), exported from `src/worker.ts`.
 * The only file that imports `agents` or `cloudflare:workers` for Pi: everything it does is
 * `PiSessionCore` (`core.ts`, tested in Node), and this shell only supplies the three things a
 * Durable Object has and Node does not —
 *
 * - **pi's storage** over the object's SQLite, and **its wake**: `agents`' `PiHarness`, installed
 *   with `Lifecycle` on a plain `DurableObject` (not the `Agent` base class, half the bundle). pi's
 *   scheduler runs in memory; the harness's Lifecycle job keeps the object alive while pi has work
 *   and restarts it after an eviction, when pi resumes its own tasks. Lifecycle installs the
 *   `fetch`/`alarm` handlers (this class defines neither), and every RPC starts it first — native
 *   RPC bypasses `fetch`.
 * - **the model**: Workers AI through the Worker's `AI` binding (`agents/models/pi-ai`'s
 *   `createAI`), every Workers AI id resolvable under provider `cloudflare`.
 * - **the container**: `ports.sandbox(sessionId)` on the session's frozen sandbox host, for the
 *   `launch-workspace` tools (`workspace.ts`).
 *
 * Nothing secret is in it: the binding needs no key, and the container holds none.
 */
import { DurableObject } from 'cloudflare:workers'
import { createModels } from '@earendil-works/pi-ai/models'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { DEFAULT_PI_MODEL } from '@launch/shared/launch-sessions'
import { PiHarness } from 'agents/harness/pi'
import { Lifecycle } from 'agents/lifecycle'
import { type AI, createAI } from 'agents/models/pi-ai'
import { loadConfig } from '../../../../../config'
import type { AppBindings } from '../../../../types'
import { SESSION_WORKDIR } from '../../claude-stream'
import { defaultSessionPorts, type SandboxPort } from '../../ports'
import {
  PI_HARNESS_SETTINGS,
  PI_WORKERS_AI_PROVIDER,
  PiSessionCore,
  type PiTurnRecord,
  type PiTurnStore,
} from './core'
import type { PiAgentPort, PiDrainResult, PiTurnRequest, PiTurnStarted } from './protocol'
import { createWorkspaceGate, launchWorkspaceExtension, type PiWorkspaceHost } from './workspace'

/** The turn record's key in the object's synchronous KV. */
const TURN_KEY = 'launch:pi:turn'

function kvTurnStore(storage: DurableObjectStorage): PiTurnStore {
  return {
    get: () => storage.kv.get<PiTurnRecord>(TURN_KEY) ?? null,
    put: record => storage.kv.put(TURN_KEY, record),
  }
}

export class PiSessionAgent extends DurableObject<AppBindings> implements PiAgentPort {
  #ai: AI | null = null
  readonly #core: PiSessionCore
  readonly #harness: PiHarness
  readonly #lifecycle: Lifecycle<AppBindings>

  constructor(ctx: DurableObjectState, env: AppBindings) {
    super(ctx, env)
    const host: PiWorkspaceHost = {
      sandbox: () => this.#sandbox(),
      cwd: () => this.#core.currentTurn()?.cwd ?? SESSION_WORKDIR,
    }
    const gate = createWorkspaceGate(host)
    const registry = createRegistry()
    this.#harness = new PiHarness({
      harness: ({ storage, context }) => {
        registry.install(launchWorkspaceExtension(host, gate))
        const models = createModels()
        models.setProvider(this.#workersAi().provider)
        return Harness.open(storage, { models, registry, settings: PI_HARNESS_SETTINGS }, context)
      },
      defaults: { model: { provider: PI_WORKERS_AI_PROVIDER, id: DEFAULT_PI_MODEL } },
    })
    this.#lifecycle = Lifecycle.install<AppBindings>(this).use(this.#harness)
    this.#core = new PiSessionCore({
      store: kvTurnStore(ctx.storage),
      onTurnStart: () => gate.reset(),
      driver: {
        harness: () => this.#harness.pi(),
        storage: () => this.#harness.storage(),
        submit: async (message, operationId) => {
          await this.#harness.submit(message, { operationId })
        },
        abort: async () => {
          await this.#harness.abort()
        },
      },
    })
  }

  /** Workers AI as a pi-ai provider — created on first use, so a missing binding fails by name. */
  #workersAi(): AI {
    if (!this.#ai) {
      if (!this.env.AI)
        throw new Error('Pi needs the Workers AI binding (`[ai]`), and it is not bound')
      this.#ai = createAI({ binding: this.env.AI })
    }
    return this.#ai
  }

  /** The session's container, on the host its row froze (the turn record carries both). */
  #sandbox(): SandboxPort {
    const turn = this.#core.currentTurn()
    if (!turn) throw new Error('No Pi turn has started in this session yet')
    return defaultSessionPorts(this.env, loadConfig(this.env), turn.sandboxHost).sandbox(
      turn.sessionId
    )
  }

  async startTurn(request: PiTurnRequest): Promise<PiTurnStarted> {
    await this.#lifecycle.start()
    return this.#core.startTurn(request)
  }

  async drain(operationId: string, afterSeq: number): Promise<PiDrainResult> {
    await this.#lifecycle.start()
    return this.#core.drain(operationId, afterSeq)
  }

  async abort(): Promise<void> {
    await this.#lifecycle.start()
    await this.#core.abort()
  }

  async exportTranscript(): Promise<string | null> {
    await this.#lifecycle.start()
    return this.#core.exportTranscript()
  }

  async importTranscript(text: string): Promise<boolean> {
    await this.#lifecycle.start()
    return this.#core.importTranscript(text)
  }
}
