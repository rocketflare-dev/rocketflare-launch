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

/** Belt and braces over git's own trace redaction: the token never reaches an error message. */
function redactGitToken(text: string, token: string): string {
  return token ? text.split(token).join('<redacted>') : text
}

/** git's `store` format: one URL with the credential in its userinfo. */
export function gitCredentialLine(token: string): string {
  return `https://x-access-token:${encodeURIComponent(token)}@github.com\n`
}

/**
 * Lock the file down and point git at it — for `https://github.com` only, in the SYSTEM config
 * (`/etc/gitconfig`; the sandbox runs as root). Not `--global`: that is `$HOME/.gitconfig`, and the
 * SDK's shells inherit `HOME` from its control server, which on Cloudflare did not match what the
 * clone read (the first remote session's clone found no helper). Then PROVE git sees the helper
 * and the file, or fail with what git sees. The script names the FILE, never the token.
 */
export function gitCredentialSetupScript(path = GIT_CREDENTIALS_PATH): string {
  const helper = `store --file=${path}`
  return [
    'set -e',
    `chmod 600 '${path}'`,
    `git config --system credential.https://github.com.helper '${helper}'`,
    `seen=$(git config --get-urlmatch credential.helper https://github.com/ || true)`,
    `if [ "$seen" != '${helper}' ] || [ ! -s '${path}' ]; then`,
    `  echo "git sees credential.helper='$seen' (HOME=\${HOME:-unset}, uid=$(id -u))" >&2`,
    '  exit 1',
    'fi',
  ].join('\n')
}

/**
 * Prove the credential works the way the clone will use it: the helper must answer a username for
 * github.com, and `git ls-remote` on the repo must succeed. On failure, print the HTTP exchange
 * (`GIT_TRACE_CURL`, which git redacts the `Authorization` header in by default) — never the
 * helper's `password=` line.
 */
export function gitProbeScript(url: string): string {
  const q = `'${url.replace(/'/g, `'\\''`)}'`
  return [
    `if ! printf 'protocol=https\\nhost=github.com\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null | grep -q '^username='; then`,
    `  echo "git credential fill gave no username for github.com (helper: $(git config --get-urlmatch credential.helper https://github.com/ || echo none), file: $(wc -c < '${GIT_CREDENTIALS_PATH}' 2>/dev/null || echo missing) bytes)" >&2`,
    '  exit 1',
    'fi',
    `if ! GIT_TERMINAL_PROMPT=0 GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1 git ls-remote ${q} HEAD >/dev/null 2>/tmp/launch-git-probe; then`,
    `  grep -iE '(=> Send header|<= Recv header): (GET|HTTP/|WWW-Authenticate|Authorization|Proxy|Location|Host)|fatal' /tmp/launch-git-probe | sed -E 's/Basic [A-Za-z0-9+/=]+/Basic <redacted>/' | tail -15 >&2`,
    '  exit 1',
    'fi',
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
    // A container that reaches GitHub itself has no other way in: no token is a failure, not a skip.
    if (!token) throw new Error('Launch could not get a GitHub token for this repository')
    await sandbox.writeFile(GIT_CREDENTIALS_PATH, gitCredentialLine(token.token))
    const setup = await sandbox.exec(gitCredentialSetupScript(), { timeoutMs: 30_000 })
    if (setup.exitCode !== 0) {
      const detail = setup.stderr.trim().split('\n').at(-1) ?? ''
      throw new Error(
        `Could not give git its credential in the sandbox${detail ? `: ${detail}` : ''}`
      )
    }
    const url = `https://github.com/${app.repoOwner}/${app.repoName}.git`
    const probe = await sandbox.exec(gitProbeScript(url), { timeoutMs: 60_000 })
    if (probe.exitCode !== 0) {
      const detail = redactGitToken(probe.stderr.trim(), token.token)
      throw new Error(
        `git cannot reach ${app.repoOwner}/${app.repoName} with its credential:\n${detail}`
      )
    }
  }
}
