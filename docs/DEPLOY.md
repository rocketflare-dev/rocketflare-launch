# DEPLOY — Cloudflare topology reference

What runs where, what the two wrangler files may and may not differ in, how resources are created,
how a release moves, and how it comes back. Procedure lives in `SETUP.md` Part 3; this is the
reference it points at.

**Workspace shape.** Everything Cloudflare lives in `apps/web`: `wrangler.toml`,
`wrangler.staging.toml`, `worker-configuration.d.ts`, `scripts/cf-provision.sh`, the parity test.
`wrangler` is a devDependency of that package, so every wrangler command runs **in `apps/web`** —
either `pnpm --filter @launch/web exec wrangler …` from the root (shorthand `pnpm web exec wrangler …`)
or the root scripts that delegate there (`pnpm deploy`, `pnpm deploy:staging`, `pnpm provision`,
`pnpm types`). `pnpm exec wrangler` at the workspace root does not resolve. Only `apps/web` is
deployed. **The CLI (`apps/cli`) is not deployed**: CI builds it (`pnpm build` → `apps/cli/dist`) as
a compile check, and it is distributed through the repo (`pnpm cli …`, or `pnpm --filter @launch/cli
build` and run `dist/cli.js`) or an internal registry — publishing the CLI is an app decision; the
package is private by default (`"private": true`, like `packages/shared`, which must stay private).

## Topology

```
                    GitHub Actions (deploy.yml)
     tag X.Y.Z ──────────────┐            ┌────────────── Release published
                             ▼            ▼
              ┌──────────────────┐  ┌──────────────────┐
              │ <app>-staging    │  │ <app>            │   one Worker per env:
              │ wrangler.staging │  │ wrangler.toml    │   fetch + queue + scheduled
              │ .toml            │  │                  │   + NotificationsHub DO
              └───────┬──────────┘  └────────┬─────────┘   + AgentRunWorkflow, AppLaunchWorkflow,
                      │                      │                   AppTeardownWorkflow
   bindings:  RATE_LIMIT_KV  [JOBS_QUEUE  FILES  AGENT_RUN_WORKFLOW  APP_LAUNCH_WORKFLOW  APP_TEARDOWN_WORKFLOW  AI]  ASSETS  (+ HYPERDRIVE under postgres)
   crons:     0 4 * * * (prune), */5 (app health) + plugins'   routes: /api /auth /ws /oidc /.well-known /ci + plugins'
                      │                      │
   neon:      DATABASE_URL secret        DATABASE_URL secret              (pooled Neon host, HTTPS + WS)
   postgres:  Hyperdrive <app>-staging   Hyperdrive <app>-production      (direct host, any Postgres)
                      │                      │
              Neon branch `staging`      Neon branch `production` (main)  one project, role per branch
```

The database path is per deployment (`DATABASE_DRIVER`, D35 — § Database driver below). Workers Paid
plan is required (Workflows, `[limits]`, and Hyperdrive under `postgres`) — Hyperdrive's plan
availability has changed over time; under `postgres` the create step (`cf-provision.sh`) reports if
the plan refuses it, with the upgrade URL. The account also holds your domain as a zone (registered there, or its nameservers
moved): the custom-domain `routes` and the Resend DNS records are created in it and `pnpm provision
preflight` proves it exists — without one, both hosts are `workers.dev` and email is skipped.
Smart Placement runs the Worker
near Neon rather than near the user, which is what makes sequential queries cheap.

## Database driver (D35)

`[vars] DATABASE_DRIVER` in each toml picks how the Worker reaches Postgres. **A toml with no
`DATABASE_DRIVER` means `postgres`**, and Launch's tomls say `"neon"`, so Launch deploys on Neon.
Locally `apps/web/.dev.vars` overrides it (the bootstrap
writes `DATABASE_DRIVER=postgres`), so development never needs the deployed driver.

| | `neon` | `postgres` |
|---|---|---|
| Driver | Neon serverless: neon-http per query, a WebSocket `Pool` per transaction | postgres.js |
| Reaches | Neon only, over HTTPS / WebSocket | any Postgres, through Hyperdrive |
| Worker holds | the `DATABASE_URL` secret — the **pooled** Neon URI | the `[[hyperdrive]]` binding (direct host) |
| `[[hyperdrive]]` block | **absent** — wrangler refuses a deploy naming an id that does not exist | present in BOTH tomls |
| Read cache | none | Hyperdrive's (60 s default) |
| Hyperdrive configs used (25 per account) | none | one per environment |

**Choosing.** Neon, and especially many apps in one account (a fleet) or a sandbox with no TCP out →
`neon`. Any other Postgres (RDS, Supabase, Crunchy, self-hosted), or one app that wants Hyperdrive's
read cache → `postgres`. `pnpm provision` reads the toml and `--driver neon|postgres` switches:
`pnpm provision cloudflare <env> --driver <d>` rewrites BOTH tomls (the var, and the
`[[hyperdrive]]` block added or removed), because the parity test wants the block in both or neither.

**Three `DATABASE_URL`s, one name.** The Worker secret (`neon` only: the pooled URI, written by
`pnpm provision secrets|deploy <env>`), the GitHub Environment secret (the DIRECT host, for
`db:migrate:ci` — any driver) and `.dev.vars` (the local database). Same name, different stores;
none of them is ever the other.

**Switching a live deployment `postgres` → `neon`**, one environment at a time, staging first:

1. `NEON_API_KEY=… pnpm provision secrets <env> --driver neon` (or `wrangler secret put
   DATABASE_URL` with the pooled URI). A `postgres` Worker ignores the secret, so this is safe first.
2. `pnpm provision cloudflare <env> --driver neon` — `DATABASE_DRIVER = "neon"` and no
   `[[hyperdrive]]` block, in both tomls. Commit.
3. Keep the `test-neon` CI job (§ CI/CD flow) green, deploy staging, check `/api/ready`, compare
   p95 with the Hyperdrive baseline, then production.
4. **Keep the Hyperdrive configs for about a week**: `wrangler rollback` to a `postgres` version
   restores its `HYPERDRIVE` binding and needs the config to still exist. Deleting them is a
   separate cleanup, never part of the switch.

`neon` → `postgres` is `pnpm provision cloudflare <env> --driver postgres` (creates the Hyperdrive
config, writes the block and the var into both tomls), commit, deploy. The Worker's `DATABASE_URL`
secret can stay; `postgres` reads it only when there is no binding.

## Wrangler anatomy — two files, one shape (D6)

`[env.*]` does not inherit bindings, so the kit ships two standalone files rather than one with a
hidden gap. `apps/web/tests/config/wrangler-parity.test.ts` enforces the table below; it runs in every
`pnpm test` and in `deploy.yml` with `REQUIRE_PROVISIONED=1`, which additionally forbids any
`<PLACEHOLDER>` value (CI on main stays green on an unprovisioned copy; a deploy cannot proceed with one).

| Must **differ** | Production | Staging |
|---|---|---|
| `name` | `<app>` | `<app>-staging` |
| `routes[].pattern` (custom domain) | app host | staging host |
| `workers_dev` | unset | `true` acceptable as fallback host |
| `[vars] APP_ENV`, `APP_URL` | `production`, `https://<app host>` | `staging`, `https://<staging host>` |
| `hyperdrive[].id` (under `postgres`), `kv_namespaces[].id` | env's ids | env's ids |
| `queues.*.queue`, `workflows[].name`, `r2_buckets[].bucket_name`, `analytics_engine_datasets[].dataset` | `<app>-jobs`, `<app>-agent-run`, `<app>-files`, `<app>_analytics` | same + `-staging` / `_staging` |

| Must be **identical** | Why |
|---|---|
| `main`, `compatibility_date`, `compatibility_flags = ["nodejs_compat"]` | same runtime semantics |
| every `binding` name, every DO `class_name`, `[[migrations]]` | application code never branches on environment |
| `[limits]` (present in both or neither) | Workflows bound CPU per step by it — see below |
| `[triggers].crons` | the dispatcher table in `scheduled.ts` is one file |
| `[assets]` (incl. `run_worker_first`), `[placement]`, `[observability]` | same SPA, same placement, same logging. `run_worker_first = true` (Launch P3): the asset router runs BEFORE the Worker and `single-page-application` answers any NAVIGATION with `index.html` without invoking `fetch` — an `<object>` embed, an `<a download>` click, and a coding session's preview (a navigation to `/` on `<port>-<shortId>-<token>.<preview domain>`, which would otherwise get LAUNCH's `index.html`). So every request reaches the Worker, and the Hono catch-all serves `ASSETS` itself while every prefix in `API_PREFIXES` stays a JSON 404 (`wrangler-parity.test.ts` asserts both) |
| `[[containers]]` (class, image, instance type, `max_instances`) | the session image and its capacity are code (Launch P3) — see § Coding sessions |
| `[vars]` **keys** (values may differ) | `loadConfig` validates one schema. `DATABASE_DRIVER` is a value, so staging may switch driver before production |
| `[[hyperdrive]]` present in both or neither | it exists only under `postgres` (D35) |

`localConnectionString` (in the `[[hyperdrive]]` block, `postgres` only) is dev-only and is the same
in both files (one local database).

## Resources per environment

| Resource | Binding | Name (prod / staging) | Create |
|---|---|---|---|
| Hyperdrive (`postgres` only) | `HYPERDRIVE` | `<app>-production` / `<app>-staging` | `pnpm --filter @launch/web exec wrangler hyperdrive create <name> --connection-string="<direct neon url>"` → `id` |
| KV | `RATE_LIMIT_KV` | `<APP>_RATE_LIMIT` / `<APP>_RATE_LIMIT_STAGING` | `pnpm --filter @launch/web exec wrangler kv namespace create <name>` → `id` |
| Queue (Phase 2) | `JOBS_QUEUE` | `<app>-jobs` / `<app>-jobs-staging` | `pnpm --filter @launch/web exec wrangler queues create <name>` (name-referenced) |
| R2 (Phase 2) | `FILES` | `<app>-files` / `<app>-files-staging` | `pnpm --filter @launch/web exec wrangler r2 bucket create <name>` |
| Durable Object (Phase 2) | `NOTIFICATIONS_HUB` | class `NotificationsHub` | declared in toml + `[[migrations]] tag = "v1", new_classes` — no create step |
| Workflow (Phase 3, built) | `AGENT_RUN_WORKFLOW` | `<app>-agent-run` / `<app>-agent-run-staging` | `[[workflows]] name / binding / class_name = "AgentRunWorkflow"` — `wrangler deploy` registers it, no create step; **account-scoped name** |
| Workflows (Launch P2) | `APP_LAUNCH_WORKFLOW`, `APP_TEARDOWN_WORKFLOW` | `launch-app-create` / `launch-app-create-staging`, `launch-app-teardown` / `launch-app-teardown-staging` | `[[workflows]]` with `class_name = "AppLaunchWorkflow"` / `"AppTeardownWorkflow"` — registered by `wrangler deploy`, no create step; **account-scoped names**. They create and archive the company's apps; each instance id is a pipeline run id (`<runId>-rN` on a retry) |
| Workers AI (Phase 3, built) | `AI` | — | `[ai] binding = "AI"` — no resource; the zero-key floor for chat (`@cf/zai-org/glm-4.7-flash`) and embeddings (`@cf/baai/bge-m3`); **billed per call to this account** (10k free neurons/day), `wrangler dev` proxies to the logged-in account; remove from BOTH tomls for zero-spend |
| Browser Rendering (app thumbnails) | `BROWSER` | — | `[browser] binding = "BROWSER"` in BOTH tomls — no resource; the `app.thumbnail` job screenshots an app's root URL after each deploy goes live (`docs/CONCEPTS.md` §18.21). **Needs Workers Paid** for practical limits (Free: 10 browser-minutes a day, 3 concurrent browsers) and bills browser time per capture. Optional in code: without the block the job logs and acks and apps show their initial — delete it from BOTH tomls to turn thumbnails off. Under `wrangler dev` it is a local browser (downloaded on first use) |
| Analytics (a PLUGIN, D31) | — | — | **no resource and no binding**: its cubes read through the request's database handle (either driver), its fact tables rebuild on the `15 * * * *` cron it declares, and `/cubejs-api` + `/mcp` are routes of this Worker. Installing it means adding that cron and those two prefixes to BOTH tomls — `pnpm provision cloudflare <env>` reads them off the installed surface and writes them (decision 12) |
| Analytics Engine (optional) | `ANALYTICS_ENGINE` | `<app>_analytics[_staging]` | declared in toml — deliberately NOT wired by the kit (only a comment in both tomls) |
| Static Assets | `ASSETS` | — | `[assets] directory = "./dist/ui"` uploaded atomically with each deploy; `run_worker_first = true` sends every request to the Worker first (Launch P3's session previews), so `/api`, `/auth`, `/ws`, Launch's issuer prefixes `/oidc` and `/.well-known`, its GitHub-OIDC surface `/ci` (P2: the deployer protocol and the scaffold job; 64 MB body cap on `POST /ci/deploy/:id/upload`, 1 MB elsewhere) and every prefix an installed plugin declares never meet the asset router — the Hono catch-all serves `ASSETS` for the rest |
| Session containers (Launch P3) | `SESSION_SANDBOX` | class `SessionSandbox`; container application `launch-sessionsandbox` / `launch-staging-sessionsandbox` (wrangler names it from the Worker and the class) | `[[containers]]` (`image = "./containers/session/Dockerfile"`, `instance_type = "standard-3"`, `max_instances = 10`) + `[[durable_objects.bindings]]` + `[[migrations]] tag = "v2", new_sqlite_classes` — no create step: `wrangler deploy` builds the image (Docker, amd64) and pushes it to Cloudflare's registry. See § Coding sessions |
| R2 (Launch P3, fast resume) | `BACKUP_BUCKET` | the SAME bucket as `FILES` (`launch-files` / `launch-files-staging`) | no create step — a second binding on the `FILES` bucket, the Sandbox SDK's fixed name for workspace backups (objects under `backups/`). Give the bucket an R2 lifecycle rule deleting `backups/` after a few days (`wrangler r2 bucket lifecycle add <bucket> …` or the dashboard): `cleanup` deletes a session's backup, the rule catches the rest. Unused until `SESSION_WORKSPACE_BACKUP` is set — see § Coding sessions |
| Workflow (Launch P3) | `SESSION_WORKFLOW` | `launch-session` / `launch-session-staging` | `[[workflows]]` with `class_name = "SessionWorkflow"` — registered by `wrangler deploy`; **account-scoped name**. One instance per coding session (id = the session id, `<id>-rN` on a restart) |
| Workflow (Launch P5) | `GRANT_PUSH_WORKFLOW` | `launch-grant-push` / `launch-grant-push-staging` | `[[workflows]]` with `class_name = "GrantPushWorkflow"` — registered by `wrangler deploy`; **account-scoped name**. One instance per shared-config push (id = the `grant_pushes` id, `<id>-rN` on a retry); a missing binding is 503 `grants_not_configured` before any row. `[vars] GRANT_BACKEND = "cloudflare"` in both files (`local` is development only) |
| RLS app role (optional, docs/RLS.md, not wired yet) | `postgres`: `HYPERDRIVE_APP`; `neon`: an `APP_DATABASE_URL` Worker secret | `<app>-<env>-app` | `postgres`: `… hyperdrive create … --caching-disabled`; `neon`: `wrangler secret put APP_DATABASE_URL` |
| Plugin resources (D31) | whatever the plugin's `plugin.json` declares (`APPROVALS_CACHE`…) | `<app>-<id>-<name>[-staging]`, and `<APP>_<ID>_<NAME>[_STAGING]` for KV | `pnpm provision cloudflare <env>` — it reads each installed plugin's `bindings[]`, creates the `kv`/`queue`/`r2` ones through `cf-provision.sh` and patches every block into BOTH tomls |
| Plugin Workflow / Durable Object (D31) | whatever the plugin declares (`ORDERS_SYNC`, `ORDERS_HUB`…) | workflow `<app>-<id>-<name>[-staging]`; a DO binding has no account-scoped name | **no create step** — `pnpm provision cloudflare <env>` writes `[[workflows]]` / `[[durable_objects.bindings]]` (+ a `plugin-<id>-v1` `[[migrations]]` tag) into both tomls and `wrangler deploy` registers them. The `class_name` resolves through the sixth barrel, `apps/web/src/plugins/worker-exports.ts` |

`pnpm web provision:cloudflare <staging|production> [app] [--apply] [--force]` (the `apps/web`
script → `scripts/cf-provision.sh`, which `cd`s to `apps/web` itself so it also works as
`bash apps/web/scripts/cf-provision.sh …`) creates a RESOURCE LIST idempotently — the kit's own
ones, KV, Queue and R2 (plus Hyperdrive when `DATABASE_DRIVER` — from the environment, else the
toml — is `postgres`), are the default list, each found by name and reused when it exists, and `PLUGIN_RESOURCES` (a JSON array of `{ type, name, binding }`, set by
`pnpm provision cloudflare <env>` from the installed plugins' manifests) appends to it — and either
prints the Hyperdrive/KV ids
with a `sed` line per toml, or with `--apply` writes them into that toml through
`scripts/provision/patch-toml.ts` (a DIFFERENT existing id is refused unless `--force`). Under `postgres` it needs
`NEON_DATABASE_URL` (direct host); both drivers need an authenticated wrangler (`wrangler login`, or
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`); the connection string is an argument of the one
`wrangler hyperdrive create` process and is redacted from every echoed line.
**Plugin resources (D31, Decision 12).** A plugin ships no toml — the two files are the host's,
always — so its `plugin.json` DECLARES what the account has to provide and `pnpm provision
cloudflare <env>` applies it. `scripts/provision/plugin-resources.ts` owns the naming rule
(`<app>-<id>-<name>[-staging]` for a queue, bucket or Workflow, `<APP>_<ID>_<NAME>[_STAGING]` for a
KV namespace, mirroring the kit's own `<APP>_RATE_LIMIT[_STAGING]`) and the refusal: a `type`
outside `kv | queue | r2 | workflow | durable_object` names itself in the error rather than being
skipped, because a binding quietly not created is a Worker that deploys and then 503s.

**Two of those five are declared rather than created.** `workflow` and `durable_object` need no
`wrangler … create`: the block in the toml is the whole registration, and `wrangler deploy` does
the rest. They are writable at all only because of the sixth barrel (D31) — a `class_name` resolves
against the named exports of `src/worker.ts`, so until `apps/web/src/plugins/worker-exports.ts`
made a plugin's class reachable there without anyone editing the entry module, either block would
have named a class nothing exported, and `wrangler deploy` refuses the whole script for that.
`d1`, `vectorize` and `analytics_engine` have no such mechanism and stay refused. `hyperdrive` is
deliberately not offered — the host owns the one database.

A `durable_object` binding also brings a `[[migrations]]` entry, tagged `plugin-<id>-v1` and
carrying `new_sqlite_classes` or `new_classes` according to the plugin's declared `storage` (which
is required, because a namespace cannot be migrated between the two). **Those tags are append-only
and host-owned**, exactly as the SQL migrations are: a tag is the record of what this Worker has
already told Cloudflare, so it is never renumbered and never rewritten. Removing the plugin takes
the next free `plugin-<id>-v<n>` with `deleted_classes` — and that one is a HUMAN step, because it
destroys the namespace and everything stored in it.

The phase writes the DECLARATIONS into **both** tomls first (the binding block with a
`<PLACEHOLDER>` id, the `crons`, the `[vars]` keys, the `apiPrefixes` in `run_worker_first` — a
no-op while it is `true`, as Launch's is), then
creates the resources for the environment it was given and patches that file's ids. Both files,
because the ordinary parity test compares binding names, `[vars]` keys, crons and
`run_worker_first` on every `pnpm test`; the placeholder in the other environment is refused by
`REQUIRE_PROVISIONED=1` until `pnpm provision cloudflare <other>` runs — exactly how the kit's own
`<KV_RATE_LIMIT_ID>` behaves. A `var` marked `"secret": true` is a Worker secret offered by
`pnpm provision secrets <env>`, never a `[vars]` key.

`pnpm provision <phase> [env]` (`apps/web/scripts/provision.ts`, driven by the `/launch-provision` skill) is
the orchestrator around it — phases `tokens` (TTY only: hidden prompts → `apps/web/.provision.env`) · `preflight` · `email create|status|verify` · `neon` ·
`cloudflare <env>` (this script with `--apply`) · `migrate <env>` · `github <env>` · `urls` ·
`deploy <env>` · `secrets <env>` · `all` — each idempotent, each ending in one `Verify:` line;
`SETUP.md` Part 3 has the table.

## Coding sessions (Launch P3)

A coding session is a Cloudflare Sandbox container (`@cloudflare/sandbox` **0.12.10**, the stable
line S7 proved, with the matching `cloudflare/sandbox:0.12.10` base image — keep the two on the SAME
version) driven by the `SessionWorkflow`, with its preview served by this Worker. What a deployment
needs, beyond the bindings above:

- **The image.** `apps/web/containers/session/Dockerfile` (a placeholder until slice 3b; the real
  one adds Node 24, pnpm 10, a pinned Claude Code and a warm pnpm store). `wrangler deploy` builds it
  with Docker and pushes it — the first push from an ARM Mac took ~5 minutes in S7 (amd64
  emulation), a cached one ~14 s. `pnpm build:api` (`wrangler deploy --dry-run`) builds it too, with
  the local Docker (observed under wrangler 4.127; nothing is pushed), and refuses a missing
  Dockerfile. Deleting the Worker leaves the container application and its
  images behind: `wrangler containers delete`, `wrangler containers images delete`.
- **`[vars]`.** `SESSION_BACKEND = "cloud"` (`local` is `wrangler dev` only — `loadConfig` refuses it
  elsewhere) and `SESSION_PREVIEW_URL = "https://{label}.<domain>"`: `{label}` becomes
  `<port>-<shortId>-<token>`. The preview hosts need a Worker route `*.<domain>/*` to THIS Worker
  and the proxied wildcard DNS record the apps domain already has (a more specific app route still
  wins); a wildcard is only allowed at the start of a route host (S7). Both environments name the
  same template today — give staging its own domain before running sessions on both.
- **Secrets.** No new Worker secret: the Anthropic key is the Setup page's `anthropic_api_key`
  credential, falling back to `ANTHROPIC_API_KEY`. The GitHub App needs `checks: read` and
  `statuses: read` on top of P2's permissions (the Setup check fails without them).
- **Egress.** `SESSION_EGRESS` in `[vars]` (both tomls, and the sandbox host's) picks the mode.
  `allowlist` (missing = this): internet OFF and an allow-list (`registry.npmjs.org`, `github.com`,
  `codeload.github.com`, `api.anthropic.com`, plus the session's Neon endpoint). `open` (what the
  tomls say for now): internet on, no allow-list, only `api.anthropic.com` and `github.com`
  intercepted. `open` is there because on real containers the interception never ends a
  container's stream after a WebSocket closes, so the kit's database scripts never exit and a
  session can't boot (`docs/plans/sandbox-websocket-close.md`); it gives up the limit on where a
  session can send data. Either way `interceptHttps = true` is set explicitly (the stable packages
  default it to `false`), and the model key and the GitHub token are injected by the outbound
  handlers IN THIS WORKER — the sandbox never holds either. A change to the var is a redeploy; a
  container already running keeps its interception until it restarts, so check with a NEW
  session.
- **Agent runtimes and personal AI accounts** (`docs/CONCEPTS.md` §18.22). Not vars: which coding
  agents sessions run, each one's model and who pays (Launch, the person's own Claude subscription
  or ChatGPT plan, or either) are set on Settings → Platform → Setup → **Coding agents**, a platform
  setting (`session_policy.runtimes`). With nothing set there: Claude Code on Launch's key only.
  Where a session's container runs is a platform setting too (Settings → Platform → Coding agents →
  **Session sandbox**, `launch_settings.session_sandbox_host`); a deployed Launch offers only its
  own containers, so there is nothing to set — the retired `SESSION_SANDBOX_HOST` var was
  development only and never in the tomls.
  `[[workflows]]` `AGENT_LOGIN_WORKFLOW` (`launch-agent-login`, staging `-staging`; nothing to
  create) runs a sign-in in a throwaway `login-<id>` sandbox of the existing `SessionSandbox` class
  — those count against `max_instances`. Optional secret `OPENAI_API_KEY` (or the Setup page's
  `openai_api_key` credential, which wins): what Codex sessions on Launch's account spend; likewise
  `ANTHROPIC_API_KEY` or the `anthropic_api_key` credential for Claude Code. Nothing to do on a
  deploy. To offer Codex, deploy the `session-6` image (or later), then turn Codex on in the card
  (for ChatGPT plans, device-code sign-in must be allowed on the person's account or workspace).
  **The image carries Codex from `session-6`** (a pinned `@openai/codex`, `ARG CODEX_VERSION`):
  the first deploy of it replaces every container, so drain first (below).
- **Drain before a deploy that touches the image or `[[containers]]` — REQUIRED.** A rollout replaces
  running containers and cuts off a running turn (S7 finding 8). The steps:
  1. Admin → Sessions → **Drain** (`POST /api/admin/sessions/drain`): new sessions answer 409
     `sessions_paused`, and every live session is woken to checkpoint (commit + push + transcript
     to R2) and suspend; a running turn finishes first. A suspended session that still keeps a
     warm container (an idle suspend, below) is woken too, and its Workflow destroys the container.
  2. Wait until Admin → Sessions shows no `ready` / `working` / `booting` session (and give the
     warm-suspended ones a few seconds to be cooled).
  3. Deploy.
  4. **Undrain** (`POST /api/admin/sessions/undrain`). People resume their own sessions (a message
     or Resume boots them again from their branch).

  A turn a rollout cuts off anyway is recorded `turn.interrupted` and the session goes `suspended`.
- **Capacity.** `max_instances` (10) caps live sessions across the deployment, and each app's Neon
  project caps its branches (10 on Launch, 25 on Scale) against `maxConcurrentPerApp` (3).
- **Warm suspends.** An idle session (`idleSuspendMinutes`, 30) is suspended with its container
  KEPT for `SESSION_WARM_KEEP_MINUTES` (45, `services/sessions/warm.ts`), so a resume inside that
  window skips the clone, install and bootstrap. A kept container is billed container time and
  counts against `max_instances` until it is cooled; lower the constant to trade resume speed for
  cost. The SDK's own `sleepAfter` (90 min) must stay longer than it (a config test pins it).
- **Workspace backups (off unless set).** When a container IS destroyed (after the warm window, or
  by a drain) the SDK's `createBackup` can save `/workspace/app` — checkout, `node_modules` and the
  app's `.dev.vars` (the session branch's URI: a credential, kept in Launch's own bucket, deleted
  with the session) — so a cold resume restores it instead of cloning and installing. Deployed it
  needs the SDK's presigned path: `SESSION_WORKSPACE_BACKUP = "presigned"` in BOTH tomls' `[vars]`,
  and on the Worker `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` (an R2 API token with object
  read/write on the bucket, `wrangler secret put`), `BACKUP_BUCKET_NAME` (the bucket's name) and
  `CLOUDFLARE_ACCOUNT_ID` (or `BACKUP_BUCKET_ENDPOINT` for a jurisdiction endpoint) — as vars in
  both tomls or as secrets. The session's allow-list gains `<account>.r2.cloudflarestorage.com`
  only while a backup or restore runs; a restore mounts the archive with FUSE (the SDK's
  squashfuse + overlay). **Unproven on Cloudflare**: the presigned upload through the container's
  HTTPS interception, FUSE in the session container, and the time for an archive with
  `node_modules`. The `binding` mode `wrangler dev` uses is not for a deployed Worker — on the SDK's
  default HTTP transport its restore holds the archive in the Durable Object's 128 MB.

## The sandbox host (development only)

`launch-sandbox-dev` (`apps/web/wrangler.sandbox-host.toml`, entry `src/sandbox-host/worker.ts`) is
a second, small Worker that gives a LAPTOP's Launch real Cloudflare session containers (the
Session sandbox platform setting's **Remote sandbox host**, `docs/SESSIONS-LOCAL.md` § Real
containers from a laptop). It is NOT part of Launch's deploy — no CI job, no provisioning phase,
and deployed Launch never binds to it: the `SANDBOX_HOST` remote service binding exists only in the
`wrangler.dev-remote.toml` that `pnpm dev` generates, and outside `APP_ENV=development` the setting
offers only the Worker's own containers (a stored `remote` is ignored, a PUT of it refused).

| | |
|---|---|
| Bindings | `SESSION_SANDBOX` → `HostedSessionSandbox` (Durable Object + `[[containers]]`, `[[migrations]] v1 new_sqlite_classes`) — nothing else |
| Container | the SAME `./containers/session/Dockerfile` and `standard-3` as Launch (a config test pins both), `max_instances = 3`; container application `launch-sandbox-dev-hostedsessionsandbox` |
| Reachability | `workers_dev = false`, `preview_urls = false`, no routes: only a service binding in the account reaches it |
| Secrets | none. The laptop's Launch sends each sandbox an egress grant over the binding (the `host` egress mode): the GitHub token before the clone and each push; before each turn the model credential for the session's runtime and account (Launch's Anthropic or OpenAI key, a person's Claude subscription token, or a ChatGPT plan's model); a sign-in's passthrough. `HostedSessionSandbox` keeps it in its Durable Object storage and its own outbound handlers (the same six hosts as Launch's) inject it — the containers hold no Launch credential |
| Build check | `pnpm build:sandbox-host` (a dry run, part of `pnpm build`; it builds the image with the local Docker) |

**Deploy** (by hand, from a machine with Docker and `wrangler login` on the Launch account):

```bash
pnpm --filter @launch/web deploy:sandbox-host   # = wrangler deploy -c wrangler.sandbox-host.toml
```

The first push builds the amd64 image (minutes under emulation on an ARM Mac; cached after). The
same rules as Launch's own containers: a change to the image or the `[[containers]]` block replaces
running containers (end or suspend dev sessions first), and `@cloudflare/sandbox` and the image's
base stay on one version. **Redeploy it whenever the session image or `src/sandbox-host/`
changes** — it builds the same Dockerfile, so a Launch deploy of a new image does not reach it.
**Now (Codex and personal accounts on the host):** a host deployed before it answers only the old
`model` grant — Claude Code on Launch's key — and refuses Codex's hosts and the sign-in hosts.
Redeploy it, which also moves it to the `session-6` image (Codex installed) and so replaces its
running containers: end or suspend remote sessions first (there is no drain switch for the host —
it has no database), then

```bash
pnpm --filter @launch/web exec wrangler login           # if not already, on the Launch account
pnpm --filter @launch/web deploy:sandbox-host           # = wrangler deploy -c wrangler.sandbox-host.toml
pnpm --filter @launch/web exec wrangler containers list # check the new version's application
```

and restart `pnpm dev` (it re-checks that the host is deployed and declares the binding). **Costs:** a `standard-3` bills memory and disk while awake (~$0.076/hour)
and CPU when used; a session's container lives through its idle window plus the 45-minute warm keep,
and the SDK's 90-minute sleep reaps one whose laptop went away. **Remove it:**
`pnpm --filter @launch/web exec wrangler delete -c wrangler.sandbox-host.toml`, then
`wrangler containers list` / `wrangler containers delete <id>` and `wrangler containers images
delete` for what the Worker leaves behind.

## Launched apps' branch protection (issue #5)

Launch merges a session's PR itself once `Gate` (the kit's CI job) is green and then pushes the
release bump straight to the app's default branch, so the branch must require `Gate` for
everyone EXCEPT Launch's GitHub App. Launch does that with a repository ruleset named `launch`
(`docs/CONCEPTS.md` §18.4) and never with classic branch protection, which no GitHub App can
bypass — under classic required checks every release fails at the bump (`release_failed`).

- **New apps** get the ruleset from the launch pipeline's `github_env` step. On a plan without
  rulesets (a private repository outside GitHub Team) the step records `unavailable` and the
  launch goes on unprotected.
- **Existing apps** (created before issue #5, or imported): `GET /api/apps/:id/branch-protection`
  says how the default branch stands. `none` → an admin applies the ruleset (**Apply**,
  `POST /api/apps/:id/branch-protection`, audited `app.branch_protection.applied`). `blocks` → the
  detail names the rule:
  1. Classic protection: on GitHub, the repository's Settings › Branches → delete the rule for the
     default branch (Launch never edits or removes it), then press **Apply**.
  2. A ruleset the App may not bypass (an organisation ruleset, or a repository one someone added):
     add the Launch GitHub App to its bypass list with "Always", or delete it, then **Apply**.
  `unknown` → the detail says why GitHub could not be asked (no repository, the App not installed
  on the owner, GitHub down); `unavailable` → upgrade the organisation's plan or accept no
  protection. Verify: the card reads `ok` and the repository's Settings › Rules › Rulesets lists
  `launch`, requiring `Gate`, with the App under Bypass list.
- **Apply rewrites** a `launch` ruleset someone edited on GitHub back to Launch's shape. Add any
  extra rules of your own in a ruleset of another name, with the App as a bypass actor.

## Crons

`[triggers] crons` must be identical in both tomls (parity test); `apps/web/src/api/scheduled.ts`
`SCHEDULED_TASKS` is the dispatcher, keyed on the exact expression.

| Expression | Task | What it does | Local trigger (`wrangler dev` never fires crons itself) |
|---|---|---|---|
| `0 4 * * *` | `pruneExpired`, `pruneAiSpans` | deletes expired sessions, consumed/expired magic links, invitations older than 30 days; then `ai_spans` older than `OBSERVABILITY_SPAN_RETENTION_DAYS` (14), one DELETE across every tenant (D32) | `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=0+4+*+*+*"` |
| `*/5 * * * *` | `healthPoll` (Launch, spec/06) | polls `/api/health` + `/api/ready` of every registered app environment, records the check, audits a status change, prunes checks older than 7 days; on demand, `POST /api/apps/:id/health-check` ("Check now") | `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*"` |
| `*/5 * * * *` | `sessions.expire`, `sessions.checks`, `sessions.gate-sweep` (Launch P3; issue #1) | ends a coding session suspended longer than its policy's `suspendedExpiryHours` (a backstop: its Workflow's own wait normally does it); refreshes the CI of shipped sessions' PRs that are pending, unread, or `none` within an hour of the ship; deletes ship-gate Neon branches (`gate-<short>-<n>`) older than three hours that a ship left behind | same as above |
| `15 * * * *` | `analytics.refreshFactTables` (the analytics PLUGIN, D31) | every registered fact table, per tenant, DELETE+INSERT in one transaction; per-tenant failures collected, logged as a warning, never abort the run. The expression is the plugin's `crons` declaration and the task is `ServerPlugin.scheduledTasks` — **a task under an expression no toml declares simply never runs** | `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=15+*+*+*+*"` — or, for one organisation, `launch analytics refresh-facts` |

Launch P2 (creating apps) adds **no cron of its own**. The crons an APP runs are the app's: the
deploy gateway applies an app's `[triggers]` to its Worker at `activate` (`PUT …/schedules`),
because a Workers version upload does not.

**Routes Launch creates for apps (P2).** Launch's own Worker keeps its one custom domain. Each app
environment gets a zone route `<slug>[-staging].<apps domain>/*` → its Worker, created by the launch
pipeline in the apps zone (`app_environments.route_ids`) and deleted by teardown; it must take
precedence over any catch-all on the zone (checked at the real-infrastructure exit, plan §5).

Health of the fact tables: `GET /api/analytics/facts/status` (admin+; `stale` = newest source row
has waited > 2× the table's interval) or `launch analytics check-facts`, which exits 1 when
any table is stale and so works as a pipeline health check. Both go through the deployed API with a
tenant API key, so there is no path here that wants a production `DATABASE_URL` on somebody's
laptop. Cron runs share the Worker's CPU budget: past a few hundred tenants, fan the per-tenant
rebuilds out through `JOBS_QUEUE`.

## Account-scoped names — the incident this guards against

Workflow names are unique **per Cloudflare account**, not per Worker. Whichever script last deployed
a given name owns it, and every instance created under that name — including instances created by
the *other* environment's binding — runs with the owning script's bindings, against the owning
script's database. In one of the source applications, staging and production briefly shared a
Workflow name: the production API created a run and started an instance, the instance executed under
the staging worker against the staging database, and production was left with a `pending` row and a
UI stuck on its last progress event. Nothing errored. Queue, R2 and Analytics Engine names are
account-scoped too. Hence: every such name in `wrangler.staging.toml` ends in `-staging`, `binding`
and `class_name` stay identical, and the parity test refuses a collision.
`pnpm --filter @launch/web exec wrangler workflows list` shows Name → Script name if you suspect one.

## `[limits] cpu_ms` — per step, both files or neither

Workflows bound CPU **per `step.do`** by the script's `cpu_ms` — 30 s default, up to 300 s on Paid.
CPU is not wall clock: a step that is almost entirely I/O still dies if it *processes* enough items
(items × per-item cost). The same source app lost a long ingest step to the 30 s default after 16
minutes of wall time, and separately had `[limits]` present in only one toml, so the same class died
in one environment and nowhere else. The kit ships `[limits]` commented out (default 30 s); raise it
in **both** files, and split a heavy phase into its own step to draw a fresh budget. Isolate memory
(128 MiB) is not configurable — page through large tables.

## Secrets model

| Kind | Where | Examples |
|---|---|---|
| Non-secret config | `[vars]` in each toml (committed) | `APP_ENV`, `APP_URL`, `APP_NAME`, `RELEASE_VERSION`, `LOG_LEVEL`, `EMAIL_FROM`, `TENANCY_MODE`, `SIGNUP_MODE`, `TENANT_SCOPE_MODE`, `AGENT_MAX_OUTPUT_TOKENS` (16384), `AGENT_MAX_TURNS` (30), `CHAT_KNOWLEDGE_TOOLS` (`true`), `CHAT_HISTORY_MAX_CHARS` (24000), `AGENT_INTERRUPT_TIMEOUT`
(`168 hours` — how long an agent run parked on a human question waits before it expires; it is
passed verbatim to `step.waitForEvent`, so it must be a duration the platform accepts, between
1 second and 365 days. **Instance retention is the real bound, not this**: 30 days on Paid, 3 on
Free, after which the instance is gone and the park is recovered by `expireParkedRun` plus the
`sendEvent → not_found` restart), `FEATURES_ENABLED` (D30 —
feature keys this environment ships at all; blank is fail-closed, and this is the knob that keeps an
unreleased surface dark in production while staging has it). `OBSERVABILITY_CAPTURE_CONTENT` (`true`), `OBSERVABILITY_SPAN_RETENTION_DAYS` (`14`) (D32). Defaulted in `config.ts` and **not** declared in the tomls until used: the OIDC sign-in vars `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_LABEL` (`Single sign-on`), `OIDC_SCOPES` (`openid email profile`), `AUTH_OIDC_ONLY` (`false`; `true` without an issuer is a config error), `OIDC_TRUST_EMAIL` (`false` — a missing `email_verified` is refused; `true` only for an issuer that controls the email claim, e.g. single-tenant Entra) — add them to BOTH tomls to turn SSO on (`SETUP.md` 2.3b); `OBSERVABILITY_PRESET`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OBSERVABILITY_TRACE_URL`, `LANGFUSE_BASE_URL` (`https://cloud.langfuse.com`), `LANGFUSE_TRACING_ENVIRONMENT` (= `APP_ENV`) — to set one, add the key to BOTH files (the parity test compares `[vars]` keys); § Tracing |
| Worker secrets | `pnpm --filter @launch/web exec wrangler secret put <NAME> [-c wrangler.staging.toml]`, once per worker; locally `apps/web/.dev.vars` | `OAUTH_ENCRYPTION_KEY` (also encrypts tenant AI keys — rotating it invalidates every `ai_configs` credential), `BOOTSTRAP_ADMIN_EMAILS`, `RESEND_API_KEY`, `GOOGLE_*`, `MICROSOFT_*`, `OIDC_CLIENT_SECRET` (optional even with OIDC on — a public client has none); AI, all optional: `ANTHROPIC_API_KEY` (platform chat), `EMBEDDINGS_API_KEY` (platform OpenAI embeddings when no `AI` binding), `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` (the langfuse tracing preset), `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k=v`, any other OTLP backend's auth); `DATABASE_URL` — under `neon` THE connection (the pooled Neon URI, put by `pnpm provision secrets|deploy`), under `postgres` only a no-Hyperdrive fallback |
| CI secrets | GitHub Environments `staging` / `production` | `DATABASE_URL` (that branch), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Scripts only | migration environment | `APP_DATABASE_URL` (db-roles, RLS enforce only) |
| Developer-local only | `apps/web/.drizzle-cube.json` (git-ignored; the analytics plugin's README has the shape) | a **tenant API key** for the drizzle-cube CLI / Claude Code plugin against `/cubejs-api` — it is an ordinary key from Settings → API keys, scopes every query to that tenant, and is revoked there; never deployed, never committed |
| Resource ids | tomls (committed) | Hyperdrive (`postgres`) / KV ids — not secrets |
| Provisioning transport | `apps/web/.provision.env` (git-ignored, 0600; written by `pnpm provision tokens` or copied from `.provision.env.example`), overridden by an exported variable of the same name (CI) | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `NEON_API_KEY`, `RESEND_API_KEY` (the full-access account key, not the Worker's sending key) + the optional Worker secrets. Not `.dev.vars`: `wrangler dev` loads that into the Worker, and account-level tokens must never reach one. Every resolved value is registered with `redact()`; Neon connection strings are fetched from the API on demand (`reveal_password` / `reset_password`) and reach children by env or stdin (`wrangler secret put`, `gh secret set`); every printed line passes one `redact()`; `apps/web/.provision.json` (git-ignored) caches ids and answers only and refuses any secret-shaped value |

`wrangler secret put` (run in `apps/web`) requires the worker to exist: the first deploy of a fresh environment runs via
`workflow_dispatch` and 500s until the secrets are set. Use different key material per environment.
A `postgres` Worker never receives `DATABASE_URL` in deployed environments — it uses `HYPERDRIVE`.
A `neon` Worker holds nothing else: `loadConfig` fails at startup without `DATABASE_URL`.

## Neon: project, branches, hosts

- **One project, a branch per environment** (`production` = main, `staging`), plus a dedicated role
  per branch. Branches are cheap and share compute quota; separate projects give separate quotas and
  credentials — choose projects if the environments must be blast-radius isolated. A shared role
  across branches means one leaked string is every environment's string; don't.
- **Branch before you migrate.** Create `staging` before the first migration runs anywhere, so each
  branch is migrated under its own role and password rather than inheriting a migrated main; the
  `neon` phase of `pnpm provision` branches `staging` from the default branch before any `migrate`
  phase, keeps the database's default owner role and sets (or reveals) a password per branch —
  `--rotate` resets them and updates what the Worker holds to match — an existing Hyperdrive config
  (`postgres`) or the `DATABASE_URL` secret (`neon`).
- **`postgres`: Hyperdrive points at the DIRECT host** (`ep-….<region>.aws.neon.tech`), not
  `-pooler`. Hyperdrive is itself a pooler; stacking it on Neon's PgBouncer adds a hop and a second
  transaction-mode layer with nothing to gain.
- **`neon`: the Worker's `DATABASE_URL` is the POOLED host** (`ep-…-pooler.…`). Every request opens
  its own HTTP queries and at most one WebSocket transaction, so Neon's pooler is what bounds the
  connection count. `set_config(…, true)` / `SET LOCAL` are transaction-local, so the
  transaction-mode pooler is safe for RLS enforce and retrieval.
- **Migrations use the direct host too.** `apps/web/scripts/migrate.ts` strips `-pooler` from any Neon host it
  is given, so the CI `DATABASE_URL` secret may be either form. A pooled backend can carry a stale
  `default_transaction_read_only` GUC that blocks DDL; the source app hit exactly that.
- `apps/web/scripts/db-roles.ts` (RLS role) also needs the direct host — `ALTER DEFAULT PRIVILEGES` and `CREATE ROLE`
  are session-level DDL.
- Neon's owner role (`neondb_owner`) is **not a superuser** — it has `CREATEROLE` and is a
  `neon_superuser` member. Postgres lets only a superuser name `SUPERUSER`, `BYPASSRLS` or
  `REPLICATION` in `ALTER ROLE`, even to switch them off, so `db-roles.ts` sets those three only when
  `current_setting('is_superuser') = 'on'` (locally) and relies on `CREATE ROLE`'s defaults on Neon.
  Its post-check still fails the run if `launch_app` ends with `rolsuper` or `rolbypassrls`.
  Before 0.14.0 this step failed on Neon with `permission denied to alter role`.
- Tests never use Neon (`safetyCheck` requires `localhost`) — the `neon` test run talks to the local
  proxy in front of the test Postgres (`pnpm test:neon`). `PREVIEW_DATABASE_URL` is an inert hook
  for per-PR Neon branches if previews are ever reinstated.

## CI/CD flow

All steps run at the repository root; the root scripts fan out with `pnpm -r` / `--filter`, so no
`working-directory` is set anywhere.

```
 push to main ─► ci.yml (root) ─► check      → gate.yml: pnpm install --frozen-lockfile → gitleaks
                        │                       → pnpm lint → pnpm typecheck
                        │                       → git diff --exit-code apps/web/worker-configuration.d.ts
                        │                       → pnpm test (pg 5499; web + cli)
                        │                       → pnpm build (web: vite + dry-run wrangler deploy; cli: tsc)
                        ├─► test-neon       → pnpm web test:neon: test Postgres + the Neon proxy (compose
                        │                     `--profile neon`), api + api-isolated + driver projects under
                        │                     DATABASE_DRIVER=neon (D35 — the gate runs `postgres`)
                        └─► plugin-check    → node scripts/plugin.mjs check (no install, no database)
                                                                                                            │
 push tag X.Y.Z ──► deploy.yml ─► ci (workflow_call, same file) ─► staging job (environment: staging)
                                     tag == ROOT package.json version?
                                     → REQUIRE_PROVISIONED=1 pnpm --filter @launch/web test:config
                                     → pnpm db:migrate:ci (staging DATABASE_URL) → pnpm --filter @launch/web build:ui
                                     → pnpm --filter @launch/web exec wrangler deploy -c wrangler.staging.toml --var RELEASE_VERSION:X.Y.Z
                                                                                    │
                                                              verify on staging: /api/health, /api/ready (the database, either driver), nav version
                                                                                    │
 gh release create X.Y.Z ──► deploy.yml ─► production job (environment: production, checkout the release tag)
                                     tag == ROOT version? → REQUIRE_PROVISIONED=1 test:config → db:migrate:ci (production)
                                     → build:ui → pnpm --filter @launch/web exec wrangler deploy --var RELEASE_VERSION:X.Y.Z

 workflow_dispatch(environment) ──► either job from the dispatched ref (first deploy; emergencies)
```

### Deploying through an external deployer (off by default)

Set the repository variable **`DEPLOYER_URL`** (optionally `DEPLOYER_AUDIENCE`) and both jobs take
a second path with **no `CLOUDFLARE_API_TOKEN` and no `DATABASE_URL` secret**: the job authenticates
with a GitHub OIDC token (`permissions: id-token: write`) and `scripts/deployer.mjs` runs

```
start (ticket; waits for approval) → build:ui → wrangler deploy --dry-run --outdir dist/deploy
  → upload (the deployer checks the bindings, stores an undeployed version, returns a short-lived
    MIGRATOR_URL, masked) → pnpm db:migrate:ci with DATABASE_URL=$MIGRATOR_URL → activate
  → finish (if: always())
```

Triggers, the CI gate, the parity check and the version resolution are the same on both
paths; with `DEPLOYER_URL` unset the migrate / `wrangler deploy` steps run exactly as above. The
contract a deployer implements — endpoints, payload, OIDC claims to check, what `migratorUrl` must be
able to do — is **`docs/DEPLOYER.md`** (protocol v1).

### Plugins in CI (D31)

Launch commits its installed plugins, so the ordinary gate already runs each one's own tests
(`src/plugins/*/tests/{api,ui,config}`). The `plugin-check` job runs `node scripts/plugin.mjs
check` — the same command a person runs — with no install and no database. There are no default
plugins to install and no second gate pass.

**`test-neon`** is how Launch's DEPLOYED path (`DATABASE_DRIVER=neon`) is tested before it deploys:
local development and the gate run `postgres`.

**Bundle size.** `pnpm build` (`build:api` = `wrangler deploy --dry-run --outdir dist/api`) produces
`dist/api/worker.js`; **`gzip -c apps/web/dist/api/worker.js | wc -c` is the size that matters, and
no figure is quoted here on purpose** — it moves with every dependency bump, and a stale number in a
doc reads as a budget nobody is holding. What is stable: drizzle-cube's Hono adapter statically
imports its MCP transport (MCP SDK + inlined chart rendering) even with MCP disabled, and that
dominates the bundle — it is not the kit shipping React to the Worker. The ceiling is the Workers
script limit (3 MiB gzip free / higher on Paid, which Workflows need anyway). If a deploy is
refused for size, look at new `src/api` dependencies first; the structural fix is upstream or a thin
adapter over `drizzle-cube/server` (`.claude/rules/cloudflare.md`). UI: the analytics chunk
(drizzle-cube client + recharts + d3) is the largest and lazy — it must never merge into the main
chunk.

**No deploy guard.** Both deploy jobs always run; an unprovisioned checkout fails loudly at the
parity check (`REQUIRE_PROVISIONED=1`), which is the point of it.

**Version rule.** The git tag must equal `version` in the **root** `package.json`; the job fails
otherwise (an inline check in `deploy.yml`). One tag ships `apps/web` and `apps/cli` together — the
`apps/*` and `packages/*` versions are informational and are not checked. Bump the root version,
move the `## Unreleased` lines in `CHANGELOG.md` under it, commit, tag. Never force-push a released
tag.

Publishing the Release is the promotion gate (required reviewers are unavailable on private repos
on the free plan; add them to the `production` environment if the plan allows). Production does not
re-run the CI gate: it ships the tag staging validated. `RELEASE_VERSION` is a `[vars]` override at
deploy time, surfaced by `/auth/session`, the nav footer and `launch status`. Local
`pnpm deploy[:staging]` (root → `apps/web`: `build:ui` + `wrangler deploy`) exist as escape hatches;
CI is the path. `wrangler deploy` always runs with `apps/web` as cwd so `[assets] directory =
"./dist/ui"` resolves — never call it from the root.

## Cloudflare API token scopes (CI token, account scope)

Workers Scripts · Workers KV Storage · Queues · Workflows · Durable Objects · R2 · Hyperdrive (only
under `postgres`) —
**Edit**. Workers AI · Account Analytics — **Read** (if used). Zone → DNS — **Edit** on the zone
holding the custom domains. One token may serve both environments.

## Observability

- `[observability.logs] enabled = true, head_sampling_rate = 1, invocation_logs = false` in both
  files: structured `console`/pino output is retained in the Workers Logs dashboard; invocation
  logs are off to keep the volume to what the app emits.
- `pnpm --filter @launch/web exec wrangler tail [-c wrangler.staging.toml] [--format pretty]` streams live logs;
  `--status error` filters.
- `pnpm --filter @launch/web exec wrangler deployments list`, `… wrangler workflows instances list <name>`,
  `… wrangler queues info <name>` for the async parts.
- AI traces (D32): spans for every chat turn, agent run, tool call, retrieval, embeddings batch and
  AI job land in the tenant's `ai_spans` rows (read with `launch traces list|show`) and, when a
  backend is configured, are exported as OTLP from `waitUntil`, never on the response path —
  § Tracing below. `ai_usage` in Postgres is the durable token ledger regardless of tracing.
  `ANALYTICS_ENGINE` request metrics are optional and fire-and-forget.
- Agent runs: `… wrangler workflows instances list launch-agent-run[-staging]` / `describe <name>
  <instanceId>`. **The instance id is `agent_runs.instance_id`, which starts as the run id and is
  not always it**: a run parked on a human whose instance was lost is restarted as `<runId>-r1`,
  `-r2`… A row stuck `queued`/`running` whose instance is gone is settled on the next
  `GET /api/agents/runs/:id` — but only once it has been quiet for `RECONCILE_LIVENESS_MS` (30 s), so
  a run that is still emitting events is left alone rather than costing a Workflow subrequest per
  reader. A row stuck `awaiting_input` is settled by `expireParkedRun` on the same read, once every
  one of its asks is past `expiresAt`; a parked run whose asks are still in date is deliberately
  left waiting. There is no sweeper cron, which means both nets need somebody to open the run.

## Tracing (D32)

The local store needs nothing: every environment writes `ai_spans` and prunes it nightly. A
backend is ADDITIONAL and platform-wide (one per deployment, never per tenant). Vars go in BOTH
tomls (the parity test compares `[vars]` keys); headers are a secret. After any change, one chat
turn or agent run should appear in the backend within a minute.

| Backend | Set |
|---|---|
| Langfuse Cloud | nothing new — `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` select the `langfuse` preset, which sends OTLP/JSON to `<LANGFUSE_BASE_URL>/api/public/otel` with Basic auth and `x-langfuse-ingestion-version: 4`. A deployment that ran D16's ingestion client migrates by deploying. Optional `OBSERVABILITY_TRACE_URL = "https://cloud.langfuse.com/project/<id>/traces/{traceId}"` for the CLI's link-out |
| Self-hosted Langfuse | the two keys + `LANGFUSE_BASE_URL = "https://langfuse.example.com"` (or `OTEL_EXPORTER_OTLP_ENDPOINT` to the full `/api/public/otel` URL) |
| Phoenix (self-hosted) | `docker run -p 6006:6006 arizephoenix/phoenix` (or your deployment); `OBSERVABILITY_PRESET = "phoenix"`, `OTEL_EXPORTER_OTLP_ENDPOINT = "https://phoenix.example.com"`. The preset defaults to `http/protobuf` — Phoenix answers JSON with a 415. Auth, if enabled: secret `OTEL_EXPORTER_OTLP_HEADERS = authorization=Bearer%20<key>` |
| Any OTLP/HTTP collector | `OBSERVABILITY_PRESET = "generic"` (the default without Langfuse keys), `OTEL_EXPORTER_OTLP_ENDPOINT` (base URL; `/v1/traces` is appended), optionally `OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"`; headers via the secret |

Headers go in with `pnpm --filter @launch/web exec wrangler secret put OTEL_EXPORTER_OTLP_HEADERS
[-c wrangler.staging.toml]`, or from `.provision.env` through `pnpm provision secrets <env>`. Values
are URL-encoded per the OTel spec. `OBSERVABILITY_CAPTURE_CONTENT = "false"` strips prompts,
completions and tool I/O from BOTH the export and `ai_spans` (names, models, tokens and latency
stay). `OBSERVABILITY_SPAN_RETENTION_DAYS` bounds the local store only — the backend keeps its own
retention. Export failures are logged (`tracing: OTLP export returned a non-OK status`) and never
fail a request; `wrangler tail` is where to look.

## Rollback

| Situation | Action |
|---|---|
| Bad Worker version, schema unchanged | `pnpm --filter @launch/web exec wrangler rollback [-c wrangler.staging.toml]` — previous version, seconds. Or `wrangler rollback <version-id>` from `deployments list` |
| Need a specific earlier tag | Actions → Deploy → `production` from that tag, or publish a Release on the earlier tag |
| Schema migration must be undone | migrations are forward-only: write a compensating migration, tag, and run the dance. `wrangler rollback` does not touch the database |
| Bad deploy right after switching a deployment to `neon` | `wrangler rollback` to the last `postgres` version — it restores that version's `HYPERDRIVE` binding, which is why the Hyperdrive configs are kept about a week (§ Database driver). Then switch the toml back with `pnpm provision cloudflare <env> --driver postgres` before the next deploy |
| RLS enforce misbehaving | `TENANT_SCOPE_MODE = "off"` in `[vars]` and redeploy — no migration (docs/RLS.md) |
| A Workflow hijacked by a name collision | fix the staging name, redeploy **both** workers (last deployer owns the name); stuck `agent_runs` rows settle on read (`GET /api/agents/runs/:id` → `reconcileRun` → `instance.status()`; `not_found` marks them `failed`) — except on the RESUME path, where `not_found` is recovered from by starting `<runId>-r1` rather than failing the run |
| Fact tables stale or wrong after a deploy | `GET /api/analytics/facts/status` (or `launch analytics check-facts`) says which; fire the `15 * * * *` cron, or `launch analytics refresh-facts` for one organisation. Rows are derived data — a rebuild is always safe; a schema change to a fact table is a normal forward migration followed by one rebuild. **First check the cron is in both tomls at all**: it is the analytics plugin's declaration, and an install that skipped that step leaves a task nothing ever dispatches |
| A dashboard renders empty / errors after a cube change | a cube member referenced by stored `analytics_pages.config` was renamed or removed — restore the member (names are frozen) or, per tenant, `POST /api/analytics/templates/recreate` (admin+) to re-copy the templates; user-created pages need a manual edit |
| Tenant AI keys unreadable after rotating `OAUTH_ENCRYPTION_KEY` | there is no re-encrypt path: admins re-enter the key in Settings → AI (the row keeps its label/model, `hasCredential` flips back); the platform `ANTHROPIC_API_KEY` is unaffected |

Verify any rollback with `/auth/session` (`releaseVersion`), `launch status` and `wrangler tail`.
