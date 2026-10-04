/**
 * The sandbox host's OUTBOUND HANDLERS (`HostedSessionSandbox.outboundByHost`) — the same rules
 * Launch's own `SessionSandbox` applies (`egress/registry.ts`), over the {@link EgressGrant} local
 * Launch pushed to the sandbox's Durable Object instead of a lookup in Launch's database, which the
 * host cannot reach (a session on the `remote` sandbox host, the `host` egress mode,
 * `services/sessions/egress/host.ts`). Every rule is the SAME function Launch's handlers call —
 * `forward-git.ts`, `forward-model.ts`, `forward-openai.ts` — so the two cannot drift.
 *
 * - **Who is asking**: `ctx.containerId`, which the platform sets to the Durable Object's own id
 *   (`this.ctx.id.toString()` in `@cloudflare/containers` 0.3.7's `ContainerProxy` props) — never
 *   anything the sandbox sends. The handler resolves the object with `idFromString` and asks it
 *   for its grant over RPC (`getEgressGrant`); the handler runs in the proxy's own invocation, not
 *   inside the object, so the call is an ordinary one.
 * - **git** (`github.com`, the `git` part): `forwardGit` — only the grant's repo, a push only to
 *   its branch and never a delete, the token injected, a fresh token's 401/404 retried.
 * - **Claude Code** (`api.anthropic.com`, the `anthropic` part): `forwardModel` — only the two
 *   Messages paths and the grant's model; Launch's key as `x-api-key`, or a subscription token as
 *   `Authorization: Bearer` with the OAuth beta flag, and then `GET /api/claude_code/*` is a 404.
 * - **Codex on Launch's key** (`api.openai.com`, the `openai` part): `forwardOpenAi` — 426 for a
 *   WebSocket, `POST /v1/responses` (+ `/compact`) on the grant's model and `GET /v1/models`, the
 *   sandbox's placeholder dropped and the key set.
 * - **Codex on a ChatGPT plan** (`auth.openai.com`, the `chatgptRefresh` part, granted for one
 *   turn): `forwardCodexRefresh` — the token refresh only. The plan's model calls go to
 *   `chatgpt.com` DIRECTLY, with no handler here or in Launch: ChatGPT blocks requests from the
 *   Workers runtime (`egress/registry.ts`), and the container holds the plan's `auth.json` anyway.
 * - **A sign-in** (the `login` part): Claude's `POST platform.claude.com/v1/oauth/token` and `GET
 *   api.anthropic.com/api/oauth/profile` (`forwardClaudeSignIn`), or Codex's device flow on
 *   `auth.openai.com` (`forwardCodexSignIn`) — passed through untouched, and nothing else.
 * - **No part for the host** (never granted, or cleared when the sandbox was destroyed or its
 *   container stopped): a 403 in the same words Launch's proxies use.
 *
 * NOT here, because they need Launch's database: per-request metering and the budget (the turn
 * meters itself from the CLI's own output and is killed at its budget, `turn-meter.ts`), marking a
 * refused subscription `needs_login`, and resealing a rotated ChatGPT refresh token the moment it
 * rotates (the turn's lease reads `auth.json` back afterwards and reseals it).
 *
 * Imports only the forwarding cores and the protocol — nothing of Launch's database or config.
 */
import {
  type EgressContext,
  forwardGit,
  isFreshToken,
  refuseGit,
} from '../api/services/sessions/egress/forward-git'
import {
  anthropicError,
  forwardClaudeSignIn,
  forwardModel,
  type UpstreamFetch,
} from '../api/services/sessions/egress/forward-model'
import {
  forwardCodexRefresh,
  forwardCodexSignIn,
  forwardOpenAi,
  openAiError,
  refuseWebSocket,
} from '../api/services/sessions/egress/forward-openai'
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
export const NO_GRANT = 'This sandbox is not a live Launch session'

/** The grant, or null when the lookup fails (an unknown id is nobody, not a 500). */
async function grantFor(lookup: GrantLookup, ctx: EgressContext): Promise<EgressGrant | null> {
  try {
    return await lookup(ctx.containerId)
  } catch {
    return null
  }
}

/** The upstream as the forwarding cores take it. */
function upstreamOf(overrides: Partial<Pick<HostedEgressDeps, 'fetch'>>): UpstreamFetch {
  const doFetch = overrides.fetch ?? ((r: Request) => fetch(r))
  return { fetch: r => doFetch(r) }
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
    ...(git.readOnlyRepos?.length ? { readOnlyRepos: git.readOnlyRepos } : {}),
  })
}

/**
 * `api.anthropic.com`: the Messages API on the grant's model with the grant's credential — or, for
 * a Claude sign-in, the account profile only.
 */
export async function hostedAnthropic(
  req: Request,
  lookup: GrantLookup,
  ctx: EgressContext,
  overrides: Partial<Pick<HostedEgressDeps, 'fetch'>> = {}
): Promise<Response> {
  const grant = await grantFor(lookup, ctx)
  const upstream = upstreamOf(overrides)
  if (grant?.login?.runtime === 'claude_code') {
    return forwardClaudeSignIn(req, 'api.anthropic.com', { upstream })
  }
  const model = grant?.anthropic
  if (!model) return anthropicError(403, 'permission_error', NO_GRANT)
  return forwardModel(req, {
    auth:
      model.auth.kind === 'oauth'
        ? { kind: 'oauth', token: model.auth.value }
        : { kind: 'api_key', key: model.auth.value },
    model: model.model,
    upstream,
  })
}

/** `platform.claude.com`: a Claude sign-in's token exchange, and nothing for anyone else. */
export async function hostedClaudeSignIn(
  req: Request,
  lookup: GrantLookup,
  ctx: EgressContext,
  overrides: Partial<Pick<HostedEgressDeps, 'fetch'>> = {}
): Promise<Response> {
  const grant = await grantFor(lookup, ctx)
  if (grant?.login?.runtime !== 'claude_code') {
    return anthropicError(403, 'permission_error', 'This sandbox is not a Launch sign-in')
  }
  return forwardClaudeSignIn(req, 'platform.claude.com', { upstream: upstreamOf(overrides) })
}

/** `api.openai.com`: Codex on Launch's key — the Responses API on the grant's model. */
export async function hostedOpenAi(
  req: Request,
  lookup: GrantLookup,
  ctx: EgressContext,
  overrides: Partial<Pick<HostedEgressDeps, 'fetch'>> = {}
): Promise<Response> {
  const upgrade = refuseWebSocket(req)
  if (upgrade) return upgrade
  const openai = (await grantFor(lookup, ctx))?.openai
  if (!openai) {
    return openAiError(
      403,
      'permission_error',
      'This Launch session does not use Launch’s OpenAI key'
    )
  }
  return forwardOpenAi(req, {
    key: openai.key,
    model: openai.model,
    upstream: upstreamOf(overrides),
  })
}

/**
 * `auth.openai.com`: a Codex sign-in's device flow, or — a session on a ChatGPT plan, during a
 * turn — its token refresh. Nothing else.
 */
export async function hostedOpenAiAuth(
  req: Request,
  lookup: GrantLookup,
  ctx: EgressContext,
  overrides: Partial<Pick<HostedEgressDeps, 'fetch'>> = {}
): Promise<Response> {
  const upgrade = refuseWebSocket(req)
  if (upgrade) return upgrade
  const grant = await grantFor(lookup, ctx)
  const upstream = upstreamOf(overrides)
  if (grant?.login) {
    if (grant.login.runtime !== 'codex') {
      return openAiError(
        403,
        'permission_error',
        `Launch sign-ins may not call ${new URL(req.url).pathname}`
      )
    }
    return forwardCodexSignIn(req, { upstream })
  }
  if (grant?.chatgptRefresh) return forwardCodexRefresh(req, { upstream })
  return openAiError(403, 'permission_error', NO_GRANT)
}
