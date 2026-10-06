# SETUP — step-by-step walkthrough

Everything needed to take Launch from a fresh clone to a configured, deployed app. Work through
the parts in order; **every step ends with a verification line — do not move on until it passes.**

**This file is instructions, not design.** What the kit does and why is in
[`docs/CONCEPTS.md`](docs/CONCEPTS.md); the Cloudflare topology is in [`docs/DEPLOY.md`](docs/DEPLOY.md);
code conventions are in `.claude/rules/`.

**Where commands run.** The repo is a pnpm workspace (`apps/web`, `apps/cli`, `packages/shared`).
**Every command below runs from the repository root** unless it says otherwise: the root
`package.json` delegates to the packages (`pnpm dev` → web, `pnpm cli …` → the CLI via `tsx`,
`pnpm web <script>` → any `apps/web` script). `wrangler` and `cfld` are devDependencies of
`apps/web`, so they are run as `pnpm web exec wrangler …` (shorthand for
`pnpm --filter @launch/web exec wrangler …`) — `pnpm exec wrangler` at the root does not exist.

Legend: `[ready]` works out of the box · `[config]` needs your configuration

**Fix missing prerequisites proactively rather than reporting them.** If Node is missing or too
old, install 24 (`nvm install` reads `.nvmrc`, or `fnm use`, or the system package manager). If
pnpm is missing, `corepack enable` (it reads `packageManager` from the root `package.json`). If
Docker is unavailable on macOS, `brew install colima docker && colima start`. On an Apple Silicon
Mac that runs coding sessions locally, use `colima start --vm-type vz --vz-rosetta --cpu 6 --memory 12`:
the session image is amd64-only, and QEMU emulation crashes it (`docs/SESSIONS-LOCAL.md` § Emulation).
Or skip local session containers entirely: with the sandbox host deployed and `wrangler login`,
`pnpm dev` also offers the **remote sandbox host** (real Cloudflare containers), chosen on Settings →
Coding agents → Session sandbox (`docs/SESSIONS-LOCAL.md` § Real containers from a
laptop); `pnpm dev` says which of the two it could make available.
On Linux install Docker
Engine and add your user to the `docker` group. Confirm the tool works, then carry on.

---

## Part 1 — First run (local) `[ready]`

> **The short way.** `bash scripts/bootstrap.sh` (or `/launch-setup` in Claude Code; `pnpm bootstrap` once
> Node and pnpm exist) does 1.1–1.7 in one go — ten steps, one `✔ n/10 <name> <what it verified>`
> line each, a `✖` line plus a `fix:` hint on the first failure — and ends with the browser open at
> `http://localhost:3000/login?as=owner@example.test`. macOS or Linux (Windows: WSL2). Re-runnable on
> a half-done machine: it inspects before it acts and never overwrites a value you wrote. Flags:
> `--offline` (no Cloudflare account: comments the `[ai]` block out of both tomls), `--online`
> (restore it), `--no-demo` (plain `pnpm seed`), `--no-plugins` (skip the installed-plugin
> check, §1.4b), `--no-dev` (stop after step 8 and print what to run next), `--no-open`,
> `--as <email>`, `--yes`, `--verbose`, `--db-url <url>` (an existing Postgres instead of Docker,
> §1.4); `--check` is `pnpm preflight`.
> Exit codes: `0` ok · `1` a step failed · `2` usage · `3` prerequisite missing · `4` port/container
> held by another checkout · `5` Cloudflare login required
> (`node scripts/bootstrap.mjs --help`).
> The numbered steps below are what it runs — for doing it by hand, or for debugging one step.

### 1.1 Toolchain
```bash
node -v            # v24.x — from .nvmrc
corepack enable && pnpm -v   # 10.x — from package.json packageManager
docker info >/dev/null && echo docker-ok
```
Verify: three lines — `v24.*`, `10.*`, `docker-ok`. `pnpm preflight` is the same check as one
read-only command (toolchain, `.dev.vars`, Postgres, Cloudflare login, `pnpm dev:status`; exit 3
when anything is missing) — `bash scripts/bootstrap.sh` installs Node through an fnm/nvm that is
already present and pnpm through corepack, and never pipes a URL into a shell.

### 1.2 Dependencies
```bash
pnpm install
```
Verify: exits 0; `ls apps/web/node_modules/.bin/wrangler` exists and `pnpm web exec wrangler --version`
prints a version. `packages/shared` is linked into both apps as TypeScript source — there is nothing
to build for it. (`ls node_modules/.bin` at the root shows only `biome`, `tsc`, `tsx`: that is
expected.)

### 1.3 Local secrets
```bash
cp apps/web/.dev.vars.example apps/web/.dev.vars
openssl rand -hex 32   # → OAUTH_ENCRYPTION_KEY in apps/web/.dev.vars
```
The only secret `.dev.vars` needs is `OAUTH_ENCRYPTION_KEY` (≥ 32 characters); the bootstrap
generates it (`3/9 secrets`), by hand it is the `openssl` line above.
Verify: `grep -c '^[A-Z_]*=.\+' apps/web/.dev.vars` is at least 2 (`DATABASE_URL` and
`OAUTH_ENCRYPTION_KEY` are set). Leave every optional key blank for now — each
feature degrades gracefully (Part 2). `.dev.vars` is git-ignored; never paste other environments'
credentials into it, not even as comments.

### 1.4 Database
```bash
pnpm dev:db:up        # pgvector/pgvector:pg17, first free port from :5432 (apps/web/scripts/dev-db.mjs)
pnpm dev:db:status    # every dev database on this machine, and which one is this checkout's
pnpm web db:check     # apps/web/scripts/test-db-connection.ts
pnpm db:migrate       # db-roles --phase=role → migrations → db-roles --phase=grants
```
Verify: `db:up` prints the port it chose; `db:check` prints the server version; `db:migrate` ends
with the applied migration count and no `role "launch_app" does not exist` error.

**The port is chosen, not fixed.** `dev:db:up` runs `apps/web/scripts/dev-db.mjs`, which gives this
checkout its own compose project, container and port: it keeps the port already in `DATABASE_URL`
whenever that is still free or still this checkout's, and otherwise takes the next free one from
5432 (skipping 5433, the Rocketflare kit's test database — Launch's own is on 5499, outside the
scan) and writes it back to `apps/web/.dev.vars`. So a SECOND
checkout on the same machine starts its own database instead of failing on a taken port or quietly
attaching to the first one's container — and a re-run never moves a database that is working.
Everything downstream reads that one value: `db:migrate`, `seed` and `drizzle-kit` through dotenv,
and `wrangler dev` from `.dev.vars` too (a copy whose toml has a `[[hyperdrive]]` block also gets it
through `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`, which `pnpm dev` sets).
`pnpm dev:db:down` stops this checkout's database and never another's.

**The local driver is `postgres`, whatever you deploy.** The tomls' `DATABASE_DRIVER` is the
DEPLOYED driver (`neon` in a fresh copy, D35); `.dev.vars` overrides it locally, and the bootstrap
writes `DATABASE_DRIVER=postgres` there — postgres.js over TCP to the compose database, nothing else
running. To run the deployed Neon driver against the same local database, `pnpm dev:db:up --neon`
also starts a Neon proxy in front of it (per-checkout port from :4444) and writes
`DATABASE_DRIVER=neon` + `NEON_LOCAL_PROXY`; `pnpm dev:db:up --postgres` switches back and stops the
proxy. `pnpm bootstrap --driver neon|postgres` sets the same thing. Verify: `pnpm db:check` prints
`Connected to … (neon driver)` or `(postgres driver)`.

Why three steps: a policy's `TO launch_app` needs the role
before migrations; the `REVOKE`s need the tables after. With `APP_DATABASE_URL` unset the role is
created `NOLOGIN` and RLS stays inert ([`docs/RLS.md`](docs/RLS.md)).

**No Docker: use an existing database.** Where Docker is not available (a coding sandbox with a
Neon branch, a shared dev server), point the bootstrap at the database you already have:
```bash
bash scripts/bootstrap.sh --no-dev --db-url "postgresql://user:pass@ep-x.neon.tech/neondb?sslmode=require"
```
It still runs ten steps. `1/10 toolchain` skips the Docker checks, and `3/10 secrets` writes the URL
to `DATABASE_URL` in `apps/web/.dev.vars` — and, for a `*.neon.tech` URL, `DATABASE_DRIVER=neon`,
which reaches Neon over HTTPS and WebSocket only (what a sandbox with no TCP out allows); any other
URL gets `postgres`, and `--driver` overrides either. `4/10 database` doesn't start a container; it waits for
`db:check` to answer (`external <host>/<db> · Connected to …`). `7/10 seed` runs with
`SEED_ALLOW_REMOTE=1`, because the seed refuses a non-local host otherwise. The seed always prints
`seeding <host>/<db>`, never the credentials. The database needs the pgvector extension available
(Neon has it). Afterwards `pnpm dev` uses that URL unchanged, `pnpm dev:db:up` reports there is
nothing to start, and `pnpm preflight` skips its Docker checks while `DATABASE_URL` points off this
machine. `--db-url` can't be combined with `--check`. A loopback URL (`localhost`, `127.0.0.1`)
still counts as this checkout's Docker database to `pnpm preflight` and `dev:db:*`. The URL, password
included, lands in your shell history.

### 1.4b Plugins `[ready]`
```bash
pnpm plugin list                  # what is installed (id, version, repo, when)
pnpm plugin check                 # audit them: exit 1 with one line per failure
```
A **plugin** is a git repository copied into this app — never an npm package — that contributes
contracts, schema, routes, jobs, agents, UI and CLI commands through six barrel files
(`docs/CONCEPTS.md` §16), importing the host only through the declared entries
(`docs/plugin-api.md`) and receiving everything else as injected context. Launch commits its
installed plugins — today `analytics` — with their barrel lines and migrations, and records each in
`launch.plugins.json`. So a fresh clone has nothing to install: the bootstrap's `6/10 plugins` step
only checks every recorded plugin's files are on disk. To add one:

```bash
pnpm plugin add <repo|path>[@ref]          # prints the plan and stops
pnpm plugin add <repo|path>[@ref] --apply  # copies, writes the barrel lines, records the surface
pnpm db:generate --name plugin-<id>-<version> && pnpm db:migrate   # the HOST's migration, always
```

`pnpm bootstrap --no-plugins` skips the check.

Verify: `pnpm plugin list` shows a line per plugin (`analytics  3.4.1 …`), `pnpm plugin check`
prints `✔ n plugin(s) check out` and exits 0, and the bootstrap step reports
`installed: analytics@3.4.1`.

A plugin ships **no migration and no toml edit**: the host runs `pnpm db:generate`, and a binding,
cron or `[vars]` key it declares is rendered into a deployed instance's `wrangler.deploy.toml` by
`pnpm provision render` (Part 3, `docs/DEPLOYMENT.md`). `/launch-plugin` drives all of it and always shows the plan before anything is written.

### 1.5 Seed
```bash
pnpm seed             # idempotent: the tenant, owner/admin/member users, one API key
pnpm seed --demo      # the same, plus each installed plugin's demo data (what the bootstrap runs; or SEED_DEMO=1)
```
`pnpm seed` creates the tenant, `owner@` / `admin@` / `member@example.test`, a pending invitation
for `invited@example.test`, the global admin `admin@clewro.com` and one API key. Launch runs
`TENANCY_MODE=single` (`.dev.vars`), so the one tenant is named after `APP_NAME` with slug
`default`, and `admin@clewro.com` is also its owner; under `multi` it is `Acme` (`acme`). In single
mode `owner@` and `admin@example.test` reach Settings → Connections on their role alone. `--demo` additionally runs every installed plugin's
`seedDemo` hook — the analytics plugin seeds its dashboards and rebuilds its fact table. Every demo
row has a fixed id and is inserted `onConflictDoNothing`, so re-running adds nothing. Local
database only — it is a `tsx` script over `DATABASE_URL`.
Verify: the output lists the seeded emails and prints the API key **once** (on the first run only;
later runs say it already exists).
`pnpm db:studio` shows the rows.

### 1.6 Run it
```bash
pnpm dev              # apps/web: wrangler dev :3001 + vite :3000 (strict ports; a preflight
                      # clears this repo's leftovers and names any other port holder)
# pnpm dev:stop       # kill this repo's dev tree (parent first, loops until quiet)
# pnpm dev:status     # what is running here + who holds :3000/:3001
```

> **Ports taken?** (a Cloudflare Sandbox holds :3000, or another app does.) Set `DEV_UI_PORT` and
> `DEV_API_PORT` — in the shell or in `apps/web/.dev.vars` (the shell wins; unset = 3000/3001) —
> and change `APP_URL` in `.dev.vars` to the new UI port, because the Worker builds its OAuth
> redirects, magic links and CORS/CSRF allow-list from it. `DEV_ALLOWED_HOSTS=a.example,b.example`
> lets Vite answer for extra hostnames (a sandbox preview URL). `pnpm dev`, Vite, the bootstrap and
> the seed all read these through `scripts/lib/dev-ports.mjs`; `pnpm dev:api` on its own reads only
> the shell. Substitute your ports for 3000/3001 everywhere below; the CLI's default server stays
> :3001, so pass `--server http://localhost:<DEV_API_PORT>`. `pnpm dev:tunnel` still targets :3000
> (cfld reads `apps/web/package.json`'s `cfld.port`).

> **Cloudflare login and the AI binding.** `wrangler dev` runs everything locally EXCEPT the Workers AI
> binding (`[ai]` in `apps/web/wrangler.toml`), which always calls Cloudflare — so the first `pnpm dev`
> on a machine that has never run `pnpm web exec wrangler login` will ask you to log in (a free account
> is enough). To stay fully offline, comment out the `[ai]` block in BOTH tomls (the parity test keeps
> them in sync): `pnpm bootstrap --offline` does exactly that, and `pnpm bootstrap --online` restores
> it. Chat then needs a key or a tenant provider (§2.5) and embeddings resolve to `EMBEDDINGS_API_KEY`
> or report "not configured". After toggling, `pnpm typecheck` regenerates
> `apps/web/worker-configuration.d.ts` without `AI` — restore the block (`--online`) before
> committing so CI's typegen diff stays clean.

> **App thumbnails locally.** The `[browser]` binding (`BROWSER`, Browser Rendering) is LOCAL under
> `wrangler dev`: nothing to set up, and the first capture downloads a headless Chrome into
> wrangler's cache (once per machine). A deploy only reaches a local Launch through the
> tunnel, so locally a thumbnail is usually taken with Settings → General → "Refresh thumbnail" on an
> app whose environment has a public `https` URL. To use Cloudflare's browsers instead, add
> `remote = true` under `[browser]` for your run — never commit it. The same local browser takes a
> session's "Screenshot preview" (it reaches `*.localhost:3001` itself); with `remote = true` those
> captures fail, because Cloudflare's browsers cannot reach your laptop.

Verify: both processes report ready; `curl -s localhost:3001/api/health` returns `{"status":"ok",…}`;
http://localhost:3000 renders the shell. Sign in: enter the seeded owner email, copy the magic-link
URL from the **wrangler dev console** (no `RESEND_API_KEY` → links are logged, not sent), open it,
land on Home. Shortcut (dev only): `http://localhost:3000/login?as=owner@example.test` signs in
through `/auth/dev-login` on load — honoured only when the server reports `devLogin`
(`APP_ENV=development`) and for the four seeded accounts, so an arbitrary address does nothing.

**Analytics check** (still in 1.6 — same terminal pair). Analytics is a PLUGIN from 0.6.0
(`docs/CONCEPTS.md` §8, §16) and the bootstrap's `plugins` step installs it, so this works on a
fresh clone unless you ran `--no-plugins`:
```bash
pnpm cli analytics check-facts       # fact-table freshness; exits 1 when any table is stale
pnpm cli analytics refresh-facts     # enqueue a rebuild for this organisation
```
Verify: `check-facts` prints `analytics_tenant_activity_daily_facts … fresh` and exits 0.
`refresh-facts` returns a job id, and the `wrangler dev` terminal logs the consumer running it
(`wrangler dev` runs the queue consumer in-process). The `15 * * * *` cron is still the normal,
cross-tenant path and `wrangler dev` never fires it by itself, so a laptop database goes stale two
hours after its last rebuild until you run one of the above or
`curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=15+*+*+*+*"`. Then, signed in, open
**Analytics** in the nav: the seeded **Organisation Overview** page renders with live member and
activity numbers. By hand, `curl -b <cookie> localhost:3001/api/analytics/pages` lists one page with
`templateKey: "tenant-overview"`, and an unauthenticated `curl -i localhost:3001/cubejs-api/v1/meta`
is a JSON 401, never HTML. `GET /api/analytics/facts/status` (owner/admin) shows the same freshness
as the CLI.

**With `--no-plugins` there is no analytics at all** — no nav item, no `/api/analytics`, no
`/cubejs-api`, no `/mcp`, and no drizzle-cube in either bundle. That is the kit's bare shape, and
`pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugin-analytics.git@1.0.2 --apply`
(then `pnpm db:generate --name plugin-analytics-1.0.2 && pnpm db:migrate`) is how it comes back.

> **Cookie note.** The session cookie is `__Host-session`, and the `__Host-` prefix *requires* the
> `Secure` flag even in development. Chrome and Firefox treat `http://localhost` as a secure context so
> this just works; Safari has historically been flaky about it. If Safari won't stay signed in locally,
> use the HTTPS tunnel (`pnpm dev:tunnel`, §1.10) or another browser.

### 1.7 CLI first run
The bootstrap already did this once: its `8/9 cli` step ran `pnpm cli whoami` with the seed's
one-time key (first run only — a re-run finds the key exists and skips; not with `--no-dev`, which
`/launch-setup` uses — run `pnpm cli login` yourself then). To use the CLI yourself, with `pnpm dev` still
running, in a second terminal:
```bash
pnpm cli login --server http://localhost:3001   # opens the browser; sign in, pick the tenant
pnpm cli whoami
```

> **Headless / no browser** (CI, agents): skip `pnpm cli login`. Sign in with the dev-login cookie
> (or any session) and hit `GET /auth/cli?redirect_uri=http://127.0.0.1:8765/callback` — the
> `Location` header carries `key=`; export it as `LAUNCH_API_KEY` with `LAUNCH_URL=http://localhost:3001`,
> then `pnpm cli whoami`. In real environments create a tenant API key in Settings → API keys instead.

`login` starts a loopback listener on the first free port in `127.0.0.1:8765–8770` and opens
`/auth/cli?redirect_uri=http://127.0.0.1:<port>/callback`; after login + tenant select the server
mints a tenant API key named `cli:<your hostname>` and redirects back. The key is stored in
`~/.launch/config.json` (mode `0600`) and is never printed in full.
Verify: `whoami` prints your email, the tenant name and a key prefix; `pnpm cli features list --json
| head` prints JSON; `ls -l ~/.launch/config.json` shows `-rw-------`; a wrong key exits `2`. For CI or
scripts, `LAUNCH_API_KEY` + `LAUNCH_URL` in the environment replace the config file (no browser).

### 1.8 Tests
```bash
pnpm test:db:up       # ephemeral Postgres on :5499 (max_connections=300; apps/web/docker-compose.test.yml, compose project launch-test)
pnpm test             # every package: web api + api-isolated + driver (real DB), ui (jsdom), config (no DB); cli
pnpm test:neon        # optional: the Neon proxy on :4433 + api, api-isolated and driver on the neon driver (CI's test-neon)
```
Verify: all projects green — including every installed plugin's own tests, which run in the host's
projects (`src/plugins/*/tests/{api,ui,config}`). The analytics plugin's `cube-isolation.test.ts`
is the one to watch: two tenants, every cube, disjoint rows.
`apps/web/tests/config/wrangler-parity.test.ts` passes with the
placeholder ids still in the tomls — the placeholder check only runs with `REQUIRE_PROVISIONED=1`
(Part 3). Single web projects: `pnpm web test:api`, `pnpm web test:ui`, `pnpm web test:config`.

### 1.9 The gate
```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```
Verify: exits 0. This is the pre-commit gate for the whole workspace; `typecheck` regenerates
`apps/web/worker-configuration.d.ts` (commit it if it changed) and `build` produces
`apps/web/dist/{ui,api}` and `apps/cli/dist/cli.js`. The Worker bundle is large — drizzle-cube's
adapter carries its MCP transport, `docs/DEPLOY.md` "Bundle size" — and `pnpm install` prints one
`@duckdb/node-api` peer warning; neither is a problem.

### 1.10 Public URL via tunnel `[ready]` (optional)
For OAuth callbacks, emailed magic links or webhooks against your laptop:
```bash
pnpm web exec cfld setup   # once: picks a Cloudflare zone, stores apps/web/.cfld.json (git-ignored)
pnpm dev:tunnel            # terminal 1: the tunnel only (cfld → :3000); writes PUBLIC_URL to apps/web/.env
pnpm dev                   # terminal 2: sees the tunnel running and serves under its URL
```
While the tunnel is up, `pnpm dev` lets Vite answer for the tunnel host (HMR over its `wss`) and
passes the URL to wrangler as `APP_URL`, so OAuth redirects, magic links and CSRF use it; localhost
still works. With no tunnel running it serves localhost only. `pnpm dev --public` / `--no-public`
override the check. Restart `pnpm dev` after starting or stopping the tunnel.

**GitHub App webhooks through it** (optional, issue #19): point a separate development GitHub App's
Webhook URL at `<the tunnel URL>/api/github/webhook` and set its secret as `GITHUB_WEBHOOK_SECRET` in
`apps/web/.dev.vars` — `docs/DEPLOYMENT.md` § 12. Without it Launch polls GitHub, as it always has.

**Creating apps needs it.** The scaffold and deploy jobs run on GitHub and call Launch back at
`APP_URL`, so `POST /api/apps` refuses with 409 `launch_not_reachable` while Launch is at
`http://localhost:3000`. With the tunnel up and `pnpm dev` restarted, open Settings → Connections →
Public URL (`/settings/public-url`; Home's "Finish setting up Launch" links it) and click "Check now": Launch fetches its own `/ci/ping` through the tunnel and the step
turns green.
Verify: the printed `https://…` host opens the app; `/auth/methods` there reports the same providers
as localhost. `.dev.vars` and the tomls are untouched.

**cfld and the zone's cert.** cfld routes DNS with the Cloudflare cert for the tunnel's zone. If
that cert belongs to another zone, cloudflared silently creates `<host>.<that zone>` instead, and
the real host answers 522 (or hits the apps wildcard). Check `dig <host>.<other zone>`; fix with
`pnpm web exec cfld login --reauth` for the right zone, then restart the tunnel. Add
the tunnel host to each OAuth app's redirect URIs (Part 2) to test those flows. The CLI can log in
through the tunnel too: `pnpm cli login --server https://<tunnel-host>`.

---

## Part 2 — External services `[config]`

None of these block local development. Each states what happens when it is absent. Secrets go in
`apps/web/.dev.vars` locally and `wrangler secret put` when deployed (Part 3); `[vars]` live in
`apps/web/wrangler.toml` and `apps/web/wrangler.staging.toml`.

### 2.1 Email — Resend
1. resend.com → verify your sending domain (SPF/DKIM)
2. Create an API key → `RESEND_API_KEY`
3. `EMAIL_FROM` in `[vars]` (both tomls) and `apps/web/.dev.vars`: a verified sender,
   `App <noreply@mail.example.com>`

Scripted for a deployed instance (Part 3, `docs/DEPLOYMENT.md`): with a full-access
`RESEND_API_KEY` and `CLOUDFLARE_API_TOKEN` in `launch.deploy.env`, `pnpm provision email create`
creates the Resend domain `EMAIL_DOMAIN` (default `notifications.<LAUNCH_DOMAIN>`) and writes its DNS
records into the Cloudflare zone; `render` sets `EMAIL_FROM`; `pnpm provision email verify` polls
verification and mints the Worker's own sending key into its `RESEND_API_KEY`; `email status` shows
which records are present.

Absent: magic links, invitations and admin notifications are logged, never sent. Verify: request a
magic link — it arrives by email.

### 2.2 Google OAuth
1. Google Cloud Console → APIs & Services → OAuth consent screen: External; scopes `openid`,
   `email`, `profile` only. While the screen is in *Testing* only listed test users can sign in —
   **Publish** it to let anyone reach the sign-up gate
2. Credentials → OAuth client ID → Web application. Authorized redirect URIs — Google matches
   exactly, add every origin you use:
   `http://localhost:3000/auth/google/callback`, `https://<tunnel-host>/auth/google/callback`,
   `https://<staging-host>/auth/google/callback`, `https://<app-host>/auth/google/callback`
3. `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

Absent: the button is hidden (`GET /auth/methods`). Verify: "Continue with Google" round-trips.
An account whose `email_verified` is false is refused — for every provider.

### 2.3 Microsoft OAuth (Entra ID)
1. Azure Portal → App registrations → New; account type "any organizational directory and
   personal accounts" (the kit uses the `common` tenant)
2. Redirect URI (Web): `{APP_URL}/auth/microsoft/callback` for each origin as in 2.2
3. Certificates & secrets → new client secret → `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`

Absent: button hidden. Verify: round trip. Redirect URIs are always derived from `APP_URL`; there
is no `*_REDIRECT_URI` variable to set.

### 2.3b Sign in with any OIDC issuer (Keycloak, Okta, Entra single-tenant, Auth0…)
One generic OpenID Connect issuer per deployment, beside or instead of the buttons above
(`docs/CONCEPTS.md` §2).
1. At the issuer, create a **confidential web client** (or a public one — PKCE only, no secret) with
   the authorization-code flow. Redirect URI: `{APP_URL}/auth/oidc/callback` for each origin, as in
   2.2. Post-logout redirect URI (if the issuer asks): `{APP_URL}/login?signedOut=1`
2. Set `OIDC_ISSUER` to the issuer's `issuer` value **exactly** (open
   `<issuer>/.well-known/openid-configuration` and copy it, trailing slash and all — a mismatch is
   refused), `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` unless the client is public. Optional:
   `OIDC_LABEL` (button text, default "Single sign-on"), `OIDC_SCOPES` (default
   `openid email profile`), `AUTH_OIDC_ONLY=true` (the login page goes straight to the issuer and
   hides every other method; the magic-link endpoint stays live for invitations — it hides, it does
   not disable), `OIDC_TRUST_EMAIL=true` (see Entra below). Locally these go in `.dev.vars`; deployed, everything but the secret is a
   `[vars]` entry in **both** tomls (commented templates are there) and `OIDC_CLIENT_SECRET` is a
   Worker secret (3.5)
3. Issuer notes:
   - **Keycloak**: `OIDC_ISSUER=https://<host>/realms/<realm>`; "Client authentication" on for a
     confidential client. A `groups` mapper is optional — the claim is read, not stored
   - **Okta**: `OIDC_ISSUER=https://<org>.okta.com` (org server) or
     `https://<org>.okta.com/oauth2/default`; app type "Web", grant "Authorization Code"
   - **Entra ID, single tenant**: `OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`;
     add the optional `email` claim to the ID token (Token configuration) — without it the kit
     falls back to the userinfo endpoint. Entra sends no `email_verified`, and the kit refuses a
     missing flag by default, so set **`OIDC_TRUST_EMAIL=true`** — only for a single tenant whose
     directory controls the `email` claim. (Multi-tenant Entra is the Microsoft button, 2.3)
   - **Auth0**: `OIDC_ISSUER=https://<tenant>.auth0.com/` — **with** the trailing slash, which is
     how Auth0 spells its issuer; Regular Web Application

Absent (`OIDC_ISSUER` blank): no `oidc` provider, the login page is unchanged. `AUTH_OIDC_ONLY=true`
without issuer and client id refuses to boot (config error). Verify: `/auth/methods` shows
`"oidc": { "label": … }`; "Continue with <label>" round-trips; `Sign out` returns to
`/login?signedOut=1` (through the issuer's logout page when it advertises `end_session_endpoint`).
An account whose `email_verified` is `false` — or missing, unless `OIDC_TRUST_EMAIL=true` — is
refused (`?error=email_unverified`); an existing kit user is linked by verified email.

### 2.4 First admin
`BOOTSTRAP_ADMIN_EMAILS=you@example.com` (comma-separated). Promoted to global admin on the first
**verified** login, logged loudly. Under `TENANCY_MODE=single` (Launch) that login also makes you
the organisation's **owner** — it creates the organisation with you as owner if there is none yet,
otherwise you join as, or are promoted to, owner. Absent: promote by hand once —
`UPDATE users SET is_global_admin = true WHERE email = '…'` (single mode: also
`UPDATE tenant_users SET role = 'owner' WHERE user_id = …`) — or every sign-up parks on `/pending`
with nobody to approve it (Launch's tomls set `SIGNUP_MODE=approval`; the kit default is
`invite_only`).

**Where setup lives.** Everything is under the one **Settings** item in the sidebar. Launch's
credentials and domain are **Settings → Connections** — one page each: Domain, Cloudflare, Neon,
GitHub, Email (Resend), Sign-in (the upstream identity provider and the OIDC issuer's keys) and
Public URL, each with its status dot in the menu (`/settings/domain`, `/cloudflare`, `/neon`,
`/github`, `/email`, `/sign-in`, `/public-url`). The kit pin is **Settings → Kit version**, the
coding agents **Settings → Coding agents**, and the access-request queue **Settings → People →
Access requests**. In single mode every organisation owner and admin can open these; in multi mode
only global admins. The **Operator** group (users, feature flags, all sessions; organisations in
multi mode) stays global-admin only. Until every connection works, a platform admin's Home lists
them under "Finish setting up Launch — n of 7". The old `/settings/platform/*` and `/admin/*`
links redirect. Verify: `/settings/domain` opens as the first admin.

**Kit version.** Settings → **Kit version** is the Rocketflare kit every new app is cut from:
Launch's default release unless you change it. Choose **Follow latest** (the kit's newest release —
the highest `X.Y.Z` tag, never a pre-release; Launch re-checks it hourly and moves the pin when a
newer one appears, without upgrading existing apps; "Check now" checks at once), pin a **release
tag** (type it, or pick from the repo's tags, newest first), or — to try a kit fix before it is
released — a **commit**: paste a SHA from any branch of the kit repo, or "Pin latest main". Launch
looks each up in the kit repo through the GitHub App (connect it first) and stores the full commit;
a commit pin is marked "Unreleased commit — for development". "Reset to default" goes back to
Launch's pin. Apps already launched keep their kit; a re-scaffold uses the pin as it is then.
Verify: the card shows the tag (or `Unreleased commit`) with the short SHA you pinned, and for
Follow latest "Checked …" and "Latest".

**The GitHub App's Administration permission also writes rulesets.** Connections → GitHub already requires
Repository › Administration: write (environments). From issue #5 Launch uses it for one more thing:
it protects each app's default branch with a repository ruleset named `launch` — `Gate` (the kit's
CI job) required, pull requests only, no force-push or deletion, and the App itself allowed to
bypass so a release can bump the version (`docs/CONCEPTS.md` §18.4). No new permission to grant.
Rulesets on a PRIVATE repository need GitHub Team (or above) on the organisation; on a free plan
GitHub refuses them, the launch records that and goes on, and the app page reports branch
protection as unavailable. Verify: after creating an app, its repository's Settings › Rules ›
Rulesets lists `launch` with your Launch GitHub App in its bypass list.

### 2.5 AI — chat, agents, embeddings
Resolution (`docs/CONCEPTS.md` §9): a per-agent assignment → the tenant's default provider in
Settings → AI & models → the platform `ANTHROPIC_API_KEY` → **Workers AI through the `AI` binding**. That last
tier means **chat and agents work on a fresh organisation with nothing configured**: Settings → AI & models shows
chat readiness `Cloudflare Workers AI · glm-4.7-flash · platform default`. Read the
cost line before relying on it, then pick any of these:

0. **Zero-key default — Workers AI.** Nothing to do; `wrangler dev` proxies the binding to your
   logged-in Cloudflare account and a deployed Worker uses its own. **Every call is billed to that
   account** (10 000 free neurons a day on any plan, then metered — GLM-4.7-Flash is about
   $0.06 / $0.40 per million input / output tokens); the `ai_usage` ledger counts the tokens. The
   floor is a model that can run the AGENTS, not just the chat box, so it needs real tool use: this
   one accepts `tool_choice`, carries tool calls in its event stream (so chat still streams token by
   token with tools on) and has a 131k context window, which is what stops one over-eager search
   poisoning the next turn. To make
   the kit zero-spend instead, comment the `[ai]` block out of BOTH tomls (the parity test keeps them
   in sync) — chat then answers 503 until a key or tenant provider exists. Any tenant can still add
   Workers AI explicitly as a chat provider (no key) to pick another model — cheaper and weaker,
   `@cf/mistralai/mistral-small-3.1-24b-instruct`, or anything else with function calling. Verify: `curl -b <cookie>
   localhost:3001/api/ai/config/readiness` → `"chat":{"ready":true,"source":"platform","provider":"workers_ai"…}`
   and `/chat` streams a reply.
1. **Platform key (optional).** `ANTHROPIC_API_KEY=` in `apps/web/.dev.vars` (deployed:
   `wrangler secret put`, Part 3). Every tenant without its own chat provider then uses it with
   `claude-sonnet-4-5` — it ranks above Workers AI. Verify: Settings → AI & models (as owner/admin) shows chat
   readiness `Anthropic · claude-sonnet-4-5 · platform default`; `curl -b <cookie>
   localhost:3001/api/ai/config/readiness` → `"chat":{…,"source":"platform","provider":"anthropic"…}`.
2. **Tenant provider (no platform key).** Settings → AI & models → *Add provider*: scope `chat`, a label (it is
   the upsert key — renaming later means delete + re-add), provider `anthropic` / `anthropic_compatible`
   (Fireworks, Moonshot presets; base URL required) / `openai` / `openai_compatible`, model, API key
   (encrypted with `OAUTH_ENCRYPTION_KEY`, never shown again — the row reports `hasCredential`). The
   first row in a scope becomes the default. Press **Test connection** before saving (a 10-token
   completion; 10 per minute per IP). Verify: the test reports `ok` and a latency; readiness reads
   `tenant`.
3. **Local mock — develop with no key at all.** Run any OpenAI-compatible server (Ollama, vLLM, a
   proxy) and add an `openai_compatible` chat config with its base URL **including `/v1`**
   (e.g. `http://localhost:11434/v1`), the model name it serves, and **any non-empty placeholder as
   the API key** (the adapter refuses an empty key; a local server ignores the bearer). Chat, the
   `summarize-text` agent and the usage table all work against it. Verify: `/chat` streams a reply.

Absent everywhere (no `[ai]` binding, no key, no tenant provider): `/chat` shows "configure AI";
`POST /api/chat/conversations` and the agent's `execute` step answer 503 `ai_not_configured` (the
agent enqueue itself still returns 202 and the run settles `failed`). Thinking is OFF unless a config
enables it with a budget (cost decision).

**Embeddings** (documents / hybrid search, `index: true` on the example agent): the `AI` Workers AI
binding (both tomls, and `wrangler dev` emulates it) is the zero-key default — `@cf/baai/bge-m3`,
1024-dim. Alternatives: an `embeddings`-scope tenant config (`openai`, `openai_compatible`,
`workers_ai`) or `EMBEDDINGS_API_KEY` for platform OpenAI `text-embedding-3-small` (reduced to 1024
dims). Verify: `POST /api/ai/documents/ingest` `{ "title": "t", "text": "hello world" }` → `status:
"indexed"`; `pnpm web db:check` reports the pgvector extension installed. Changing the dimension is a
new table (`docs/ADAPTING.md` §3).

**Document uploads** (Knowledge → Upload file): Markdown/text/CSV/JSON index straight away; PDF,
Word, Excel, OpenDocument, HTML and XML are converted by Workers AI Markdown Conversion on the same
`AI` binding (`wrangler dev` proxies it to Cloudflare, so `wrangler login` is needed; conversion of
documents is free) in the `document.convert` queue job. Verify: upload a small PDF on `/documents`,
watch the row go `Indexing → Indexed` within the 5 s poll (the wrangler terminal logs
`document.convert: indexed`), search a phrase from it, and click the download icon to get the
original back from R2. Without `[ai]` a binary upload answers 503 `conversion_not_configured`.

Agent runs need the `AGENT_RUN_WORKFLOW` binding (declared in both tomls; `wrangler dev` runs
instances locally). Without it `POST /api/agents/runs` is 503 `agent_runs_not_configured`. Verify
(from the Agents page in the nav, or by hand):
`POST /api/agents/runs` `{ "agentKey": "summarize-text", "input": { "text": "<a paragraph>" } }` →
202; `GET /api/agents/runs/<id>` reaches `succeeded` with `output.summary`.

**Human-in-the-loop walkthrough** (`docs/CONCEPTS.md` §9). A run can stop and ask a person, and
**`wrangler dev` is the only way to exercise that** — the suspend is `step.waitForEvent`, which the
Node test suite drives with a fake. Nothing extra to configure; `AGENT_INTERRUPT_TIMEOUT`
(`168 hours`) is already in both tomls. With `pnpm dev` running and signed in at
`/login?as=owner@example.test`:

1. **Agents → Summarise text**, paste a paragraph, turn *index the result* ON, run it. Watch the
   timeline fill **live** (token-by-token it is not — the stream carries durable rows — but it
   arrives in well under a second, not in 3-second lumps), then stop on *"Add this summary to the
   knowledge base?"*. The Agents nav item shows a badge of 1, and the notification bell deep-links
   to the run.
   Verify: `GET /api/agents/runs/<id>` reports `status: "awaiting_input"` with one pending interrupt.
2. **Answer it from a second browser** signed in as `admin@example.test`, then answer the same one
   in the first. One gets a 200, the other a 409 `interrupt_not_pending` rendered as *"somebody else
   answered"* — not an error toast. The run resumes on its own.
   Verify: the run reaches `succeeded` and the document appears in `/documents` **exactly once**
   (the write is behind `ctx.once`; a second copy means that broke).
3. **Restart `pnpm dev` while a run is parked**, then answer it. The run resumes across the
   restart — `wrangler dev` loses the instance, so this also exercises the `sendEvent → not_found`
   path that creates `<runId>-r1`. This is the durability claim; if anything is going to be wrong,
   it is this.
4. **Cancel a parked run.** It settles `cancelled` with `error` NULL and its interrupts `expired` —
   a refusal is a status, not a fault.
5. **Ask `research-topic` something ambiguous.** It calls `ask_human` and raises a `choice` from
   inside a tool handler; answer it, then type a **steering note** into the still-running run and
   watch it appear in the timeline and change the answer. Ask it to *save* what it finds and it
   calls `index_finding`, which is gated by `Tool.requiresApproval` — approve it (editing the text
   first, which `allowEdits` permits) and the note lands in the knowledge base.
6. **Reload a settled run**: identical to the streamed version.
   `curl -N -H 'Accept: text/event-stream' "http://localhost:3001/api/agents/runs/<id>/agui/stream"`
   shows `data:`-only frames with `id:` on group boundaries only.

### 2.6 Tracing (D32)
Nothing to set up: every chat turn, agent run, tool call, retrieval and embeddings batch is
recorded as spans in the local `ai_spans` table, with zero credentials. Verify: send a chat message
or run the example agent, then (as an owner/admin, logged in with `pnpm cli login`):
```bash
pnpm cli traces list                  # newest first; --agent chat · --status error · --run <id>
pnpm cli traces show <traceId|runId>  # the span tree: model, tokens, latency, tool args/results
```
A chat turn shows `invoke_agent chat` with `chat <model>` and `execute_tool <name>` children, and
retrieval/embeddings under the tool. `OBSERVABILITY_CAPTURE_CONTENT=false` drops prompts and tool
I/O. Optional backend (Langfuse keys keep working with no new setting; Phoenix locally is
`docker run -p 6006:6006 arizephoenix/phoenix` + `OBSERVABILITY_PRESET=phoenix` +
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006` in `.dev.vars`): `docs/DEPLOY.md` § Tracing.

### 2.6b Evals (D33)
Optional, and it costs tokens: put `ANTHROPIC_API_KEY` in `apps/web/.dev.vars`, then
```bash
pnpm test:db:up     # evals run against the TEST database and migrate it themselves
pnpm eval           # three starter suites: knowledge chat, summarize-text, research-topic
pnpm eval:view      # the score diff against the previous run, then the report UI
```
Without a key every suite skips and says why. Thumbs on chat replies and run output are live with
no setup; `pnpm cli feedback list --rating down` then `pnpm cli evals promote <id> --dataset <name>`
turns a bad answer into a case. Everything else — suites, judges, baselines, CI — is in
`docs/EVALS.md`.

### 2.7 Plugins `[ready]` (D31)

Analytics is not core; it is the `analytics` PLUGIN (from `rocketflare-dev/rocketflare-plugins`,
`plugins/analytics`, 3.4.1), committed with Launch, so a fresh clone has dashboards without you
doing anything. Nothing to configure.

```bash
pnpm plugin list                                   # what is installed, and from where
pnpm plugin check                                  # anchors, kit range, barrel lines, migrations
pnpm plugin remove analytics --apply               # then pnpm db:generate && pnpm db:migrate
pnpm plugin add <repo|path>[@ref]                  # read the plan; --apply installs it
```

**Every command prints its plan and stops until `--apply`.** Installing a plugin gives it full
Worker and database access — it is as trusting as merging a pull request — and the plan is what you
say yes to. It will never generate a migration, edit a wrangler toml or write a resource id: those
arrive as numbered steps you run yourself. The analytics plugin's are the `15 * * * *` cron and the
`/cubejs-api` + `/mcp` prefixes in both tomls, and two `resolve` entries plus two proxy lines in
`apps/web/vite.config.ts`.

**The drizzle-cube CLI / Claude Code plugin** (optional, with analytics installed): create
`apps/web/.drizzle-cube.json` — git-ignored, and the plugin repository's README has the shape —
with `apiToken` set to a tenant API key from Settings → API keys and `serverUrl` your `wrangler dev`
origin or a deployed host. It is an ordinary Bearer key: every query it makes is scoped to that
tenant by the cubes and it is revoked in the same place. Verify: the CLI's `meta` lists
`ActivityEvents`, `TenantActivityDaily`, `TenantUsers`, `Users`.

Writing one of your own: `/launch-plugin`, or `apps/web/src/plugins/CLAUDE.md` and the installed
`apps/web/src/plugins/analytics/`.

### 2.8 Feature flags `[ready]` (D30)

Nothing to configure — flags work out of the box, and Launch ships none yet (a flag is declared in
`CORE_FEATURE_FLAGS` or by a plugin's `SharedPlugin.features`). Once one exists, as a global admin
open **Settings → Feature flags**: set it to On, or to Rollout and the percentage decides
deterministically; force it on or off for one organisation and that beats the percentage either
way.

Two things worth knowing before you add your own:

- **`FEATURES_ENABLED` is the release gate, and `wrangler dev` reads `[vars]` from
  `wrangler.toml`** — the PRODUCTION value. So a flag you mark `environmentGated` and ship dark in
  production is dark on your laptop too unless `.dev.vars` lists it. That is why
  `.dev.vars.example` carries the key.
- **A flag is not a permission.** Gate with `requireFeature` / `{ feature: 'x' }`, never with
  `access Feature:x` — a global admin's `manage all` satisfies the CASL form and would show them a
  surface the deployment does not ship. `docs/CONCEPTS.md` §15 has the incident this rule came from.

Verify: `pnpm cli features list --json` prints the effective flags for your tenant; flipping one in
Settings → Feature flags changes it on the next call.

### 2.9 Rebrand checklist
Done when Launch was seeded from Rocketflare 0.15.0: package names (`@launch/*`), worker names, DB
names, CLI bin (`launch`) / config dir (`~/.launch`) / env prefix (`LAUNCH_`), `EMAIL_FROM`. The
themes and logo are still the kit's.

---

## Part 3 — Cloudflare deploy `[config]`

**Deploying your own Launch is [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** — the runbook, from a
fresh clone: fill one git-ignored file at the repo root (`launch.deploy.env`, from
`launch.deploy.env.example`), then type **`/launch-deploy`** in Claude Code or run
`pnpm provision all`. It creates the GitHub App, the Neon project, the Cloudflare resources, the
DNS, deploys, puts every Worker secret and writes the Connections credentials, pausing before each
paid step under the skill. An instance never touches the committed tomls: its ids live in
`.launch/state.json` and every wrangler call uses `apps/web/wrangler.deploy.toml`, rendered from
`wrangler.toml`. Updating it is a rerun. `pnpm provision --help` lists the phases.

**The rest of this part is the committed-toml path** — the kit's two-environment shape
(`apps/web/wrangler.staging.toml` + `apps/web/wrangler.toml`, a Neon branch per environment) and
the GitHub Actions release dance in `deploy.yml`. It is the manual reference behind that shape and
what CI deploys; it is **not** how an instance from `launch.deploy.env` is deployed, and the two
don't mix (`docs/DEPLOYMENT.md` § 9 says what CI for an instance still lacks). Only `apps/web` is
deployed; the CLI is built by CI but not published. Reference: [`docs/DEPLOY.md`](docs/DEPLOY.md).
You need Cloudflare on **Workers Paid** with your domain as a zone, Neon, and (for email) Resend —
`docs/DEPLOYMENT.md` § 0 has the detail.

### 3.1 Accounts and access
1. Cloudflare account on **Workers Paid** (Workflows and `[limits]` need it, and Hyperdrive under
   `postgres` — Hyperdrive's plan availability has changed over time; the Hyperdrive create step
   reports if the plan refuses it) **with your domain as a zone on it** (registered there, or its nameservers moved —
   `docs/DEPLOYMENT.md` § 0): the custom-domain `routes` and the email DNS records live in that
   zone. Without one, both hosts are `workers.dev` and email is skipped. `pnpm web exec
   wrangler login`.
   Verify: `pnpm web exec wrangler whoami` prints the account, and the dashboard lists the domain
   as an active zone.
2. CI API token (account scope): Workers Scripts, KV, Queues, Workflows, Durable Objects, R2
   (+ Hyperdrive under `postgres`) — edit; Workers AI, Account Analytics — read; Zone → DNS — edit on your zone.
   Verify: `CLOUDFLARE_API_TOKEN=… pnpm web exec wrangler whoami` succeeds.
3. Neon: one project; branches `production` (main) and `staging` — create `staging` **before** the
   first migration, so each branch is migrated with its own password rather than inheriting a
   migrated main (the database's default owner role is kept on both). Record the **direct** and `-pooler` connection strings for each. Under `neon` the
   Worker gets the pooled one (3.5); under `postgres` Hyperdrive gets the direct host; `apps/web/scripts/migrate.ts` strips `-pooler` itself. Never put these strings in
   a file in this repo. Verify: `psql "<direct url>" -c 'select 1'` on both branches.

### 3.2 Provision Cloudflare resources
```bash
pnpm web provision:cloudflare staging --apply        # DATABASE_DRIVER = "neon" (the kit's tomls)
pnpm web provision:cloudflare production --apply
# tomls already on postgres (Hyperdrive needs the direct host):
NEON_DATABASE_URL='<staging direct url>' pnpm web provision:cloudflare staging --apply
```
`pnpm web provision:cloudflare` runs `apps/web/scripts/cf-provision.sh` with `apps/web` as its
working directory (the script also `cd`s there itself, so `bash apps/web/scripts/cf-provision.sh
staging --apply` from the root works too). It creates (or finds, by name) the resources: the KV
namespace `<APP>_RATE_LIMIT[_STAGING]`, the Queue `<app>-jobs[-staging]`, the R2 bucket
`<app>-files[-staging]` (the last two are name-referenced — nothing to paste) and, under
`postgres` only, the Hyperdrive config `<app>-<env>`. Switching the driver (the var and the
`[[hyperdrive]]` block, in the toml it is given) is `DATABASE_DRIVER=neon|postgres` in the
environment of `pnpm web provision:cloudflare <env> --apply`; run it for both environments.
`--apply` writes the KV (and Hyperdrive) ids into the toml through
`scripts/provision/patch-toml.ts` (byte-preserving; a DIFFERENT existing id is refused unless
`--force`); without it the script prints the ids and a `sed` line to run yourself. The Workflow
(`[[workflows]]` `AGENT_RUN_WORKFLOW`), the Workers AI binding (`[ai]`) and the DO need no create
step — `wrangler deploy` registers them — but the Workflow `name` is account-scoped: staging MUST be
`<app>-agent-run-staging` (`docs/DEPLOY.md`, "Account-scoped names").
Verify: `REQUIRE_PROVISIONED=1 pnpm web test:config` passes — no `<PLACEHOLDER>` left, every
account-scoped staging name ends in `-staging`, ids differ. Commit the tomls (ids are not secrets).

### 3.3 GitHub Environments and secrets
Repository → Settings → Environments → create `staging` and `production`. In **each**:

| Secret | Value |
|---|---|
| `DATABASE_URL` | that branch's Neon connection string (owner role; pooled or direct) |
| `CLOUDFLARE_API_TOKEN` | the token from 3.1 (may be shared) |
| `CLOUDFLARE_ACCOUNT_ID` | account id |

Verify: both environments list three secrets. Optionally add required reviewers to `production` if
your plan supports it; otherwise publishing the Release is the gate (3.6).

### 3.4 First deploy (the worker must exist before secrets can be set)
Actions → **Deploy** → Run workflow → environment `staging` (uses the ref you dispatch from). It
runs CI, the provisioned parity test, migrations against the staging branch, builds the UI and
deploys `wrangler.staging.toml` from inside `apps/web`. Runtime 500s are expected until 3.5.
Verify: the run is green; `pnpm web exec wrangler deployments list -c wrangler.staging.toml` shows it.

### 3.5 Worker secrets
**Under `neon`, first** put the Worker's database connection — the branch's **pooled** URI:
`printf '%s' "$POOLED_URL" | pnpm web exec wrangler secret put DATABASE_URL -c wrangler.staging.toml`
(`pnpm provision` does this for an instance; here it is by hand). Then, for every other non-`[vars]` name
in `apps/web/.dev.vars.example` (skip `DATABASE_DRIVER` and `NEON_LOCAL_PROXY` — local only —
`DATABASE_URL` under `postgres`, which uses Hyperdrive, and `APP_DATABASE_URL` unless enabling RLS; the `OIDC_*` names other than
`OIDC_CLIENT_SECRET`, and `AUTH_OIDC_ONLY`, are `[vars]` — Part 2.3b):
```bash
# one per name: OAUTH_ENCRYPTION_KEY RESEND_API_KEY BOOTSTRAP_ADMIN_EMAILS GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
#   MICROSOFT_CLIENT_ID MICROSOFT_CLIENT_SECRET OIDC_CLIENT_SECRET ANTHROPIC_API_KEY OPENAI_API_KEY EMBEDDINGS_API_KEY
#   LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY OTEL_EXPORTER_OTLP_HEADERS
printf '%s' "$OAUTH_ENCRYPTION_KEY" | pnpm web exec wrangler secret put OAUTH_ENCRYPTION_KEY -c wrangler.staging.toml
```
`wrangler secret put NAME` reads the value from stdin when stdin is not a terminal — pipe it with
`printf '%s' "$V"`, never `--body` or an argument, so the value stays out of argv and shell history
(interactively it prompts). `pnpm provision secrets` does exactly this for an instance, from
`launch.deploy.env`. Repeat without `-c` for production after its first deploy. Use different keys per
environment. `ANTHROPIC_API_KEY`, `EMBEDDINGS_API_KEY`, the two `LANGFUSE_*` keys and `OTEL_EXPORTER_OTLP_HEADERS` are optional
(Part 2.5/2.6): skip them and the features degrade as described there. `OPENAI_API_KEY` is optional
too: what Codex sessions on Launch's account spend (`docs/CONCEPTS.md` §18.22). Which coding agents
sessions run, and whether people may use their own Claude subscription or ChatGPT plan, is not a
var: enable them on Settings → Coding agents (by default, Claude Code on
Launch's key only). Nor is where session containers run: a deployed Launch always uses its own
containers (the Session sandbox setting's remote host is for development only).
Verify: `pnpm web exec wrangler secret list -c wrangler.staging.toml` shows the names;
`curl https://<staging-host>/api/health` returns ok, `curl https://<staging-host>/api/ready` returns
ok (it runs a query — a 503 there means the Worker cannot reach Neon: under `neon` a missing or
wrong `DATABASE_URL` secret, under `postgres` Hyperdrive pointing at the wrong host or SSL), and `/auth/methods` lists your providers. With Launch's `SIGNUP_MODE=approval` (the kit default is `invite_only`) the
admin's first login lands on `/pending` under `multi` (the first organisation is created from Settings → People → Access requests, which needs no
membership);
under `single` it creates the organisation with the admin as owner (Part 2.4).
Point the CLI at it: `pnpm cli login --server https://<staging-host>`.

### 3.6 Custom domains
Uncomment `routes = [{ pattern = "<host>", custom_domain = true }]` in each toml (staging host in
the staging file). Wrangler creates the DNS record on the next deploy. Set `[vars] APP_URL` to
`https://<host>` in the same file. Update OAuth redirect URIs (Part 2).
Verify: the host serves the app over HTTPS; the parity test still passes (`routes` may differ).

### 3.7 The release dance (every subsequent deploy)
1. Bump the **root** `package.json` version to X.Y.Z and move the `## Unreleased` lines in
   `CHANGELOG.md` under `## X.Y.Z`. Commit. (The `apps/*` versions are informational; one tag ships
   web and cli together.)
2. `git tag X.Y.Z && git push origin X.Y.Z` → **staging** deploys (`deploy.yml`: CI gate → parity
   with `REQUIRE_PROVISIONED=1` → `pnpm db:migrate:ci` on the staging branch →
   `pnpm --filter @launch/web build:ui` → `pnpm --filter @launch/web exec wrangler deploy -c
   wrangler.staging.toml --var RELEASE_VERSION:X.Y.Z`). The job fails if tag ≠ root version.
3. Check staging: `/api/health`, the version in the nav footer, the flow you changed.
4. `gh release create X.Y.Z --title X.Y.Z --generate-notes` → **production** deploys the release's
   tag with `wrangler.toml`. Publishing the Release is the promotion gate.
Verify: production `/auth/session` reports `releaseVersion: "X.Y.Z"`; `pnpm cli status` against it
prints the same version.

### 3.8 Rollback
- Fast: `pnpm web exec wrangler rollback [-c wrangler.staging.toml]` — redeploys the previous Worker
  version (code + bindings; **not** the database).
- Deliberate: re-run Actions → Deploy → `production` from the previous tag, or publish a Release on
  the previous tag again. Migrations are forward-only; write a compensating migration if a schema
  change must be undone.
Verify: `/auth/session` shows the expected version; `pnpm web exec wrangler tail` shows healthy requests.

### 3.9 What the parity test demands, in one place
`apps/web/tests/config/wrangler-parity.test.ts` runs in `pnpm test` (placeholders allowed) and in
`deploy.yml` with `REQUIRE_PROVISIONED=1` (placeholders forbidden). It reads both tomls relative to
`apps/web` (not the process cwd), so it behaves the same from the root and from the package. It
requires: identical binding names and DO `class_name`s, `compatibility_date`/`flags`, `[limits]`,
`[triggers].crons`, `[assets]`, `[[migrations]]` and `[vars]` keys across both files; staging `name`
= production `name` + `-staging`; every Workflow `name`, queue `queue`, R2 `bucket_name` in staging
ends in `-staging` and differs from production; Hyperdrive/KV ids differ; a `[[hyperdrive]]` block
is in both files or neither, and never in a `neon` file. When you add a binding, add
it to both files, run `pnpm types`, and commit `apps/web/worker-configuration.d.ts`.
