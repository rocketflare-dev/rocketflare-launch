# CONCEPTS — what is built, and why

One section per subsystem: what it does, the invariant it protects, the decision behind it
(D-numbers), and its **Known gaps**. Check here before assuming a capability exists; update it when
you change one. **Keep it short** — a section states the rule and points at where the detail lives.
Conventions and mechanics belong in `.claude/rules/*.md` and the per-directory `CLAUDE.md` files;
setup in `SETUP.md`; Cloudflare topology in `docs/DEPLOY.md`; RLS in `docs/RLS.md`.

| § | Section | § | Section |
|---|---|---|---|
| 1 | [Tenancy](#1-tenancy) | 9 | [AI layer](#9-ai-layer) |
| 2 | [Auth](#2-auth) | 10 | [Deployment](#10-deployment) |
| 3 | [API shell](#3-api-shell) | 11 | [CLI](#11-cli) |
| 4 | [Database](#4-database) | 12 | [Shared package](#12-shared-package) |
| 5 | [Background work and realtime](#5-background-work-and-realtime) | 13 | [Upgrading a copy](#13-upgrading-a-copy) |
| 6 | [Email and storage](#6-email-and-storage) | 14 | [Definition of done](#14-definition-of-done-for-the-kit) |
| 7 | [UI shell](#7-ui-shell) | 15 | [Feature flags](#15-feature-flags) |
| 8 | [Analytics](#8-analytics) | 16 | [Plugins](#16-plugins) |
| 18 | [Launch control plane](#18-launch-control-plane) | 17 | [Connectors](#17-connectors) |

**Layout (D26).** A pnpm workspace: `apps/web` (the Worker — Hono API + React UI, §§1–10),
`apps/cli` (§11), `packages/shared` (zod contracts, §12), and `apps/evals` (developer-run eval
suites on vitest 4, §9 — never part of the gate).

---

## 1. Tenancy

**Every row of domain data belongs to a tenant, and the schema is the same for one tenant or many.**

- **`TENANCY_MODE = multi | single` (D25)** is configuration, not a fork. `multi`: users join many
  tenants via `tenant_users`, the session carries the current one. `single`: one tenant, every
  admitted user auto-joins as `member` (a `BOOTSTRAP_ADMIN_EMAILS` address as `owner` — below);
  multi-only surface is 404 `tenancy_mode_single`
  (`requireMultiTenant`) and hidden via `useTenancyMode()`. Switching to `multi` needs no migration.
  Launch deploys `single` (both tomls, and `.dev.vars.example` for the seed); the test suite runs
  `multi`, because the kit's tests exercise the multi-tenant paths.
- **`SIGNUP_MODE = open | invite_only | approval` (D9)**, default `invite_only`. Uninvited logins
  land on `/pending`; `approval` also files an `access_requests` row at *verify* time;
  `open` gives a personal tenant through `onNoTenant`. Invitations are handled first on every login
  path, and every fallback gates on "has no memberships", not "is new".
- **Roles (D10).** `owner | admin | member` plus `support` (minted from `/admin`, visible to the
  customer); `users.isGlobalAdmin` is a platform flag. Default for a new subject: owner/admin/support
  `manage`, member `read` with route-scoped writes. "Own row" is always a route predicate — **CASL
  conditions are used nowhere**. Deleting a tenant and changing `owner` need an explicit
  `role === 'owner'` check. The matrix lives in `apps/web/src/permissions/` (+ its `CLAUDE.md`).
- **One admin in single mode: `canAdministerPlatform`.** Two surfaces administer more than one
  organisation's data. **`/api/platform/*` + `/settings/platform/*`** is the DEPLOYMENT: the setup
  wizard (credentials, apps domain, public URL, template pin — every `launch_settings` /
  `admin_credentials` write), the OIDC issuer's signing keys and the access-request queue. Its gate
  is `canAdministerPlatform(auth, config)` (`@launch/shared/permissions`, wrapped by
  `apps/web/src/permissions/platform.ts`, enforced by `platformAdminMiddleware`, mirrored by the
  UI's `platformAdmin` nav guard): a global admin, or **in `single` mode the one organisation's
  `owner` or `admin`** — there the organisation IS the company running Launch, so its admins own
  the platform too. In `multi` mode it is `isGlobalAdmin` alone, exactly as before: one tenant's
  admin never holds credentials every tenant depends on. Those tables stay deployment-wide (no
  `tenant_id`); an action is audited in the admin's organisation with them as the actor.
  **`/admin` + `/api/admin/*`** behind `globalAdminMiddleware` stays the operator's cross-tenant
  surface in every mode — organisations (list, suspend, enter as `support`, which creates a real
  membership), users (the global flag, blocking), feature flags and live coding sessions — and its
  nav entry shows only to global admins. Both are cookie-only (a tenant API key never passes), and a
  global admin with no membership reaches both, so there is always someone to approve the first
  request and finish Setup. A single-mode reviewer who is not a global admin approves only into
  their own organisation, and grants `owner` only as an owner. The first admin (a
  `BOOTSTRAP_ADMIN_EMAILS` address on a verified login, and the seed's platform admin) is the
  organisation's **owner** in single mode (`admitBootstrapAdmin`: created as it, joined as it, or
  promoted to it), so Setup is theirs on the tenant role, not only the global flag.
- **Deleting a tenant has two halves.** The `tenantRef()` FK cascade removes everything in
  Postgres; the **`tenant.purge`** job (§5) removes the R2 prefix and runs each plugin's
  `onTenantDeleted`. The queue binding is checked *before* the `DELETE`.
- **Groups and visibility (D29).** Tenants declare group types → groups → members;
  `AuthContext.groups` is resolved with the membership (a Bearer key uses its **creator's** groups, looked up on
  every request). A restrictable resource has an explicit `visibility` column (`tenant | groups`)
  plus a junction table. **The column decides and the rows only grant**, so an empty grant list
  means "owner and admins only". It never falls back to "public". The predicate is SQL in
  `services/access.ts` (`accessScopeOf` → `visibleDocuments` / plugin predicates), **ANDed with the
  tenant predicate, never substituted for it**. Admin-level roles bypass it. Groups grant READ only.
  Deleting a group that still grants something is 409 `group_in_use` (`?force=1` narrows).
  `access.changed` nudges the affected users.
- **Isolation = predicates + inert RLS (D1)** — §4, `docs/RLS.md`.

**Known gaps:** in single mode the users list, blocking a user and feature flags stay on `/admin`
(global admins only) — a single-company admin removes people from Settings → People instead;
dev-login does not apply `BOOTSTRAP_ADMIN_EMAILS` (the seed makes its admin an owner instead);
no IdP group sync (SCIM/SAML claims); no group hierarchy or per-group roles;
conversations, runs, prompts and non-Knowledge files have no visibility; agent-written documents
are always `tenant`; no audit log beyond `activity_events`; no personal API keys (tenant keys only).

## 2. Auth

- **Sessions are rows**: `user_sessions`, 30-day sliding TTL (`SESSION_TTL_MS`), cookie `__Host-session` (`HttpOnly`,
  `SameSite=Lax`, `Secure` outside development). `authMiddleware` resolves session → user →
  membership → groups → features in one query. The second strategy is a Bearer tenant API key
  (hashed, expiry, soft revoke).
- **Magic link** is the zero-credential path: a 256-bit, 15-minute, single-use, SHA-256-hashed
  token. With no `RESEND_API_KEY` the URL is logged. Dev-login exists and 404s in production.
- **OAuth is a registry** (D11): one generic `/auth/:provider` router over `ProviderDefinition`s
  (Google, Microsoft via arctic). Redirect URIs come from `APP_URL`, accounts link by verified email,
  and tokens are AES-GCM encrypted under `OAUTH_ENCRYPTION_KEY`. The return path is `?returnUrl=`
  (`?redirectTo=` still accepted); the flow cookie carries state, PKCE verifier and a nonce.
- **Any OIDC issuer** (`providers/oidc.ts`): set `OIDC_ISSUER` + `OIDC_CLIENT_ID` (+ optional
  `OIDC_CLIENT_SECRET`) and an `oidc` provider appears, labelled `OIDC_LABEL`. Endpoints come from
  discovery (cached per isolate, refused unless its `issuer` matches exactly); code + PKCE S256 +
  `nonce`; the `id_token` is verified with jose against the issuer's JWKS (`iss`, `aud`, `exp`,
  `nonce`; an unknown `kid` refetches the set — rotation). The identity key is `${iss}|${sub}` in
  `oauth_providers.provider_user_id`, so no migration; a changed issuer falls back to
  verified-email linking. The issuer must assert `email_verified: true`: a missing flag is
  unverified (refused as `email_unverified` — no email linking, no admission) unless
  `OIDC_TRUST_EMAIL=true` opts in an issuer that controls the claim (single-tenant Entra); an
  explicit `false` is always refused. `AUTH_OIDC_ONLY=true` sends the login page straight to the issuer and
  refuses `/auth/google|microsoft` — it **hides** magic link, it does not disable it (invitations
  still use it). With an `end_session_endpoint`, `POST /auth/logout` answers
  `200 { endSessionUrl }` (RP-initiated logout back to `/login?signedOut=1`, which never
  auto-redirects); otherwise 204. Setup: `SETUP.md` → "Sign in with any OIDC issuer".
- **Hardening (D12)**: random tokens hashed with SHA-256, a required encryption key, CSRF by origin
  allow-list (Bearer is exempt), and a KV sliding-window rate limit on login routes that no-ops
  without `RATE_LIMIT_KV`.
- **Bootstrap admin (D9)**: an address in `BOOTSTRAP_ADMIN_EMAILS` becomes a global admin on its
  first VERIFIED login (magic link, OAuth, OIDC — `admitUser`). In single mode it is also made the
  organisation's `owner` (`admitBootstrapAdmin`: the tenant is created with them as owner when
  there is none, otherwise they join as, or are promoted to, owner — idempotent), because there the
  owner/admin IS the platform admin (§1). In multi mode it only gets what any member-less user
  gets. Dev-login bypasses `admitUser`, so it grants neither.
- **CLI handoff (D26)**: `GET /auth/cli?redirect_uri=http://127.0.0.1:<port>/callback` only allows
  loopback redirects. It mints a revocable tenant key `cli:<hostname>` and 302s back with it.
  Details: `.claude/rules/api.md`.

**Known gaps:** no provider token refresh; the rate limit is approximate; no session management UI
beyond "log out everywhere"; CLI keys differ from other keys only by name. OIDC: one issuer per
deployment; the `groups` claim is read into the profile but **not stored or mapped** to kit groups
or roles; no `id_token_hint` on logout (id_tokens are not kept, so the issuer may ask to confirm);
no back-channel or front-channel logout; `OIDC_TRUST_EMAIL=true` trusts every email the issuer
sends (no per-domain rule) — set it only for an issuer that controls the `email` claim; the client secret
is sent as `client_secret_basic` only (no `private_key_jwt`).

## 3. API shell

- **One Worker, one app** (D5): `src/worker.ts` exports `{ fetch, queue, scheduled }` plus the
  DO/Workflow classes; `api/index.ts` exports `app` so tests call `app.request(req, env, ctx)`.
- **Config (D3/D4)**: `loadConfig(env)` validates `Cloudflare.Env` with zod once per isolate.
  Routes read `c.get('config')`. `APP_ENV` replaces `NODE_ENV`, and `process.env` is banned in `src/`.
- **Middleware order is deliberate** (error envelope → logger → config → security headers → body
  limit → CORS → CSRF → DB → tracing → mounts). Auth is per mount. The ASSETS catch-all 404s every
  API prefix, so a missing route never returns `index.html`. Order and exceptions:
  `.claude/rules/api.md`.
- **Contracts (D13)**: zod schemas from `@launch/shared` are used by the server, UI and CLI.
  There is no `hono/client` RPC. Errors are `{ error, statusCode, code?, details? }` everywhere,
  and success bodies are bare.
- **Routes are thin** and never run long work (§5).
- **Local dev ports**: Vite :3000 proxies to `wrangler dev` :3001, both `strictPort`, unless
  `DEV_UI_PORT` / `DEV_API_PORT` are set (shell, then `.dev.vars`; `scripts/lib/dev-ports.mjs` is the
  one reader). `APP_URL` follows the UI port by hand — the Worker cannot read the shell — and
  outside production CORS/CSRF also allow the loopback twin of `APP_URL` and of the request's own
  loopback origin. `SETUP.md` 1.6.

**Known gaps:** `pnpm dev:tunnel` always targets :3000 (cfld reads `package.json`); `pnpm dev:api`
alone reads `DEV_API_PORT` from the shell only, not `.dev.vars`; no `/api/ready` smoke step against a preview; no OpenAPI (`@hono/zod-openapi` is the
path); no per-PR previews.

## 4. Database

- **Two drivers, one client per request (D35, replacing D2's "postgres.js only")**:
  `DATABASE_DRIVER` picks Drizzle over the Neon serverless driver (`neon`: neon-http per query, a
  WebSocket `Pool` opened for `db.transaction`) or over `postgres.js` (`postgres`, through
  Hyperdrive — any Postgres). A missing var means `postgres`; the kit's tomls say `neon`;
  `.dev.vars` says `postgres`, so local work and the gate never need the deployed driver.
  `openDatabase(env)` (`db/client.ts`) is the one resolver — URL `PREVIEW_DATABASE_URL ??
  DATABASE_URL` under `neon`, `?? HYPERDRIVE.connectionString ??` in between under `postgres` — and
  the client is built per request / consumer message / step / cron run and closed in `waitUntil` or
  `finally`. No LISTEN/NOTIFY, advisory lock or PREPARE on the request path under either.
  Why two: Hyperdrive caps an account at 25 configs (a fleet of apps cannot each have one) and
  sandboxes have no TCP out, but Hyperdrive is also how a copy reaches a Postgres that is not Neon.
  Detail and the switch: `docs/DEPLOY.md` § Database driver, `docs/NEON-DRIVER.md`.
- **Code never sees the driver.** `Database` is drizzle's `PgDatabase` base, so a raw
  `db.execute()` is `unknown`: its rows are read with `rows()` and an unreturned write's count with
  `affected()`, because postgres.js returns an array with `.count` and Neon `{ rows, rowCount }`.
  `tests/config/driver-results.test.ts` fails a cast, an index or a `.rows`/`.count` read on a raw
  result, and a driver import, anywhere in `src/` (installed plugins included). Raw SQL returning a
  list uses `json_agg` / `to_jsonb` — postgres.js leaves a raw array as `"{a,b}"`.
- **Tested both ways.** The gate runs `postgres`; the `driver` vitest project (the code that
  differs) runs there too, and CI's `test-neon` job runs it plus the whole api suite under `neon`
  through a local Neon proxy (`pnpm test:neon`, ~30 s). Locally `pnpm dev:db:up --neon` runs the
  deployed driver on the local database.
- **Conventions**: one file per table, `tenantRef()` + `timestamps()` (`timestamptz`), append-only
  enums, `vector(1024)` (a new dimension means a new table). `migrate.ts` creates the `vector`
  extension first. Detail: `.claude/rules/database.md`.
- **Local port is chosen** (`scripts/dev-db.mjs`): each checkout gets its own compose project and
  port, written back to `DATABASE_URL`, so two copies never share a database. The test database's
  compose project is pinned too (`name: launch-test`), so another Rocketflare-derived checkout's
  `test:db:up` cannot recreate Launch's test container.
- **Or an existing database** (`pnpm bootstrap --db-url <url>`): for a machine with no Docker (a
  coding sandbox on a Neon branch). The URL goes into `DATABASE_URL` and nothing is started; a
  `*.neon.tech` URL also sets `DATABASE_DRIVER=neon` there (HTTPS + WebSocket only, which is what a
  sandbox allows; `--driver` overrides). An
  off-box `DATABASE_URL` (not loopback) is left alone by `dev-db.mjs` and skips preflight's Docker
  checks. The seed runs there with `SEED_ALLOW_REMOTE=1`.
- **Migrations**: `db:generate` → read the SQL → `db:migrate` (role → migrations → grants).
  Migrations are forward-only.
- **Cross-tenant allow-list**: `tests/config/unscoped-allowlist.test.ts` fails a function that
  queries a `tenant_id` table without naming a tenant. Each exception carries a reason. It does
  not prove `admin.ts` is the only cross-tenant surface.
- **RLS** ships inert: every tenant table has `tenantIsolation()` (enforced by `rls-coverage`),
  and `TENANT_SCOPE_MODE=enforce` waits on the spike in `docs/RLS.md`.

**Known gaps:** the RLS spike has not been run; no read replicas; the local Neon proxy is a
community image, mirrored to `ghcr.io/rocketflare-dev` and rebuilt with our start script (pinned by digest) — Neon's official "Neon Local"
needs a cloud account; `neon` in deployment has no read cache and pays a round trip per query
(p95 is measured per app when it switches, not gated); `test-neon` installs no plugins, so a
plugin's own tests run under `neon` only in a local `pnpm test:neon`; the TEST database is pinned to
5499 (off the kit's 5433, so a kit checkout's tests can run alongside), so two Launch checkouts
cannot run `pnpm test` at once. `--db-url` with a loopback URL (a native
Postgres) still looks like this checkout's Docker database to preflight and `dev:db:*`, and a
re-run of the bootstrap without the flag checks for Docker again.

## 5. Background work and realtime

**A route never runs long work (D7).** Anything under 30 s total goes to `JOBS_QUEUE`, multi-step
work goes to `AGENT_RUN_WORKFLOW`, and cron only dispatches.

- **Jobs**: one queue, envelope `{ id, type, payload, enqueuedAt }`, variants are DATA
  (`CORE_JOB_VARIANTS` + plugin `jobs`). A mapped handler table proves completeness, so there is no
  switch. `type` is the version seam (`x.v2`). An invalid envelope is acked; a handler error retries
  with backoff up to `max_retries`. A missing binding throws. Consumers await everything and never
  use `waitUntil`. Queued today: `tenant.purge`, invitation and access-decision emails,
  `document.index`/`document.convert`, `chat.compact`. The magic link stays inline.
  Detail: `.claude/rules/api.md`.
- **Workflow**: `AgentRunWorkflow` (§9). **Concurrency is a DB claim row, never a `Map`**:
  `ACTIVE_RUN_STATUSES` (exclusive index, includes parked runs) ⊃ `CLAIMABLE_RUN_STATUSES`
  (the claim). Keep those two lists separate. A lost instance is settled on read, and there is no
  sweeper cron.
- **Cron**: `scheduled.ts` looks up the task by expression. `0 4 * * *` prunes; plugins add their
  own tasks, and each expression must appear in both tomls.
- **Realtime (D8)**: `NotificationsHub` DO, one per tenant, stateless, using the hibernation API
  with RPC publish. `GET /ws` resolves the cookie itself. **"DB is the truth, WebSocket is a
  nudge"**: events carry ids, and the UI invalidates the query-key roots from
  `REALTIME_INVALIDATIONS`. The `entity` of `entity.changed` IS the query-key root. All nudges go
  through `services/realtime.ts` inside `defer`, after commit.

**Known gaps:** `/api/admin` paths do not nudge; `notification.read` is never emitted;
`activity.record` has no producer; the DO 101 upgrade is untestable under Node; no dead-letter
queue; no vitest-pool-workers smoke project.

## 6. Email and storage

- **Email**: Resend over `fetch`, `sendEmail(...)`, neutral templates. With no key, messages are
  logged (`[email:dev]`), never errors. The magic link is sent inline; other email is `email.send`
  jobs.
- **Storage (D23)**: the `StorageService` seam over the `FILES` R2 binding. Keys are
  `tenants/<tenantId>/<scope>/<uuid>-<name>`. Bytes stream through the Worker (no presigned
  URLs). The `files` table is the immutable index and the only thing the browser can name. Writes
  go object first, then row, and a failed insert deletes the object.
- **`/api/files`**: upload with per-scope type/size checks (413/415); tenant-scoped read (another
  tenant's file is 404) with ETag/304; **only allowlisted types render inline, everything else is
  an attachment**. Uploaders can delete their own files, admins any. A document-owned file is 409
  `owned_by_document`.
- **Framing is opt-in per response**: only a route that proved the type (`isEmbeddableMimeType`, PDF)
  sets `embeddable`, which relaxes `DENY` to `SAMEORIGIN` for that one response. It is set before
  the 304 early return. Never use a path allowlist for this.
- A missing `FILES` binding is 503 `storage_not_configured`. `tenant.purge` pages through the
  tenant prefix and is idempotent.

**Known gaps:** `avatarUrl` is global but the object is tenant-scoped (initials fallback elsewhere);
re-uploads leave the old object; no listing endpoint, quotas or presigned URLs; unbranded templates.

## 7. UI shell

- **Design tokens (D20)**: two DaisyUI themes in `ui/index.css`, where the brand hexes are the only
  hex values; `contrast.test.ts` gates them. Tailwind scanning is `source(none)` + explicit
  `@source` lines. A plugin's pages get the `../plugins/**/ui/**` line, and precompiled dependency
  CSS gets none.
- **Providers**: ErrorBoundary → QueryClient → Auth → Ability → WebSocket → Router. A global 401
  clears the cache and redirects to `/login?returnUrl=`.
- **Guards**: one `RequireGuard` primitive; nav items use the same guard as their page.
  `/login?as=` dev sign-in only works when the server reports `devLogin` and the email is a seeded
  account.
- **Data**: `api-client.ts` parses with shared schemas, there is one hook file per resource, and
  keys come from `queryKeys`. zustand holds only websocket state. Detail: `.claude/rules/ui.md`,
  `apps/web/src/ui/CLAUDE.md`.

**Known gaps:** no route preloading; no "system" theme or cross-tab sync; the dev quick-login list
is hard-coded.

## 8. Analytics

**The `analytics` PLUGIN (D31, since 0.6.0), committed with Launch.** Repository
`rocketflare-dev/rocketflare-plugins`, subdirectory `plugins/analytics`, at 3.4.1. Once installed, its docs are its own `CLAUDE.md`
files. drizzle-cube cubes scope every `sql()` by tenant, dashboards are jsonb `DashboardConfig`s
restrictable to groups, fact tables rebuild on the `:15` cron, and its cube-isolation test is
mandatory. The kit core knows nothing about drizzle-cube, and other plugins extend it through
`analyticsExtensions({...})`. `bootstrap --no-plugins` gives a kit without it.

The kit still owns `activity_events`, the catch-all/`run_worker_first`/Vite-proxy files its
prefixes must be added to, and the visibility registry it registers into.

**Known gaps (kit side):** `activity_events` has no retention; nothing proves a plugin's cron reached
the tomls beyond parity between the two files; fact refresh/check need a running server and CLI.

## 9. AI layer

Server: `api/services/{ai,agents}/**` (read their `CLAUDE.md`), `services/prompts.ts`,
`api/workflows/agent-run.ts`. Contracts: `packages/shared/src/ai/*`. Rules: `.claude/rules/api.md`
§ AI services.

- **One resolver (D17)**: `resolveChat` / `resolveEmbeddings` are the only readers of `ai_configs`
  / `agent_models` and the only place credentials are decrypted. Chat order: per-agent assignment →
  tenant default → platform `ANTHROPIC_API_KEY` → **Workers AI `glm-4.7-flash` via `[ai]`** → 503
  `ai_not_configured`. Embeddings order: tenant → Workers AI `bge-m3` (1024-dim) →
  `EMBEDDINGS_API_KEY` → 503. Workers AI calls are **billed** to the account; removing `[ai]` from
  both tomls makes the kit zero-spend. Credentials never leave the server (`hasCredential`); every
  error is normalised to `AiError` with secrets redacted.
- **Providers**: `anthropic`, `anthropic_compatible`, `openai`, `openai_compatible`, `workers_ai`.
  There is no Vercel AI SDK and no Bedrock (a SigV4 adapter behind `ChatClient` is the extension).
  Workers AI quirks — two response shapes, per-model `tool_choice`/streaming lists, fragmentary tool
  calls, schema-flattening retry — are in `services/ai/CLAUDE.md`. The floor model was chosen
  because it can run the *agents*.
- **Kit** (`services/ai/kit.ts`): `runStreamingChat`, `runToolLoop`, `callStructuredTool`, prompt
  caching helpers. Prompts are code (`PROMPT_REGISTRY`) with per-tenant override rows.
- **AG-UI is the wire protocol (D28)**: `@ag-ui/core` is pinned exactly and imported only by
  `shared/src/ai/agui.ts`. The kit emits 15 events plus a `kit.` CUSTOM namespace (apps use their
  own prefix). It supports SSE (`data:` only, no `event:` line) or protobuf.
  `POST /api/agui/run` is the `RunAgentInput` endpoint. The server owns the transcript, the client
  supplies only the new message, and client `tools[]` are refused.
- **Chat**: owned by `userId`; `chat-turn.ts` is the one implementation behind `/api/chat` and
  `/api/agui`. Everything that can fail as JSON runs before the stream opens, and stream writes use
  `streamDatabase(c)`. A cancelled run emits no terminal event. Chat can call the three knowledge
  tools (`CHAT_KNOWLEDGE_TOOLS`), capped at 6 turns. **Long threads are compacted**: a
  character-budget window (`CHAT_HISTORY_MAX_CHARS`), with the dropped prefix folded into
  `conversations.summary` by the `chat.compact` job (compare-and-set). Document cards come from
  `kit.document` events produced by a pure mapper, so nothing about a card is stored. The admin
  inspector (`/stats`) is derived per request.
- **Agents (D7)**: `POST /api/agents/runs` enqueues (row → Workflow instance → 202); the exclusive
  index dedupes. The Workflow runs `claim → execute#N → (resume#N | expire#N) → finish`, and
  **every step name carries its round**, because a repeated name replays the recorded result.
  A retry resumes: `ctx.checkpoint` keeps the tool-loop transcript and `ctx.once(key, fn)` gives
  once-per-run effects (a DB unique index; at-least-once with a recorded result).
- **Human-in-the-loop (#17)**: `ctx.interrupt({ key, spec })` parks the run on
  `step.waitForEvent`. The key must be stable across attempts. Answering is a compare-and-set on the
  row, *then* a nudge to the instance (`not_found` → restart as `<runId>-rN`). There are four
  closed interrupt kinds (approval/choice/input/form). Model-called tools are gated on the tool
  (`requiresApproval`) before any handler runs. Artifacts are an upserted table, and steering notes
  are event rows delivered once.
- **Reading runs**: `agent_run_events` is the durable log, and AG-UI is a pure read-time
  projection (`/agui`), also streamed live by tailing `seq` (`/agui/stream`, #7). A read-stream
  failure emits no `RUN_ERROR` (clients reconnect); `id:` goes on the last frame of a row's group,
  and reconciliation runs once before the first frame. Payloads never go over the tenant-wide DO,
  because run visibility is per run.
- **Knowledge (D18)**: `documents` + `chunks` (pgvector HNSW). Text is ingested inline or by job;
  uploads go to R2, then `AI.toMarkdown`, then the same indexer. Search is hybrid dense + lexical
  with RRF, scoped by `AccessScope` (§1). `document-content.ts` is the one text reader behind both
  the viewer and `get_document`. Agent tools resolve the requester's access at execute time.
  **External ids (D34)**: `documents.external_id` is unique per `(tenant_id, source)` (partial
  index, `0016`); an ingest carrying one is an upsert — one `ON CONFLICT` statement, grants
  replaced, chunks rebuilt, a replaced original removed from R2 — so a connector's re-sync never
  duplicates. Plugins reach it through `ingestDocument` (§16).
- **Usage**: one `ai_usage` row per call, costed at write time from the one price table
  (`shared/ai/pricing`; an unknown model gets `null` and is counted as unpriced).
- **Tracing (D32, supersedes D16's Langfuse ingestion client)**: `api/observability/`. Every AI call
  site talks to the `Tracer` seam; the recorder batches ended spans and flushes (in `waitUntil`, or
  awaited at the end of a stream, step or job) to two sinks: our own **OTLP/HTTP exporter**
  (`otlp-fetch.ts` — JSON by default, hand-encoded protobuf for backends that take nothing else,
  e.g. Phoenix; no dependency, no Node API) and the **local `ai_spans` table**, written whether or
  not a backend is configured (the request path opens its own short-lived client per non-empty
  flush). Attribute names — OTel GenAI semconv, OpenInference, Langfuse aliases — live in ONE module,
  `genai-attributes.ts`. Handles nest, and the active span rides `AsyncLocalStorage`, so a tool
  span (recorded by the kit's single tool runner — every tool, kit or plugin, chat or run),
  retrieval and embeddings nest without signature changes. **Workflow continuity**: a run's trace
  id is its uuid's hex and its root span id is derived from it, so each `execute#N` (a separate
  invocation) is a child of a root the `finish` step records once the run has settled. Covered:
  chat turns, agent runs, tools, retrieval, embeddings, the `chat.compact` / `document.index` /
  `document.convert` jobs. `OBSERVABILITY_PRESET` (`langfuse|phoenix|generic`) fills endpoint and
  auth — existing `LANGFUSE_*` keys migrate with no new secret; `OBSERVABILITY_CAPTURE_CONTENT=false`
  strips prompts, completions and tool I/O from both sinks; `pruneAiSpans` on the nightly cron keeps
  `OBSERVABILITY_SPAN_RETENTION_DAYS` (14), one DELETE across every tenant. Read back through
  `GET /api/traces[/:id]` (`read Trace`, admin+ — spans hold other people's prompts) and `launch traces list|show`; the
  `launch-traces` skill teaches an agent to debug from the span tree. Switch recipes: `docs/DEPLOY.md`
  § Tracing.

  **D32 decisions** (design grilling, 2026-09-25): our own OTLP exporter behind the existing seam —
  not Cloudflare's native tracing, not the Langfuse SDK · the backend is platform-wide only ·
  content capture is on by default, with a flag to disable · agent context comes from the CLI
  reading our own Postgres, not a backend REST adapter.
- **Evals (D33)**: `apps/evals`, its own workspace package because vitest-evals needs vitest 4 and
  the kit's suites are on vitest 3. `pnpm eval [suite] [--model x] [--judge-model y] [--compare]`
  runs `suites/**/*.eval.ts` against the TEST database with real models (the platform
  `ANTHROPIC_API_KEY` from `.dev.vars`; no key → every suite skips and says why). **Targets are
  in-process and go through the product's own code**: the chat target drives the real
  `POST /api/chat/conversations/:id/messages` route (so `prepareChatTurn` decides prompt, history and
  tools, as in production); the agent target runs `enqueueRun` → `claimStep` → `executeRun` →
  `finishStep` inline. Each case gets a tenant of its own with its `context` documents ingested, so
  retrieval can only find what the case put there. Everything a target does runs in
  `withEvalScope` (`observability/context.ts`), which marks its traces `launch.eval=true`.
  **The harness input IS the `EvalCase`** (`shared/ai/evals.ts`: input, messages, context,
  expected `{ output, rubric, tools, toolsMatch, contains }`, tags, source), so judges read each
  case's own expectations; `describeCases` attaches to a case only the judges it declares something
  for, because vitest-evals averages a `null` score as 0. Deterministic judges (`Contains`,
  `Matches`, `Schema`, `Trajectory` with agentevals' strict/unordered/subset/superset, `Budget`)
  come first; LLM judges (`Rubric`, `Faithfulness` against what retrieval actually returned,
  `Reference` = vitest-evals' `FactualityJudge`) run through ONE judge harness that calls the kit's
  resolver on the `evals-judge` prompt key — so `agent_models` can pin it, `--judge-model` overrides
  it, and every call is an `ai_usage` row under `evals.judge`. `--provider` / `--judge-provider
  fireworks|gemini` put the target or judge on a real encrypted tenant `ai_configs` row
  (Fireworks through the kit's own `fireworks` preset, Gemini as `openai_compatible`), so vendor
  comparisons also exercise the tenant-config tier. A run is a vitest JSON report in
  `.evals/runs/<ts>-<sha>.json` (git-ignored), stamped with the sha, models and prompt hashes;
  baselines are committed per suite (`baselines/<suite>.json`, `pnpm eval:baseline`) and
  `--compare` exits 1 on a per-case, per-judge drop past `--threshold` (0.1). `pnpm eval:view`
  prints the score diff between two runs, then serves the vitest-evals report UI (runs, cases,
  transcripts, judge rationales). The optional `evals.yml` workflow runs it on manual dispatch or a
  `run-evals` label, outside the gate. How-to: `docs/EVALS.md`; the `launch-evals` skill drives it.
- **Feedback and promotion (D33)**: thumbs on assistant messages and run output
  (`POST /api/feedback`, `create Feedback` for every member, on an answer they can READ — another
  member's thread is a 404, admins included). One row per `(tenant, target, user)` in
  `ai_feedback`; voting again replaces, the same thumb twice withdraws. Each vote is also a
  zero-length `feedback` span under the answer's trace root (`launch.feedback.rating`), shown by
  `launch traces show`. AG-UI capabilities now declare `feedback: true` for chat and runs.
  Admins (`read Feedback`) list the queue (`launch feedback list --rating down`) and
  `GET /api/evals/export?messageId|runId` drafts an `EvalCase` — question, history, the passages
  retrieved, the tools called, the OBSERVED answer as `expected.output`, the feedback — which
  `launch evals promote <id> --dataset <name>` appends to a dataset after warning that it is
  tenant data (it will not write without `--yes` or a confirmed prompt).

  **D33 decisions** (design grilling, 2026-09-25, issue #21): vitest-evals as the runner, in its
  own vitest-4 package rather than a workspace-wide vitest upgrade or a home-grown runner · targets
  in-process, through the real route and runtime · no in-app eval UI (JSON runs + the report UI) ·
  datasets are code; promotion from real traffic and thumbs · the judge goes through the resolver,
  with a `--judge-model` override · in core, not a plugin · the `launch-evals` skill is a first-class
  deliverable. The prompt key is `evals-judge` (keys are kebab-case); the ledger feature is
  `evals.judge`.
- **Rejected**: Cloudflare's Agents SDK. Per-instance SQLite sits outside RLS, the tenant FK cascade
  and cross-tenant indexes, and the inbox would need Postgres anyway. One `step.do` per model turn
  was also rejected: steps are unlimited in wall-clock time, and splitting would force every side
  effect outside a step to replay.

**Known gaps:** no document summary or thumbnail (the card is an excerpt; Workers cannot rasterise);
`charOffset` does not map to PDF pages; no frontend tools in chat, no `STATE_DELTA`; protobuf drops
`TOOL_CALL_RESULT` and has no stream cursor; `@ag-ui/core` is 0.0.x (pin + contract test are the
mitigation); no token-level streaming for runs (would need a per-run DO); char-based history budget
not derived from the model; sliding window defeats prompt caching on long threads; `enqueueRun`
does not pre-resolve the client; Workers AI forced tools on off-list models are best-effort; no
rerank, no generated `tsvector`; no non-exclusive agents; HITL asks cannot be amended, have no
reminders, and parks are bounded by instance retention (3 days Free / 30 Paid); runs nobody opens
stay active-looking; no budgets/quotas over `ai_usage` or prompt versioning. Tracing: no per-tenant
backends (BYO keys via `sealSecret`), no native `tracing.enterSpan`, no metrics export, no
Langfuse/Phoenix MCP; inline ingest from `POST /api/ai/documents/ingest` is untraced (no active
span); the backend receives a run's root only at `finish`, so an in-flight run has no root there;
exported content is capped at 32 000 chars per value. Evals: no in-app eval UI or dataset editor;
the report UI has no side-by-side view (the diff is `eval:view`'s terminal table); no HTTP targets
against a deployed instance, no red-teaming, no push to Langfuse datasets; a run that parks on a
person scores as a miss (an eval cannot answer it); run faithfulness sees each passage's
600-character event preview; without `EMBEDDINGS_API_KEY` retrieval in evals leans on the lexical
half of hybrid search; `--provider` knows three vendors (anthropic, fireworks, gemini) and the
latter two are unpriced; a thumbs vote is a
zero-length span, not an OTLP span event, and is not traced when the answer's root was pruned.

## 10. Deployment

Two standalone tomls (D6) kept identical in everything code can see by `wrangler-parity.test.ts`.
Account-scoped names carry `-staging`. Neon uses one project with a branch and role per
environment; under `postgres` Hyperdrive points at the direct host, under `neon` the Worker's
`DATABASE_URL` secret holds the pooled one (D35). Tagging `X.Y.Z` (which must equal the root
version) deploys staging; publishing the Release deploys production. `ci.yml` (→ `gate.yml`) is the
single gate, which `deploy.yml` calls. `pnpm provision <phase>` / `/launch-provision` automates
accounts → resources → secrets → deploy over REST. Reference: `docs/DEPLOY.md`, `SETUP.md` Part 3.

**External deployer (opt-in).** A Cloudflare token that can deploy a Worker can bind any resource in
the account into it, so a CI job holding one can reach other apps' data. With the repository
variable `DEPLOYER_URL` set, `deploy.yml` holds no Cloudflare token and no database credential: it
proves who it is with a GitHub OIDC token and hands the dry-run build to a deployer that checks the
bindings, stores an undeployed version, issues short-lived migration credentials, then activates
(`scripts/deployer.mjs`; the v1 contract is `docs/DEPLOYER.md`). Unset, the default path is unchanged.

**Known gaps:** no release helper; no per-PR previews; no CLI publishing;
provisioning HTTP calls have not been run end-to-end against live accounts; no automated
Workers-plan check. The kit ships no deployer, only the client and the contract; the job waits for
approval on a runner (fine for minutes, wasteful for hours — there is no re-dispatch).

## 11. CLI

A thin client over `/api/*` using a tenant API key. It parses with shared schemas and never keeps
a second copy of the contract (D26). `api.ts` is the only `fetch` site. Config lives in
`~/.launch/config.json` (0600); `LAUNCH_API_KEY`/`LAUNCH_URL` override it for CI.
`--json` is available on every read. `traces list|show` reads the local AI trace store (D32);
`feedback list` is the thumbs queue and `evals promote <id> --dataset <name>` appends a draft eval
case to `apps/evals/datasets/` (D33, both admin+). `sessions start|say|ship|end|ls|preview-url`
drives Launch P3 coding sessions (§18.14) — `ship` follows the ship to live on staging by default,
printing each stage, and exits 1 on a reopen or a stall (`--no-wait` returns at once; `--wait` is
a no-op alias); `approvals ls|show|approve|reject` and `releases
ls|create|promote [--wait]` are the P4 inbox and shipping (§18.19); `audit verify|export` the
hash-chained log (§18.18). Exit codes: 0 ok · 1 error · 2 not logged in ·
3 forbidden.
No command prints a full key. Plugins register top-level commands named after their id.
Detail: `.claude/rules/cli.md`.

**Known gaps:** no device-code flow; one profile at a time; `logout` does not revoke the key; no
shell completion; not published.

## 12. Shared package

`packages/shared` is private and has no build step: `@launch/shared/<module>` resolves to
`src/<module>.ts` (so a plugin entry is `…/plugins/<id>/index`). Contracts come first (D13): a new
API surface starts here. Allowed imports: `zod`, siblings, type-only `@casl/ability`, and
`@ag-ui/core` only in `ai/agui.ts` (`shared-imports.test.ts`). It never imports `apps/*`, and
`src/plugins/**` never imports one of the five composers at runtime (that would create a module
cycle). Detail: `packages/shared/CLAUDE.md`.

**Known gaps:** no own test suite; no OpenAPI; no contract versioning between web and CLI.

## 13. Provenance — Launch does not track the kit

**Launch was seeded from Rocketflare 0.15.0 and then cut loose.** The kit's upgrade and release
machinery (`.rocketflare.json`, `kit:upgrade`, `kit:release`, porting notes, the update-check and
changelog hooks) was removed; later kit releases are not ported automatically.

- **`launch.plugins.json`** records the installed plugins only: each plugin surface, the app's
  names (a plugin is translated into them on the way in), and `kitVersion` — the kit plugin API
  level a plugin's `minKit` is checked against. `plugin-manifest.test.ts` holds it to that shape.
- **Plugins still upgrade** with `pnpm plugin upgrade`: a blobless mirror in `.plugin-cache/`, the
  plugin's own diff translated through `applyReplacements()`, patched with `--reject` as a fallback,
  the version stamp written last and only on a clean apply.
- **Changes are recorded in `CHANGELOG.md`** under `## Unreleased`.

**Known gaps:** a kit fix Launch wants is ported by hand; a plugin release that needs a newer kit
plugin API than `kitVersion` cannot be installed until those host changes are ported.

## 14. Definition of done for the kit

A fresh agent can clone and run `bash scripts/bootstrap.sh` with zero credentials and land signed in.
From there it must be able to:

- log in by magic link and through the CLI
- invite a member, switch tenants, approve an access request, including under `single` mode
- see live refresh from a second browser and queued email
- upload an avatar
- stream a chat with persisted usage
- run, watch live, cancel and HITL-answer agents across a dev restart, with the approved document
  indexed exactly once
- ingest, upload a PDF and search it
- restrict content by group and watch it disappear and reappear live
- see analytics installed, removable cleanly with `plugin remove`
- provision and deploy to staging

The full gate stays green at every step. `SETUP.md` is the walkthrough.

## 15. Feature flags

**A feature flag is configuration, not a permission (D30).** Every gate reads the `features`
**array** (`hasFeature`, `requireFeature`, `{ feature }` nav guards), never CASL. A global admin's
`manage all` would satisfy `access Feature:x` and expose unreleased surfaces.

- **Two layers**: `FEATURES_ENABLED` in `[vars]` is the fail-closed release gate, consulted only for
  `environmentGated` flags. Then the admin rollout: tenant override → `on`/`off` → `rollout`
  percentage → registry default.
- **Keys are code** (`FEATURES` + metadata). No migration is needed to add one; orphaned rows are
  inert. Launch ships **no** flag yet, so `featureNameSchema` is a refined string and
  `featureDefinition(key)` is how code reads a flag's metadata.
- **`featureBucket` is a wire format**: FNV-1a over `"<key>:<unit>"` mod 100, with golden vectors
  in `features.test.ts`. It is monotonic (the percentage is never hashed) and independent across
  flags.
- Resolved inside the session query, with no extra round trip. Gate every door: API mounts (404
  `feature_disabled`, not 403), plugin registries, **hooks that create rows**, and nav/routes.
- Admin UI at `/admin/feature-flags`; a tenant override nudges that tenant.
  `GET /api/features` / `launch features list` show effective state.
- **Rejected**: Cloudflare Flagship. It has no notion of your tenants, whole-object `PUT` loses
  updates, it has no local store, and the browser SDK needs a token. It fits the kit's own
  cross-deployment rollouts, not per-tenant entitlements.

**Known gaps:** gated code still ships in the bundle (the server is the protection); no per-user
forcing or scheduling; platform flips reach open tabs only on their next session fetch; no cache on
the Bearer path; flags cannot gate pre-tenant surfaces.

## 16. Plugins

**A plugin is a git repository COPIED into an app, never an npm package (D31)**, translated through
`applyReplacements()` like kit code. Only first-party plugins for now: installing one is as trusting
as merging a PR. A plugin repo mirrors the host tree and ships **no migration, no toml and no
`package.json`**. Working guide: `apps/web/src/plugins/CLAUDE.md`, `/launch-plugin`,
`docs/plugin-api.md`.

- **Outbound**: four published entries (server, UI, shared, CLI). Nothing reaches past them, in
  either direction between core and plugins.
- **Inbound**: a plugin imports the host only through **declared entries** and receives everything
  else as **injected context** (`RequestCtx`, `JobCtx`, `CronCtx`, `ToolCtx`, `AgentCtx`,
  `WorkflowCtx`, `HookCtx`, `SeedCtx`, `DetachedCtx` — thin adapters over kit internals). Two things
  cannot be injected and are entries instead: `@/db/schema/kit` (module-scope table helpers,
  imported by relative path) and the split UI kit (`ui-wiring` for the eager entry, `ui` for lazy
  pages). Tests use `@testkit/{integration,unit}`, whose builders refuse a database handle not
  created by `setupTestDatabase`. `tests/helpers/plugins.ts` enforces all of this, and every
  diagnostic names the replacement import.
- **Six barrels**, one line per plugin each, written by `pnpm plugin add|remove`: shared, server,
  schema, ui, worker-exports (DO/Workflow classes reach `worker.ts`), cli. Each exports an `as const`
  tuple plus a widened list, so an empty kit still typechecks. **Opening a closed set** always
  follows one pattern: `X = [...CORE_X, ...plugins]`. `ServerPlugin<S>` checks handlers, agents and
  prompts exhaustively against the plugin's own keys.
- **Namespacing**: the id is `^[a-z][a-z0-9-]*$` and namespaces jobs (`<id>.x`), query keys
  (`<id>:`), `/api/<id>`, CLI commands and CUSTOM events. Never `kit.`. Table prefixes are a human
  convention; **two plugins declaring the same table is a `plugin check` failure**.
- **Record**: a `kind: 'plugin'` surface (`source: {repo, subdir, version, commit}`) in
  `launch.plugins.json`; with `--local` it goes in the git-ignored `launch.plugins.local.json`.
- **Compatibility is OBSERVED (decision 5c)**: the kit emits a `## Surface ledger` in
  `docs/plugin-api.md` (generated, diff-checked). A plugin's `uses` is **derived** from its imports
  by `pnpm plugin export`, and compatibility is the set difference `uses \ ledger`, checked before
  any file is copied. The one surviving number is a top-level `minKit` floor, checked against
  `kitVersion` in `launch.plugins.json`. `requires.kit` / `requires.pluginApi` are refused by name.
  CI runs `pnpm plugin check`, and the gate runs every installed plugin's own tests.
- **Lifecycle** (`scripts/plugin.mjs`): `add` (plan, then `--apply`), `upgrade`, `remove`
  (`--archive`), `list`, `check`, `export`. Every plan step is **declarative, agent (with its
  assertion) or human** — a printed instruction is not a mechanism. The host generates the
  migration (`db:generate --name plugin-<id>-<version>`). `pnpm provision cloudflare <env>` writes
  a plugin's bindings (`kv|queue|r2|workflow|durable_object`), crons, prefixes and vars into BOTH
  tomls. DO migration tags `plugin-<id>-vN` are append-only.
- **`plugin check` is an exhaustive oracle**: manifest fields, `minKit`, ledger diff, barrel lines,
  `*.rej`, migration tag, host dependencies, worker exports, a tenant-isolation test for tenant
  tables, `onTenantDeleted` for DOs, table collisions, declared skills. Each finding names file, line and exact edit.
  Structural checks read comment-free code. CI runs the same command.
- **Agent tools**: `agentTools(ctx)` may be async and may return `[]`. That is how a tool reaches
  only the tenants that turned it on: the plugin reads its own settings row for `ctx.scope.tenantId`.
  A builder that throws is logged and skipped. `buildAgentTools` is therefore async.
- **Credentials**: a plugin stores a tenant's key with `sealSecret` / `openSecret` from
  `@/plugins/api`. That is the kit's AES-GCM under `OAUTH_ENCRYPTION_KEY`, with a 503 when the key
  is unset. Store the sealed value in a `*_enc` column and answer `hasCredential`.
- **Public mounts (D34)**: `publicMounts` are routes a third party calls with no session — an
  admin-consent callback, a webhook. Only under `/api/hooks/<id>` (so no toml edit and one
  enumerable prefix per plugin), mounted before the authed table with no `authMiddleware` and no
  gate; `tests/config/plugins.test.ts` refuses one anywhere else and any authed mount there. The
  handler gets `publicCtx(c)` — no tenant, no auth fields, `enqueue`, `features(tenantId)` — and
  proves the caller before naming a tenant. `signState` / `verifyState` are the proof for a
  round-trip the plugin started: HMAC-SHA256 under a key HKDF-derived from
  `OAUTH_ENCRYPTION_KEY`, a `purpose` that is part of the signed body, an absolute expiry
  (default 10 min), `null` for every failure. Signed, not encrypted.
- **Background feature checks (D34)**: `JobCtx`, `CronCtx` and `PublicCtx` carry
  `features(tenantId)` — the same resolution as `auth.features`, with no user, so a cron that fans
  out across tenants can skip the ones whose flag is off.
- **Knowledge ingest (D34)**: `ingestDocument` / `ingestDocumentFile` / `deleteIngestedDocument`
  over the kit's ingest paths (§9). With an `externalId`, the same `(tenant, source, externalId)`
  UPDATES the row — text, owner, visibility, grants, chunks, the stored original — so a sync can
  replay safely. Group ids are checked against the tenant first. This file belongs to the
  `feature-knowledge` surface; a plugin that ingests requires it.
- **Skills**: a plugin ships agent skills at `skills/<dir>/` in its own tree and declares them in
  `"skills"`; `add` copies each to `.claude/skills/<dir>/` (the one place outside its roots a
  plugin may write) and records it on the surface, `upgrade` REPLACES it (never patches — an agent's
  instructions are the plugin's outright), `remove` deletes it. `<dir>` is `<id>` or `<id>-*` and
  its SKILL.md `name:` equals it, so a plugin skill can never shadow a host `launch-*` one; an existing
  directory is a refusal. `plugin check` fails a declared skill that is missing, misnamed or
  undescribed, and a directory in the plugin's namespace it does not declare. `.claude/` in a
  plugin repository stays that repository's own tooling. `analytics` ships four.
- **Hooks** (`onTenantCreated`, `onTenantDeleted`, `seedDemo`) run post-commit, are idempotent,
  and are try/caught. DO state is purgeable only through instance names **derived** from the tenant
  id.
- **Traps measured, now rules**: registries a plugin composes into are FUNCTIONS, not consts
  (module-evaluation order); a value a plugin needs moves to a leaf module; browser-read registries
  are separate files from composing ones; plugins declare `relations()` for their own tables only
  (drizzle type intersection); annotate `const ctx: RequestCtx` so `never` narrows.
- **`analytics`** is the one installed plugin. The kit's `example-feature` reference plugin was
  removed from Launch (migration `0018` drops its `example_notes` table).

**D31 decisions** (cited by number in code comments):

| # | Choice |
|---|---|
| 1 | First-party only; the install plan waits for a human |
| 2 | The kit is bare; `defaultPlugins` + a bootstrap step keep a fresh clone unchanged |
| 3 | `example-feature` is the reference plugin |
| 4 | A plugin is recorded as a `kind: 'plugin'` surface; `readManifest()` is the one kit-vs-app predicate |
| 5 | Compatibility is proved in CI from both ends (`ci.yml` with defaults installed; `plugin-ci.yml`; `kit:release` refusal) |
| 5b | *(reversed)* a `PLUGIN_API` integer beside `requires.kit` |
| 5c | Compatibility is observed: derived `uses` against the emitted ledger, plus a `minKit` floor |
| 6 | Cubes/fact tables/dashboards are plugin-owned registries via `extensions`, narrowed by the owner |
| 7 | Analytics extracted with no compatibility path (tables become `analytics_*`) |
| 8 | Pages are `lazy()`, proved by a source-level test |
| 9 | Four published entries; deep imports fail in either direction |
| 10 | Phase A shipped as four PRs, one release |
| 11 | Uninstall drops tables by default, `--archive` on request |
| 12 | Provisioning writes plugin bindings into both tomls (`kv`/`queue`/`r2` created; `workflow`/`durable_object` declared) |
| 13 | Every manifest has a required `repo` |
| 14 | The inbound surface is injected context (the `*Ctx` family), not imported symbols |
| 15 | What cannot be injected is a declared entry (`@/db/schema/kit`, split UI kit, `@testkit/*`) |
| 16 | A printed instruction is not a mechanism — hence the worker-exports barrel |
| 17 | DO migration tags are append-only and host-owned |
| 18 | Out-of-Postgres tenant state is purged via `onTenantDeleted` over derived DO names |
| 19 | Test builders refuse a fake database |
| 20 | Every plan step is declarative, agent or human (`kind` in `--json`) |
| 21 | `plugin check` is an exhaustive, untiered oracle that reads comment-free code |
| 22 | Table prefixes are convention; collisions are the check |
| 23 | A plugin ships agent skills: `skills/<dir>/` → `.claude/skills/<dir>/`, namespaced by id, replaced on upgrade |

This table is the kit's record. In Launch, 2, 3 and 5 no longer hold: there are no default plugins,
`example-feature` was removed, and there is no plugin CI workflow or release refusal — CI runs
`pnpm plugin check` and the installed plugins' tests.

**Known gaps:** no sandbox, review or signing; no rename migrations (expand/contract only); no
cross-plugin FK tooling or `many()` onto core tables; `grants` is additive by convention only;
provisioning never deletes resources; `d1`/`vectorize`/`analytics_engine` bindings are refused;
the ledger judges only ledgered entries, ignores namespace imports, truncates types over 300
chars, and `uses` is only as fresh as the last export; table collisions are caught by `check`, not
refused at `add`; the isolation check proves a test exists, not that it is right; no database-free
test of data-touching handlers; one DO per row is unpurgeable (purge-intent ledger not built);
nothing tests a plugin against kit versions between its floor and `kitVersion`. Public mounts (D34) get no rate limit of their own and no `@testkit` builder
(test them through `request()`); `verifyState` has no replay ledger — a token is reusable until it
expires, so a plugin whose callback must run once records that itself; an ingested document's
upsert reads the previous row before writing, so two racing re-ingests of a FILE may leave one
replaced original behind in R2; a plugin skill edited in place is overwritten by the next
`plugin upgrade` (copy it to a skill of your own first), and `check` validates a skill's name and
description, not what it says — a stale command in a SKILL.md is caught only by reading it.

---

## 17. Connectors

An **organisation connection** to Microsoft 365 or Google Workspace (D34): an org admin grants an
operator-registered app access to the whole directory, calendars and — later — mail and files, and
Launch syncs them into the tenant. It is **not login** (§2): a different app, a different
grant (admin consent / domain-wide delegation, app-only tokens), a different subject (the
organisation, not the signer). The design, operator and customer-admin setup, phases and the MCP
assessment are in `docs/CONNECTORS.md`.

It ships as plugins, not core: the `connectors` base plugin (installations, connections, sync
cursors, the settings tab, the sync job and cron) and one provider plugin each (`m365` first,
`google-workspace` next), registered through `extensions.connectorProviders`. The kit's part is
four generic seams on the plugin surface (§16): public mounts at `/api/hooks/<id>`, `signState` /
`verifyState`, `ingestDocument` with an `externalId` upsert (§9), and `features(tenantId)` off the
request.

| # | Choice |
|---|---|
| 1 | Login and connection stay separate apps, even in production |
| 2 | One operator-registered app per deployment by default; a per-customer BYO app is the escape hatch |
| 3 | The data model covers all three usage models from day one: installation → connection with `ownerType` `tenant` or `user` |
| 4 | Org-wide app-only ships first; per-user delegated is phase 4 |
| 5 | Directory + calendar by delta polling first — no restricted scopes, so no Google CASA gate |
| 6 | Webhooks only ever trigger a delta fetch; polling stays the backstop |
| 7 | Every synced row carries its owner; tenant isolation alone is not enough inside one organisation |
| 8 | Vendor MCP servers are not a data plane (delegated only, no delta or webhooks) — at most a later chat-tool adapter |

**Known gaps:** no webhooks yet (phase 2); no mail or file ingestion (phase 3); no per-user
delegated connections or refresh-token rotation (phase 4); Google Workspace provider not built;
M365 uses a client secret, not a certificate assertion; no Exchange RBAC-for-Applications scoping
script; synced private rows are still readable by tenant admins (D29 owner-and-admins); the kit has
no MCP client; directory sync does not provision kit users or groups (it only matches by email).

---

## 18. Launch control plane

What makes this copy Launch rather than the kit: a registry of the company's Rocketflare apps, an
OIDC issuer they sign in through, the sealed platform credentials Launch acts with, and an
append-only audit log (spec/03–06, 08; the build plans are `docs/plans/p1-foundation.md` and
`docs/plans/p2-create-app.md`). From P2 it also creates apps (§18.5–18.8), and from P3 it runs
coding sessions on them (§18.9–18.14, `docs/plans/p3-sessions.md`, `docs/SESSIONS-LOCAL.md`);
from P4 a second person approves what needs one, releases ship through a production gate, and the
audit log is hash-chained (§18.15–18.19, `docs/plans/p4-approvals.md`); from P5 apps hold shared
config through approved grants (§18.20, `docs/plans/p5-grants.md`).
Services live in `api/services/launch/` and `api/services/oidc/`; contracts in
`packages/shared/src/launch-{apps,oidc,setup,audit,pipeline,sessions,approvals,releases,grants}.ts`.

**Tables** (`apps`, `app_owners`, `app_environments`, `app_health_checks`, `app_operations`,
`oidc_clients`, `oidc_client_grants`, `oidc_codes`, `audit_events`, and from P4 `approval_requests`,
`approval_decisions`, `approval_policies`, `app_releases`, `audit_chain`, and from P5
`shared_resources`, `shared_resource_values`, `app_grants`, `grant_pushes`, `grant_push_targets`,
`app_config_scans`) are
tenant tables like any other, scoped to the single company tenant. Three are platform
infrastructure with no tenant and are revoked from the app role: `oidc_signing_keys`,
`admin_credentials`, `launch_settings`. Teams are the kit's `groups` (D29) — there is no `teams`.

### 18.1 Audit log

`recordAudit` (`services/launch/audit.ts`) is AWAITED, unlike `recordActivity`, and usually runs in
the same transaction as the change. `audit_events` is append-only in the database: a `BEFORE UPDATE
OR DELETE` trigger raises (except inside the tenant cascade), and `UPDATE`/`DELETE`/`TRUNCATE` are
revoked from `launch_app`. Actors are `user` (with email, IP, user agent, request id), `system` (the
cron) or `app` (a relying party at the token endpoint); `actor_user_id` has no FK, so deleting a
user never rewrites history. A summary is `{before?, after?}` and never carries a secret — a
credential or client secret is recorded as `'set'`. `GET /api/audit` (admin+, filter by app and
action, cursor-paged) backs the `/audit` page.

From P4 the log is sealed into a hash chain, verifiable and exportable (§18.18), and every
approval's audit rows carry `approval_id`.

**Known gaps:** no SIEM stream (spec/08, P6); no retention policy; the page filters only by app and
action.

### 18.2 Admin credentials and setup checks

The setup wizard (`/settings/platform/setup`, `routes/setup.ts` at `/api/platform/setup`;
`canAdministerPlatform` — a global admin, or in single mode the organisation's owner/admin, §1;
the old `/admin/setup` link redirects, anchors kept) holds the Cloudflare account
token, the Neon org key, a full-access Resend key and the GitHub App (id, PEM, org), plus the
settings beside them (apps domain, account id, Neon region, notifications domain, GitHub org). A
credential is validated, SEALED with `OAUTH_ENCRYPTION_KEY` (one row per kind in
`admin_credentials`), checked, then audited `credential.set` / `.rotated` / `.checked` /
`.removed`. Responses carry only status — set, when, by whom, the last check's probes
(`ok|warning|failed` with the vendor's scrubbed message) — never a value. Probes run on an
injected `fetch`: the Cloudflare zone is in the account and has a proxied wildcard, the Neon key
lists projects, the Resend key is full-access and the notifications domain verified, the GitHub
App is installed on the org with the required write set. The upstream IdP step is read-only (it is
Launch's own `OIDC_*` config).

Two probes do more than read. **The wildcard**: when the zone has no `*.<apps domain>` record at
all, saving or re-checking the Cloudflare token (the domain card re-checks after a domain change)
creates a proxied `AAAA * → 100::` and reports "Created …", audited `dns.wildcard.created` on the
zone; a DNS-only record is never changed — the probe fails and says how to fix it — and a token
without DNS Edit fails with Cloudflare's scrubbed error. `GET /api/platform/setup` never probes, so a
page load changes nothing. **The Neon region** is never read from `GET /regions`, which refuses
organization keys (404): a pinned id is checked against the static `NEON_REGIONS`
(`@launch/shared/launch-setup`; an unknown one is a warning, Neon validates it on the first
create), and an unset one is pinned to where most of the org's projects already are, else
`DEFAULT_NEON_REGION` (`aws-us-east-2`, Neon's default for a new project), with a warning either
way. The wizard offers the list as a select with an "Other…" free-text fallback.

**The public URL (step 7).** The scaffold job and every app's deploy job run on GitHub's runners
and call Launch BACK (`/ci/scaffold/*`, `/ci/deploy/*`) at the URL they were dispatched with —
Launch's `APP_URL` (`issuerOf(cfg)`, the same value that is the jobs' OIDC audience, every app's
`DEPLOYER_URL` and `OIDC_ISSUER`; under `pnpm dev` it is `.dev.vars`' `http://localhost:3000`,
or the tunnel's `https://…` host while `pnpm dev:tunnel` is up — SETUP §1.10). It is not a
setting: it is the Worker's config. `services/launch/public-url.ts` checks it in two probes:
`url` (static — `https`, and not `localhost`/`*.localhost`, `.local`/`.internal`/`.home.arpa`, a
dotless name, or a loopback, private, CGNAT, link-local or unspecified IP literal) and, when that
passes, `probe` — Launch fetches `<APP_URL>/ci/ping?nonce=<random>` through the internet and
expects the nonce back with an HMAC of it under its own `OAUTH_ENCRYPTION_KEY`, which proves the
hostname routes to THIS Launch (through the tunnel locally), not merely to something. A wrong
proof or a non-ping answer fails; unreachable fails under `APP_ENV=development` and is a
`warning` in a deployment (see the gap). The result is stored as `launch_settings.public_url_check`
for the URL it ran against. The wizard's card shows it (the static half alone until someone clicks
"Check now", `POST /api/platform/setup/public-url/check`, audited `public_url.checked`; the overview
still never probes). **The gate**: `POST /api/apps`, a create run's retry and "Deploy to
production" call `requirePublicUrl` first and refuse with 409 `launch_not_reachable` (`details`:
the URL and the probes) — before any write. It reuses a passing result for 10 minutes and a
failing one for 30 seconds (so starting the tunnel shows up quickly), and probes again otherwise;
a static failure never probes. The Create modal shows the reason and links to the step.

**Known gaps:** Cloudflare write scope is a standing `warning` — nothing proves it short of
creating a Worker; `NEON_REGIONS` is a hand-kept list (a region Neon adds later is only a
warning until it is added); saving the apps domain through the API alone (not the wizard)
does not re-check, so the wildcard is created on the next save or check; checks run only when a credential is saved or re-checked, not on a schedule;
one row per kind for the whole deployment, so a suite that needs credentials mocks the module
over an in-memory store (`tests/helpers/credential-store.ts`) rather than racing the setup suite.
The public-URL probe is unproven on a deployed Worker: whether a Worker can fetch its own hostname
depends on how it is routed (a same-zone Route does not loop back; a Custom Domain should), so an
UNREACHABLE probe in a deployment is only a `warning` and does not block creates — the static check
still does; the gate does not cover an app's own tag-triggered deploys (GitHub starts those, not
Launch); an import dispatches nothing and is not gated.

### 18.3 The OIDC issuer

Launch is the issuer at `APP_URL` (no trailing slash; `loadConfig` refuses `OIDC_ISSUER ===
APP_URL`, since Launch's own `OIDC_*` is its UPSTREAM login). Public, outside `/api`, in
`run_worker_first`: `/.well-known/openid-configuration`, `/.well-known/jwks.json`,
`/oidc/authorize`, `/oidc/token`, `/oidc/userinfo`, `/oidc/logout` (`routes/oidc.ts`).

- **Flow**: code + PKCE S256 only. An unknown client or unregistered `redirect_uri` gets an HTML
  page and never a redirect; every other error goes back with `state` and `iss` (RFC 9207). Codes
  live 60 s in `oidc_codes`, stored hashed, single-use by a compare-and-set; a replay REVOKES the
  first redemption's access token (userinfo refuses it) and is audited `oidc.code_replayed`.
- **Claims**: ES256 `id_token` with `sub` = the Launch user id, `email`, `email_verified: true`,
  `name`, `groups` (group names in the client's tenant), `nonce`, `auth_time` (when the Launch
  session began). The access token is an `at+jwt` for userinfo only. Clients authenticate with
  `client_secret_basic` or `_post` against a hashed secret, compared in constant time.
- **Keys** (`services/oidc/keys.ts`): `next → active → retiring → retired`; the next key is
  published before it signs, a retiring one stays in the JWKS until the longest token plus a
  cache margin has passed. Private JWKs are sealed; `/api/platform/oidc` lists and rotates
  (`oidc.key.rotated`) — Settings → Platform → Identity, `canAdministerPlatform` (§1).
- **Access policy** (`services/oidc/policy.ts`): the person must be a member of the client's
  tenant; app owners (named or the owner group) always pass; `company` admits every member,
  `restricted` needs a user or group grant. A member refused is sent to `/request-access`
  (`app.access.requested`). Every sign-in and refusal is audited (`oidc.signin`, `oidc.denied`).
  From P4 a request is an `app.access` approval (the P4 migration moved P1's pending ones across
  with their ids and dropped `app_access_requests`): asking opens (or joins) it through the engine
  (`services/oidc/access-requests.ts`), the app's owners or the organisation's admins decide it in
  the approvals inbox (§18.15), and the kind's `applyInTx` adds the user grant (`app.access.policy_changed` with the approval id).
  `/apps/:slug/access` still lists the requests; P1's decide route answers 410
  `access_request_moved`.
- **Re-authentication**: `prompt=login`, or a session older than `max_age`, ends the Launch
  session and sends the person to `/login` (the return URL carries a `launch_reauth` marker so it
  cannot loop); under `prompt=none` it is `login_required`.
- **Logout** (RP-Initiated Logout 1.0): with an `id_token_hint` Launch signed (retiring keys and
  expired hints accepted) for an enabled client, naming the signed-in person, the session ends at
  once; otherwise — including every Rocketflare app, which keeps no id_token — a confirmation page
  whose same-origin form POST ends it (the CSRF middleware refuses a cross-site one). Only a
  `post_logout_redirect_uri` registered for that client is ever followed, with `state`.

**Known gaps:** no refresh tokens, consent screen, dynamic registration, front/back-channel logout
or `prompt=consent|select_account`; re-authentication ends the whole Launch session, and
`prompt=login` is not forwarded to Launch's own upstream IdP (which may answer silently); logging
out of Launch does not end the apps' own sessions; authorize and logout answer GET only for relying
parties (a cross-site POST with the cookie is refused by CSRF).

### 18.4 Registry, health and OIDC clients

- **Import** (`POST /api/apps/import {repo, ref?, ownerGroupId?}`, admin+): the GitHub App token is
  narrowed to the one repo and `contents: read`; Launch reads `.rocketflare.json` (else
  `launch.plugins.json`) and both wrangler tomls, parsed by `rocketflare-manifest.ts` — the
  manifest leniently (a zod passthrough: `app {slug, display, domain}`, the kit version from
  `kit.version` or `kitVersion`), the tomls with `smol-toml` (name, `APP_URL`, binding ids; a kit
  `<PLACEHOLDER>` is not an id). The slug must follow spec/04 (a letter first, not `*-staging`, not
  reserved) and is globally unique. `apps`, one `app_environments` row per toml, the
  `app_operations` steps and `app.imported` are written in one transaction.
- **Catalogue and detail** (`/apps`, `/apps/:slug`; members read): name, team, kit version, a
  status dot per environment with its last check; the detail page shows resources, 24 h health
  history, the operations log and the OIDC card.
- **Health** (`services/launch/health.ts`, the `*/5` cron and `POST /api/apps/:id/health-check`):
  `GET {url}/api/health` and `/api/ready`, 5 s each. `up` = both 200, `degraded` = health 200 and
  ready not (the Worker runs, its database does not answer), `down` = anything else (timeout,
  DNS, 5xx). Each probe updates the environment and writes an `app_health_checks` row; a status
  CHANGE is audited `app.health.changed` (the first observation is the baseline, not a change);
  checks older than 7 days are pruned. Ten tenants at a time, three environments at once.
- **OIDC client** (`services/launch/oidc-clients.ts`): `POST /api/apps/:id/oidc-client` registers
  one client per app (`lc_…`) with `{url}/auth/oidc/callback` and `{url}/login?signedOut=1` for
  every environment with a URL. The secret is shown ONCE (stored as a hash, last four kept as a
  hint) with a config snippet; `rotate-secret` and `PATCH …/redirect-uris` are audited.

**Known gaps:** no Cloudflare verification of the recorded resource ids; no re-sync from the repo after import; health is
polled, not pushed, and the cron does not run under `pnpm dev` (use "Check now" or
`/cdn-cgi/local/scheduled`); no alerting on a status change beyond the audit row.

### 18.5 Creating an app (the launch pipeline)

`POST /api/apps` (any member; `routes/app-pipeline.ts`) checks the slug (spec/04 plus no
`launch-` prefix), writes `apps` (`source='created'`, `status='requested'`, a reserved run id),
both `app_environments` rows, the creator as owner and `app.create.requested` in one transaction
(`requestApp`), then opens an `app.create` approval (P4). A creator at or above
`launch_settings.app_create_role` (default admin) is auto-approved and the kind's `applyAfter`
starts `APP_LAUNCH_WORKFLOW` with the run id as the instance id at once → 202 `approvalId: null`;
anyone else gets 202 with `approvalId` and the launch waits for an admin's approval (a rejection
or expiry archives the app, `app.create.rejected`). `AppLaunchWorkflow` (`api/workflows/app-launch.ts`) only wires steps; their
bodies are `services/launch/pipeline/launch-steps.ts`, each inside `runStep` (`operations.ts`):
one `app_operations` row per `(run_id, step)`, every vendor id recorded the moment it exists, a
succeeded row skipped with its stored ids, failures scrubbed. No step result carries a secret; the
step that mints one puts it on the Worker itself.

- **Steps**: `reserve` → `repo` (private repo + the two scaffold files) → `scaffold.start|wait|
  verify` (§18.6; `.rocketflare.json` and the toml names must match `names.ts`) → `neon` (project;
  then, as `neondb_owner` over the HTTP SQL endpoint with a password minted for the step, one
  statement per call: roles `migrator` (LOGIN CREATEROLE) and `app` (LOGIN) created IN SQL,
  database `app` owned by `migrator` through the API, `CREATE EXTENSION IF NOT EXISTS vector` in
  it, `GRANT migrator TO app`; a `staging` branch with both passwords reset) → `cloudflare` (KV, queue, R2 per
  environment) → `oidc_client` → `write_config` (both tomls, one commit: the ids, `APP_URL`,
  `EMAIL_FROM`, `TENANCY_MODE=single`, `SIGNUP_MODE=open`, Launch as `OIDC_ISSUER`,
  `AUTH_OIDC_ONLY`, `workers_dev=false`) → `placeholders` (a stub Worker per environment applying
  the toml's DO migrations, its workflows, queue consumers and `<host>/*` route; it exports a `queue`
  handler that retries every message and a no-op `scheduled`, since Cloudflare refuses a consumer on a
  script without one — 11001; its `fetch` is a 503 with `Retry-After: 60` — plain text, except
  that a browser (`GET`/`HEAD` accepting `text/html`, outside `/api/`) gets the uncached animated
  launching page, `rocketflare/placeholder-page.ts`, with the app's escaped display name; the page
  polls `/api/health` every 12 s and reloads into the app on its first 200. Preview it with
  `pnpm web preview:placeholder`) → `github_env`
  (environments — a token with `administration: write`, GitHub's permission for creating one —, `DEPLOYER_URL=${APP_URL}/ci`, `DEPLOYER_AUDIENCE=${APP_URL}`) →
  `worker_secrets` → `email` (non-blocking; skipped with its reason while Setup has no Resend key or
  no verified notifications domain) → `deploy_staging.start|wait|check` → `health` (up to
  20 probes, 30 s apart) → `production` (skipped) → `live` (`app.launched`, a notification).
  The deploy wait and check succeed only on an ACTIVATED staging ticket (`activated_at`, §18.7) —
  never on `finished` + a version: a job that died between upload and activate (its
  `db:migrate:ci` failed) still calls `finish`, and that ticket fails the wait at once with "The
  staging deploy job ended without activating the new version (it stopped after upload — see the
  run)" (plus the ticket's own error), so the launch fails and offers Retry instead of probing
  `health` against the placeholder. The wait reads the newest ticket opened since the dispatch
  (less 30 s of skew) that was not already closed before it, so a Retry never re-reads the ticket
  it is retrying.
- **Why SQL roles** (verified on a real Neon project, Postgres 17.11): a role Neon's API creates
  is `cloud_admin`'s and a `neon_superuser` member (CREATEROLE, BYPASSRLS) — far too much for the
  Worker's `app` — and `neondb_owner`, a member without ADMIN OPTION, cannot grant it on PG16+
  ("permission denied to grant role"). A role `neondb_owner` creates in SQL is ordinary, it may
  grant it, and Neon's API lists it, resets its password, builds its `connection_uri` and accepts
  it as a database owner. `migrator` is no `neon_superuser`, so the step creates `vector` itself
  (the kit's `CREATE EXTENSION IF NOT EXISTS vector` is then a no-op); as `migrator` the kit can
  create tables, its RLS role and `GRANT` that role to `app`. Each role, the membership and the
  database is checked before it is written, so a retry repeats nothing. **Repair**: a project an
  earlier Launch left with API-created `migrator`/`app` (either a `neon_superuser` member) has
  database `app` deleted through the API — only when it has no table in `public` — and those roles
  deleted through the API, then recreated in SQL; with tables, or a `staging` branch already cut
  from them, the step fails saying so and deletes nothing.
- **The adapter** is `pipeline/ports.ts` `defaultPorts()`: `rocketflare/{names,toml,
  placeholder-worker,scaffold-job}.ts` and `scaffold/github-actions-runner.ts`. The Workflow
  depends on the ports only.
- **Waits are rounds**: `…poll#N` reads the ticket row (the truth) and asks whether the job
  itself died, then `…wait#N` parks on the event for one round (30 × 1 min for the scaffold, 15 ×
  3 min for the deploy). The event is a nudge — it only ever says SUCCESS, so a round is how long a
  job's failure can go unseen. The `…wait` row is opened `running` by the step that dispatched the
  job (`openWait`), so the job's row shows it running between dispatch and finish; each
  poll records the job's GitHub run on it (`runId`, `runUrl` = `html_url`) the moment the run is
  listed, and the view returns it as the step's `url`. A run that ends `failure`/`cancelled`, or a
  dispatch GitHub lists no run for within 10 minutes (`SCAFFOLD_START_WINDOW_MS`), fails the wait
  at that poll with a scrubbed sentence — and, when `APP_URL` is not public, says that the job
  could not call Launch back. A poll that finds a failure answers `{ done, error }` and the
  Workflow throws outside the poll's `step.do`, so its retries do not fail it again.
  **The same poll also runs on READ** (`pipeline/wait-poll.ts`, from `GET /api/apps/:id/pipeline`
  through `pipeline/read.ts`; never throws into the request): for the latest create run whose
  `scaffold.wait` or `deploy_staging.wait` row is `running`, the one request whose compare-and-set
  on a `readPolledAt` stamp in the row's `external_ids` lands (at most once per 20 s per wait,
  `WAIT_POLL_WINDOW_MS`; the row's `updated_at` — the reconcile's staleness clock — is left alone)
  runs `scaffoldPoll` / `deployPoll` with the request's credentials. So the run link appears as soon
  as GitHub lists the run, and a job that died (a red gate never reaches `/ci/deploy`, so no event
  comes) fails its wait at the next page read instead of the Workflow's next round — which, under
  local wrangler, may never come (a `waitForEvent` timeout does not always wake the instance, and
  the reconcile rightly leaves a `waiting` one alone). A wait that settled on read sends its event
  (`SCAFFOLD_FINISHED_EVENT` / `DEPLOY_FINISHED_EVENT`) to `apps.launch_instance_id`, so a live
  instance wakes and its next poll proceeds or fails the run; a failed one also fails the app with
  `app.launch_failed` there and then. `markLaunchFailed` writes only a status change, so the
  Workflow's own failure path after it (or after a Stop) adds no second audit row. The run derives
  `failed` from the row, so Retry is offered even if the instance never wakes.
- **Retry** (`POST /api/apps/:id/pipeline/retry`, `manage App`, only a `failed` run): a new
  instance `<runId>-rN` with the same run id, `N` one past the highest an earlier retry's
  `app.pipeline.retried` audit row recorded (local wrangler hands back an existing instance id
  instead of refusing it, so trying `-r1` again silently started nothing), so succeeded steps are
  skipped and the failed one resumes with `ctx.prior`; a failed wait restarts the job it waited
  on — for the scaffold on a FRESH ticket (the old one is withdrawn even if no job ever claimed
  it), with the job files on `main` first brought up to this Launch's (the skipped `repo` step
  committed an older copy; an unchanged tree commits nothing); a retried `placeholders`
  sends only the DO migrations the script does not have. Refused 409 `launch_not_reachable` for a
  create run while the public URL fails its check (§18.2). The live instance id is kept on
  `apps.launch_instance_id`, and `/ci/scaffold/done` and `/ci/deploy/:id/finish` send their events
  there (`pipeline/instance.ts`).
- **Re-scaffold** (`POST /api/apps/:id/pipeline/rescaffold`, `manage App`, `pipeline/rescaffold.ts`):
  the kit pin is read only by the scaffold, so a launch that failed LATER (the app's CI red on a
  kit bug a newer release fixes) cannot pick a newer kit up by Retry. Before the first deploy the
  repo holds only the scaffold and Launch's config commit, so it may be scaffolded again from the
  CURRENT pin — only while the create run is `failed`, the app is neither `live` nor `archived`,
  and it has never deployed (`rescaffold-check.ts`: no `deploy` ticket with `activated_at` — an
  upload `finish` closed before activation never ran, and neither did a job that died at its gate).
  A never-activated ticket that was handed the migrator credential is not evidence by itself — the
  kit's `db:migrate:ci` runs its role phase (one transaction) before any migration, so a job can
  get the credential and change nothing — so the POST asks that environment's DATABASE
  (`rescaffold-database.ts`; staging, and production too if one of its tickets got the credential):
  as `neondb_owner` over Neon's HTTP SQL (password reset on the branch, direct URI for `app`, one
  statement per call, both dropped), it counts `drizzle.__drizzle_migrations` rows (drizzle's
  default table, which the kit's migrate script writes) and tables in `public`. Zero and zero →
  allowed; otherwise 409 `app_already_deployed` with the count ("staging has 12 applied
  migrations"); Neon unreachable, not connected, or no branch recorded → refused conservatively,
  saying why. Only that case makes a vendor call, and only the POST: `GET …/pipeline` never asks
  Neon — it offers the button with `rescaffoldChecksDatabase: true`, and the confirm dialog says
  Launch will check the database first (no cache to go stale; the 409's message is the answer).
  Otherwise 409 `run_not_failed` / `app_live` / `app_archived` /
  `app_already_deployed` / `no_run`, saying a deployed app takes a kit upgrade. It is a retry with
  the repository's steps re-opened, their ids kept for `ctx.prior`: `scaffold.start` is failed
  "Reset by re-scaffold" (so the run stays retryable), `scaffold.wait|verify`, `write_config`,
  `placeholders`, `deploy_staging.start|wait|check`, `health`, `production` and `live` go back to
  `pending` (a run with a pending row derives `running`, so the page shows the new instance
  working, and Stop and reconcile treat a pending row as the next step), then `retryPipeline`
  starts `<runId>-rN`. `scaffold.start` finds its old ticket `finished`, opens a fresh one,
  re-commits the job files the last job deleted and dispatches the job with the pin as it is now;
  the job replaces the tree and fast-forwards `main` on the app's history; `scaffold.verify` checks
  the NEW kit version (or, for a commit pin, the NEW commit); `write_config` re-applies the config onto the fresh tomls; `placeholders`
  re-PUTs the Workers with the migrations after the recorded tag only, keeping the route and the
  secrets (`keep_bindings: ['secret_text']` — a script upload replaces the bindings otherwise).
  `reserve`, `repo`, `neon`, `cloudflare`, `oidc_client`, `github_env`, `worker_secrets` and `email`
  are kept: none reads the repository's content. `GET …/pipeline` answers `canRescaffold` (the
  run allows it, the database check aside; the viewer still needs `manage App`),
  `rescaffoldChecksDatabase` and `templateTag` (the pin's label, when it
  does: the tag, or `@<short sha>` for a commit pin — `templatePinLabel`, so the button reads "Re-scaffold
  from kit @6ee75e8"). Audited `app.pipeline.rescaffolded` (old and new kit label, and the new
  commit) beside the retry's own row.
- **The job's own files go in `[skip ci]`.** `repo`'s "Add the Launch scaffold job" and a
  re-dispatch's "Update the Launch scaffold job" (`SCAFFOLD_JOB_COMMIT_MESSAGES`) end in
  `[skip ci]`: pushed to `main`, they would run the app's own `ci.yml`, whose Biome lints
  `.launch/scaffold.mjs` and fails — a red run on `main` for a commit that is not app code. It
  suppresses push/pull_request-triggered workflows only; the dispatched `launch-scaffold.yml`
  runs. `write_config`'s "Configure the app for Launch" does NOT carry it: that is app code, and
  its green CI is what lets the deploy skip re-gating (kit 0.15.3's gate-once).
- **Stop** (`POST /api/apps/:id/pipeline/cancel`, `manage App`, only a `running` create run —
  409 `run_not_running`; `pipeline/cancel.ts`): the way out of a run stuck in a wait. Its running
  step (or, between steps, the next one) is marked failed "Stopped by <email>", an unclaimed
  scaffold ticket is withdrawn, the live instance is terminated (best effort — one that refuses
  finds its wait row failed at its next poll and fails the run itself), the app is `failed` and
  `app.pipeline.cancelled` is audited. Retry then restarts that step.
- **Reconcile** (`pipeline/reconcile.ts`, from `GET /api/apps/:id/pipeline` and before a retry;
  never throws into the request): a run whose Workflow died under a step — `wrangler dev`
  reloading the Worker mid-step, an uncaught throw outside `runStep`, the platform's limits — is
  failed on read, so Retry is offered instead of a step `running` for ever. Only a run that derives
  `running` and wrote no row for 3 minutes (`RECONCILE_STALE_MS`) is looked at, and only by the
  one request whose compare-and-set on its newest row's `updated_at` lands, so a run is asked about
  at most once per 3 minutes (no migration: the timestamp is the throttle). The instance is
  `apps.launch_instance_id` for a launch, and for a teardown `<runId>` or the `<runId>-rN` its
  latest `app.pipeline.retried` row recorded. `errored`, `terminated`, `complete`, `unknown` or
  not found → every `running` row (between steps: the next step) is failed "The launch's Workflow
  stopped (<status>) while this step ran — Retry resumes from here", keeping its recorded ids for
  the retry's `ctx.prior`; a launch's app becomes `failed` with `app.launch_failed` (as the
  Workflow's own failure path), and `app.pipeline.reconciled` is audited. `queued`, `running`,
  `waiting` (a wait parked in `step.waitForEvent`) and `paused` are left alone — except a non-wait
  step whose attempt started over 7 minutes ago (`STALLED_STEP_MS`) while the instance claims
  `queued|running`: an attempt is capped at 5 minutes and every retry re-claims the row, so that
  is the local engine keeping its persisted `running` after a reload killed the step; it is failed
  the same way and the instance terminated (best effort).
- **UI**: "Create app" (a live slug check and a preview of `<slug>-staging.<apps domain>`, the
  domain from `GET /api/apps`' `appsDomain`; a 409 `launch_not_reachable` says why and links to
  Setup › Public URL), the step list polled while a run is owed — running, done and failed each
  with its own glyph, a job's "View run" link to its GitHub Actions run, the failed step's error
  — "Retry from failed step" and, while `canRescaffold`, "Re-scaffold from kit <tag>" (a confirm
  saying `main` is replaced and the database, storage, Workers and secrets are kept), "Stop" (with
  a confirm) while a launch runs, the deploys card and
  Archive (`pages/apps/components/`). The list is the VIEW's rows, not the Workflow's steps: a CI
  job's three rows read as one — "Scaffold from the template" (`scaffold` = `scaffold.start` +
  `.wait` + `.verify`) and "Deploy staging" (`deploy_staging` = `.start` + `.wait` + `.check`),
  so a launch is 15 rows (`APP_LAUNCH_VIEW_STEPS`), the teardown's 12 unchanged. `pipelineView`
  merges them with the pure `mergePipelineParts` (`@launch/shared/launch-pipeline`): failed if a
  part failed (its error, the latest failure's), running while a part runs or between parts,
  succeeded when all are done, skipped when all were; the wait's run URL, the highest attempt,
  the earliest start and — once settled — the last finish. The rows stay separate underneath, and
  cancel, retry and the audit name the real step (`scaffold.wait`).

**Known gaps:** a dead run is only noticed when someone reads its page (there is no cron), 3
minutes after its last row at the earliest — about 9 for a stalled local step; under `wrangler dev`
a WAIT whose instance died, or a run that died between steps, can still read `waiting`/`running`
from the local engine and is left alone — Stop it (a teardown has no Stop); waits are rounds, so a lost event — or a job's failure — costs up to one round (1
minute for the scaffold, 3 for the deploy) while nobody has the app's page open (with it open, the
read poll sees a dead job within 20 s; nothing polls a wait without a reader), and a job that
SUCCEEDED but whose event was lost still waits for the Workflow's next poll to go on (the read
nudges it; a local instance that never wakes needs Stop and Retry); a run that GitHub lists but leaves `queued` (no runner
free) is waited on for the full 30 minutes; a GitHub API error while polling is retried by the poll
step and then fails the run as that error (no run link); the
`production` step is always skipped (the first production release is a separate, approved
deploy); a re-scaffold replaces anything committed to `main` since the scaffold (history keeps
it), and two retries or re-scaffolds posted at once can each start an instance (no claim row);
when a deploy got the migrator credential the page offers Re-scaffold before the database is
checked, so the button stays on offer after the POST refused it (the 409 says why), and the check
counts drizzle's own table and `public` only — a migration that wrote solely to another schema and
recorded nothing would not be seen; a new DO migration tag in a later build is refused by the gateway (the Versions API cannot
apply it); `write_config` answers only the kit's one KV binding (`RATE_LIMIT_KV`) — a toml declaring
another fails the step by name; the owner group is not mapped to GitHub team access; everything is
proven against the FakeCloud only, except the Neon roles above (plan §5 lists what the first real
run must still confirm: `db:migrate:ci` as `migrator` end to end; that deleting an API role through
Neon's API works on the repair path; version upload onto a placeholder with
`v1`, workflows and consumers on it, schedules, a 5–10 MB upload, per-app routes over Launch's
catch-all; the GitHub App's permissions, how soon a pushed workflow is dispatchable, whether an
installation token may push workflow files, the OIDC claim shapes, `ci.yml` against the 45-minute
wait).

### 18.6 The scaffold job

Launch cannot run the kit's rename, plugin install and gate in a Worker, so the `repo` step commits
`.github/workflows/launch-scaffold.yml` and `.launch/scaffold.mjs` (`rocketflare/scaffold-job.ts`)
and `scaffold.start` opens an `approved` scaffold ticket and dispatches the job
(`GitHubActionsScaffoldRunner`, behind the `ScaffoldRunner` seam a P3 sandbox will also fill). The
job trades its GitHub OIDC token at `POST /ci/scaffold/token` for a one-hour installation token
scoped to that repo (`contents` + `workflows` write — `GITHUB_TOKEN` can never push workflow files)
and the plan, once per ticket; clones the pinned kit at its tag and checks the commit (a commit
pin: fetches the SHA itself, below); patches
around rocketflare#37 (kits before 0.15.2 only — from 0.15.2 `KIT.preservedPattern` keeps the org and the
patch is skipped); runs `rename.mjs --skip-install` and then `pnpm install
--no-frozen-lockfile` itself (on a runner `CI=true` makes the rename's own install frozen, and it
fails on the workspace names the rename just changed); installs the default plugins; deletes the kit-only
workflows and `.launch/`; runs `lint`, `typecheck` and `test:config`; pushes `main`; revokes its
token; and calls `POST /ci/scaffold/done {commit}`.

The job needs Launch reachable at `APP_URL` from GitHub's runners — `POST /api/apps` refuses
while it is not (§18.2). If it dies anyway (a red gate, a moved tag, Launch unreachable after all),
the next scaffold poll sees the run's conclusion through `GitHubActionsScaffoldRunner.poll` — which
finds the run by listing the workflow's `workflow_dispatch` runs created since the dispatch, since
the dispatch returns no run id — and fails `scaffold.wait` with the run's link; a retry dispatches
a new job on a new ticket. A re-scaffold (§18.5) runs the same job over a repo that already
holds a scaffold and Launch's config commit: the tree is replaced by the pinned kit's and the
commit fast-forwards `main` on the app's history (`scaffold-script.test.ts` covers it). Under `pnpm dev` the job reaches Launch only through the tunnel, and the
Vite dev server now proxies `/ci` to wrangler (it did not, so a job calling the tunnel got the SPA's
`index.html`).

The default pin (`DEFAULT_TEMPLATE_PIN`) is kit **0.16.0**: 0.15.0 plus the rename fixes a
hyphenated slug needs — the evals script's `report.<slug>` identifier (0.15.1), then the API-key
prefix (`<snake>_`), the `rocketflare-dev/` references, the test Compose project and a stale
`docs/plugin-api.md` (0.15.2, whose CI now gates a copy renamed to `my-app`), then an app CI a
copy can pass (0.15.3: the default-plugins gate — which failed every Launch-made app with "already
installed" — runs only in the kit, a commit already green in CI skips the deploy's gate, and the
neon run's cron tests no longer time out), then a deploy job that runs only the parity test (0.15.4:
the whole config project needed git history its depth-1 checkout lacks), then a role setup that
works as `migrator` (0.15.5: the kit's db-roles no longer alters CREATEDB/CREATEROLE when they are
already off, which Postgres 16+ refuses to a role without CREATEDB), then a magic link that
opening does not spend (0.15.6), then `pnpm test:ephemeral` — the suite on a throwaway Neon gate
branch, no Docker — which a session's ship gate ran (0.15.7, §18.13), then the kit's own tests
moved to `apps/web/tests/kit-only/`, which the rename deletes, so an app's gate no longer fails on
the kit's version chain once the app releases a version of its own (0.15.8), then `pnpm gate` —
lint, typecheck, test, build defined once and a copy's ONE CI job, `pnpm test` the one full run (on
a Neon gate branch when `TEST_DATABASE_BRANCH` is set), `test:ephemeral` removed, and the kit's own
workflows (`kit.yml`, `plugin-ci.yml`, `notify-plugins.yml`) `kitOnly`, so the rename strips them
(0.16.0; the ship gate's contract, `SHIP_GATE_KIT_VERSION`, §18.13). Launch's scaffold still deletes
`notify-plugins.yml`, `plugin-ci.yml` and the old `tests/config/plugin-ci.test.ts` — a no-op from
0.16.0, kept for an older pin — and gates with `pnpm gate lint typecheck` + `pnpm web test:config`
on a kit that has `pnpm gate` (`pnpm lint`, `pnpm typecheck` by name on one that does not). A
`launch_settings.template_pin` row overrides it — the ONE source of the pin; there is no env var.

**Kit version (Setup).** A platform admin sets the pin on the Setup page's Kit version card
(`/settings/platform/setup`, `KitVersionCard`): it shows the pin new apps get (repo, tag or
"Unreleased commit", short SHA; Default or Overridden) and takes either a **release tag** (typed, or
picked after "List tags" — `GET /api/platform/setup/template-pin/tags`) or a **commit** (a SHA on
any branch, or "Pin latest main"). `PUT /api/platform/setup/template-pin`
(`templatePinRequestSchema`) resolves it SERVER-side through GitHub as the connected GitHub App (a
`contents: read` installation token, revoked after; the kit repo is public, so it need not be
installed there; no App → 409 `github_app_not_configured`): a tag through `GET …/git/ref/tags/{tag}`,
an annotated tag dereferenced through `GET …/git/tags/{sha}`; a commit through
`GET …/commits/{ref}`, which also proves it is in that repo. A ref the repo lacks is 422
`kit_ref_not_found` and nothing is stored (`services/launch/kit-pin.ts`). "Reset to default" is
`DELETE …/template-pin` (the row deleted, so the default moves with Launch again). Both audit
`setting.changed` with the pin before and after. A commit pin shows "Unreleased commit — for
development".

**A commit pin** (`templatePinSchema` with no `tag`): a kit commit that has no release, for
testing a kit fix without cutting a release each time. The plan's `tag` is then `null`
(`scaffoldPlanSchema`); the job `git init`s the kit, `fetch --depth 1 origin <sha>` (GitHub serves
any reachable commit) and `checkout FETCH_HEAD`, refuses unless HEAD is the pinned SHA, and logs
"Kit <repo> @ <sha> (unreleased commit)"; its commit is "Start from Rocketflare @<short sha>". The
#37 patch is unchanged (it keys off the kit's own rename-lib). `scaffold.verify` then demands no
version equal to a tag — only that `.rocketflare.json` records one — and requires `kit.commit` to
be the pinned SHA (a release pin checks the commit too when the manifest records one). The app
records `template_ref` = the SHA, `template_commit` = the SHA and `template_version` = the kit
version the manifest reported (e.g. 0.15.4). `app.scaffold.token_issued` audits `kit:
<repo>@<tag>` for a release and `<repo>@<sha>` for a commit pin, plus `kitCommit`.

**Known gaps:** a real scaffold on a GitHub runner has run green (kit 0.15.1: token trade, clone,
rename, install, plugins, gate, push), but that app's own CI then failed on the API-key prefix,
fixed in 0.15.2, and its deploy then failed on the default-plugins gate and neon timeouts, fixed in
0.15.3; the 0.15.3 deploy's gate went green and its deploy job failed at the parity step, fixed in
0.15.4 — a staging deploy past the parity step is still unproven. The session image carries the pnpm store of the default pin's
kit (`SESSION_KIT_TAG` = `DEFAULT_TEMPLATE_PIN.tag`, 0.16.0; a config test fails when they drift);
an app pinned to another kit still falls back to the registry for what differs. The Kit version card's GitHub lookups
and the commit-pin fetch are proven against the FakeCloud and local git repos only — that an
installation token reads a public repo outside the installation, and a real runner's `fetch` of a
SHA that is not a branch tip, are unconfirmed; the catalogue still shows a commit-pinned app by
its `template_version` alone (the SHA is on `template_ref`); `.launch/scaffold.mjs` is not itself
Biome-clean — `[skip ci]` is what keeps it off the app's CI.

### 18.7 The deploy gateway

An app's `deploy.yml` runs the kit's `scripts/deployer.mjs` against `/ci/deploy` (routes/CLAUDE.md)
holding no credential. Tickets live in `deploy_tickets`, every transition a compare-and-set
(`deploy/tickets.ts`, `pending → approved|rejected → uploaded → active → finished`, or `failed`).
**Deployed means `activated_at`**, set by the `uploaded → active` compare-and-set in `activate`
and nothing else (`isDeployed`): an uploaded version is not a deploy, and `finish` — which the job
runs `if: always()` — closes a ticket `finished` from any open status, so `finished` + `cf_version_id`
may be an upload that never went live. A deploy ticket `finish` closes without an activation gets
`error = 'finished before activate'` (kept if it already had one; audited on `deploy.finished` with
`activated: false`), and the app page badges it "not activated". Every "has it deployed" reader —
the launch's deploy wait/check, re-scaffold, the deploys card — uses `activated_at`; the
environment's `last_deploy_*` (Promote's "staging runs this release"), a release's
`staging_active`/`production_active` and P5's grant repair pushes are all written by `activate`
itself. Migration 0027 backfilled it from each ticket's `deploy.activated` audit event (then
`updated_at` for a still-`active` ticket with none); a `finished` ticket with neither stays NULL.
Staging is auto-approved; production claims a live pre-approval bound to the run's ref (a granted
Promote, or "Deploy to production" — §18.17), or opens `pending` plus a `deploy.production`
approval that an owner or admin decides (inbox or app page) within the job's `WAIT_SECONDS`. Upload parses the toml (`smol-toml`) and `binding-check.ts` allows only the app's
recorded KV ids, queues, bucket and workflows, in-script Durable Objects, `ai`, `assets` and vars,
refusing every other binding kind, any route and a newer DO migration tag, each as `"<kind>
<binding>=<value>"` — a refusal is 403, the ticket `failed`, and no Neon call. Otherwise the assets
and version go up (`keep_bindings: ['secret_text']`, `RELEASE_VERSION`), the `migrator` password is
reset and returned once as `migratorUrl`, and `activate` deploys it at 100%, applies the crons and
workflows and resets the password again; `finish` revokes if still live — including after an
upload that was never activated.

**Deploy progress** (`deploy/progress.ts`): the app overview's "Deploying" panel
(`GET /api/apps/:id/deploys/latest`, each environment's newest ticket) and the catalogue's
`latestDeploy` (the newest in-progress deploy, else the newest) show a deploy as it runs —
dispatched → approved → uploaded → migrating → activating → live, or failed with a sentence — with
its GitHub run. The phase is DERIVED from the ticket, never stored: an unclaimed approved
pre-approval is `dispatched` (failed once it lapses), a run's approved ticket `approved`,
`cf_version_id` `uploaded`, `credentials_issued_at` `migrating`, `activation_started_at` (migration
0028; `activate` stamps it before its vendor calls, informational only) `activating`, and
`activated_at` live; a pending production ticket is `awaiting_approval`. Like the launch's wait
(`pipeline/wait-poll.ts`), the read polls: for each in-progress ticket a run has claimed
(`approved`/`uploaded`, at most five per read) a compare-and-set on `run_polled_at` (0028) lets
one request per 20 s ask GitHub for the run (`actions: read`, token revoked after); a run that
completed, or whose latest attempt is newer than the ticket's, ended without the deploy, so the
ticket goes `failed` (with `finished_at`) once, the migrator is revoked if still live (best effort),
`deploy.failed` is audited by `system` with `polledOnRead`, and the release run fails. Nothing in
the poll can throw into the read. The overview and the catalogue poll every 5 s while a deploy is
in progress and not waiting on a person; when it settles the app's queries refresh once.

**Known gaps:** a GitHub-only author (a person who dispatched or published by hand) is not a
Launch user, so the approver ≠ author rule cannot exclude them; deploy progress sees a run only
once it has claimed a ticket — a dispatched production run that dies in its gate before `start`
shows `dispatched` until its pre-approval lapses (15 minutes), and an in-progress ticket nobody
reads is never polled (no cron sweeps them); the Versions API does
not do what `wrangler deploy` does — DO migrations (a new tag is refused), registering new
workflows, queue consumers and crons are Launch's job, so only the ones Launch knows are applied.

### 18.8 Archiving an app (teardown)

`POST /api/apps/:id/teardown {confirmSlug, deleteRepo?}` (`manage App`) starts
`APP_TEARDOWN_WORKFLOW`. It gathers the ids from EVERY create run's `app_operations` plus
`app_environments` and deletes in reverse: routes, queue consumers, Worker scripts, workflows,
queues, R2 (emptied first), KV, Resend keys, the Neon project; the OIDC client is disabled, not
deleted; the repo is archived (deleted only with `deleteRepo`). A 404 is success, so a half-created
app tears down too. It ends `archived` with `archived_at` and `app.archived`; retry is the same
`<runId>-rN` rule, and the same reconcile (§18.5) fails a step whose teardown Workflow died under it
— audited `app.teardown_failed` and `app.pipeline.reconciled`, the app keeping its status — so the
retry is offered.

**Known gaps:** an IMPORTED app's teardown only disables its sign-in client — Launch did not create
its resources and leaves them, and its repo, alone; a deleted repo is gone for good.

### 18.9 Coding sessions: the lifecycle

A session is a container running Claude Code against one app's repo, with a live preview, ending in
a pull request (spec/07). State lives in Postgres — `sessions` (status, request columns, sealed
credentials, metering, PR) and `session_events` (the append-only log the page, the CLI and the
stream read) — and one `SessionWorkflow` instance per session (`workflows/session.ts`, step bodies
in `services/sessions/steps.ts`) does all the work. **Routes never run anything**: they write a
request column as a compare-and-set on `status` (`pending_message`, `requested_action` =
`ship|end|resume`, `cancel_requested_at`) and wake the instance (`SESSION_WAKE_EVENT`, empty
payload) with `wakeOrRestart` (`lifecycle.ts`) — a lost instance (retention, a `wrangler dev`
reload) is restarted as `<id>-rN` from the row.

- **Start** (`POST /api/apps/:id/sessions`, `create Session` on an app the caller can read): refused
  before any write with 503 `sessions_not_configured`, 409 `app_has_no_repo`, `sessions_paused`,
  `session_limit` (`maxConcurrentPerApp` active) or `session_budget_exhausted` (the app's month);
  then the row with the policy SNAPSHOTTED onto it, audit `session.created`, the instance.
- **Boot**: `claim` → `db` (the app's `dev` branch ensured, with `session_owner` and the kit's RLS
  role `rocketflare_app` — NOLOGIN, held by `session_owner` WITH ADMIN — made in SQL by
  `neondb_owner`; the first session PREPARES it — migrate + seed — then branches) →
  `sandbox.start` → `repo` (clone, `session/<short>`,
  `.claude/settings.local.json`; `GIT_TERMINAL_PROMPT=0`, the whole checkout under a `flock` on
  `/workspace/.launch/repo.lock` so overlapping attempts queue, and a failure reports git's last
  15 stderr lines) → `bootstrap` (the kit's bootstrap on the session's own database)
  → `dev` (`pnpm dev`, UI :5173, API :8787 — never :3000) → `ready` + `preview.ready`. Each boot
  step writes a `step` event (the page's checklist). The first successful `bootstrap` records the
  checkout's `apps/web/migrations` hash (`sessions.migrations_hash`); a later one (a cold resume) is
  against a prepared database, so it never re-seeds or re-checks it and migrates only when the hash
  changed. The prepare records its checkout's hash on `apps.session_db.migrationsHash`, and a
  session branched from a `ready` `dev` STARTS from it (`branchStep`; `unknown` for a `dev`
  prepared before it was recorded — then it migrates once), so its first boot is a resume's too — through the bootstrap preload, which answers the kit's `pnpm seed` / `db:migrate` /
  `web db:check` children (`LAUNCH_BOOTSTRAP_SKIP`, `rocketflare-dev.ts`): the kit has no flag for
  it. On EVERY boot the preload skips `db:check` and runs `db:migrate` as the kit's migrator alone
  (`tsx scripts/migrate.ts`, no `db-roles` before or after — its role is on `dev` already, its
  grants matter only under `TENANT_SCOPE_MODE=enforce`): each of the kit's database scripts opens
  its own WebSocket through the container's egress interception, and on real Cloudflare containers
  a later one of those hung. A prepare opens two (migrate, seed); a session on a `ready` `dev`
  none, or one when its migrations are newer; a session branched while `dev` is being prepared
  elsewhere two (it seeds its own branch).
- **A session never changes a tracked file for its dev setup** (`rocketflare-dev.ts`). The kit's
  `bootstrap --offline` (a sandbox has no Cloudflare login, so `[ai]` must be off) comments the
  `[ai]` block out of BOTH wrangler tomls in place, and the checkpoint commits the whole tree — so
  the first real ship (hola-world PR #2) carried the toggle and a `worker-configuration.d.ts`
  without `AI`, which merged would have taken Workers AI out of the app's production. Now: the
  bootstrap preload drops the kit's writes to the two tomls and the types (`LAUNCH_BOOTSTRAP_KEEP`);
  every dev start (`startDevServer`) first writes `apps/web/wrangler.session.toml` — the CURRENT
  `wrangler.toml` with `[ai]` off, the kit's own toggle — and wrangler's own redirect file
  `apps/web/.wrangler/deploy/config.json` (`{ "configPath": "../../wrangler.session.toml" }`), which
  `wrangler dev` follows ("Using redirected Wrangler configuration.") and `wrangler types` does not,
  so the gate's `pnpm typecheck` still generates the types from the tracked toml, `AI` included.
  Both files are git-ignored (`.git/info/exclude`, written by the checkout and the checkpoint's
  scan; `.wrangler/` is also in the kit's `.gitignore`). No kit change: `pnpm dev` runs as the kit
  wrote it. **Branches an earlier Launch checkpointed** are healed on their next boot (every
  `bootstrap#K`, the restored-workspace path too, `healDevSetup` against `sessions.base_sha`): a
  toml whose `[ai]` is off where the base's is on gets the block back (the agent's other edits
  kept), and the types are the base's again when they differ from it ONLY by `AI: Ai;` and the
  generated header (otherwise the ship gate's typecheck regenerates them and `ship.commit` commits
  that); the next checkpoint commits the repair. **The checkpoint's guard** (`checkpoint.ts`
  `DEV_SETUP_GUARD_SCRIPT`, after `git add`) refuses to commit the offline toggle — a staged toml
  whose live `[ai]` became `# [ai]`, or types losing `AI` while the staged toml keeps `[ai]` — with a
  `CheckpointError('guard')`: nothing committed or pushed, the `error` event names the files, and a
  ship stops at `ship.save`.
- **Idle** is judged by `last_activity_at`, not by the wait alone: a live session's `wait#N`
  times out after what is left of the policy's `idleSuspendMinutes` counted from
  `last_activity_at` (`idleMinutesLeft`), and `suspend#N` with reason `idle` re-reads the row and
  does nothing when the stamp is younger than the window — the next `inspect` waits out the rest.
  A turn, a checkpoint, the model proxy and **the person's use of the live preview** move the stamp
  (the gateway, throttled to one write a minute, §18.12); nothing wakes the Workflow for a preview
  request, which is why the timeout re-checks. An open session page alone (its event stream) does
  NOT count: a forgotten background tab would keep a container up for the whole
  `maxSessionHours`.
- **Loop**: `inspect#N` reads the row and picks one of `wait#N` (idle timeout: suspend; a warm
  suspended session's window: cool; a suspended session's expiry: end; the checkpoint debounce:
  `checkpoint#N` and wait on), `turn#N`, `checkpoint#N` (a debounce already due), the ship round (`ship.claim#N` … §18.13), `suspend#N` (a drain), `cool#N` (a drain, or a warm window already
  over), `resume#N` (boot again with `#K` names — warm: `sandbox.start#K` → `dev#K` only; cold:
  the whole boot, then restore the transcript), `end#N`. A message that arrives while
  booting waits on the row and runs as soon as it is `ready`. **`cleanup` always runs**: destroy
  the container, delete the ship gate's branches and then the database branch, forget the sealed
  credentials, settle `ended` (a
  `shipped` or `failed` session keeps its status), audit `session.ended`.
- **Warm suspend** (`warm.ts`, two thresholds): an IDLE suspend (`idleSuspendMinutes`)
  checkpoints and KEEPS the container, dev server and all (`sessions.container_kept_at`); the
  preview answers 503 as for any suspended session. A resume inside `SESSION_WARM_KEEP_MINUTES`
  (45) finds the boot marker `sandbox.start` wrote, reuses that `bootId`, re-applies the allow-list
  with the session database's hosts, and runs only `dev#K` — which reuses the dev server when both
  ports still answer, else `pnpm dev:stop` and starts it again. After the window `cool#N` destroys
  the container and the next resume boots cold; a drain cools at once, and the SDK's `sleepAfter`
  (90 min, longer than the window — a config test pins it) or a recreated container (no marker)
  makes the resume cold too (`onStop` clears `container_kept_at`). A drain, a rollout, an end and a
  lost instance whose container could not be salvaged still destroy at once (a salvaged one is kept
  — Reconcile, below). A warm container is billed as container time while it waits.
- **Workspace backups** (`workspace-backup.ts`, `SESSION_WORKSPACE_BACKUP`: `binding` under
  `APP_ENV=development`, `off` deployed unless `presigned` is set up — `docs/DEPLOY.md`): before a
  destroying suspend (a drain, after its checkpoint) or a `cool#N` destroys the container, the
  Sandbox SDK's `createBackup` archives `/workspace/app` (`node_modules` and the app's `.dev.vars`
  included) into `BACKUP_BUCKET` (the `FILES` bucket, under `backups/`), recorded on
  `sessions.workspace_backup` with its `git rev-parse HEAD` and image version; a newer backup and
  `cleanup` delete the old one. A cold resume runs `restore.check#K` and, when the backup's commit
  is the branch head (`head_sha`) and its image is this one, `restore#K` (`restoreBackup`, then the
  HEAD re-checked) instead of `repo#K`; the `bootstrap#K` after a restore whose migrations did not
  change installs and bootstraps nothing — it re-applies the allow-list and the dev-server keys.
  Anything else — no backup, the branch moved on, a restore that fails — clones and installs, and
  the checklist line says "Cloning instead: …". A backup never fails a suspend or a resume.
- **Who**: the creator, the app's owners and admins may see and drive a session (`access.ts`); any
  other caller gets the same 404 as a missing one. Extending the budget is owners and admins only.
- **Expiry** (`sessions.expire`, `*/5`): the backstop for a suspended session whose instance is
  gone — it asks for `end`, or cleans up inline without `SESSION_WORKFLOW`.
- **Never hang silently.** Every sandbox call a step makes is bounded (`deadline.ts`:
  `boundedSandbox` — 90 s for a control call, a command's own timeout plus a minute, 20 min at
  most) and so is every Neon call (5 min); a call past its deadline fails the step with "<step>: the
  sandbox (<call>) did not answer within N s". A failed command's error carries its last 40 lines
  of output with the database URI scrubbed, shown in the checklist and `sessions.error`, and a
  failed session's page offers "Start a new session". `sandbox.start` writes a boot id into the
  container and every later boot step checks it: a container recreated EMPTY under the session
  (Docker's OOM killer on a laptop) fails the step as "The session container stopped while … and
  came back empty" rather than working on nothing. The dev step's port wait checks the dev
  server's pid and fails at once, with its log's tail, when it exits. A boot step polls the row every
  10 s: **End** mid-step stops it and the session ends (not fails) — the button reads "Ending…" —
  and it writes a heartbeat (`last_activity_at`) every 30 s.
- **Reconcile** (`reconcile.ts`, on `GET /api/sessions/:id`, on `POST /:id/end` with a 75 s window,
  and on the `*/5` cron): a `requested`/`booting`/`ending` session with no heartbeat for 3 minutes
  (15 for `ending`) is asked about its instance, once per window (a compare-and-set on
  `last_activity_at`). Lost, errored or terminated — or "running" with a boot step that quiet,
  which is how the local engine reports a step a `wrangler dev` reload killed — the instance is
  terminated and the session settled: `ending` when the person asked to end it, else `failed`
  naming the step that was running; then a FRESH instance (`restartSessionInstance`) does the
  cleanup, because `claim` sends an `ending` session, and a settled one with no `ended_at`, straight
  to `cleanup`. **A `working` turn** is covered the same way — a running turn writes the heartbeat
  every 10 s from its cancel watch (`turn.ts`) — but a dead turn is not a dead session, and its
  container usually outlives the instance (a reload or a deploy kills the step, not the sandbox):
  the row is LEFT `working`, the dead instance terminated and a fresh one started, whose `claim`
  sends every live session (`ready`/`working`/`blocked`/`shipping`) to **`salvage`**
  (`steps.ts`) before anything is destroyed: if the container still carries its boot marker, the
  orphaned Claude Code process is stopped by its pid file (SIGTERM, 5 s, SIGKILL — the turn's own
  kill script), then a checkpoint runs (`reason: 'salvage'` — commit, push and the transcript to R2,
  so `--resume` keeps the conversation). A container whose turn is confirmed stopped is KEPT
  (`container_kept_at`) whether or not the checkpoint worked — when it did not, the workspace is the
  only copy of the work — and the loop's resume goes WARM (`dev#K` only); an unreachable or empty
  container is destroyed and the resume is cold, as before. The turn is closed by the salvage with
  what happened: `turn.failed` "…Launch stopped Claude Code and saved your work…" / "…could not
  save your work to the branch (…); it is still in the session's workspace…" / "…could not save
  its work: the sandbox could not be reached…" — or `turn.interrupted { cancelled }` when a Stop was
  pending. (Only when no fresh instance can be started is the turn closed by the reconcile itself,
  `ready`, so it does not spin.) The salvage writes the heartbeat while it runs, so it is never
  mistaken for another dead turn. **Stop without a turn step**: only the turn step polls
  `cancel_requested_at`, so a `working` session with a Stop pending is judged after 30 s of quiet
  (`SESSION_CANCEL_STALL_MS`, three missed beats) instead of 3 minutes, and `POST /:id/cancel`
  reconciles at once — a fresh heartbeat costs nothing (the live step reads the cancel within 2 s),
  a stale one terminates the dead instance and starts the salvaging one; the route runs nothing in
  the sandbox. The same path cleans up a session settled `failed` by hand whose branch was never
  deleted. **A conversation that cannot come back is forgotten**: a cold resume whose
  `claude_session_id` has no transcript to restore (or one the container does not hold after the
  write) clears it with an `error` event ("The earlier conversation could not be restored; Claude
  starts fresh with the code as it is."), and a turn clears it too when the container says the
  transcript is missing (`test -s`) or when a `--resume` ends at once as `error_during_execution`
  with no tokens and nothing said — then runs once more as a new conversation — so one lost
  transcript can never fail every later turn. **The app's `dev` prepare claim** (`apps.session_db.status = preparing`) records its
  session and time; a claim whose session is no longer active, or older than 30 minutes, is taken
  over, and `fail` / `cleanup` give back a claim their session still holds (`failed`).

**Known gaps:** proven with fakes (`tests/api/session-e2e.test.ts`, `session-stall.test.ts` and the
per-slice suites) and booted locally in slice 3b; never deployed. No real model turn or ship has run
anywhere — only the fake Claude Code output (`claudeStreamJson`, reconstructed from the S7
transcripts). `wrangler dev` reloading the Worker (a source edit, or a build rewriting `dist/ui` in
the same checkout) kills the running step; the reconcile settles such a boot as failed after 3
quiet minutes rather than resuming it — a new session is the recovery; a turn it kills is found
after 3 quiet minutes (30 s with a Stop pending) and salvaged — its process stopped, its work
checkpointed, the container kept for a warm resume — which is proven with the `FakeSandbox` only:
that a real kept container's dev server survives the reload, and that `claude` flushes its
transcript on SIGTERM, need a real container. The salvaged turn itself is not continued: the person
sends the message again. A container that answers but whose kill script fails is destroyed, so its
unsaved edits are still lost then. A `shipping` session whose instance died is not reconciled (no
heartbeat is read for it) — a later wake's `claim` salvages it, and its gate branch (issue #1) is
deleted by the session's cleanup or, after three hours, by `sessions.gate-sweep`. A step cannot be cancelled mid-call: a timeout or an End fails it, and `cleanup`'s destroy is
what stops the command still running in the container. Presence is only the preview: someone
reading the session page, or the diff, without touching the preview is idle after
`idleSuspendMinutes` (a visible-tab heartbeat from the page is not built). The warm resume is
proven with the `FakeSandbox` only: that a kept container's dev server (Vite, `wrangler dev`)
survives 45 idle minutes, and that the SDK does not stop it earlier, need a real container. A start
on the same Durable Object seconds after a destroy has twice never answered under `wrangler dev`
(`docs/SESSIONS-LOCAL.md` § A start that never answers): `CloudflareSandbox.start` now bounds each
attempt (100 s) and retries once after a reset, and `onStop`'s database write is bounded (10 s) —
the cause is not reproduced, so whether that is enough is unproven. The lighter cold-resume
bootstrap swaps the kit bootstrap's `spawn` for its three database children by name (`pnpm seed`,
`pnpm db:migrate`, `pnpm web db:check`, kit 0.15): a kit that reaches them another way runs them
in full again (slower, and on real containers back to the connection count that hung); the RLS
role's name is the kit's `APP_ROLE` copied as a constant (`SESSION_APP_ROLE`), so an app that
renamed it runs a migrator whose policies name a missing role; the preload is proven under real Node with a stand-in
bootstrap, not yet in a container. Workspace backups are proven against the `FakeSandbox` and the
SDK's call shapes only: whether `binding` mode's restore (the whole archive through the Durable
Object, base64, on the SDK's default HTTP transport) beats a clone and an install under `wrangler
dev`, and everything about `presigned` on Cloudflare (the upload through the HTTPS interception,
FUSE in the container, the size and time of an archive with `node_modules`), need real containers.
`SANDBOX_TRANSPORT=rpc` would stream the `binding` restore instead, but changes every SDK call and
is untried. A tenant's deletion leaves its sessions' backups to the bucket's lifecycle rule
(`tenant.purge` pages `tenants/<id>/` only).

### 18.10 The sandbox and the local backend

`SessionSandbox extends Sandbox` (`@cloudflare/sandbox` 0.12.10 stable, `durable-objects/
session-sandbox.ts`) with `interceptHttps = true` set explicitly, `outboundByHost` handing
`api.anthropic.com` and `github.com` to handlers IN LAUNCH'S WORKER, and one of two egress modes
(`SESSION_EGRESS`, in `session-sandbox-base.ts`): `allowlist` (missing = this) — internet off and
an allow-list (npm, github.com, codeload, api.anthropic.com, the same on a laptop), which makes
the SDK intercept every connection; `open` (the three tomls, for now) — internet on, no
allow-list, `setAllowedHosts` a no-op, so only the two handler hosts are intercepted and the
database goes direct. Under `open` the constructor deletes the SDK's persisted
`OUTBOUND_CONFIGURATION` before `super()`, or a reused object (`prepare-<appId>`) restores its
allow-list and intercept-all; a container already running keeps its interception until it
restarts. Why `open`: `docs/plans/sandbox-websocket-close.md`. The
SDK is imported in two files only (the Durable Object base `session-sandbox-base.ts`, shared with
the sandbox host's class, and the `CloudflareSandbox` adapter); everything else talks to
`SandboxPort` (`sandbox-port.ts`, re-exported by `ports.ts`), with `SessionDbPort` (`NeonSessionDb`,
always), `RepoHostPort` (GitHub, or the local git server), `ModelUpstream` and `SessionEgressPort`,
all bound once in `defaultSessionPorts`.
**Where the container runs (`SESSION_SANDBOX_HOST`).** `local` (the default, and every deployed
Launch): this Worker's `SESSION_SANDBOX` — under `wrangler dev`, local Docker. `remote`
(development only, never with `SESSION_BACKEND=local`): a real Cloudflare container in the SANDBOX
HOST Worker (`launch-sandbox-dev`, `wrangler.sandbox-host.toml`), because `wrangler dev` runs every
`[[containers]]` on Docker and a Durable Object cannot be a remote binding, but a service binding
can. `RemoteSandbox` drives it through the remote binding `SANDBOX_HOST` (declared only in the
`wrangler.dev-remote.toml` that `pnpm dev` generates — the two deployed tomls never carry it): its
`WorkerEntrypoint` is `SandboxPort` with the sandbox name first, run by the same `CloudflareSandbox`
adapter, errors returned as `{ name, message }` so a rollout is still `SandboxInterruptedError`; the
log stream crosses as a `ReadableStream` and is parsed locally (no `AbortSignal` crosses); the
preview goes through the binding's `fetch`, which carries the HMR upgrade. A remote sandbox's
`sessions.sandbox_id` is `remote:<name>` (another Worker's Durable Object id cannot be computed).
**How the container reaches Anthropic and GitHub (`SessionEgressPort`).** `proxied` (every
in-process sandbox): the egress handlers below. `host` (a remote sandbox — the host cannot reach
Launch's database to run the handlers, `egress/host.ts`): Launch PUSHES the host what to inject —
an `EgressGrant` (the repo, the session's branch and upstream, the session's sealed installation
token (`sessionGitToken`, the git handler's own) with its expiry; the key and the policy's model)
over the host's RPC (`setEgressGrant`) before the clone, each turn and each checkpoint's push.
`HostedSessionSandbox` keeps it in its Durable Object storage (cleared on `destroy()` and
`onStop`) and has its OWN outbound handlers for `github.com` and `api.anthropic.com`
(`sandbox-host/egress.ts`), which find the grant from `ctx.containerId` and inject through the
same pure cores as Launch's handlers (`egress/forward-git.ts`, `egress/forward-model.ts`): one
repo, a push only to `session/<short>` and never a delete, the Messages API on the policy's model
only, a fresh token's 401/404 retried. No grant → the same 403 as the proxies. The container holds
no credential in EITHER mode — only the placeholder key, and no git credential or helper. The
turn runner and the checkpoint are the same code in both — they ask the port and `proxied` answers
"nothing to do" — and the transcript scrubs GitHub token shapes as well as Anthropic keys.
**The database.** A session's database is ALWAYS a real Neon branch of the app's project, under
either `SESSION_BACKEND`, reached DIRECTLY from the container: there is no TCP out, so the app runs
`DATABASE_DRIVER=neon` (the `Pool`'s `wss://<endpoint>/v2` for the kit's migrate, seed and
`db:check`; HTTP `api.<region>.neon.tech/sql` for the app's Worker under `pnpm dev`), with no
`NEON_LOCAL_PROXY`. Under `allowlist`, `sessionBootstrap` sets the allow-list to the base plus EXACTLY those two hosts,
derived from the URI it is handed (`sessionDbEgressHosts`, which refuses anything but an
`ep-….neon.tech` endpoint) — before the prepare run on `dev`, and again, replacing it, before the
bootstrap on the session's own branch. `session_owner` (`LOGIN CREATEROLE`) is made IN SQL by
`neondb_owner`, as `provision-neon.ts` makes `migrator`, and `vector` in `session_app` as the owner;
a role an earlier Launch made through Neon's role API (a `neon_superuser` member) is dropped
through the API with `session_app` and made again, and that `dev` is prepared afresh. The branch
URI is still the only credential in the container.
**Waiting on Neon** (`NeonClient.waitForOperations`, `services/launch/neon.ts`): a new branch is
waited on for its `create_branch` operation ONLY (`waitForBranch`) — the session branch, `dev` and
the launch pipeline's `staging` — not the `start_compute` Neon returns with it: the compute starts
on its own or on the first connection, and a write that conflicts with it is refused 423 and
retried. Every other write (password resets, databases, roles, deletes, a new project) still waits
for all of its operations. Polls and 423 retries back off from 200 ms ×1.5 to a 1 s cap, all
pending operations read in parallel per round; a wait gives up (504) after 120 s slept, a 423
after 33 retries (~30 s).
The image (`containers/session/Dockerfile`) is the Sandbox base plus Node 24, pnpm 10, a pinned
Claude Code and a warm pnpm store for the default pin's kit (0.16.0, `SESSION_KIT_TAG`; image
`session-5`). The checkout is `/workspace/app` and `$HOME` is
`/root` (`SESSION_WORKSPACE` / `SESSION_HOME` in `rocketflare-dev.ts`, the one definition). The
turn and the checkpoint's git set `HOME` to it explicitly. A turn runs `claude -p` with
`--permission-mode bypassPermissions` and `IS_SANDBOX=1`, the container being the boundary.
`.claude/settings.local.json` holds only deny rules (`git push`, `git remote`, `git config`),
which bypass mode honours. Launch makes every push (`checkpoint.ts`) and opens the PR (`ship.ts`).
The git handler allows smart-HTTP on the session's one repo, refuses a push to any ref but
`session/<short>`, and injects a one-hour installation token sealed on the row (re-minted under
10 minutes left, an expired one included — the usual case after an idle hour; sealed back in a
compare-and-set on the expiry it read, so two requests re-minting at once converge on the one
token the row keeps). **A fresh token is retried**: GitHub does not always accept an installation
token for a second or so after issuing it, and answers the anonymous-looking request for a private
repo "Repository not found" (404) — seen on a real push one second after a re-mint. When the token
was minted by this request, or sealed within the last minute (its expiry says so: GitHub's tokens
live exactly an hour), a 401 or 404 is sent again after 0.5 s, 1 s and 2 s — the body is already
buffered, and a 401/404 did nothing. An older token's 404 passes through at once.
`SESSION_BACKEND=local` (development only) swaps only where the repo lives (the local
git server, still through the git handler) — procedure and timings in `docs/SESSIONS-LOCAL.md`.
Under `APP_ENV=development` (every `wrangler dev` container, whatever the backend) each command
runs with `GOGC=off GOMEMLIMIT=1536MiB` (`SessionDevEnv.emulated`). The allow-list is widened at
RUNTIME by `sessionBootstrap` (`setAllowedHosts`, bounded at 90 s): measured under wrangler 4.127 /
sandbox 0.12.10, a runtime `setAllowedHosts` on a running container returns at once and the next
command runs, immediately and after 40 s idle — it re-registers the interception on the proxy
sidecar and does not restart anything.
**Long commands run in the background and are polled, never one blocking `exec`**
(`background-command.ts` `runInBackground`: the install and the kit bootstrap, for a prepare run
and a session's own bootstrap alike). Measured on real Cloudflare containers (2026-09-29): **the
Sandbox SDK serialises every call to a sandbox behind a running `exec`** — during a 25 s exec,
`readFile`, `startProcess` and another `exec` all waited for it — so a long exec cannot be watched
and a step retry's short exec queued behind the first attempt's orphaned run ("did not answer
within 2 min"); and over the sandbox host's remote binding a blocking exec RPC was dropped after
~7 min ("Peer closed WebSocket: 1006"), its result lost while the command kept running. While a
BACKGROUND process runs every call answers at once. So the command starts with `startProcess`
(a runner script: `setsid -w` gives it its own process group, whose leader writes
`<name>.pid` = `<pid> <runId>`; output in `<name>.log`; `<runId> <code>` in `<name>.exit`, via tmp +
`mv`) under the bootstrap `flock`, and is polled every `commandPollMs` (2.5 s) with short
`readFile`s — every 8th poll also `kill -0`s the pid, so a runner that died without an exit code
is noticed; three failed polls in a row give up. A step RETRY attaches to a live run of the same
name instead of starting another; a finished one is never reused (the same name runs again for
another database). Past `BOOTSTRAP_TIMEOUTS` (capped by `execMaxMs`) the whole process group is
killed and the step fails with the redacted log tail, as a non-zero exit does
(`SessionBootstrapError`). **The running step says where it is**: `withProgress` gives each boot
step `scope.progress(detail)`, a `step` row still `running` with a `detail` — `pnpm install`,
`starting the app's bootstrap`, then the kit's latest `✔ n/10 name` (mark, count and name only,
`bootstrapProgressOf`) — written only when it changes; the boot checklist shows it under the label,
and the AG-UI projection sends a running row for an already-open step as `kit.agent.step` alone,
never a second `STEP_STARTED`.

**Known gaps:** the Neon wait's speed-up (only `create_branch`, 200 ms backoff) is proven with
fakes, not yet timed against real Neon; the session branch still waits for its password reset's
operations, which Neon may hold until the compute has started; and the branch step still runs
before the sandbox starts rather than alongside it (`docs/plans/sandbox-session-issues.md`,
"Slow, not broken"). The kit's bootstrap refuses root, so the session works around it
(`NOT_ROOT_PRELOAD`; `docs/plans/upstream-kit-issues.md` 10). The dev setup's untracked config
leans on two things the kit and wrangler do not promise: the kit's bootstrap toggling `[ai]`
through `writeFileSync` (the preload's hook — a kit that writes another way would toggle the tomls
again, and the resume heal and the checkpoint guard are then what stand between it and a PR), and
wrangler's `.wrangler/deploy/config.json` redirect (measured on wrangler 4.127: `dev` follows it,
`types` does not). An agent's edit to `wrangler.toml` reaches the RUNNING dev server only at its
next start (the session config is copied, not watched). A session that was live across the
deploy of this fix keeps its toggled working tree until it is suspended and resumed (the heal runs
at boot); its next checkpoint does not trip the guard (HEAD already carries the toggle), so a ship
from it still carries the toggle — resume it first, or put the three files back on the branch by
hand. The heal's types rule is exact-match only; the redirect is proven with a stand-alone
`wrangler dev` and the scripts under real Node and git, not yet in a session container. On an ARM Mac the amd64 image runs
under emulation (QEMU, or Rosetta under Docker Desktop), where Go binaries (esbuild inside tsx,
Vite and wrangler) crash in their GC ("The service was stopped" — what failed the first real
session, whose Launch ran `wrangler dev` on the `cloud` backend): every `wrangler dev` session runs
with `GOGC=off`, so each wants ~4 GB (the SDK's own control server ~1 GiB idle, the dev stack ~3
GiB) and in an 8 GB VM shared with other containers the VM's OOM killer takes the control server —
hola-world's second session died that way at "Starting dev server" (`docs/SESSIONS-LOCAL.md`
§ Memory). A process that crashes under emulation used to leave its core dumps in the checkout —
one crash left a 5.8 GB `core` and a 5.7 GB `qemu_claude_<date>_<pid>.core` in `/workspace/app`,
and the checkpoint's `git add -A` timed out on them. Every command now runs with `ulimit -c 0`
(`RLIMIT_CORE` 0, inherited by all it starts); QEMU user mode writes the guest's `qemu_*.core`
only when `RLIMIT_CORE` allows it, so the one limit should cover both — read from QEMU's source,
not reproduced with a crash. The image cannot set it (Docker's `--ulimit` is the platform's run
option); the checkpoint's exclusions and size limit (§18.13) are the second line. `workerd` itself
runs under emulation. An arm64 local image is blocked upstream: the
Sandbox base image is amd64-only and `wrangler dev` builds containers for `linux/amd64` only. The allow-list includes the region's shared `api.` SQL host
(the neon-http driver's), which answers any endpoint in that region for whoever holds its
credentials — the container holds only its branch's. **The egress allow-list is off**
(`SESSION_EGRESS=open` in the tomls): on real Cloudflare containers the interception never ends
the container's TCP/TLS stream after a WebSocket closes, so a Node script that ends its pool and
lets Node exit (the kit's `migrate`, `db-roles`, `seed`) finished its work and never exited
(2026-09-29; a relay of our own did not help). Under `open` nothing guards where the container
sends data; the credentials stay outside it. That `open` boots a remote session is unproven until
the next remote run. Neither sandbox class maps the database any more (a static `outboundByHost`
key intercepts its host even with internet on); `egress/forward-database.ts`, the WebSocket
relay (`allowHalfOpen`, a close passed on to the other side only), is kept for the next probe
(`docs/plans/sandbox-websocket-close.md`, Part 2). Under `allowlist` on a real container an
allow-listed Neon endpoint is passed through with no handler, so the database's WebSocket breaks
there as before. workerd (the app's
`wrangler dev` inside the container) trusting the interception CA is unproven. First-start latency,
`max_instances`, git through `interceptHttps` and whether a deploy stops running sandboxes are
unproven on Cloudflare (plan §5). That a fresh installation token's 404 is GitHub's eventual
consistency is inferred from one incident (re-mint at :21, "Repository not found" at :22, both
services 200 minutes later), not reproduced; the retry is bounded at 3.5 s, and a token-lifetime
change at GitHub would make the "sealed within a minute" test miss (the minting request itself
still retries). **The `host` mode (`SESSION_SANDBOX_HOST=remote`, development only) gives up one
of the proxies' guarantees:** the host has no database, so it neither meters nor checks the budget
per request — the budget is enforced per turn (checked before, the process killed when its
running cost reaches what is left, §18.11), so one response can overshoot by its own size. The key
and the token never reach the container, and the branch rule is kept. The grant crossing the
remote binding and the host's handlers injecting on a real container are covered by unit tests
(`session-host-egress`, `session-egress-forward`), not yet run end to end
(`docs/plans/sandbox-session-issues.md`). A remote container's time is not
metered (`container_seconds` stays 0; the host's `onStop` has nowhere to write), a container the
platform put to sleep is not marked `suspended` by it, and the host keeps no workspace backups. JS
RPC, a `ReadableStream` result and the HMR upgrade through a REMOTE binding are read from wrangler
4.127's remote-proxy source (capnweb over a WebSocket; `Upgrade` passed through), not yet run.
The remaining blocking execs are short (the clone ≤ 5 min, the port waits in 20 s chunks, the
migrations hash); the ship gate (`ship.ts`, lint + typecheck + test + build) is still ONE blocking
exec and has the same exposure. The background runner needs `setsid` and `flock` (util-linux, in
the Sandbox base image); an attached run gets its whole deadline again from the attach, and a
FakeSandbox, not a real container, proves the attach and the kill paths (the runner script itself
runs under bash in `background-command.test.ts` where `setsid` exists).

### 18.11 Chat, the model proxy and budgets

A turn (`services/sessions/turn.ts`, step `turn#N`, no retries, the policy's `maxTurnMinutes`)
checks the budget, claims `ready → working`, writes `user.message` + `turn.start`, and runs
`claude -p … --resume <id> --output-format stream-json` in the sandbox; `claude-stream.ts` maps
each line to `text` / `tool.start` / `tool.end` / `turn.end` events, batched every 250 ms or 20
events. Every turn, resumed ones included (the flag does not survive `--resume`), carries
`--append-system-prompt` with the `session-system-note` prompt filled in (`sessionSystemNote`;
editable in Settings like any registry prompt): where it is, what Launch does for it, and that it
never runs the full gate — only targeted lint and tests for the files it changes, since Launch's
ship gate and the PR's CI run the whole gate (the ship fix turn's `session-ship-fix` says the same).
Before 2026-10 the prompt was registered but never sent. `cancel_requested_at` is polled every 2 s and kills the process (a Stop whose turn step is
gone is carried out by the reconcile's `salvage`, §18.9); a rollout is `turn.interrupted` and
`suspended`. **A container that died under the session is noticed** (`boot-marker.ts`): the
Workflow carries the `bootId` `sandbox.start` wrote into the container into every turn and
checkpoint. A dead container (out of memory in a `pnpm build`, most often) does not end the turn's
log stream — it goes quiet — so every 45 s (`TURN_LIVENESS_PROBE_MS`) the turn reads the marker,
bounded at 20 s: the read reaches a fresh, EMPTY container with no marker → `turn.interrupted {
container_lost }` at once; 4 reads in a row with no answer (`TURN_LIVENESS_MAX_FAILURES`, about four
minutes) → the same. A log stream that fails or ends early is checked once more before it is called
"lost the connection". The session goes `suspended` (like a rollout: `rollout#N` destroys what is
left, nothing is checkpointed), and the next message resumes from the last save (§18.9's cold
resume: the workspace backup, else the branch; the transcript from R2). A turn whose container is
already empty never starts: the message stays pending, the session goes `suspended` with a resume
requested and an `error` event says why, so the resume runs it on the new container. A `--resume` whose transcript is missing, or that Claude Code refuses at once
(`error_during_execution`, no tokens, nothing said), clears `claude_session_id`, says so in an
`error` event and runs the turn (once more) as a new conversation. Pushing is disallowed to Claude — Launch commits and pushes.
**Launch never leaves a turn's process running unread**: the command records its pid
(`/workspace/.launch/turn.pid`, then `exec claude …`), and whenever the turn stops reading a
process that has not reported its exit — the log stream failed (`turn.failed`, "Launch lost the
connection…") or closed early, or a cancel/timeout aborted the reader — `terminateTurnProcess`
sends the SDK kill and then, in the container, SIGTERM to the pid and its children and SIGKILL
after 5 s. Each call is bounded at 30 s, logged, and never fails the turn; after a rollout there is
no container to stop. The escalation goes by pid because the SDK's `killProcess` (0.12.10) drops
its signal argument. Every command and process also runs with `ulimit -c 0` (`inSubshell`), so a
crash leaves no core file behind (§18.10, §18.13).
The page reads the rows (`GET /:id/events?afterSeq=`, paged by `nextSeq`) and uses
`GET /:id/agui/stream` (the four run-stream rules; facts with no AG-UI frame travel as the
`launch.session.event` CUSTOM event, `SESSION_CUSTOM_EVENTS` in `@launch/shared/launch-sessions`)
only as a cadence.

**The model proxy** (`egress/anthropic.ts`): the sandbox holds only `launch-session-placeholder`.
The handler finds the session from the platform's `ctx.containerId` (never from the request),
allows only `POST /v1/messages` and `/count_tokens` on the policy's model, checks the budget (an
Anthropic-shaped 403 and NO upstream call when over), swaps in the real key (the
`anthropic_api_key` credential, else `ANTHROPIC_API_KEY`) and meters the SSE or JSON usage into
`ai_usage` (`session_id`, feature `session`) and the session's totals in one transaction.
**Budgets**: `maxSessionUsd` (plus any extension) per session and `appMonthlyUsd` (or
`apps.session_monthly_budget_microcents`) per app, checked at create, before each turn (→
`blocked`, `budget.reached`, audit `session.budget.reached`) and per call; `POST /:id/budget
{extraUsd, reason?}` opens a `session.budget` approval in the creator's name (P4): an owner or
admin who is not the creator approves it in the same call (200), anyone else — the creator
included — waits for one (202, `approvalId`). The approval extends the cap (audited
`session.budget.extended` with the approval id) and wakes a blocked session.
**The `host` egress mode meters the turn instead** (`turn-meter.ts`: the host's handlers inject
but do not meter, having no database): each `assistant` line's usage (per response id, repeated
content lines counted once) is the running cost, compared with `budgetHeadroom` (the nearer of the session's and
the app month's remaining cap, read at the turn's start) — reached, the process is killed,
`budget.reached` and a `turn.failed` saying why. At the end the `result` line's `modelUsage`
(Claude Code's background calls included; else its `usage` under the policy's model; else what the
running sum saw, so a killed turn is still paid for) is written through the proxy's own
`recordSessionUsage`: the same pricing, one transaction per row.

**Known gaps:** a response the sandbox abandons mid-stream is never metered (the meter records at
the body's end); the liveness probe is proven with the `FakeSandbox` only (`die()`: a stream that
goes quiet, then an empty container) — that a probe into a dead container deployed boots an empty
one (or times out) rather than hanging past its 20 s bound is from session d9124cbb's checkpoint,
not a test; a container that stays unresponsive for four probes but is in fact alive is destroyed
with its unsaved edits (the threshold is a guess); the ship turn is probed too, but a ship whose
container died goes back to `ready` — the next turn's marker check is what suspends it; the turn's kill reaches Claude Code and its DIRECT children (`pkill -P`), not a
grandchild that detached into a process group of its own; the pid file is read at kill time, so a
pid the kernel reused meanwhile would be signalled (not seen); the kill escalation is proven
against real processes locally, not yet inside the session image; a model with no price (`estimateCostMicrocents` → null) costs nothing to the
budget, so the allow-list must name a priced model; the ship turn's prompt is not in the transcript
(no `user.message`); the proxy's streaming overhead is unmeasured.

### 18.12 The preview gateway

A preview host is `<port>-<shortId>-<token>.<SESSION_PREVIEW_URL domain>`; `worker.ts` sends it to
`api/preview/gateway.ts` before the Hono app (so no `X-Frame-Options`; `run_worker_first = true`
keeps `[assets]` from answering `/`). `POST /:id/preview-grant` mints a 60 s HMAC grant (HKDF of
`OAUTH_ENCRYPTION_KEY`, info `launch-preview`) for that host and person; the iframe loads
`/__launch/grant?g=…`, which sets the host-only cookie `__Host-launch-preview` (SameSite=None,
Partitioned; `launch-preview`, Lax, in development) and redirects to `/`. Every later request needs
the cookie for this host and session (401 otherwise), an ended session is 410, a booting or
suspended one 503; only :5173 and :8787 are proxied (`SandboxPort.fetch`), with `frame-ancestors
<APP_URL>` and a status cache of 15 s per isolate. The UI reloads the frame after every turn.
**Nothing proxied is cached**: every response gets `Cache-Control: no-store, private` and
`CDN-Cache-Control: no-store`, whatever the dev server sent — Cloudflare's zone default gave a
`.css` four hours in the browser, so the reload after a resume showed the stylesheet from before the
session's edits (HMR only ever fetches fresh `?t=` URLs, which hid it while the session ran).
**A preview request is the person's activity**: an authenticated request to a `ready` / `blocked`
session moves `last_activity_at` (the idle clock, §18.9) in `waitUntil`, at most once a minute per
session per isolate and only on a stamp older than a minute in the database, so a Vite page's
hundred module requests cost one write. Never for `working`: there the stamp is the turn's
heartbeat, which the reconcile reads, and a preview must not hide a dead turn.

**Known gaps:** a grant is reusable within its 60 s (not single-use); Vite HMR over the WebSocket
upgrade is untested, locally and deployed; an ended session is served for up to 15 s from the
status cache; `SameSite=None` cookies inside the iframe are unproven on real browsers and hosts.
A preview left open with nothing requesting (Vite's HMR socket idles silently) is idle; a
running preview app that polls its API keeps its session live until `maxSessionHours`.

### 18.13 Checkpoints, ship and the PR

**When** (debounced, `session.ts`): after a turn that ran with the container up, `turn#N` asks
the checkout whether anything is unsaved (`workspaceChanged`: `git status --porcelain`, and HEAD
against `head_sha` — a turn may commit itself; a check that fails counts as a change). Nothing →
no checkpoint. Something → the loop remembers it (`DirtyState`: when the first unsaved turn
ended, when the latest one did — ISO times from the step results, never a clock read outside a
step) and the next `wait#N` times out after `SESSION_CHECKPOINT_DEBOUNCE_MS` (30 s) from the
latest turn: a message inside it runs and the 30 s start again from ITS end; 30 quiet seconds →
`checkpoint#N`, and the session waits on (no suspend). A session that has held unsaved changes
for `SESSION_CHECKPOINT_MAX_DEFER_MS` (5 min) checkpoints straight after its next turn however
busy the conversation, and a debounce wait is cut to that cap. A suspend, an end and a ship still
checkpoint first; a turn step that died checkpoints at once; a rollout has nothing left to save.
**A checkpoint first checks the boot marker** (`checkpointStep`, with the loop's `bootId`): a
container that came back empty has nothing to save, so instead of failing at its first `cd`
("Failed to change directory to '/workspace/app'") the `error` event says the container stopped
and the changes since the last save are lost — and a debounced (`turn`) checkpoint suspends the
session and destroys the empty container, so the next message resumes from the last save; a
suspend neither keeps nor backs up such a container, and an end just ends.
**Checkpoint** (`checkpoint.ts`): `git add -A`, a
commit by Launch with the person as `Co-Authored-By`, `git push origin HEAD:refs/heads/session/
<short>` through the git handler, and Claude's transcript to R2 (`sessions/<id>/claude.jsonl`) so
a resume can `--resume`. **Nothing huge is staged**: the repo step writes the core-dump names
(`core` as a file — `!core/` keeps a directory of that name — `core.[0-9]*`, `*.core`,
`qemu_*.core`) into the checkout's `.git/info/exclude`, never the app's `.gitignore`; every
checkpoint re-asserts them (a restored workspace may predate them) and first lists every untracked
or modified file over 50 MB (`CHECKPOINT_MAX_FILE_BYTES`). Each is left out of `git add` by a
literal pathspec exclusion — not deleted — and named in an `error` event ("Saved, but left out …
core (5.8 GB)"), and the save goes on. The scan also drops a `.git/index.lock` a timed-out git left
behind, when no git is running. A git command that does not answer within 120 s is a
`CheckpointError` naming the step and the limit. A failed checkpoint is an `error` event ("Could not
save the session's work: …"), not a failed session: the session stays `ready`, the next turn runs
(its dirty check finds the work still unsaved, so the debounce tries again), and the branch holds
the previous one. A push
that fails transiently ("Repository not found", a 401/404/429/5xx, a dropped connection —
`TRANSIENT_PUSH_RE`) is tried once more after 3 s: the push is idempotent and the step has no
retry of its own; a rejected ref (non-fast-forward, the git handler's 403) is not retried.
**Ship** (issue #1; the steps in `ship-steps.ts`, the kit contract in `gate.ts`, the PR in
`ship.ts`): **Launch runs the gate, never Claude, and only its exit codes decide.** `ship.claim#N`
(`ready → shipping`) → `ship.save#N` (a checkpoint, so the half hour the gate may take risks
nothing unsaved) → `ship.kit#N` (which commands the checkout's kit takes, below) → per attempt `A`
(numbered across the session's ships, `SHIP_GATE_ATTEMPTS` = 3 per ship): `ship.gate#N.A.lint`
(`pnpm gate lint`) → `ship.gate#N.A.typecheck` (`pnpm gate typecheck`) → `ship.db#N.A` →
`ship.gate#N.A.test` (`pnpm gate test`) → `ship.db-clean#N.A`, stopping at the first red step.
**The steps are the kit's `pnpm gate`** (rocketflare-launch#2, kit 0.16.0): the one definition of an
app's checks, which is also the copy's ONE CI job, run a step at a time — so a green ship gate is
the same checks the PR's CI runs, minus ONE declared exception, `build` (`SHIP_GATE_SKIPPED`): it
re-bundles the UI and the Worker — the step most likely to run a container out of memory — and the
PR's CI runs it minutes later. There is no `generated` step because the kit has none.
`tests/config/ship-gate-contract.test.ts` proves it from the kit's own list: against a fixture of
the pinned kit's `pnpm gate --list --json`, Launch's steps plus `SHIP_GATE_SKIPPED` are exactly the
kit's steps. **Which kit** (`ship.kit#N`, `GATE_KIT_PROBE`): a root `gate` script means the kit
is asked for `pnpm gate --list --json` (schema 1, `{ schema, steps: [{ id, command, database }] }`,
the kit's `packages/shared/src/gate.ts` mirrored as `kitGateListSchema` — Launch cannot import the
kit; an added field or step is not a schema change, so extra fields are dropped) and the plan is
Launch's steps in the LISTED order; a list that lacks `lint`, `typecheck` or `test`, or names a
step Launch neither runs nor skips, is REFUSED with a sentence, never silently skipped — running
less than the app's CI and calling it green is what the gate is for. Only `test:ephemeral` (kit
0.15.7 up to 0.16.0, whose copies keep the script in their own `package.json`) means the legacy
three: `pnpm lint`, `pnpm typecheck`, `pnpm test:ephemeral`. Neither means the kit is too old. A
refusal or a too-old kit is a red `test` row saying why (on the round's first attempt), no fix
turn, and no gate branch. The PR body names the commands the green attempt actually ran. Each command is a polled background command in the checkout
(`runInBackground`, `gate-<step>` files) with a hard deadline (5 / 10 / 25 min; its process group
killed past it — under `allowlist` a vitest run can hang on exit behind the egress interceptor's
WebSocket bug), a Workflow step with one retry that RE-ATTACHES to the running command, and one
`ship.gate { step, passed, attempt, command, durationMs, output, target? }` event whose output is
a redacted tail (`gateOutputTail`: the URL and its password, anything shaped like a connection
string or a key removed), and — on the test step — `target`, the line the kit's `pnpm test` prints
first (`test target: remote Neon branch gate-… (no Docker; the whole suite under neon)`, redacted
the same way), which the ship panel shows under the Tests row. **The test step's database** is a throwaway Neon
branch per attempt, `gate-<short>-<A>`, a CHILD of the session's branch (its schema, its roles:
`session_owner` owns `session_app`'s tables and holds ADMIN on `rocketflare_app`) with its own
compute, made by `ship.db` (`createGateBranch`, waiting for `create_branch` only; it first deletes
any gate branch an earlier attempt of the session left). The command gets the kit's contract
(0.15.7's, unchanged in 0.16.0, where `TEST_DATABASE_BRANCH` is also what tells `pnpm test` it is on
a remote target) exactly — `DATABASE_URL` (`session_owner` on the gate branch, direct host, password reset when the
run STARTS — a lazy env, so a retried step that re-attaches never resets it under the suite),
`TEST_DATABASE_BRANCH`, `TEST_DATABASE_ENDPOINT` (the `ep-…` id in that URL) — and no
`NEON_LOCAL_PROXY`: a session's database is always a real Neon branch reached directly, on a laptop
too, so the gate's is as well (there is no local-Docker variant to fall back to). The allow-list
gains exactly the branch's direct and `-pooler` hosts and its region's SQL host for the step (a
no-op under `SESSION_EGRESS=open`). **The driver differs from the copy's CI by design**: the copy's
CI runs the suite under `postgres` plus a `neon` conformance pass (the driver seam); the ship gate's
`pnpm gate test` runs the WHOLE suite under `neon` on a real Neon branch, because a sandbox has 443
and no Docker. Same steps, different driver — a failure on one and not the other is a seam bug for
the kit, not something to patch in the app (the kit's time limits scale with the target, ×12 on
remote Neon, 0.16.0). **Red, with attempts left** → `ship.fix#N.A`: ONE turn, the
`session-ship-fix` prompt with the failing command and its tail ("fix this; do not run the tests
or start a database — Launch re-runs the gate"), through the `shipFix` hook (3c's
`createShipTurnRunner`, metered and cancellable like any turn), and the gate runs again whatever
the turn says. **Green** → `ship.commit#N` (the final checkpoint) → `ship.summary#N`: the PR's
title and body from ONE model call, no tools, over the person's messages and the branch's diff
stat (`summarizeShip`: `resolveChat` with the `session-ship-summary` prompt key — an agent-model
assignment picks the model, else Anthropic's Haiku when the provider is Anthropic, else the
default; no tenant or platform chat → the sessions' own Anthropic key on Haiku; its usage an
`ai_usage` row billed to the session, `session:ship-summary`; any failure → the session's title or
first request and the diff stat) → `ship.pr#N` (`openPullRequest`, head `session/<short>`, base
the default branch; `pr_number`/`pr_url`, `shipped`, `ship.pr`, audit `session.shipped`, the
config the PR declares) — and the Workflow cleans up (shipping ends the session). A green gate
makes no model call but the summary. **No PR** → `ship.settle#N`: an `error` event saying why
(still red after every attempt, the gate cannot run on the app, the fix turn did not run, the save
or the PR failed, a step threw), `shipping → ready`, and the fix turns' changes debounced like a
turn's. **A lost container suspends, never `ready`**: every ship step that touches the container
reads the boot marker first, and one that came back empty — or died under a gate command or a fix
turn — is `shipping → suspended` with a resume asked, an `error` event, the container destroyed,
and the loop resumes from the last save (the person ships again). **End works mid-ship**
(`POST /:id/end` accepts `shipping`): a gate command sees it within `endPollMs` and is killed, a
fix turn is cancelled, and the round settles so the loop ends the session. **No orphan gate
branch**: `ship.db-clean` runs in a `finally` after every `ship.db`, the settle of a round that
threw deletes them, cleanup (and the expiry's inline cleanup) deletes a session's gate branches
BEFORE its own branch (Neon refuses to delete a parent), and `sessions.gate-sweep` on `*/5` deletes
any `gate-*` branch of a session-running app's project older than three hours
(`GATE_BRANCH_MAX_AGE_MS`) — by name, so no row has to remember them. CI (`pr_checks`, check runs
+ combined status) is read at once, on `GET /:id/pr` (at most every 30 s) and by `sessions.checks`
on `*/5` while pending, unread, or `none` within an hour of the ship (GitHub has not queued the
workflows yet when the PR opens).

**Known gaps:** between a turn and its debounced checkpoint (up to 30 s, 5 min in a busy
conversation) the work and the transcript live only in the container — a crash or a lost instance
then loses them (a rollout always did; a container that runs out of memory mid-turn loses the
turn's edits too — there is no memory limit or warning before it happens); a turn that changed no file does not copy the transcript to
R2 until the next checkpoint (a suspend always makes one); an oversized untracked file keeps the
workspace dirty, so every turn is followed by a checkpoint that re-reports it; a file over the size
limit that is already TRACKED keeps its last committed
version (its new content is not saved); the scan and the stale-lock check are proven against real
git and bash locally (`tests/config/session-checkpoint-scan.test.ts`), not yet inside the session
image; no real PR opened by the App has triggered `ci.yml` yet; rulesets limiting pushes
to `session/*` are not set up (only the git handler enforces it); a gate that needs more than the
sandbox has (a service, a secret) cannot pass; after shipping there is no "keep working" in the UI
— a new session starts from the default branch unless the API is given `baseRef`. The ship gate
(issue #1, #2) is proven against the FakeSandbox and the FakeCloud's Neon only: `pnpm gate test`
on a REAL Neon gate branch — the kit's test setup as `session_owner` (its `ALTER ROLE` on
`rocketflare_app`, the grants and the truncate, on a branch of a branch), the connection count against a
small compute, the kit's scaled time limits on a fresh 0.16.0 scaffold, how long branch creation
takes — has not run; nor has `pnpm gate --list --json` been read from a real checkout, nor a gate
run inside a real sandbox (the memory the suite needs beside the dev server, a vitest that
hangs on exit under `allowlist` — the deadline kills it, which then reads as red). An app on a kit
before 0.15.7 cannot ship until its kit is upgraded (a red `test` row says so), and a kit whose
`pnpm gate` gains a step Launch does not know cannot ship until Launch learns it. The session
image with the 0.16.0 store (`session-5`) is defined, not yet deployed (`wrangler deploy` builds
it; drain sessions first). A `shipping`
session whose Workflow died is still not reconciled (its gate branch is swept after three hours).
The summary's model is not traced (D32).

### 18.14 Drain, the UI and the CLI

**Drain** (`POST /api/admin/sessions/drain`, global admins, Admin → Sessions) sets
`launch_settings.sessions_paused` (new sessions 409) and wakes every live session, whose
`inspect#N` checkpoints and suspends it, and every suspended one that still keeps a warm container,
whose `inspect#N` cools (destroys) it; `/undrain` clears it and people resume their own.
`docs/DEPLOY.md` makes it a required step before a deploy that touches the image. **UI**: the
session page `/apps/:slug/sessions/:id` (its own lazy chunk: chat, composer, preview, header with
cost against the cap and Ship / End / Resume / Extend budget, boot checklist, ship panel), the
"Coding sessions" card on the app page, Admin → Sessions. **CLI**: `launch sessions start|say
[--follow]|ship [--no-wait]|end|ls|preview-url` (§11).

**Ship to staging, in the UI and the CLI (issue #5).** The ship panel walks the landing from the
pure `landingTimeline(events, session.landing)` (`sessionChatModel.ts`): gate → PR → CI (the
current round in words, the PR's checks by name) → review, when the ship has one (naming who it
waits on from the `session.merge` request's `eligible`, with a link to it) → merged → released
vX.Y.Z → "Live on staging: <link>, version vX.Y.Z". It reads only the rows after the last `ship.pr`
and the row's `landing`; once a reopen clears the landing the rows tell the story — the reason in
one sentence (`REOPEN_TEXT`), and for red CI the failing check, its link, the redacted log tail and
**Ask Claude to fix it**, which posts the fix as an ordinary turn (`POST /turns`, the composer's
route; a `suspended` session resumes on it). A stall (after the merge) says why (`STALLED_TEXT` +
the landing's `error`) and links the app page, where release, retry and production live. `pr`
mode keeps today's ending (the PR and its CI). The chat gets a notice per landing row; the
composer's blocked sentence names the stage; End is hidden while `merging` (the route's 409); the
Ship confirm words what will happen from the app's ship settings. A session is polled every
`SESSION_LANDING_POLL_MS` (15 s) while its landing moves — `shipped` included, while `releasing` /
`deploying` — and never while it waits on a reviewer (`approval`). The app page's **Shipping** card
(`ShipSettingsCard`, below the pipeline strip) lets owners and admins choose "go live on staging"
or "open a pull request for review on GitHub" and who reviews (nobody / the app's owners / named
teams — every group for `manage Group`, the reader's own otherwise); it is read-only for the review
when an admin `session.merge` policy decides it (the stored review is sent back unchanged), and
sentences for everyone else. Below it, for owners and admins, the main branch's protection in
plain words (`ok` Protected · `none` · `blocks` → remove the rule, DEPLOY.md · `unavailable` ·
`unknown`, plus the server's `detail`), with **Apply Launch's protection** for administrators
where it helps (`none`, `blocks`). The pipeline strip prints each change's stored summary as one
plain line under its title (`summaryLine`), and an approval page for a `session.merge` shows the PR,
the session (link to its page), the head commit, the summary and the diff stat.

**Known gaps:** a drain wakes live sessions in EVERY organisation (it is about the deployment's
image), and audits in each; there is no scheduled drain or automatic undrain after a deploy; the
drain → deploy → resume rehearsal has not been run. Issue #5: the ship panel names who a review
waits on only for a reader who may read the `session.merge` request (otherwise "an approver in
Launch"); "Ask Claude to fix it" exists for red CI only (a rejected review's note is shown, not
sent); the CLI's follow gives up after four hours (a review may wait two days) and says the ship
carries on; the branch-protection line is shown to owners and admins only, though any member may
read it.

### 18.15 The approvals engine (P4)

One generic engine decides everything a second person must approve (spec/08,
`docs/plans/p4-approvals.md`; `api/services/approvals/*`, contracts in
`packages/shared/src/launch-approvals.ts`). It knows nothing about apps or deploys: each KIND is a
`KindHandler` (`kinds/<kind>.ts` — `defaultPolicy`, `describe`, `eligibleExtra`, `applyInTx`,
`applyAfter`, `onClosed`). Six are built — `app.create`, `app.access`, `deploy.production`,
`session.budget` (§18.16–18.17), P5's `grant.request` (§18.20) and issue #5's `session.merge`
(below); `config.change` and `app.teardown` are named in the contract but have no handler and
nothing opens them (P6).

- **Open** (`engine.open`): resolve the policy (below) and SNAPSHOT it onto the request with the
  excluded set (the requester, plus whoever the kind names — the promoter, a release's cutter and
  its sessions' creators) and the expiry; the pending-subject unique index makes asking twice find
  the open request. A requester at or above `autoApproveRole` is auto-approved — still a row,
  decided by `system`, audited, its `applyInTx` in the same transaction. Otherwise audit
  `approval.requested` and notify the eligible approvers.
- **Decide** (`POST /api/approvals/:id/decide`) is ONE transaction: `SELECT … FOR UPDATE`,
  eligibility evaluated NOW (app ownership and group membership at decide time, never from the
  snapshot), the decision row (unique per person → 409 `already_decided`), one reject vetoes and N
  approvals approve, `applyInTx`, audit `approval.decided` (+ `approval.approved|rejected`). Two
  approvers racing serialise on the row lock: one 200, one 409 `not_pending`. The requester and
  the excluded are 403 `self_approval`, anyone else the policy does not name 403
  `not_an_approver`, and a request the caller may not see is the same 404 as a missing one.
- **After commit** `applyAfter` runs the vendor effect (publish a GitHub Release, start a Workflow,
  wake a session), claimed by incrementing `apply_attempts` as a compare-and-set while
  `applied_at` is null. A failure records `apply_error`; the `approvals.sweep` task (`*/5`)
  retries it after a four-minute quiet period and gives up loudly after
  `APPROVAL_MAX_APPLY_ATTEMPTS` (5): `approval.apply_failed` and a notification. Every
  `applyAfter` is idempotent for that reason. The sweep also expires due requests (the kind's
  `onClosed` runs: a release goes `rejected`, a requested app `archived`).
- **Cancel** (`POST …/:id/cancel`): the requester or an admin, while pending (`approval.cancelled`).
- **Policies** (`approval_policies`, `GET|PUT|DELETE /api/approval-policies` — under `/api`, not
  `/api/admin`, because an organisation admin manages them: `manage ApprovalPolicy`; audited
  `approval.policy.set|removed`): per kind at scope app → the app's owner group → tenant → the
  code default (`DEFAULT_APPROVAL_POLICIES`). Fields: approvers `{appOwners, admins, groupIds,
  userIds}`, `minApprovals` (N), `allowSelfApproval`, `expiresAfterMinutes`, `autoApproveRole`.
  Only admins edit, at every scope — an owner loosening their own gate defeats it. Defaults:
  `app.create` admins, auto-approved at `launch_settings.app_create_role` (default admin), 7 days;
  `app.access` the app's owners AND the organisation's admins (P1 parity; migration 0024 widened
  the requests 0023 moved), 14 days; `deploy.production` owners + admins, N=1, 24 h or the
  ticket's own deadline; `session.budget` owners + admins, the session's `suspendedExpiryHours`;
  `session.merge` the app's owners, N=1, no self-approval, 48 h (`SESSION_MERGE_EXPIRY_HOURS`).
- **`session.merge`** (issue #5, `docs/plans/i5-ship-to-staging.md` §1.11–§1.12): a coding
  session's PR passed CI and waits for a person in Launch before Launch squash-merges it. Subject
  `session`, requester the session's creator, excluded everyone who wrote a `user.message` in it;
  the context (`sessionMergeContextSchema`) carries the PR, the ship summary and diff stat from
  `sessions.ship_summary` and the head SHA the approval is for. It is the one kind whose rule an
  app's OWNERS set too: the app's ship settings (`apps.ship_settings.review`: none, the app's
  owners, or named teams) are passed as the snapshotted policy, and an admin `approval_policies`
  row for `session.merge` at app, group or tenant scope wins over them and makes review mandatory
  (decision §0.3 relaxes "only admins edit" for this kind). **Today (slice S1) the kind is
  registered with its default policy and description only**: nothing opens one yet, and its
  `applyInTx` / `applyAfter` / `onClosed` throw `NotWiredError` until slice S2 wires the landing.
- **Reads**: `GET /api/approvals?box=mine|requested|all&status&kind&appId` (`all` is admins';
  anyone else asking for it gets `mine`), `GET /count` (the nav badge), `GET /:id` —
  `approvalDetailSchema` with the decisions, `canDecide` / `whyNot` / `canCancel` for the caller,
  and `eligible`: the people a pending request still waits on (eligible, not excluded, not yet
  decided; capped at 25), so the UI and the CLI NAME them. Anyone the policy names, the requester,
  the excluded and whoever decided may read a request; admins read all.
- **Notifications** (`notify.ts`, best-effort after commit): `approval_requested` to each eligible
  approver, `approval_decided` / `approval_expired` to the requester (`notificationLink` →
  `/approvals/:id`), `entity.changed {entity: 'approval'}` to everyone it concerns, and an
  `email.send` job per recipient (`email.ts`).

**Known gaps:** the `mine` box and the badge scan up to 500 pending rows and filter eligibility in
code; a global admin who is not a member of the organisation is never notified (they are not in
`tenant_users`); a cancelled request tells nobody but through the realtime nudge (no
`approval_cancelled` notification or email); approving by email reply or Slack is out of scope
(spec/08); session permission prompts (`canUseTool`) are not approvals (plan §1.14).

### 18.16 The stand-ins on the engine (P4)

Four P1–P3 stand-ins became kinds (plan §4c), each described with its surface: **`app.access`**
(§18.3 — asking opens it, the P1 decide route answers 410 `access_request_moved`, the approval's
`applyInTx` adds the grant), **`app.create`** (§18.5 — `POST /api/apps` writes the app
`requested` and opens it; `applyAfter` starts `APP_LAUNCH_WORKFLOW`; a rejection or expiry
archives the app), **`session.budget`** (§18.11 — `POST /api/sessions/:id/budget` answers
`extendBudgetResponseSchema`, the session plus `approvalId`: 200 when the caller's own approval
raised the cap, 202 while it waits; `applyAfter` wakes the session) and **`deploy.production`**
(§18.7 and §18.17). The P1 table `app_access_requests` is gone: migration 0023 copied its pending
rows into `approval_requests` with their ids, so `/apps/:slug/access` still lists them.

**Known gaps:** a budget request is found again after a reload only through the creator's own
`requested` box (an owner viewing someone else's blocked session sees Extend, which approves in
one click, not the pending request); `meetsAppCreateRole` survives only as the `app.create`
default.

### 18.17 Releases, Promote and the production gate

Launch does the kit's release dance itself (`services/launch/releases/*`, plan §1.8), under an
installation token narrowed to the one repo and revoked after each call (`releases/github.ts`).
**Release** (`POST /api/apps/:id/releases {bump}`, owners and admins) reads the root `package.json`
on the default branch, commits the bump (only the version moves), tags the bump commit `X.Y.Z` —
which starts `deploy.yml` staging — and records the merged PRs since the previous tag
(`compareCommits` + `listPullRequestsForCommit`; an app's first release uses its merged session
PRs), each matched to its Launch session; idempotent by the tag (a Release that died before
tagging resumes rather than bumping twice). **Promote** (`…/:rid/promote`) needs staging to run the
release and be `up` (probed now if the last reading is stale), then opens `deploy.production`
(subject `release`) excluding the promoter, whoever cut it and its sessions' creators. **On
approval** the kind (`approvals/kinds/deploy-production.ts`) writes a pre-approval bound to
`refs/tags/X.Y.Z` in the decide transaction and publishes the GitHub Release after it
(idempotent by `getReleaseByTag`); the production run's `start` claims it only if its ref matches.
A run published or dispatched by hand in GitHub opens its own approval (subject `deploy_ticket`,
requested by `github:<actor>`, expiring with the ticket); approving after its window is 409
`deploy_run_gone`. "Deploy to production" with no release opens one with subject `app` (the
default branch; approve → pre-approval + `workflow_dispatch`). A tag run links its ticket to the
release (`release_id`); activation (never a mere `finish` — §18.7) moves it `staging_active` /
`production_active`. The
`sessions.checks` cron follows shipped session PRs to their merge (`pr.merged` with the merge
SHA, `pr.closed`), and `GET …/:rid/chain` is the audit trail from PR to production, linked by ids.
**The pipeline strip** (rocketflare-launch#5) reads `GET /api/apps/:id/promotion`
(`releases/promotion.ts`, any member): the newest release (the candidate), each environment's
`last_deploy_version` / `last_deploy_at` / health / URL and the release carrying it, the PRs of
every release after production's version up to the candidate (the code is cumulative, so an
intermediate release that never reached production ships too; capped at 50), each with the title
of the Launch session that wrote it, and the candidate's `deploy.production` request with the people
it still waits on — named for every member, unlike the approval's own page. It decides nothing:
Promote is the same route and the same approval.

**Known gaps:** GitHub is polled, not listened to (webhooks are P6); the first release of an app
with no earlier tag lists only its session PRs; branch protection must let the App push the bump
to the default branch; rate limits on the compare for a large release are untested; a failed
production run marks the release `failed` but nothing re-dispatches.

### 18.18 The audit hash chain, verify and export (P4)

`audit_chain(tenant_id, seq, audit_event_id, prev_hash, hash)` (append-only) seals the audit log
(spec/08 "Integrity options", plan §1.12; `services/launch/audit-chain.ts`). The `audit.seal` task
(`*/5`) takes a per-tenant `pg_advisory_xact_lock` and appends the next ≤ 1 000 unsealed events in
`(at, id)` order, `hash = sha256(prev_hash ‖ canonical JSON of the event)`, `prev_hash` "" at seq
1 — a sealer rather than a trigger, so audit inserts never queue behind one lock. The canonical
form (version 1: fifteen fixed keys, nulls kept, `at` to the millisecond, `summary` keys sorted) is
documented in the file's header. `GET /api/audit/verify` (admin+, `auditVerifySchema`) recomputes
the chain: `ok`, rows checked, `sealedThrough`, `unsealed`, and the first broken `seq`.
`GET /api/audit/export?format=json|csv&appId&action&from&to` (admin+, audited `audit.exported`)
streams the sealed rows in `seq` order, then the unsealed ones with `seq`/`prevHash`/`hash` null;
every row carries `seq`, `prevHash` and `hash`. JSON Lines is the verifiable format:
`scripts/verify-audit-export.mjs` (no dependencies) re-derives each hash offline — a whole chain
by default, or a FILTERED export row by row with `--filtered`, each from its own `prevHash`. CSV
(RFC 4180, formula cells defused with `'`) is for reading. `launch audit verify|export` (§11)
streams the export straight to a `0600` file.

**Known gaps:** tampering is evident only after the next seal (up to five minutes); a chain cannot
show the loss of its NEWEST rows, or a log rewritten and re-sealed from some point on — keep each
export's last `seq`/`hash` and compare; a filtered export cannot show that nothing between two of
its rows is missing; no SIEM stream (P6); `audit.seal`'s advisory lock over Neon's WebSocket pool
is untested.

### 18.19 Approvals and releases: the UI and the CLI (P4)

**Inbox** `/approvals` (every member; nav badge = `GET /api/approvals/count`, refreshed by the
`approval` nudge, never polled): `?box=mine|requested|all` tabs (All for admins), `?kind=` /
`?status=` filters, each row a link saying in words what is being approved. **A request's page**
`/approvals/:id` (where every approval notification links): the decision panel pinned above the
context — focus on its heading, one sentence instead of buttons for someone who may not decide
(`whyNot`, naming who it waits on from the server's `eligible` — or saying nobody can approve it
under the policy), a 409 shown as information, N-of-M progress, an expiry that ticks at the rate
`expiryState` chooses, an optional comment, Withdraw for the requester or an admin — then the
requester's reason, the per-kind context (a production deploy: version, commit, staging health, the
PRs with their CI) and, for a release, its chain (`GET …/releases/:rid/chain`), beside the policy
snapshot and the decisions (with "Waiting on": the eligible people, by name). It polls only while an
approval is being carried out (`appliedAt` pending). **Settings → Approvals** (`manage
ApprovalPolicy`): per kind, the organisation's policy or the server-reported default, plus team/app
overrides. **The app page** leads with a pipeline strip — `Staging: v1.4.2 (healthy, deployed 10 minutes
ago)` → **Promote to production** → `Production: v1.4.1` — and, in plain words, what the promotion
ships (each session's title, then its PR's). Promote is on offer when staging runs the newest
release, is `up`, and production runs something older; otherwise the button is disabled with the
reason ("Staging is still deploying", "Staging is unhealthy", "Production already runs v1.4.2",
"Nothing on staging yet"). After the click (the same confirmation as a release row, the same
route) the strip stays: "Waiting for approval from <names>" with the request's link and Copy
link, then "Deploying to production…", then "Live in production: v1.4.2" with the production
link. Owners and admins (`viewerCanDeploy`) get the button; everyone else reads the strip with who
can promote. Every state is one pure function (`pages/apps/components/promotionModel.ts`). Below
it the Releases card (New release with a version preview, Promote → the
approval it opened, each release's chain on demand); a pending production ticket links to its
approval; "Deploy to production" opens a `deploy.production` request; the access page's requests
link to their approvals; a member's new app waiting in `requested` on an `app.create` approval shows
that request instead of the launch panel, and nothing polls while it waits. **The session page**: an
owner/admin's "Extend" still approves in one click; the creator gets "Ask for more budget" (amount +
reason → a `session.budget` request) and then a link to it. **The audit page**: Verify (on demand)
and CSV / JSON Lines export. **CLI**: `launch approvals ls|show|approve|reject` and `launch releases
ls|create|promote [--wait]` (§11); `approvals show` prints the eligible list too.

**Known gaps:** the policy's own words still count the teams a member cannot list rather than
naming them; the strip says what ships from session and PR TITLES — a PR's body is not stored, so
there is no summary beyond them; it polls only while the candidate deploys, so a staging health
change reaches it on the next read, a "Check now" or a release nudge; the strip's Promote is plain
`btn-primary`, not the page's flame (Start session already holds it); the releases card shows only what the audit log recorded (a release cut outside
Launch has no chain before its tag); nothing re-dispatches a failed production run from the UI.

### 18.20 Shared config and grants (P5)

Spec/09's catalogue is called **shared config** (`/shared-config`, `/api/shared-resources`),
because "catalogue" already means the apps list. A **shared resource** is a named bundle of items
(`{key, kind: var|secret, rotationDays?}`) owned by a kit group, with values sealed per
environment as one versioned blob (`services/grants/sealed.ts`, `encryptToken` — the
`admin_credentials` pattern). An app **holds** it through a grant — one app × resource ×
environment, approved as a `grant.request` (subject `grant`) whose approvers are the resource's
owner group — and `GRANT_PUSH_WORKFLOW` (`GrantPushWorkflow`, `launch-grant-push[-staging]`) puts
the values on the app's Worker as secrets, vars included (a `plain_text` would be overwritten by
the app's own toml on its next deploy). One live grant per app × resource × environment, one active
version per resource × environment, and one running push per resource × environment are partial
unique indexes rendered from the shared closed sets. `GRANT_BACKEND` is `cloudflare` (Worker
secrets) or `local` (records the names, development only — `loadConfig` refuses it elsewhere). A
group that owns a resource cannot be deleted (409 `group_owns_shared_config`); a resource is
archived, never deleted, while a grant points at it. Every service file under `services/grants/`
is listed with its exports in `types.ts`; the exit test is `tests/api/grants-e2e.test.ts` (below).

**Resources and values (5b — `resources.ts`, `values.ts`, `access.ts`).** Members read the list,
the item names and the policies (they need them to ask); the owner group's members and admins set
values and edit the description and items; admins create, archive and edit the owner group and the
per-environment `policies` (full `ApprovalPolicy` values — the P4 rule). **Values are write-only**:
no route answers a secret; a var's value is in the detail's `vars` for owners and admins only, and
only they see the holders (`access.canSeeHolders` — the one rule the push and revoke paths use
too). `PUT /:id/values/:env` writes version N+1 in one transaction with the resource row locked: a
blank or missing key keeps the previous value (opened and merged on the server), an unknown key is
400 `unknown_item_key`. With no holders it answers 200 `pushId: null` and the old version is
`retired` at once; with holders the old one goes `retiring` and a `rotate` push starts (202
`{versionId, version, pushId}`; 409 `push_in_progress` before any write while one runs). Archive
(`DELETE`) is 409 `resource_has_holders` while any grant is live. Audited
`shared_resource.created|updated|archived|values.set` — a summary names keys, never values.

**Pushes, rotation and revocation (5c — `push.ts`, `push-steps.ts`, `backing.ts`, `revoke.ts`,
`sweep.ts`).** `startPush` checks the binding (503 `grants_not_configured`), inserts the
`grant_pushes` row (idempotent by `approval_id`, so a retried `applyAfter` finds its push) and
creates the instance with the push id. Steps: `plan` materialises one `grant_push_targets` row per
grant in scope (`grant`/`repair`: the one grant; `rotate`: every active grant of the environment;
`revoke`/`expire`: the one `revoking` grant); `push#N` handles ten targets each, skipping a
succeeded target and a grant that already holds a newer version, and writes through the
`GrantBacking` seam (`put`, `putDetailed` → `{names, shadowedVars}`, `remove`); `finish` settles
`succeeded | partial | failed`. Values are opened inside `push#N`, registered for redaction and
scrubbed from every error; a step returns counts only. **A rotation retires the old version only
when every holder succeeded** — then the owners get `grant_rotated` ("revoke the old credential at
the vendor"; Launch cannot); a partial one leaves it `retiring`, notifies `grant_push_failed` and
offers Retry, which restarts the SAME push as instance `<pushId>-rN` and writes only the failed
targets (409 `push_not_retryable` for a push that succeeded). **The 10053 remedy**: a plugin
install puts its vars in the app's tomls, so the first push onto a Worker whose live version binds
`M365_TENANT_ID` as `plain_text` meets Cloudflare's 10053 "binding name already in use". The
backing then copies the serving version the way `wrangler versions secret put` does (metadata,
bindings, modules), drops those vars, adds the entries as `secret_text`, keeps every other secret
and the assets, and deploys it at 100% — one version, so the app is never without both — records
the names on the target (`grant_push_targets.shadowed_vars`, migration 0026) and audits
`grant.var_shadowed`. Revocation (`DELETE /api/apps/:id/grants/:gid` — the app's owners, the
resource's owners, admins) moves the grant `revoking` and a `revoke` push deletes the names (a 404
is done), ending it `revoked`; the app answers 503 by the kit's missing-config convention. The
`grants.sweep` task (`*/5`) reminds the app's owners 7 days before an expiry (`grant_expiring`),
expires due grants with an `expire` push, and reminds the resource's owners when a secret is older
than its `rotationDays` (`grant_rotation_due`, once per version).

**Requests, the app's grants and the gateway (5d — `approvals/kinds/grant-request.ts`,
`requests.ts`, `holders.ts`, `deploy/gateway.ts`).** `POST /api/apps/:id/grants` (the app's owners
and admins) refuses everything before its first row (`shared_resource_archived`,
`grant_expiry_past`, `values_not_set`, `grant_already_held`), then per environment writes a
`requested` grant and opens a `grant.request` with `policy: resource.policies[env] ??
resolvePolicy(…)` (the engine's optional `OpenApprovalInput.policy`, so a resource's own policy
wins) → 202 `{grants: [{id, environment, approvalId, status}]}`; `grant.requested` is audited with
the approval id, like every later grant row. The kind's `eligibleExtra` is the owner group's
members, so the default policy names nobody and the admins are refused (`not_an_approver`) unless
a policy adds them; the requester is excluded as on every kind. `applyInTx` activates the grant,
`applyAfter` starts its `grant` push, `onClosed` ends it `rejected` / `expired`. `GET
/api/apps/:id/config` (`appConfigView`) is what the app declares, what matched, what is needed and
every grant; `POST …/:gid/repush` starts a `repair` push. **The gateway's half**: `uploadDeploy`
drops the toml's `plain_text` / `json` bindings named by a LIVE grant of the app and environment
(`holders.grantedKeys` — `requested` included, so the first deploy after a request already stops
shipping the var) and records them as `shadowedVars` on the ticket and in `deploy.uploaded`;
`keep_bindings` carries the secrets. `activateDeploy` starts a `repair` push for a grant pushed
after the upload began, because the version holds the secrets as of its upload and activating it
would undo a newer rotation.

**Detecting declared needs (5e — `rocketflare/declared-config.ts`, `detect.ts`).** Spec/02's
`declaredConfig`: `launch.plugins.json` `surfaces[]` → each `anchor` (`plugin.json`) → `vars[]`
(parsed as `plugin-lib.mjs` validates them), plus the kit's optional secrets under plugin `kit`.
Keys match resource items by exact name; archived resources match nothing; a matched resource is
NEEDED when no environment holds a live grant of it. `scanAppConfig` runs after commit on import
(the route hands it `realtime`, so the bell nudges live), on a Release (at the new tag) and on
`POST /:id/config/scan` (answers `appConfigSchema`); it records `app_config_scans` (a failure is
`error` on the row, never a failed import or Release) and notifies the app's owners once per newly
needed resource (`grant_needed`, linked to the config page). `scanShipConfig` answers the same at a
session's PR head as the `ship.config_needs` event, never stored. Sessions never receive grant
values (spec/03).

**The UI and the CLI (5f).** `/shared-config` lists every resource with its value STATUS per
environment ("v3 · 2 apps"; "Show archived" lists archived ones WITH the live ones — `?archived=
true`); admins create one (`CreateResourceModal`). `/shared-config/:id` says what is set ("Set —
version 3, rotated 2 days ago by Carol"), shows var values and the holders to the owner team and
admins only (the detail's `holders` is the signal), and its values modal is write-only: a set key
reads "Set — hidden" with Replace, inputs are never pre-filled (secrets are password inputs), a
blank keeps the current value, and saving where apps hold it is a rotation whose push shows N/M
with the failed apps and Retry (`PushProgress`, polled only while queued/running). Revoke per
holder is confirmed; admins edit the per-environment policy (`ResourcePolicyForm`). An app's
`/apps/:slug/config` and the Config card on its page show the matched resources with a state per
environment (held / pushing / requested with the request's link / missing with Request), the
declared keys by plugin and the keys nothing matches. A `grant.request` approval names what the app
would receive and who decides — `extraApprovers` in `approvalModel.ts` names the owner team,
because the policy's own lists are empty; Settings → Approvals accepts a shared-config policy that
names nobody for the same reason (`hasImplicitApprovers`). Ship's `ship.config_needs` row is one
line in the session's ship panel. CLI: `launch shared ls|show|set|rotate|pushes` (values from a
hidden TTY prompt or stdin, never argv) and `launch grants needs|ls|request|revoke`.

**The exit test** (`tests/api/grants-e2e.test.ts`, spec/11 P5) runs it end to end with nothing P5
mocked: a Release of an app whose repo carries the M365 connector notifies its owner; the owner
requests both environments; the owner team approves (production N=2, the admin refused); the push
goes through the real Cloudflare backing into the FakeCloud (10053 on, so the live plain vars are
replaced by the remedy); a redeploy through `scripts/deployer.mjs` drops the shadowed toml vars and
keeps the secrets; one rotation reaches three holders (partial → Retry → old version retired →
vendor-revoke notice); a revoke empties one Worker only; the audit chain seals and verifies; and no
secret sentinel appears in any response, row, step result, notification, log line or deployer
output. Variants: a rejection, and a rotation between upload and activate restored by the repair
push.

**Known gaps:**

- *Cloudflare, unverified against the real API*: every secret write is a new deployed version, so a
  three-item push is three versions (a mixed state lasting seconds); the version and `content/v2`
  shapes the 10053 remedy copies; behaviour during a gradual deployment; per-script version counts
  and rate limits across a fleet-wide rotation; whether `keep_bindings` copies secrets as of the
  upload (§1.6 assumes so). Secrets Store is not a backing yet.
- *Pushes*: one push per resource × environment, so approving grants for several apps at once
  serialises them — a second approval's `applyAfter` meets 409 `push_in_progress`, is recorded on
  the grant's `push_error` and retried by the approvals sweep (up to five minutes later); a repair
  push colliding with a running rotation is recorded on the grant and NOT retried; a `startPush`
  that fails after the values commit leaves the previous version `retiring` with no push (a manual
  re-push or the next rotation clears it).
- *Resources*: `rotationDue` is measured from the active version's `set_at`, so changing a var
  restarts the secret's clock; removing an item in a `PATCH` does not remove the secret from
  holders' Workers; a resource can be archived while a version is still `retiring`; no UI to
  archive a resource or edit its items (the API and CLI only).
- *Requests*: an auto-approved request (`autoApproveRole`) audits `grant.approved` before
  `grant.requested`; a member with no part in a request gets 404 rather than 403 when deciding; a
  deploy while a grant is only `requested` already drops the toml var, so the app runs without it
  until the approval lands (or is rejected and the next deploy restores it); `ApprovalPanel`'s
  labels are generic for grants.
- *Detection*: the `grant_needed` link opens the config page with no resource preselected; local
  (`SESSION_BACKEND=local`) sessions emit no `ship.config_needs`; import and Release scan inline
  (a slow GitHub read lengthens the request).
- *Imported apps* must have their Workers in Launch's account with a recorded `worker_name`; one
  still deploying with its own `wrangler deploy` must drop the shadowed vars from its toml itself.
- *Local development*: `pnpm dev` takes `GRANT_BACKEND` from the toml (`cloudflare`) unless
  `.dev.vars` sets `local` (`.dev.vars.example` does; a `.dev.vars` made before P5 does not), so an
  approval under `pnpm dev` with platform credentials stored pushes to the real Cloudflare account.
  Add `GRANT_BACKEND=local` to `.dev.vars`.
- The exit test drives `GrantPushWorkflow` step by step under Node, not in workerd; the real exit
  run (a connector installed through a session, real Entra credentials, a rotation in Entra) is a
  staging task.
