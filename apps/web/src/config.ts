/**
 * Application configuration (D3, D4, D9, D25): one zod schema over the Worker `env` object,
 * validated lazily and memoised per isolate by env identity. Called from `fetch` (via
 * `configMiddleware`), `queue` and `scheduled` so all three entry points fail identically.
 *
 * Only vars/secrets live here; bindings (HYPERDRIVE, RATE_LIMIT_KV, ASSETS, ...) stay on
 * `c.env`. Nothing in `src/` reads `process.env` — the validation style is the Node reference app's
 * `src/config.ts`, the source is the env object Cloudflare hands us.
 */
import { GRANT_BACKENDS } from '@launch/shared/launch-grants'
import { sharedPlugins } from '@launch/shared/plugins'
import { z } from 'zod'

/** `wrangler dev` passes `KEY=` lines from .dev.vars as empty strings; treat those as unset. */
const optionalString = z.preprocess(
  value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional()
)

const optionalSecret = (min: number) =>
  z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(min).optional()
  )

/** A blank-or-absent enum var, for the ones whose ABSENCE means something (auto-detect). */
const optionalEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(values as unknown as [T[number], ...T[number][]]).optional()
  )

/** `[vars]` arrive as strings; blank means "use the default", never 0. */
const optionalPositiveInt = (fallback: number) =>
  z.preprocess(
    value =>
      value === undefined || value === null || String(value).trim() === '' ? fallback : value,
    z.coerce.number().int().positive()
  )

/** `[vars]` arrive as strings: `"false"` / `"0"` / `"no"` are false, blank is the default. */
const optionalBoolean = (fallback: boolean) =>
  z.preprocess(value => {
    if (value === undefined || value === null || String(value).trim() === '') return fallback
    if (typeof value === 'boolean') return value
    return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase())
  }, z.boolean())

/**
 * A comma-separated list of lowercase identifiers (feature keys). `csvList` below coerces to email
 * addresses, which is right for `BOOTSTRAP_ADMIN_EMAILS` and wrong for anything else.
 */
const csvKeys = z.preprocess(
  value =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(s => s.trim().toLowerCase())
          .filter(Boolean)
      : (value ?? []),
  z.array(z.string())
)

const csvList = z.preprocess(
  value =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(s => s.trim().toLowerCase())
          .filter(Boolean)
      : (value ?? []),
  z.array(z.string().email())
)

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const

const coreConfigSchema = z.object({
  // ---- [vars] (non-secret, wrangler.toml) -------------------------------------------------
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  /** Public origin; derives OAuth redirect URIs, magic-link URLs, CSRF/CORS allow-lists. */
  APP_URL: z.string().url(),
  APP_NAME: z.string().min(1).default('Launch'),
  /** Overridden at deploy time by CI (`wrangler deploy --var RELEASE_VERSION:<tag>`). */
  RELEASE_VERSION: z.string().min(1).default('dev'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  EMAIL_FROM: z.string().min(1).default('Launch <noreply@example.com>'),
  /** D25: schema is identical in both modes; `single` disables the multi-org surface. */
  TENANCY_MODE: z.enum(['multi', 'single']).default('multi'),
  /** D9: who may create an account. */
  SIGNUP_MODE: z.enum(['open', 'invite_only', 'approval']).default('invite_only'),
  /** D1: `enforce` wraps tenant-scoped work in a transaction with `set_config(..., true)`. */
  TENANT_SCOPE_MODE: z.enum(['off', 'enforce']).default('off'),
  /**
   * D35: `neon` (Neon serverless: HTTP queries, a WebSocket pool for transactions, needs the
   * `DATABASE_URL` secret) or `postgres` (postgres.js via the `HYPERDRIVE` binding, any Postgres).
   * Missing means `postgres`, so a copy that never set it is unchanged. `.dev.vars` overrides the
   * toml locally — the bootstrap writes `postgres` there.
   */
  DATABASE_DRIVER: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(['neon', 'postgres']).default('postgres')
  ),
  /**
   * D32: where the langfuse preset sends spans when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset —
   * `<base>/api/public/otel`.
   */
  LANGFUSE_BASE_URL: z.string().url().default('https://cloud.langfuse.com'),
  /** `deployment.environment.name` on every exported span; defaults to `APP_ENV` (D32). */
  LANGFUSE_TRACING_ENVIRONMENT: optionalString,
  /**
   * D32: the OTLP/HTTP base URL spans are POSTed to (`/v1/traces` is appended). Unset + Langfuse
   * keys → Langfuse Cloud; unset otherwise → no export (the local `ai_spans` store still records).
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional()
  ),
  /** `http/json` (default) or `http/protobuf` (the phoenix preset's default — Phoenix takes nothing else). */
  OTEL_EXPORTER_OTLP_PROTOCOL: optionalEnum(['http/json', 'http/protobuf']),
  /**
   * D32: which backend's auth and headers to fill in. Unset → `langfuse` when both Langfuse keys
   * are set (existing deployments migrate with no new secret), else `generic`.
   */
  OBSERVABILITY_PRESET: optionalEnum(['langfuse', 'phoenix', 'generic']),
  /** D32: `false` strips prompts, completions and tool I/O from the export AND from `ai_spans`. */
  OBSERVABILITY_CAPTURE_CONTENT: optionalBoolean(true),
  /** D32: link-out template, `{traceId}` substituted — e.g. `https://cloud.langfuse.com/project/<id>/traces/{traceId}`. */
  OBSERVABILITY_TRACE_URL: optionalString,
  /** D32: days of `ai_spans` the nightly prune keeps. */
  OBSERVABILITY_SPAN_RETENTION_DAYS: optionalPositiveInt(14),
  /** D17: per-call `max_tokens` when a tenant config sets none; and the tool-loop turn cap. */
  AGENT_MAX_OUTPUT_TOKENS: optionalPositiveInt(16384),
  AGENT_MAX_TURNS: optionalPositiveInt(30),
  /**
   * D18: give the chat box the knowledge tools (`search_knowledge`, `get_document`,
   * `list_documents`), so it answers from the workspace's own material. It costs more tokens per
   * turn and, on Workers AI — which has no tool-call event stream — the reply stops arriving token
   * by token. `false` is the operator's way back to a tool-free chat.
   */
  CHAT_KNOWLEDGE_TOOLS: optionalBoolean(true),
  /**
   * Issue #17: how long a run parked on a human question waits before it expires. Consumed
   * VERBATIM as the `timeout` of `step.waitForEvent`, so it must be a duration string Cloudflare
   * Workflows accepts ("168 hours", "30 minutes", "7 days") — not a number of seconds.
   *
   * Workflows allows 1 second to 365 days here and a `waiting` instance does not count toward
   * concurrency, so parking really is free. The real bound is **instance retention**: 30 days on
   * Workers Paid but only 3 days on Free, and a run parked past retention loses its instance, so
   * `waitForEvent` never fires and only the read-path expiry sweep recovers it. Keep this under
   * 3 days if you are not on Workers Paid.
   */
  AGENT_INTERRUPT_TIMEOUT: z.string().min(1).default('168 hours'),
  /**
   * D17: characters of stored history a chat turn may replay. The real constraint is the model's
   * context window and the tenant picks the model, so this is the knob rather than a message count
   * — 24 000 chars is roughly 6 000 tokens, which leaves room on the 24k-token Workers AI floor.
   * Raise it for a long-context provider. Anything older is trimmed and folded into the thread's
   * rolling summary by the `chat.compact` job.
   */
  CHAT_HISTORY_MAX_CHARS: optionalPositiveInt(24_000),
  /**
   * D30, layer 1: the feature keys this deployment ships AT ALL. Only consulted for a flag whose
   * registry entry sets `environmentGated` — everything else is decided by the rollout state in the
   * database, so an ordinary flag needs no toml edit.
   *
   * Blank means none, which is the FAIL-CLOSED direction and the point: this gate's failure mode is
   * an unreleased surface appearing in production, so an environment that forgets the var stays
   * dark. Note `wrangler dev` reads `[vars]` from `wrangler.toml`, so a key listed only in staging
   * is absent on every developer's laptop unless `.dev.vars` overrides it — which is why
   * `.dev.vars.example` lists the kit's gated keys.
   */
  FEATURES_ENABLED: csvKeys,
  /**
   * Generic OpenID Connect sign-in (`providers/oidc.ts`). Unset → no `oidc` provider, the login
   * page is exactly what it was. Set it to the issuer's `issuer` value VERBATIM (trailing slash
   * included when the issuer has one) — discovery must echo it back or sign-in is refused.
   */
  OIDC_ISSUER: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional()
  ),
  OIDC_CLIENT_ID: optionalString,
  /** Button text on the login page ("Sign in with …" is the UI's, not this). */
  OIDC_LABEL: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(1).default('Single sign-on')
  ),
  /** Space-separated; `openid` is always sent whether listed or not. */
  OIDC_SCOPES: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(1).default('openid email profile')
  ),
  /**
   * `true` → the login page redirects straight to the OIDC issuer and hides the other methods, and
   * `/auth/google|microsoft` refuse to start. Hides, not disables: the magic-link endpoint stays
   * live for invitations. Requires `OIDC_ISSUER` + `OIDC_CLIENT_ID` (a config error otherwise).
   */
  AUTH_OIDC_ONLY: optionalBoolean(false),
  /**
   * Secure default `false`: an OIDC issuer that omits `email_verified` is not trusted for its
   * email (the sign-in is refused as `email_unverified`). `true` treats a MISSING flag as verified
   * — only for an issuer that controls the `email` claim (single-tenant Entra). An explicit
   * `email_verified: false` is refused either way.
   */
  OIDC_TRUST_EMAIL: optionalBoolean(false),

  /**
   * Launch P3 (coding sessions): where a session's repo lives. `cloud` — GitHub (the tomls).
   * `local` — the local git server (`docs/SESSIONS-LOCAL.md`). Either way the database is a real
   * Neon branch of the app's project and the container is the platform's (`wrangler dev`'s own
   * locally). `loadConfig` refuses `local` outside `APP_ENV=development`: it points sessions at a
   * laptop's git.
   */
  SESSION_BACKEND: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(['cloud', 'local']).default('cloud')
  ),
  // Where a session's CONTAINER runs is no longer a var: it is the `session_sandbox_host` platform
  // setting (`services/sessions/sandbox-host.ts`, the Platform → Coding agents tab), development
  // only for `remote` and never with SESSION_BACKEND=local — enforced there, frozen per session.
  /**
   * Launch P3: how a session's CONTAINER reaches the internet. `allowlist` — internet off, the
   * egress allow-list, everything through the egress interception (spec/03). `open` — internet
   * on, no allow-list; only the model and git hosts are intercepted, for their credentials, so the
   * container still holds neither. Missing = `allowlist`. The tomls (and the sandbox host's) say
   * `open` until Cloudflare's interception ends a container's stream after a WebSocket closes
   * (docs/plans/sandbox-websocket-close.md). The Durable Object reads it through
   * `sessionEgressMode(env)`, which follows this default.
   */
  SESSION_EGRESS: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(['allowlist', 'open']).default('allowlist')
  ),
  /**
   * The preview origin template: `{label}` becomes `<port>-<shortId>-<token>`
   * (`https://{label}.clewro.com`; `http://{label}.localhost:3001` locally). Unset, previews are
   * off and `worker.ts` sends nothing to the preview gateway.
   */
  SESSION_PREVIEW_URL: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .regex(
        /^https?:\/\/\{label\}\.[a-z0-9.-]+(:\d+)?$/i,
        'SESSION_PREVIEW_URL is an origin whose host STARTS with {label}, e.g. https://{label}.example.com'
      )
      .optional()
  ),
  /**
   * Launch P5 (shared config and grants, plan §1.11): where a grant's values are pushed.
   * `cloudflare` — the app Worker's secrets (the tomls). `local` — record the names, call no vendor
   * (`.dev.vars`). `loadConfig` refuses `local` outside `APP_ENV=development`: a deployed Launch
   * that "pushed" nothing would leave every app on its missing-config 503.
   */
  GRANT_BACKEND: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(GRANT_BACKENDS).default('cloudflare')
  ),
  /**
   * Launch P3, fast resume: whether a session's workspace (`/workspace/app`, `node_modules` and
   * `.dev.vars` included) is backed up when its container is destroyed, so a cold resume restores
   * it instead of cloning and installing (`services/sessions/steps.ts`, the Sandbox SDK's
   * `createBackup` / `restoreBackup` into the `BACKUP_BUCKET` binding). `off`; `binding` — the
   * archive moves through the Durable Object and the R2 binding (`localBucket`, what `wrangler dev`
   * supports); `presigned` — the container moves it itself over presigned R2 URLs (the SDK's
   * deployed path: needs the `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` secrets, `BACKUP_BUCKET_NAME`
   * and an account id — `docs/DEPLOY.md` § Coding sessions; `loadConfig` refuses it without an
   * account id or endpoint). Unset: `binding` under `APP_ENV=development`, else `off`
   * (`workspaceBackupMode`). This governs THIS Worker's containers: a session on the remote sandbox
   * host is `presigned` whenever the account id or endpoint below is set (and this is not `off`).
   */
  SESSION_WORKSPACE_BACKUP: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(['off', 'binding', 'presigned']).optional()
  ),
  /**
   * `SESSION_WORKSPACE_BACKUP=presigned`: where the container reaches R2 — the allow-list gains
   * this origin's host, else `<account>.r2.cloudflarestorage.com` from the account id below. The
   * SDK reads the same three names from the Worker's environment.
   */
  BACKUP_BUCKET_ENDPOINT: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional()
  ),
  CLOUDFLARE_R2_ACCOUNT_ID: optionalString,
  CLOUDFLARE_ACCOUNT_ID: optionalString,
  /** `SESSION_BACKEND=local`: the git server sessions clone from and push to (`pnpm sessions:local-git`). */
  SESSION_LOCAL_GIT_URL: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional()
  ),

  // ---- Secrets (.dev.vars locally, `wrangler secret put` deployed) — all optional here;
  //      features gate on presence (zero-creds first run) or demand them at use time. -------
  /**
   * The owner connection string. Under `neon` it is THE connection (the pooled Neon URI, a Worker
   * secret); under `postgres` the fallback when there is no HYPERDRIVE binding (local, tests).
   */
  DATABASE_URL: optionalString,
  /** Per-PR Neon branch; when set it wins over HYPERDRIVE and DATABASE_URL (see db/client.ts). */
  PREVIEW_DATABASE_URL: optionalString,
  /**
   * D35, local only: the Neon proxy in front of the compose Postgres (`http://localhost:4444`),
   * written by `pnpm dev:db:up --neon`. Never set in a deployed environment.
   */
  NEON_LOCAL_PROXY: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional()
  ),
  /** AES-GCM key for OAuth tokens at rest (D12). */
  OAUTH_ENCRYPTION_KEY: optionalSecret(32),
  RESEND_API_KEY: optionalString,
  /** Comma-separated emails promoted to global admin on first VERIFIED login (D9). */
  BOOTSTRAP_ADMIN_EMAILS: csvList,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  MICROSOFT_CLIENT_ID: optionalString,
  MICROSOFT_CLIENT_SECRET: optionalString,
  /** Optional: a PUBLIC client (PKCE only) has none. Sent as HTTP Basic (`client_secret_basic`). */
  OIDC_CLIENT_SECRET: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  /**
   * §18.22: the OpenAI key Codex sessions on Launch's account spend, when no `openai_api_key`
   * admin credential is set — swapped in at the egress, never in a sandbox (Stream B).
   */
  OPENAI_API_KEY: optionalString,
  EMBEDDINGS_API_KEY: optionalString,
  LANGFUSE_PUBLIC_KEY: optionalString,
  LANGFUSE_SECRET_KEY: optionalString,
  /** D32: extra OTLP request headers, `k=v,k=v` (values URL-encoded, per the OTel spec). A secret. */
  OTEL_EXPORTER_OTLP_HEADERS: optionalString,
})

/**
 * `[vars]` and secrets contributed by installed plugins (D31), validated with everything else so a
 * plugin with a missing var fails at `loadConfig` rather than at its first request.
 *
 * `AppConfig` stays the CORE type on purpose, and the cast is what holds that line: `extend()` over
 * a `ZodRawShape` collapses the inferred shape to an index signature, which would turn every kit
 * key into `any`. A plugin reads its own keys through its own narrowing helper — one plugin's vars
 * can never widen, or weaken, the type the kit is checked against.
 */
const pluginConfigShape: z.ZodRawShape = Object.assign(
  {},
  ...sharedPlugins.map(p => p.config ?? {})
)
const configSchema = coreConfigSchema.extend(pluginConfigShape).superRefine((cfg, ctx) => {
  // An OIDC-only login page with no issuer would offer no way in at all.
  if (cfg.AUTH_OIDC_ONLY && !(cfg.OIDC_ISSUER && cfg.OIDC_CLIENT_ID)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUTH_OIDC_ONLY'],
      message: 'AUTH_OIDC_ONLY=true needs OIDC_ISSUER and OIDC_CLIENT_ID',
    })
  }
  // Launch IS an OIDC issuer at APP_URL (spec/05); its own OIDC_ISSUER is its UPSTREAM login.
  // Pointing one at the other would send every sign-in round in a circle.
  if (cfg.OIDC_ISSUER && cfg.OIDC_ISSUER.replace(/\/+$/, '') === cfg.APP_URL.replace(/\/+$/, '')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OIDC_ISSUER'],
      message:
        'OIDC_ISSUER must not be APP_URL: Launch is the issuer for its apps, and OIDC_ISSUER is ' +
        "Launch's own upstream sign-in (Google, Microsoft, any other issuer)",
    })
  }
  // Local sessions point at a laptop's Postgres and git server: never in a deployed Worker.
  if (cfg.SESSION_BACKEND === 'local' && cfg.APP_ENV !== 'development') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SESSION_BACKEND'],
      message: 'SESSION_BACKEND=local is only allowed with APP_ENV=development',
    })
  }
  // The local grant backing pushes nothing: never in a deployed Worker.
  if (cfg.GRANT_BACKEND === 'local' && cfg.APP_ENV !== 'development') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['GRANT_BACKEND'],
      message: 'GRANT_BACKEND=local is only allowed with APP_ENV=development',
    })
  }
  // A presigned backup is moved by the CONTAINER, so its allow-list needs the R2 endpoint — which
  // Launch derives from these (`backupEgressHosts`). Without one every backup would be refused.
  if (
    cfg.SESSION_WORKSPACE_BACKUP === 'presigned' &&
    !(cfg.BACKUP_BUCKET_ENDPOINT || cfg.CLOUDFLARE_R2_ACCOUNT_ID || cfg.CLOUDFLARE_ACCOUNT_ID)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SESSION_WORKSPACE_BACKUP'],
      message:
        'SESSION_WORKSPACE_BACKUP=presigned needs CLOUDFLARE_ACCOUNT_ID (or BACKUP_BUCKET_ENDPOINT): ' +
        'the container reaches R2 itself, and the egress allow-list is derived from them',
    })
  }
  // A Neon deployment has no HYPERDRIVE fallback: fail here, not on the first query.
  if (cfg.DATABASE_DRIVER === 'neon' && !(cfg.DATABASE_URL || cfg.PREVIEW_DATABASE_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message: 'DATABASE_DRIVER=neon needs the DATABASE_URL secret (the pooled Neon URI)',
    })
  }
}) as unknown as typeof coreConfigSchema

export type AppConfig = z.infer<typeof coreConfigSchema>
export type AppEnvName = AppConfig['APP_ENV']
export type OAuthProviderName = 'google' | 'microsoft' | 'oidc'

/** Thrown by `loadConfig`; the message lists every missing/invalid key. */
export class ConfigError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    const details = issues.map(issue => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n')
    super(`Invalid environment configuration:\n${details}`)
    this.name = 'ConfigError'
  }
}

/**
 * Memo keyed on the env OBJECT, not its contents: in production `env` is one object for the
 * life of the isolate, so this parses once; in `wrangler dev` a .dev.vars edit yields a new
 * object and re-validates. Failures are not cached so every caller sees the same error.
 */
const cache = new WeakMap<object, AppConfig>()

export function loadConfig(env: unknown): AppConfig {
  const key = typeof env === 'object' && env !== null ? env : undefined
  if (key) {
    const hit = cache.get(key)
    if (hit) return hit
  }
  const result = configSchema.safeParse(env ?? {})
  if (!result.success) throw new ConfigError(result.error.issues)
  if (key) cache.set(key, result.data)
  return result.data
}

// ---- Derived helpers ---------------------------------------------------------------------

export const isProduction = (cfg: AppConfig): boolean => cfg.APP_ENV === 'production'
export const isDevelopment = (cfg: AppConfig): boolean => cfg.APP_ENV === 'development'

/** `{APP_URL}/auth/{provider}/callback` — never configured per provider (D11). */
export function oauthRedirectUri(cfg: AppConfig, provider: OAuthProviderName): string {
  return new URL(`/auth/${provider}/callback`, cfg.APP_URL).toString()
}

/** Without a Resend key, magic links are logged instead of sent (zero-creds first run). */
export const hasEmail = (cfg: AppConfig): boolean => Boolean(cfg.RESEND_API_KEY)

/** Providers whose client id AND secret are both present — the login page shows only these. */
export function configuredOAuthProviders(cfg: AppConfig): OAuthProviderName[] {
  const providers: OAuthProviderName[] = []
  if (cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET) providers.push('google')
  if (cfg.MICROSOFT_CLIENT_ID && cfg.MICROSOFT_CLIENT_SECRET) providers.push('microsoft')
  if (hasOidc(cfg)) providers.push('oidc')
  return providers
}

/** An OIDC issuer is configured — issuer + client id (the secret is optional: public clients). */
export const hasOidc = (cfg: AppConfig): boolean => Boolean(cfg.OIDC_ISSUER && cfg.OIDC_CLIENT_ID)

/** `AUTH_OIDC_ONLY` in force (loadConfig has already refused it without an issuer). */
export const isOidcOnly = (cfg: AppConfig): boolean => cfg.AUTH_OIDC_ONLY && hasOidc(cfg)
