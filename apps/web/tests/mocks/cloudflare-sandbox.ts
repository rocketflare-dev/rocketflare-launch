/**
 * Stub for `@cloudflare/sandbox` (Launch P3). `vitest.config.ts` aliases the package here, because
 * the real one extends `@cloudflare/containers`' `Container`, which imports `cloudflare:workers`
 * and speaks to a container runtime Node does not have. Only what the two SDK-importing files use
 * is here: the `Sandbox` base class (with the egress fields and the static `outboundByHost` the
 * `SessionSandbox` class sets), `ContainerProxy` (re-exported from `src/worker.ts`), and
 * `getSandbox(ns, name)` — which, like the real one, is `ns.get(ns.idFromName(name))`, so under
 * `createTestEnv()` it answers the `FakeSandboxNamespace`'s recording stub.
 *
 * Tests do not drive a container through this: they hand the code a `FakeSandbox`
 * (`tests/helpers/fake-sandbox.ts`), which implements the `SandboxPort` every caller sees.
 */
import { DurableObject } from 'cloudflare:workers'

type OutboundHandler = (
  req: Request,
  env: unknown,
  ctx: { containerId: string; className: string }
) => Promise<Response> | Response

export class Sandbox<Env = unknown> extends DurableObject<Env> {
  /** The per-host outbound handlers a subclass assigns (`SessionSandbox.outboundByHost = …`). */
  static outboundByHost: Record<string, OutboundHandler> | undefined
  interceptHttps = false
  enableInternet: boolean | undefined = true
  allowedHosts?: string[]
  defaultPort?: number
}

export class ContainerProxy {
  async fetch(_request: Request): Promise<Response> {
    return new Response('ContainerProxy stub', { status: 501 })
  }
}

export function getSandbox<T>(
  ns: { idFromName(name: string): unknown; get(id: unknown): T },
  id: string
): T {
  return ns.get(ns.idFromName(id))
}
