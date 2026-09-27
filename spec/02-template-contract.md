# 2. The app-template contract

Status: spec, not built.

The contract is the **only** coupling between Launch and the kind of app it manages. Launch
drives apps through a `TemplateAdapter`. **Rocketflare is the only template Launch supports.** The
interface exists to keep the pipeline independent of kit internals and to version the contract
across kit releases, not to add other templates.

## The adapter interface

The shape below is illustrative and not final.

```ts
interface TemplateAdapter {
  id: 'rocketflare'
  contractVersion: 1

  /** A repo tree for a new app, built inside a scaffold sandbox. It gets a repo token and nothing more. */
  scaffold(input: { slug: string; displayName: string; templateRef: string }): ScaffoldPlan

  /** The resources the app needs per environment, read from the repo. */
  resources(repo: RepoReader): Promise<ResourceDecl[]>   // hyperdrive, kv, queue, r2, workflow, do…

  /** The secrets and vars the app declares it needs; this feeds grant detection (09). */
  declaredConfig(repo: RepoReader): Promise<ConfigDecl[]>

  /** Write resource ids, URLs and vars back into the repo. Launch commits the result. */
  writeConfig(repo: RepoReader, env: EnvName, values: ConfigValues): Promise<FileChange[]>

  /** Where each environment's secrets go, and which GitHub Environment secrets CI needs. */
  secretTargets(env: EnvName): SecretTarget[]

  /** How a release happens: tags, releases, dispatch inputs. */
  release: ReleaseStrategy

  /** Liveness and readiness probes. */
  health: { live: string; ready: string }

  /** The env var names the app reads for OIDC sign-in (05). */
  auth: { issuer: string; clientId: string; clientSecret: string }

  /** Bring-up commands inside a coding session sandbox (07). */
  devBootstrap: string[]

  /** Optional: a session prompt that brings the app up to date with its template (10). */
  upgradePrompt?: (from: string, to: string) => string
}
```

`contractVersion` changes when the adapter needs a surface the template doesn't guarantee. Each
app records the adapter and contract version it was created with.

## Rocketflare adapter v1

It is written purely against surfaces every Rocketflare app exposes today. All of these exist in
the kit as of 0.12.x:

| Adapter need | Rocketflare surface |
|---|---|
| `scaffold` | The kit repo at a **pinned release tag** → `node scripts/rename.mjs <slug> "<Display>" --domain <host>` (non-interactive; exit 0/1/2) → `pnpm plugin add … --apply` for each `defaultPlugins` entry → commit. It runs in a scaffold sandbox because it needs Node, `pnpm install` and Biome. |
| identity of an app | `.rocketflare.json`: `app { slug, display, domain }`, `kit { version, commit }`, `defaultPlugins`, the surfaces manifest |
| `resources` | `apps/web/wrangler.toml` and `wrangler.staging.toml`: fixed bindings (`HYPERDRIVE` in the kit today, dropped by Launch apps, see below; `RATE_LIMIT_KV`, `JOBS_QUEUE`, `FILES`, `NOTIFICATIONS_HUB`, `AGENT_RUN_WORKFLOW`, `AI`, `ASSETS`), plus plugin blocks. Resource names follow `<slug>[-staging]` |
| `writeConfig` | The same two tomls: placeholders such as `<KV_RATE_LIMIT_ID>` and `<KV_RATE_LIMIT_STAGING_ID>`, plus the `[vars]` `APP_URL` and `EMAIL_FROM`, and `workers_dev = false` with no `routes`: Launch owns each app's routes ([04](04-hostnames-and-dns.md)). The two files must keep the same shape; the app's own parity test enforces that. |
| `declaredConfig` | Every installed plugin's `plugin.json` `vars[]`, with `secret: true` marking a secret. Also the kit's optional secrets (`ANTHROPIC_API_KEY`, `LANGFUSE_*`, `OTEL_EXPORTER_OTLP_HEADERS`, …) |
| `secretTargets` | **Worker secrets**: `OAUTH_ENCRYPTION_KEY` (64 hex chars, generated once, never rotated blindly because it seals tenant credentials), `RESEND_API_KEY`, `BOOTSTRAP_ADMIN_EMAILS`, `DATABASE_URL` (the branch's pooled URI), plus the OIDC client secret. **GitHub Environments**: no secrets; the variable `DEPLOYER_URL` only (see gap 3) |
| `release` | `.github/workflows/deploy.yml`: a tag `X.Y.Z` equal to the root `package.json` version deploys staging; publishing the GitHub Release deploys production; `workflow_dispatch` takes an `environment` input. Each job migrates the database, then runs `wrangler deploy`. For Launch apps the jobs deploy through Launch instead (gap 3) |
| `health` | `GET /api/health` (liveness, returns the version) and `GET /api/ready` (`SELECT 1` through the database client) |
| `auth` | **Missing today.** Rocketflare signs in with Google, Microsoft, magic link and dev login; there is no generic OIDC provider. See "What the template must add" below |
| `devBootstrap` | **Not `pnpm bootstrap`**, which needs Docker for its database. Instead its steps against the session's Neon branch: `pnpm install` → `.dev.vars` (`DATABASE_URL`, `OAUTH_ENCRYPTION_KEY`) → offline AI → `pnpm db:migrate` → dev servers. The kit pins Vite to `:3000`, which a Sandbox reserves, so the kit needs **configurable dev ports**; S7 ran Vite on `:5173` ([S7](../spikes/s7-sandbox/RESULT.md)) |
| `upgradePrompt` | `/rf-upgrade` to `<version>`, the kit's own upgrade skill, run inside the app's repo |

What Launch reads, it reads through the GitHub contents API or inside a sandbox, never from a
local checkout.

## What the template must add

The full, explicit list for the kit, with defaults that leave standalone apps unchanged, is
[13. What Rocketflare needs to change](13-rocketflare-changes.md). This section gives the
reasoning for the three largest.

There are three gaps.

### 1. A generic OIDC login

It is worth having in Rocketflare for its own sake,
since every copy would gain Okta, Entra, Keycloak or any other OIDC sign-in, and Launch would be
one more issuer.

The kit's provider registry (`apps/web/src/api/auth/providers/`) already holds `google` and
`microsoft` on arctic, so a third, config-driven `oidc` provider fits the existing seam:

- `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_LABEL`;
- a mode where OIDC is the only method and `/login` redirects straight to it.

If the kit doesn't take it, the adapter can add it at scaffold time as template-side code. That
is worse, because every app then owns a fork of its login.

### 2. A database client that doesn't need Hyperdrive

Launch apps don't use Hyperdrive. Its limit of 25 configs per account would cap the fleet at about
12 apps ([S0](../spikes/s0-limits/RESULT.md)). The kit's client (`apps/web/src/db/client.ts`) is
postgres.js only. Without a `HYPERDRIVE` binding it falls back to `DATABASE_URL` over direct TCP,
which works but costs ~800 ms per request ([S3](../spikes/s3-neon-hyperdrive/RESULT.md)). The
change:

- plain queries over **Neon's HTTP driver** (~105 ms, the same as Hyperdrive in S3);
- `db.transaction(...)` over a **Neon WebSocket** connection opened only for it (~300 ms more),
  because the kit uses interactive transactions in 10 places, including tenant-scope RLS
  (`set_config(..., true)`) and `SET LOCAL` in AI retrieval. The HTTP driver can't do those;
- selected by config, so an app deployed outside Launch can keep Hyperdrive.

It is a contained change: `db/client.ts`, `middleware/database.ts`, and the places that pass
`HYPERDRIVE` to the resolver (queues, scheduled, workflows, span-store). **Coding sessions need it
too**: their egress allowlist can't carry Postgres TCP ([S7](../spikes/s7-sandbox/RESULT.md)), so
`scripts/migrate.ts` and `scripts/seed.ts` must also be able to run over the WebSocket driver.

S7 also hit what is probably a separate kit bug on Neon: `db-roles.ts` runs
`ALTER ROLE … NOSUPERUSER NOBYPASSRLS … NOREPLICATION`, which Neon's owner role may not run. The
same statement is in `db:migrate:ci`. To confirm with the kit. If the kit doesn't take
it, the adapter carries it as a scaffold-time patch, with the same drawback as above.

### 3. A deploy job that deploys through Launch

The kit's `deploy.yml` migrates with `DATABASE_URL` and runs `wrangler deploy` with
`CLOUDFLARE_API_TOKEN`, both stored in the GitHub Environment. Launch apps store neither
([03](03-trust-and-credentials.md), [S1](../spikes/s1-worker-token/RESULT.md)). Their jobs:

- request a GitHub Actions OIDC token (`id-token: write`) and call `DEPLOYER_URL`;
- wait for Launch's go-ahead, and receive short-lived migration credentials;
- run `pnpm db:migrate:ci` with them;
- build with `wrangler deploy --dry-run --outdir`, plus the UI assets, and upload the build to
  Launch.

The kit could offer this as a deploy mode in its own workflow, selected by `DEPLOYER_URL` being set.
The variable is named for any deployer, not for Launch. Otherwise the adapter replaces
`deploy.yml` at scaffold time; the release triggers (tag → staging,
published release → production) stay the same.

## What Launch deliberately does not reuse

The kit's `pnpm provision` is a good **reference** for the order of phases and for making every
phase find-or-create. Launch does not run or import it, because it:

- assumes one checkout is one app, with state in local files;
- uses the `gh` CLI;
- creates Cloudflare resources by parsing wrangler's text output;
- calls Neon without an `org_id`;
- finds resources by name, so two apps with the same slug would silently share them;
- has no repo creation and no teardown.

Launch provisions against the vendor REST APIs itself ([06](06-registry-and-pipeline.md)). The
adapter only says *what* an app needs and *where* the answers go.

## Known gaps

- The Rocketflare surfaces are stable by convention, not by a published guarantee. A kit release
  that renames a placeholder breaks adapter v1. Mitigation: pin the scaffold tag per Launch
  release, and let fleet upgrades ([10](10-fleet-operations.md)) move apps forward only through
  PRs.
