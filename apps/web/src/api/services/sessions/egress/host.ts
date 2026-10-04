/**
 * The `host` egress mode (`SessionEgressPort`, `ports.ts`) — a session (or sign-in) container on
 * the sandbox host (a session whose `sandbox_host` is `remote`, DEVELOPMENT ONLY). The host Worker
 * cannot reach Launch's database, so its outbound handlers cannot look the session up the way
 * Launch's own proxies do (`egress/registry.ts`). Instead, Launch PUSHES them what they inject —
 * an {@link EgressGrant}, over the host's RPC (`setEgressGrant`), stored on the sandbox's Durable
 * Object on the host, NEVER in the container:
 *
 * - **git** ({@link HostEgress.prepareGit}, before the clone, each turn and each checkpoint's
 *   push): the app's repo, the session's branch, the upstream, and the session's repo-scoped
 *   installation token — the same sealed token the git proxy uses (`sessionGitToken`: reused while
 *   it has more than 10 minutes left, else re-minted and sealed back) — with its expiry, so the
 *   host retries a freshly minted token's 401/404 as the proxy does.
 * - **the model** ({@link HostEgress.turnEnv}, before each turn), by the session's runtime and
 *   credential source — the same credential Launch's own proxy would swap in:
 *
 *   | runtime × source        | grant                                                        |
 *   |-------------------------|--------------------------------------------------------------|
 *   | Claude Code × platform  | `anthropic` — Launch's key (`resolveModelKey`), `api_key`     |
 *   | Claude Code × user      | `anthropic` — the creator's subscription token, `oauth` (`usableClaudeCredential`, the proxy's own rule) |
 *   | Codex × platform        | `openai` — Launch's OpenAI key (`resolveOpenAiKey`)           |
 *   | Codex × user            | `chatgptRefresh` — the token refresh only; revoked again by {@link HostEgress.endTurn} |
 *
 *   It returns NO environment: each runtime's own `turnEnv` already gives the process its
 *   placeholder (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_API_KEY`, or none on a
 *   ChatGPT plan), and an extra `ANTHROPIC_API_KEY` would WIN over a subscription's OAuth token.
 * - **a sign-in** ({@link HostEgress.prepareLogin}, before the login sandbox's CLI starts): the
 *   `login` part, naming the runtime whose sign-in requests the host passes through.
 *
 * So the container holds no Launch credential in either mode, git needs no credential helper, and
 * the host's handlers keep the proxies' rules (`forward-git.ts`, `forward-model.ts`,
 * `forward-openai.ts` — the same functions).
 *
 * **What it still gives up, against the proxies**: the BUDGET is enforced per turn, not per
 * request — checked before a turn, and a turn on Launch's account is KILLED when its running cost
 * (from the CLI's own usage) reaches what is left (`turn-meter.ts`, `turn.ts`), so one response can
 * overshoot by its own size (Codex reports usage only at the end of a turn, so its turn is not cut
 * short at all); a subscription token Anthropic refuses is not marked `needs_login`; a ChatGPT
 * refresh is not resealed the moment it rotates (the lease's read-back after the turn reseals it);
 * and the host records no container time.
 */
import type { AgentRuntimeId } from '@launch/shared/launch-agents'
import { resolveSessionPolicy, sessionBranchName } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { apps, type SessionRow } from '../../../../db/schema'
import { CredentialNeedsLoginError } from '../credentials/errors'
import { getById, openSecret } from '../credentials/store'
import { ModelKeyMissingError, resolveModelKey, resolveOpenAiKey } from '../model-key'
import type { RepoHostPort, SessionEgressPort } from '../ports'
import { CLAUDE_ACCOUNT_LABEL, usableClaudeCredential } from '../runtimes/claude-code/credentials'
import { unwrap } from '../sandbox/remote-sandbox'
import type { EgressGrantUpdate, SandboxHostRpc } from '../sandbox-host/protocol'
import type { SandboxPort } from '../sandbox-port'
import { sessionGitToken, upgradeReadOnlyRepos } from './github'

export { ModelKeyMissingError }

/** The one host call this mode needs. */
export type EgressGrantSink = Pick<SandboxHostRpc, 'setEgressGrant'>

export class HostEgress implements SessionEgressPort {
  readonly mode = 'host' as const

  constructor(
    private readonly db: Database,
    private readonly cfg: AppConfig,
    private readonly repoHost: RepoHostPort,
    private readonly host: EgressGrantSink,
    private readonly now: () => Date = () => new Date()
  ) {}

  private async grant(sandbox: SandboxPort, grant: EgressGrantUpdate): Promise<void> {
    await unwrap(this.host.setEgressGrant(sandbox.name, grant))
  }

  /** The model part for this turn — see the header's table. Throws by name when there is none. */
  private async modelGrant(session: SessionRow): Promise<EgressGrantUpdate> {
    const model = resolveSessionPolicy(session.policy).model
    const user = session.credentialSource === 'user'
    if (session.runtime === 'codex') {
      // `chatgpt.com` is reached directly (ChatGPT blocks the Workers runtime): the host passes
      // only the plan's token refresh on `auth.openai.com`, and only while a turn holds it.
      if (user) return { chatgptRefresh: true }
      const key = await resolveOpenAiKey(this.db, this.cfg)
      if (!key) throw new ModelKeyMissingError('openai')
      return { openai: { key: key.apiKey, model } }
    }
    if (user) {
      // The proxy's own rule: the session's credential, same tenant, the creator's, active, unexpired.
      const row = session.agentCredentialId
        ? await getById(this.db, session.tenantId, session.agentCredentialId)
        : null
      if (!usableClaudeCredential(row, session, this.now())) {
        throw new CredentialNeedsLoginError(CLAUDE_ACCOUNT_LABEL)
      }
      return {
        anthropic: { auth: { kind: 'oauth', value: await openSecret(this.cfg, row) }, model },
      }
    }
    const key = await resolveModelKey(this.db, this.cfg)
    if (!key) throw new ModelKeyMissingError()
    return { anthropic: { auth: { kind: 'api_key', value: key.apiKey }, model } }
  }

  async turnEnv(sandbox: SandboxPort, session: SessionRow): Promise<Record<string, string>> {
    await this.grant(sandbox, await this.modelGrant(session))
    // The runtime's own environment carries the placeholders; nothing to add (see the header).
    return {}
  }

  /** After a turn: a ChatGPT plan's refresh passes only while a turn holds it, as in the proxy. */
  async endTurn(sandbox: SandboxPort, session: SessionRow): Promise<void> {
    if (session.runtime === 'codex' && session.credentialSource === 'user') {
      await this.grant(sandbox, { chatgptRefresh: null })
    }
  }

  /** Before a login sandbox's CLI starts: let exactly that runtime's sign-in through. */
  async prepareLogin(sandbox: SandboxPort, runtime: AgentRuntimeId): Promise<void> {
    await this.grant(sandbox, { login: { runtime } })
  }

  async prepareGit(sandbox: SandboxPort, session: SessionRow): Promise<void> {
    const [app] = await this.db
      .select({ repoOwner: apps.repoOwner, repoName: apps.repoName })
      .from(apps)
      .where(and(eq(apps.tenantId, session.tenantId), eq(apps.id, session.appId)))
      .limit(1)
    if (!app?.repoOwner || !app.repoName) throw new Error("This session's app has no repository")
    const repo = { owner: app.repoOwner, repo: app.repoName }
    const token = await sessionGitToken(this.db, this.cfg, this.repoHost, session, repo, this.now())
    // The host's handler has no other way to authenticate: no token is a failure, not a skip.
    if (!token) throw new Error('Launch could not get a GitHub token for this repository')
    // P6 6c: a kit upgrade session may also fetch the pinned kit, read-only (`forwardGit`).
    const readOnlyRepos = session.kind === 'upgrade' ? await upgradeReadOnlyRepos(this.db) : []
    await this.grant(sandbox, {
      git: {
        ...repo,
        branch: session.branch ?? sessionBranchName(session.shortId),
        upstream: this.repoHost.gitUpstream(repo),
        token: token.token,
        expiresAt: token.expiresAt.getTime(),
        ...(readOnlyRepos.length ? { readOnlyRepos } : {}),
      },
    })
  }
}
