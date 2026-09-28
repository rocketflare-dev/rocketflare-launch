/**
 * The `host` egress mode (`SessionEgressPort`, `ports.ts`) — a session container on the sandbox
 * host (`SESSION_SANDBOX_HOST=remote`, DEVELOPMENT ONLY). The host Worker cannot reach Launch's
 * database, so its outbound handlers cannot look the session up the way Launch's own proxies do
 * (`egress/github.ts`, `egress/anthropic.ts`). Instead, Launch PUSHES them what they inject — an
 * {@link EgressGrant}, over the host's RPC (`setEgressGrant`), stored on the sandbox's Durable
 * Object on the host, NEVER in the container:
 *
 * - **git** ({@link HostEgress.prepareGit}, before the clone, each turn and each checkpoint's
 *   push): the app's repo, the session's branch, the upstream, and the session's repo-scoped
 *   installation token — the same sealed token the git proxy uses (`sessionGitToken`: reused while
 *   it has more than 10 minutes left, else re-minted and sealed back) — with its expiry, so the
 *   host retries a freshly minted token's 401/404 as the proxy does.
 * - **the model** ({@link HostEgress.turnEnv}, before each turn): the key (`resolveModelKey`; none
 *   → {@link ModelKeyMissingError}, the turn fails by name) and the policy's model. The turn's
 *   process gets only the PLACEHOLDER, exactly as in the proxied mode: Claude Code sends it, the
 *   host's handler drops it and sets the key.
 *
 * So the container holds no credential in either mode, git needs no credential helper, and the
 * host's handlers keep the proxies' rules — one repo, a push only to `session/<short>` and never a
 * delete, only the Messages API with the policy's model (`forward-git.ts`, `forward-model.ts`).
 *
 * **What it still gives up, against the proxies**: the BUDGET is enforced per turn, not per
 * request — checked before a turn, and a turn is KILLED when its running cost (from Claude Code's
 * own usage lines) reaches what is left (`turn-meter.ts`, `turn.ts`), so one response can
 * overshoot by its own size; and the host records no container time.
 */
import { resolveSessionPolicy, sessionBranchName } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { apps, type SessionRow } from '../../../../db/schema'
import { MODEL_KEY_PLACEHOLDER, ModelKeyMissingError, resolveModelKey } from '../model-key'
import type { RepoHostPort, SessionEgressPort } from '../ports'
import { unwrap } from '../sandbox/remote-sandbox'
import type { EgressGrant, SandboxHostRpc } from '../sandbox-host/protocol'
import type { SandboxPort } from '../sandbox-port'
import { sessionGitToken } from './github'

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

  private async grant(sandbox: SandboxPort, grant: EgressGrant): Promise<void> {
    await unwrap(this.host.setEgressGrant(sandbox.name, grant))
  }

  async turnEnv(sandbox: SandboxPort, session: SessionRow): Promise<Record<string, string>> {
    const key = await resolveModelKey(this.db, this.cfg)
    if (!key) throw new ModelKeyMissingError()
    const model = resolveSessionPolicy(session.policy).model
    await this.grant(sandbox, { model: { key: key.apiKey, model } })
    // The process holds the placeholder, never the key (the host's handler swaps it).
    return { ANTHROPIC_API_KEY: MODEL_KEY_PLACEHOLDER }
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
    await this.grant(sandbox, {
      git: {
        ...repo,
        branch: session.branch ?? sessionBranchName(session.shortId),
        upstream: this.repoHost.gitUpstream(repo),
        token: token.token,
        expiresAt: token.expiresAt.getTime(),
      },
    })
  }
}
