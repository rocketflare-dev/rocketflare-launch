/**
 * The Anthropic key coding sessions spend (Launch P3, plan §1.4) — and the rule that it, and the
 * sandbox's placeholder, never appear anywhere a person or a log can read.
 *
 * - **Source**: the admin credential `anthropic_api_key` (sealed in `admin_credentials`, set in the
 *   setup wizard), falling back to the Worker's `ANTHROPIC_API_KEY` secret (`.dev.vars` locally).
 *   Read per request by the model proxy (`egress/anthropic.ts`), which is the ONLY caller: the key
 *   is swapped into the upstream request and dropped.
 * - **The placeholder**: a sandbox is started with `ANTHROPIC_API_KEY=launch-session-placeholder`
 *   (`claudeTurnEnv`, `claude-stream.ts`), so Claude Code believes it has a key and the handler can
 *   tell the call came through a session. It is not a secret, but a session's transcript is shown
 *   to people and stored for ever, and "no key-shaped string in an event" is the checkable rule —
 *   so {@link redactModelKeys} scrubs both it and anything shaped like a real Anthropic key from
 *   every string the turn writes (a tool that ran `env` would otherwise print the placeholder).
 */
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { getCredential } from '../launch/credentials'

/** What the sandbox holds instead of a key. It must never reach Anthropic, or an event. */
export const MODEL_KEY_PLACEHOLDER = 'launch-session-placeholder'

/** Where the key came from — for a log line or a status, never the key itself. */
export type ModelKeySource = 'credential' | 'env'

export interface ModelKey {
  /** The real key. Put it on ONE upstream request and drop it. */
  apiKey: string
  source: ModelKeySource
}

/** The key sessions spend, or null when neither the credential nor the secret is set. */
export async function resolveModelKey(db: Database, cfg: AppConfig): Promise<ModelKey | null> {
  const stored = await getCredential(db, cfg, 'anthropic_api_key').catch(() => null)
  if (stored?.secret.apiKey) return { apiKey: stored.secret.apiKey, source: 'credential' }
  if (cfg.ANTHROPIC_API_KEY) return { apiKey: cfg.ANTHROPIC_API_KEY, source: 'env' }
  return null
}

/**
 * Anthropic key shapes (`sk-ant-api03-…`, `sk-ant-admin01-…`), the placeholder, and GitHub token
 * shapes (`ghs_…` installation tokens, `ghp_…`, `github_pat_…`) — in the `direct` egress mode
 * (`egress/direct.ts`) the container holds a real key and a real token, and a tool that ran `env`
 * or read the git credential would otherwise print them into the transcript.
 */
const KEY_PATTERN = new RegExp(
  `sk-ant-[A-Za-z0-9_-]{4,}|${MODEL_KEY_PLACEHOLDER}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}`,
  'g'
)

export const REDACTED = '[redacted]'

/** `text` with every key-shaped substring and the placeholder replaced by `[redacted]`. */
export function redactModelKeyText(text: string): string {
  return text.replace(KEY_PATTERN, REDACTED)
}

/**
 * `value` with {@link redactModelKeyText} applied to every string in it, at any depth. Returns a
 * copy; objects keep their keys (a key NAME like `ANTHROPIC_API_KEY` is not a secret).
 */
export function redactModelKeys<T>(value: T): T {
  if (typeof value === 'string') return redactModelKeyText(value) as T
  if (Array.isArray(value)) return value.map(item => redactModelKeys(item)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = redactModelKeys(item)
    return out as T
  }
  return value
}
