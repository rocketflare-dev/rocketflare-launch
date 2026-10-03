/**
 * What Codex reads besides its command line (§18.22-B): `$CODEX_HOME` (`/root/.codex`) and the
 * turn process's environment. Written before EVERY turn (`beforeTurnFiles`), so a container that
 * came back empty, or a policy that changed the model, is right on the next turn.
 *
 * - `config.toml` — never ask (`approval_policy = "never"`: nobody could answer in `exec` mode),
 *   no Codex sandbox inside Launch's (`danger-full-access`), credentials in a FILE (the lease's
 *   `auth.json`, never a keyring), no update check, and nothing that phones home or calls a model
 *   the egress would refuse: analytics, feedback and OTEL metrics off (ChatGPT mode otherwise calls
 *   `chatgpt.com/backend-api/codex/analytics-events` and `ab.chatgpt.com`, spike S-B1), memories off
 *   (their extraction calls other models), hosted web search off (it runs at OpenAI, outside the
 *   egress, and bills extra), and request compression off — ChatGPT mode zstd-compresses its
 *   request bodies by default (`enable_request_compression`), and the egress must read the model
 *   out of every body.
 * - `AGENTS.md` — the session system note. Codex reads `$CODEX_HOME/AGENTS.md` first, then the
 *   repository's own (spike S-B1), so the app's AGENTS.md still applies.
 * - `rules/launch.rules` — an execpolicy that forbids `git push` and GitHub CLI writes. A guardrail
 *   only (spike: `forbidden` holds without Codex's sandbox but a determined agent can route around
 *   it); the egress — git credentials only through Launch's proxy, the checkpoint pushes — is the
 *   boundary.
 *
 * The environment is NON-secret: `CODEX_API_KEY` (the variable `codex exec` reads, not
 * `OPENAI_API_KEY`, spike S-B1) is the placeholder the egress swaps for Launch's key — and only on
 * Launch's account. On a person's plan there is no key at all: `CODEX_API_KEY` would WIN over the
 * leased `auth.json`.
 */
import type { SessionCredentialSource } from '@launch/shared/launch-agents'
import { MODEL_KEY_PLACEHOLDER } from '../../model-key'
import { SESSION_HOME } from '../../rocketflare-dev'
import type { RuntimeFile } from '../types'

/** Codex's home in the session image: config, rules, the system note, the rollouts, `auth.json`. */
export const CODEX_HOME = `${SESSION_HOME}/.codex`
export const CODEX_CONFIG_PATH = `${CODEX_HOME}/config.toml`
export const CODEX_AGENTS_PATH = `${CODEX_HOME}/AGENTS.md`
export const CODEX_RULES_PATH = `${CODEX_HOME}/rules/launch.rules`
export const CODEX_AUTH_PATH = `${CODEX_HOME}/auth.json`
/** Where Codex writes a thread's rollout: `sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl`. */
export const CODEX_SESSIONS_DIR = `${CODEX_HOME}/sessions`

/** A TOML basic string: `"…"` with `\` and `"` escaped and control characters dropped. */
function tomlString(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is dropped
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '')
  return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** `$CODEX_HOME/config.toml` for a turn on `model`. */
export function codexConfigToml(model: string): string {
  return [
    '# Written by Launch before every turn (§18.22-B). Edits here are overwritten.',
    `model = ${tomlString(model)}`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'cli_auth_credentials_store = "file"',
    'check_for_update_on_startup = false',
    'web_search = "disabled"',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[feedback]',
    'enabled = false',
    '',
    '[otel]',
    'metrics_exporter = "none"',
    '',
    '[features]',
    'enable_request_compression = false',
    'memories = false',
    '',
  ].join('\n')
}

/**
 * `$CODEX_HOME/rules/launch.rules` — from the spike's `codex-execpolicy-no-push.rules`, verified
 * against Codex 0.160's execpolicy (`prefix_rule`).
 */
export const CODEX_LAUNCH_RULES = `# Written by Launch before every turn (§18.22-B): Launch pushes and owns GitHub, the agent does not.
# A guardrail only — the session's egress is the boundary.
prefix_rule(
    pattern = ["git", "push"],
    decision = "forbidden",
    justification = "Launch pushes for you when you ship; do not run git push.",
    match = [["git", "push"], "git push origin main", "git push --force"],
    not_match = ["git status", "git pull"],
)
prefix_rule(
    pattern = ["git", ["-C", "-c"]],
    decision = "prompt",
    justification = "git with -C/-c is not allowed in Launch sessions.",
    match = ["git -C /workspace push", "git -c a=b push"],
)
prefix_rule(
    pattern = ["gh", ["pr", "repo", "release", "api", "auth"]],
    decision = "forbidden",
    justification = "Launch owns GitHub operations.",
)
`

/** The files a Codex turn needs in `$CODEX_HOME` (the lease adds `auth.json` on a person's plan). */
export function codexBeforeTurnFiles(input: {
  model: string
  systemNote: string | null
}): RuntimeFile[] {
  return [
    { path: CODEX_CONFIG_PATH, content: codexConfigToml(input.model) },
    { path: CODEX_AGENTS_PATH, content: `${input.systemNote?.trim() ?? ''}\n` },
    { path: CODEX_RULES_PATH, content: CODEX_LAUNCH_RULES },
  ]
}

/** The turn process's environment: placeholders only, by construction. */
export function codexTurnEnv(source: SessionCredentialSource): Record<string, string> {
  return {
    CODEX_HOME,
    HOME: SESSION_HOME,
    NO_COLOR: '1',
    ...(source === 'platform' ? { CODEX_API_KEY: MODEL_KEY_PLACEHOLDER } : {}),
  }
}
