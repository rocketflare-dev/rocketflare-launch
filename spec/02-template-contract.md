# 2. The app-template contract

Status: spec, not built.

The contract is the **only** coupling between Launch and the kind of app it manages. Launch
drives any app through a `TemplateAdapter`. Rocketflare is adapter v1, and other templates (a
plain Worker, a static site, a Python Worker) can be added later without touching the pipeline.

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
| `resources` | `apps/web/wrangler.toml` and `wrangler.staging.toml`: fixed bindings (`HYPERDRIVE`, `RATE_LIMIT_KV`, `JOBS_QUEUE`, `FILES`, `NOTIFICATIONS_HUB`, `AGENT_RUN_WORKFLOW`, `AI`, `ASSETS`), plus plugin blocks. Resource names follow `<slug>[-staging]` |
| `writeConfig` | The same two tomls: placeholders such as `<HYPERDRIVE_ID>`, `<HYPERDRIVE_STAGING_ID>`, `<KV_RATE_LIMIT_ID>` and `<KV_RATE_LIMIT_STAGING_ID>`, plus the `[vars]` `APP_URL` and `EMAIL_FROM` and `routes = [{ pattern, custom_domain = true }]`. The two files must keep the same shape; the app's own parity test enforces that. |
| `declaredConfig` | Every installed plugin's `plugin.json` `vars[]`, with `secret: true` marking a secret. Also the kit's optional secrets (`ANTHROPIC_API_KEY`, `LANGFUSE_*`, `OTEL_EXPORTER_OTLP_HEADERS`, …) |
| `secretTargets` | **Worker secrets**: `OAUTH_ENCRYPTION_KEY` (64 hex chars, generated once, never rotated blindly because it seals tenant credentials), `RESEND_API_KEY`, `BOOTSTRAP_ADMIN_EMAILS`, plus the OIDC client secret. **GitHub Environment secrets** (`staging`, `production`): `DATABASE_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| `release` | `.github/workflows/deploy.yml`: a tag `X.Y.Z` equal to the root `package.json` version deploys staging; publishing the GitHub Release deploys production; `workflow_dispatch` takes an `environment` input. Each job migrates the database, then runs `wrangler deploy` |
| `health` | `GET /api/health` (liveness, returns the version) and `GET /api/ready` (`SELECT 1` through Hyperdrive) |
| `auth` | **Missing today.** Rocketflare signs in with Google, Microsoft, magic link and dev login; there is no generic OIDC provider. See "What the template must add" below |
| `devBootstrap` | `pnpm bootstrap --yes --no-dev` then `pnpm dev`. This is the kit's zero-credential first run (Postgres on `:5432`, UI on `:3000`, API on `:3001`) |
| `upgradePrompt` | `/rf-upgrade` to `<version>`, the kit's own upgrade skill, run inside the app's repo |

What Launch reads, it reads through the GitHub contents API or inside a sandbox, never from a
local checkout.

## What the template must add

**A generic OIDC login.** It is the only gap. It is worth having in Rocketflare for its own sake,
since every copy would gain Okta, Entra, Keycloak or any other OIDC sign-in, and Launch would be
one more issuer.

The kit's provider registry (`apps/web/src/api/auth/providers/`) already holds `google` and
`microsoft` on arctic, so a third, config-driven `oidc` provider fits the existing seam:

- `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_LABEL`;
- a mode where OIDC is the only method and `/login` redirects straight to it.

If the kit doesn't take it, the adapter can add it at scaffold time as template-side code. That
is worse, because every app then owns a fork of its login.

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

- There is only one adapter. The interface shape above will change when a second template
  arrives.
- The Rocketflare surfaces are stable by convention, not by a published guarantee. A kit release
  that renames a placeholder breaks adapter v1. Mitigation: pin the scaffold tag per Launch
  release, and let fleet upgrades ([10](10-fleet-operations.md)) move apps forward only through
  PRs.
