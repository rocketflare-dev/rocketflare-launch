/**
 * The sandbox host's OUTBOUND HANDLERS (`HostedSessionSandbox.outboundByHost`) — the same
 * injection Launch's own `SessionSandbox` does (`egress/github.ts`, `egress/anthropic.ts`), over
 * the {@link EgressGrant} local Launch pushed to the sandbox's Durable Object instead of a lookup
 * in Launch's database, which the host cannot reach (`SESSION_SANDBOX_HOST=remote`, the `host`
 * egress mode, `services/sessions/egress/host.ts`). The container holds no credential: git and
 * Claude Code send their requests bare (Claude Code with the placeholder key), and these handlers,
 * running in the host Worker's `ContainerProxy`, add the token or the key on the way out.
 *
 * - **Who is asking**: `ctx.containerId`, which the platform sets to the Durable Object's own id
 *   (`this.ctx.id.toString()` in `@cloudflare/containers` 0.3.7's `ContainerProxy` props) — never
 *   anything the sandbox sends. The handler resolves the object with `idFromString` and asks it
 *   for its grant over RPC (`getEgressGrant`); the handler runs in the proxy's own invocation, not
 *   inside the object, so the call is an ordinary one.
 * - **git** (`github.com`): `forwardGit` — only the grant's repo, a push only to its branch and
 *   never a delete, the token injected, a fresh token's 401/404 retried.
 * - **the model** (`api.anthropic.com`): `forwardModel` — only the two Messages paths and the
 *   grant's model, the sandbox's placeholder dropped and the real key set. NOT metered and no
 *   budget check here: the turn meters itself from Claude Code's output and is killed at its
 *   budget (`turn-meter.ts`).
 * - **No grant** (never set, or cleared when the sandbox was destroyed or its container stopped):
 *   a 403 in the same words Launch's proxies use for a container that is not a live session.
 *
 * Imports only the two forwarding cores and the protocol — nothing of Launch's database or config.
 */
import {
  type EgressContext,
  forwardGit,
  isFreshToken,
  refuseGit,
} from '../api/services/sessions/egress/forward-git'
import { anthropicError, forwardModel } from '../api/services/sessions/egress/forward-model'
import type { EgressGrant } from '../api/services/sessions/sandbox-host/protocol'

/** The grant of the sandbox whose container sent the request (null: none, or no such object). */
export type GrantLookup = (containerId: string) => Promise<EgressGrant | null>

export interface HostedEgressDeps {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
}

const defaultDeps = (): HostedEgressDeps => ({
  fetch: (input, init) => fetch(input, init),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
})

/** The same words Launch's proxies use for a container that is not a live session. */
const NO_GRANT = 'This sandbox is not a live Launch session'

/** The grant, or null when the lookup fails (an unknown id is nobody, not a 500). */
async function grantFor(lookup: GrantLookup, ctx: EgressContext): Promise<EgressGrant | null> {
  try {
    return await lookup(ctx.containerId)
  } catch {
    return null
  }
}

/** `github.com`: git smart-HTTP to the grant's repo, keyed with the grant's token. */
export async function hostedGitHub(
  req: Request,
  lookup: GrantLookup,
  ctx: EgressContext,
  overrides: Partial<HostedEgressDeps> = {}
): Promise<Response> {
  const deps = { ...defaultDeps(), ...overrides }
  const git = (await grantFor(lookup, ctx))?.git
  if (!git) return refuseGit(403, NO_GRANT)
  return forwardGit(req, {
    repo: { owner: git.owner, repo: git.repo },
    branch: git.branch,
    token: async () => ({ token: git.token, fresh: isFreshToken(git.expiresAt, deps.now()) }),
    upstream: git.upstream,
    fetch: deps.fetch,
    sleep: deps.sleep,
  })
}

/** `api.anthropic.com`: the Messages API with the grant's model, keyed with the grant's key. */
export async function hostedAnthropic(
  req: Request,
  lookup: GrantLookup,
  ctx: EgressContext,
  overrides: Partial<Pick<HostedEgressDeps, 'fetch'>> = {}
): Promise<Response> {
  const model = (await grantFor(lookup, ctx))?.model
  if (!model) return anthropicError(403, 'permission_error', NO_GRANT)
  const doFetch = overrides.fetch ?? ((r: Request) => fetch(r))
  return forwardModel(req, {
    key: model.key,
    model: model.model,
    upstream: { fetch: r => doFetch(r) },
  })
}
