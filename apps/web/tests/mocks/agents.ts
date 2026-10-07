/**
 * Stub for the three `agents` entries the Pi session object imports (rocketflare-launch#14):
 * `agents/harness/pi`, `agents/lifecycle` and `agents/models/pi-ai`. Tests run under Node, not
 * workerd, and those entries extend `cloudflare:workers` classes Node does not have — so
 * `vitest.config.ts` aliases them here, exactly as it does the Sandbox SDK. Only
 * `runtimes/pi/agent.ts` imports them, and only `src/worker.ts`'s re-export loads that file in a
 * test; a Pi turn under test drives the in-process core instead (`tests/helpers/pi.ts`).
 */

export class PiHarness {
  pi(): Promise<never> {
    return Promise.reject(new Error('agents/harness/pi is stubbed in tests'))
  }
  storage(): Promise<never> {
    return this.pi()
  }
  submit(): Promise<never> {
    return this.pi()
  }
  abort(): Promise<never> {
    return this.pi()
  }
}

export class Lifecycle {
  static install(_host: unknown): Lifecycle {
    return new Lifecycle()
  }
  use(_capability: unknown): this {
    return this
  }
  start(): Promise<void> {
    return Promise.resolve()
  }
}

export type AI = { provider: unknown }

export function createAI(_settings: unknown): AI {
  return { provider: { id: 'cloudflare' } }
}
