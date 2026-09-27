# 13. What Rocketflare needs to change

Status: proposal to the kit, from the P0 spikes ([spikes/SUMMARY.md](../spikes/SUMMARY.md)).
Written against kit **0.13.0**.

## The rule for every change

**Rocketflare stays a complete, separate product.** Every change below:

- is **generic**: useful to any Rocketflare app, and nothing in it names Launch;
- is **off by default**: an app that doesn't opt in behaves exactly as it does today, including
  `pnpm bootstrap`, `pnpm dev`, `pnpm provision` and the deploy workflow;
- is **selected by configuration** (an env var, a `.dev.vars` key, a GitHub variable), never by
  detecting Launch;
- adds **no runtime dependency** on Launch: no client library, and no call to Launch from an
  app's Worker.

Launch drives these switches from its adapter ([02](02-template-contract.md)). If the kit declines
one, the adapter carries it as a scaffold-time patch instead, at the cost of every app owning a
fork of that code.

## Summary

| # | Change | Why (spike) | Default when unset | Size |
|---|---|---|---|---|
| 1 | Generic OIDC login provider | Launch is the company's sign-in (S6) | Provider absent; Google, Microsoft and magic link as today | Medium |
| 2 | Neon serverless database driver | Hyperdrive caps a fleet at ~12 apps (S0, S3); sessions can't use Postgres TCP (S7) | postgres.js over Hyperdrive, as today | Medium |
| 3 | Deploy through an external deployer | CI can't hold a Cloudflare token safely (S1, S5) | The current `deploy.yml` path | Medium |
| 4 | Configurable dev ports | A Sandbox reserves `:3000` (S7) | `3000` and `3001` | Small |
| 5 | Bootstrap against an existing database | No Docker in a sandbox (S7) | Docker compose, as today | Small |
| 6 | Fix `db-roles.ts` on Neon | `ALTER ROLE … NOSUPERUSER …` fails for Neon's owner (S7) | — (a bug fix) | Small |

Needs **no** change: routes (the tomls already leave `routes` commented out, and the parity test
allows them to differ), `EMAIL_FROM` and Resend (already a var and a secret), health endpoints,
`.rocketflare.json`, `rename.mjs`, and plugin manifests.

---

## 1. A generic OIDC login provider

**Why.** Launch signs everyone in to every app as one OIDC issuer
([05](05-identity-sso.md)). S6 showed a standard OIDC client (`openid-client`) works against it
unchanged, so the kit needs a plain OIDC provider and nothing specific to Launch. It also gives
every Rocketflare copy Okta, Entra ID, Keycloak or Auth0 sign-in on its own.

**Change.**
- A third provider in `apps/web/src/api/auth/providers/` beside `google.ts` and `microsoft.ts`:
  `oidc.ts`. It uses discovery from `OIDC_ISSUER`, the code flow with PKCE (S256) and a `nonce`,
  and verifies the `id_token` with `jose` against the issuer's JWKS (`iss`, `aud`, `exp`, `nonce`).
- Config: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (secret), and `OIDC_LABEL`
  (button text).
- `AUTH_OIDC_ONLY=true`: `/login` redirects straight to the provider, and the other methods are
  hidden. Magic link can stay on for guests via the existing settings.
- User mapping: match on the `sub` claim, store the issuer with it, and fall back to a verified
  `email` for the first link. Optionally read a `groups` claim for display; roles stay app-local
  ([05](05-identity-sso.md)).
- Logout: if the issuer publishes `end_session_endpoint`, `/logout` can redirect there with
  `id_token_hint` and `post_logout_redirect_uri`.

**Default.** No `OIDC_ISSUER` → the provider isn't registered, and login is unchanged.

**Done when.** A kit app signs in against any standard issuer (Launch's, Keycloak in CI), with
tests for a replayed code, a bad `nonce`, the wrong audience, and a JWKS key rotation.

## 2. A Neon serverless database driver

**Why.**
- Launch apps don't use Hyperdrive: its 25 configs per account cap a fleet at about 12 apps (S0).
- Without Hyperdrive, the kit's postgres.js falls back to direct TCP at ~800 ms per request (S3).
- Coding-session sandboxes can't send Postgres over TCP at all; only HTTPS leaves them (S7).

Neon's serverless driver fixes all three: HTTP matched Hyperdrive (~105 ms against ~95 ms per
query), and WebSocket gives interactive transactions (S3).

**Change.**
- `DATABASE_DRIVER = "postgres" | "neon"` (a var; default `postgres`).
- In `apps/web/src/db/client.ts`, `neon` mode returns a drizzle handle that:
  - runs **queries over Neon HTTP** (`drizzle-orm/neon-http`);
  - runs **`db.transaction(...)` over a Neon WebSocket connection** opened only for that
    transaction (`drizzle-orm/neon-serverless`, `Pool`), because the kit uses interactive
    transactions in 10 places, including `tenant-scope.ts` (`set_config(..., true)`) and
    `SET LOCAL` in AI retrieval. The HTTP driver can't do those.

  The URL comes from the `DATABASE_URL` Worker secret (the branch's pooled URI).
- The places that pass `HYPERDRIVE` into the resolver (`middleware/database.ts`, queues,
  scheduled, workflows, `span-store.ts`) take the handle from `createDatabase` rather than
  reading the binding themselves.
- **Scripts too:** `migrate.ts`, `seed.ts` and `db-roles.ts` must work over the WebSocket driver
  when `DATABASE_DRIVER=neon`, because a coding session can't reach Postgres over TCP (S7).
- The `HYPERDRIVE` binding becomes optional in the tomls. The parity test allows it to be absent
  from both files, or present in both.

**Default.** `postgres` → exactly today's behaviour: postgres.js over Hyperdrive, with
`localConnectionString` in dev.

**Done when.** The test suite passes in both modes against a Neon branch, including the
tenant-scope and retrieval transactions, and a Worker with no `HYPERDRIVE` binding serves
`/api/ready`.

## 3. Deploy through an external deployer

**Why.** A per-Worker Cloudflare token in GitHub can bind **any** resource in the account into its
own Worker: another app's KV, R2, Queues, Worker or database (S1). Launch therefore deploys every
app itself, and CI holds no Cloudflare token and no production database credential. S5 ran this
end to end on a non-Enterprise org, 14 of 14 checks passing.

**Change** (in `.github/workflows/deploy.yml`):
- A second path, taken when the repository variable **`DEPLOYER_URL`** is set. It's a generic
  name: "an external service that deploys this app". Each job gets `permissions: id-token: write`.
- The steps, from S5's [launch.mjs](../spikes/s5-deploy-via-launch/app-repo/launch.mjs), ~100
  lines, shipped as `scripts/deployer.mjs`:
  1. `start`: request a GitHub OIDC token (audience = the deployer) and open a ticket; wait for
     approval with a timeout.
  2. Build with `wrangler deploy --dry-run --outdir dist` plus `build:ui`, and **upload** the
     modules, the toml and the static assets. The deployer checks the bindings, stores an
     undeployed version, and returns short-lived migration credentials.
  3. `pnpm db:migrate:ci` with `DATABASE_URL` set to those credentials.
  4. `activate`, then `finish` in an `if: always()` step.
- The release triggers are unchanged: a tag `X.Y.Z` deploys staging, and a published release
  deploys production.
- `RELEASE_VERSION` travels in the upload (the deployer sets it as a var).

**Default.** No `DEPLOYER_URL` → the existing jobs run unchanged (`CLOUDFLARE_API_TOKEN`,
`DATABASE_URL` from the environment, `wrangler deploy`).

**Done when.** The same workflow deploys a kit app both ways. The deployer protocol (start,
upload, activate, finish, plus the payload shape) is documented in the kit as a small, versioned
contract, so any deployer can implement it.

## 4. Configurable dev ports

**Why.** `:3000` inside a Cloudflare Sandbox belongs to the SDK's own control server. The kit pins
Vite to `:3000` with `strictPort`, and `dev-server.mjs` to `[3000, 3001]`, so `pnpm dev` can't
start in a coding session (S7).

**Change.**
- `DEV_UI_PORT` and `DEV_API_PORT` (env or `.dev.vars`), read by `vite.config.ts` (`server.port`
  and the `/api` proxy target), `scripts/dev-server.mjs` (`PORTS`, the ready URL), `bootstrap.mjs`
  (`UI_URL`, `API_URL`) and the default `APP_URL` in `.dev.vars.example`.
- `DEV_ALLOWED_HOSTS`, passed to Vite's `server.allowedHosts`, so the dev server can be reached
  through a preview hostname. S7 used `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`, which is Vite's
  internal escape hatch.

**Default.** `3000` and `3001`, and Vite's normal host check.

**Done when.** `DEV_UI_PORT=5173 pnpm dev` serves the UI on `:5173`, with the API proxy working.

## 5. Bootstrap against an existing database

**Why.** `pnpm bootstrap` requires Docker and docker compose for its local Postgres (the
toolchain check, then `dev-db.mjs up`). Coding sessions have no Docker. Each gets its own Neon
branch instead (S7). The seed also refuses a non-local database.

**Change.**
- `pnpm bootstrap --db-url <url>` (or `DATABASE_URL` already set in `.dev.vars`, with `--db-url`
  passed): skip the Docker checks and the compose steps, write the URL to `.dev.vars`, and run
  migrate and seed against it.
- With `--db-url`, the seed treats the given database as the intended target: it passes
  `SEED_ALLOW_REMOTE` itself, and prints the host it is seeding so a mistake is visible.
- The existing `--offline` (AI without a Cloudflare login) and `--no-dev` stay as they are.

**Default.** Unchanged: Docker compose on a per-checkout port.

**Done when.** `pnpm bootstrap --yes --no-dev --offline --db-url <neon branch>` completes on a
machine with no Docker. Combined with change 4, `pnpm dev` then comes up (S7 did these steps by
hand, 24 s to a live preview).

## 6. Fix `db-roles.ts` on Neon

**Why.** The role phase runs
`ALTER ROLE rocketflare_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`. Only a
superuser may set `SUPERUSER`, `BYPASSRLS` or `REPLICATION`, even to "no". Neon's owner role isn't
one, so on a Neon branch it fails with "permission denied to alter role" (S7). The same statement
runs in `db:migrate:ci`, so **deploys to Neon are probably affected today**. This needs confirming
against the kit's own Neon setup.

**Change.** Set only `NOCREATEDB NOCREATEROLE` unconditionally, and add the three superuser-only
attributes when `current_setting('is_superuser') = 'on'`. `CREATE ROLE … NOLOGIN` already
defaults all three to off, so nothing is lost.

**Default.** A bug fix, with the same result on a local superuser.

**Done when.** `pnpm db:migrate` passes against a fresh Neon branch as its owner role, and
against the local compose Postgres.

---

## What Launch does *not* ask of the kit

- No Launch plugin, client library, SDK or runtime call.
- No change to how an app is structured, named, provisioned by hand, or upgraded
  (`/rf-upgrade`).
- No Launch-specific names in config. `DEPLOYER_URL`, `DATABASE_DRIVER`, `OIDC_*` and
  `DEV_*_PORT` are all generic.

Launch keeps everything else on its own side of the contract: provisioning, routes, secrets,
grants, approvals, and the session sandbox.

## Order

Changes 6, 4 and 5 are small and unblock coding sessions (P3). Change 1 is needed for P1's exit
(an app signs in through Launch). Changes 2 and 3 are needed for P2 (creating apps without
Hyperdrive, deployed by Launch). Until the kit ships a change, the adapter applies it as a
scaffold-time patch ([02](02-template-contract.md)).
