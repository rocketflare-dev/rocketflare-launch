/**
 * The `direct` egress mode (`SessionEgressPort`, `ports.ts`) — a session container on the sandbox
 * host (`SESSION_SANDBOX_HOST=remote`, DEVELOPMENT ONLY) calls Anthropic and GitHub itself, because
 * the host Worker cannot reach Launch's database to run the proxies (`egress/anthropic.ts`,
 * `egress/github.ts`). Launch hands the container what the proxies would have injected:
 *
 * - **The model key**, as `ANTHROPIC_API_KEY` in the environment of each `claude -p` process
 *   (`turnEnv` → `turn.ts`): resolved per turn (`resolveModelKey`), never in the image, never on
 *   disk, never in an event (`redactModelKeys` scrubs key shapes from everything a turn writes).
 * - **A repo-scoped installation token** (`RepoHostPort.gitAuth`: `contents: write` on the one
 *   repo, one hour), the same sealed token the git proxy uses (`sessionGitToken`: re-minted under
 *   10 minutes left), written before the clone, each turn and each checkpoint's push to
 *   {@link GIT_CREDENTIALS_PATH} — 0600, outside the checkout, read by git's `store` helper for
 *   `https://github.com` only. Never in the repo, a command line, a log or an event.
 *
 * **What this gives up, against the proxies** (docs/CONCEPTS.md §18, docs/SESSIONS-LOCAL.md):
 *
 * - Code the model runs can READ the key and the token (`env`, `cat`). The allow-list still limits
 *   where they can go (Anthropic, GitHub, npm, the session's Neon endpoint), and both are scrubbed
 *   from the transcript — but a determined prompt can use them within those hosts.
 * - The git proxy's branch rule is gone: the token can push to ANY branch of the app's repo, and
 *   delete one. Launch itself only pushes `session/<short>`, and Claude Code is still denied
 *   `git push` — but protect `main` on GitHub.
 * - The budget is enforced per turn, not per request: checked before a turn, and a turn is KILLED
 *   when its running cost (from Claude Code's own usage lines) reaches what is left
 *   (`turn-meter.ts`), so one response can overshoot by its own size.
 */
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { apps, type SessionRow } from '../../../../db/schema'
import { resolveModelKey } from '../model-key'
import type { RepoHostPort, SessionEgressPort } from '../ports'
import { SESSION_LAUNCH_DIR } from '../rocketflare-dev'
import type { SandboxPort } from '../sandbox-port'
import { sessionGitToken } from './github'

/** Where the container's git credential lives: outside the checkout, never in a backup of it. */
export const GIT_CREDENTIALS_PATH = `${SESSION_LAUNCH_DIR}/git-credentials`

/** No key is configured: the turn cannot start (the same sentence the model proxy answers). */
export class ModelKeyMissingError extends Error {
  constructor() {
    super('Launch has no Anthropic key configured')
    this.name = 'ModelKeyMissingError'
  }
}

/** git's `store` format: one URL with the credential in its userinfo. */
export function gitCredentialLine(token: string): string {
  return `https://x-access-token:${encodeURIComponent(token)}@github.com\n`
}

/**
 * Lock the file down and point git at it — for `https://github.com` only, globally (the clone runs
 * `git init` in an empty directory, and a restored workspace keeps its own `.git/config`). The
 * script names the FILE, never the token.
 */
export function gitCredentialSetupScript(path = GIT_CREDENTIALS_PATH): string {
  return [
    'set -e',
    `chmod 600 '${path}'`,
    `git config --global credential.https://github.com.helper 'store --file=${path}'`,
  ].join('\n')
}

export class DirectEgress implements SessionEgressPort {
  readonly mode = 'direct' as const

  constructor(
    private readonly db: Database,
    private readonly cfg: AppConfig,
    private readonly repoHost: RepoHostPort,
    private readonly now: () => Date = () => new Date()
  ) {}

  async turnEnv(): Promise<Record<string, string>> {
    const key = await resolveModelKey(this.db, this.cfg)
    if (!key) throw new ModelKeyMissingError()
    return { ANTHROPIC_API_KEY: key.apiKey }
  }

  async prepareGit(sandbox: SandboxPort, session: SessionRow): Promise<void> {
    const [app] = await this.db
      .select({ repoOwner: apps.repoOwner, repoName: apps.repoName })
      .from(apps)
      .where(and(eq(apps.tenantId, session.tenantId), eq(apps.id, session.appId)))
      .limit(1)
    if (!app?.repoOwner || !app.repoName) throw new Error("This session's app has no repository")
    const token = await sessionGitToken(
      this.db,
      this.cfg,
      this.repoHost,
      session,
      { owner: app.repoOwner, repo: app.repoName },
      this.now()
    )
    if (!token) return
    await sandbox.writeFile(GIT_CREDENTIALS_PATH, gitCredentialLine(token.token))
    const setup = await sandbox.exec(gitCredentialSetupScript(), { timeoutMs: 30_000 })
    if (setup.exitCode !== 0) throw new Error('Could not give git its credential in the sandbox')
  }
}
