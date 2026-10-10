# Several kits, one contract: design

**Status:** proposed, 2026-10-10. Not started. Proposes decision **D36**. It supersedes in part
[spec/02](../../spec/02-template-contract.md), which says Rocketflare is the only template. Open
questions are in §9.

## 1. Why

A company should decide for itself what its people can build with Launch. Today Launch builds every
app from one kit, Rocketflare: the platform setting `template_pin` points at a single repo.
The aim of this design is that:

- a platform admin registers **several kits**, and Rocketflare is only the default;
- a user picks a kit when they create an app, and the app keeps that kit for its whole life,
  including when it is upgraded;
- a company gets a kit by **forking a meta-kit** (`rocketflare-dev/launch-kit`) and filling it in.
  If the files, workflows and skills the contract names exist, Launch can create, develop in,
  ship and upgrade the company's apps with no change to Launch.

**Scope.** A kit can be any shape as long as it runs on the same platform. Its internals are its
own business: Rocketflare-derived or written from scratch, with any UI or framework, any plugin
system or none. What stays fixed is everything Launch provisions and operates:

- one Cloudflare Worker per environment (staging, production);
- Neon Postgres;
- the deployer protocol v1 ([DEPLOYER.md](../DEPLOYER.md));
- OIDC sign-in through Launch's issuer;
- only the resource kinds Launch can provision.

Non-Workers stacks are out of scope. Supporting them would make provisioning, deploy and preview
pluggable too, which this design does not attempt.

## 2. What exists today

**The seam exists but is mostly bypassed.**

- `TemplateAdapter` (`services/launch/rocketflare/adapter.ts:144-197`) has `id: 'rocketflare'` as a
  literal type and contract `'1'`. Only `services/launch/upgrades.ts` calls it.
- About 30 files import the Rocketflare modules directly. The modules are:
  - `rocketflare/{names,toml,scaffold-job,placeholder-worker,declared-config}.ts`;
  - `rocketflare-manifest.ts`;
  - `sessions/rocketflare-dev.ts`.
- The files that import them include:
  - `pipeline/launch-steps.ts`, `grants/detect.ts`, `health.ts`, `thumbnails.ts`;
  - `sessions/steps.ts`, `sessions/gate.ts`;
  - the runtimes.
- `pipeline/ports.ts` `defaultPorts()` is the one real injection point. It carries names,
  `writeConfig`, the placeholder script and the scaffold.

**`apps.template` is written but never read.** It defaults to `'rocketflare'`
(`db/schema/apps.ts:56`). The kit is one platform setting, `template_pin`
(`packages/shared/src/launch-setup.ts`, `DEFAULT_TEMPLATE_PIN`). The setting already accepts any
`owner/name` (`PUT /api/platform/setup/template-pin`), so pointing Launch at a Rocketflare fork
half-works today. The scaffold check refuses anything that does not look like Rocketflare.

**The kit-side contract is real but nowhere declared.** What Launch relies on is spread across
the kit:

- `.rocketflare.json`;
- `scripts/rename.mjs`;
- `pnpm gate --list --json`;
- the job named `Gate` in `ci.yml`;
- `deploy.yml` (deployer protocol v1);
- the health routes;
- the OIDC var names;
- the bootstrap's sandbox flags;
- `DEV_UI_PORT` and `DEV_API_PORT`;
- `TEST_DATABASE_BRANCH`;
- `pnpm kit:upgrade` and the `rf-upgrade` skill;
- `LAUNCH_GATE_APP_ID`.

Launch hardcodes every one of these. §4 maps each to a contract field.

## 3. Decision D36

> Launch supports any kit that conforms to the **Launch kit contract**. A kit declares how it
> conforms in a root `launch.kit.json`, and a conformance check proves it before the kit can be
> picked. Rocketflare is conforming kit #1, not a special case. Launch's code holds no knowledge of
> a particular kit except one built-in fallback manifest for Rocketflare releases that predate
> `launch.kit.json`.

Each app records the kit it was created from (`apps.kit_id`), and the kit's version, commit and
contract version, as `template_*` does today. Upgrades move an app forward within its own kit only.

## 4. The contract: `launch.kit.json`

Each block generalises something Launch hardcodes today. The right-hand column of the table names
that thing.

| Block | Declares | Replaces in Launch today |
|---|---|---|
| `schema` | `1` | — |
| `kit` | `id`, `name`, `description`, `icon`; version source (root `package.json` `version`); release tag pattern (`X.Y.Z`) | `id: 'rocketflare'`; `latestKitTag`'s tag rule in `kit-pin.ts` |
| `scaffold.init` | A non-interactive command template, with `{slug}`, `{display}` and `{domain}` substituted. Its exit codes are 0 for ok, 1 for an error and 2 for a usage error | the `rename.mjs` call in `scaffold-job.ts` |
| `scaffold.kitOnly` | Paths deleted from a copy | `KIT_ONLY_FILES` in `scaffold-job.ts` |
| `scaffold.postInit` | Commands run after init (install, lint:fix) | the hardcoded `pnpm install` / `pnpm lint:fix` |
| `scaffold.appManifest` | The path where a copy records `app {slug, display, domain}` and `kit {id, version, commit}` | `MANIFEST_PATHS` (`.rocketflare.json`, `launch.plugins.json`), `stampKitCommit` |
| `worker.tomls` | The toml path per environment | `WRANGLER_PATHS` |
| `worker.naming` | Resources are named `<slug>-<suffix>[-staging]`; ids are `<NAME_ID>` placeholders | `names.ts`, `KIT_BINDINGS`, the binding checks in `scaffoldProblems` |
| `launchProvides` | Launch's vocabulary mapped to the kit's own names: `appUrl`, `emailFrom`, `databaseUrl`, `databaseDriver`, `oidc.{issuer,clientId,clientSecret,only}`, `bootstrapAdmins`, `emailApiKey`; `generated: [{ name, kind: 'hex64' }]`; fixed `vars` (`TENANCY_MODE`, …) | `ROCKETFLARE_WORKER_SECRETS`, `launchVars` in `toml.ts`, `adapter.auth` |
| `declaredConfig` | Optional secrets and vars; where plugin manifests live, if the kit has plugins | `KIT_OPTIONAL_CONFIG` in `declared-config.ts` |
| `database` | `roles` (`migrator`, `app`); `extensions` (`vector`); the CI migrate command; the rule for naming the app's RLS role | `provision-neon.ts`, `deploy/migrator.ts`, `appRlsRoleFor` |
| `health` | `live` and `ready` paths | `adapter.health` |
| `ci` | The required check (`Gate`); the gate-list command (gate schema 1); the gate-verified variable; the gate's test env names | `KIT_REQUIRED_CHECK`, `sessions/gate.ts`, `gate-branch.ts`, `gate-variable.ts` |
| `release` | The workflow file; the name of its environment input; `deployerProtocol: 1` | `deploy.yml` in three places (`adapter.ts`, `pipeline/ports.ts`, `releases/github.ts`) |
| `session` | `install`; `bootstrap` (with `{dbUrl}`); `devStart` and `devStop`; the env names for the dev ports; the files Launch may write; the env names for skipping steps and allowing root | `sessions/rocketflare-dev.ts` (`INSTALL_COMMAND`, `BOOTSTRAP_COMMAND`, the preload, the ports, `SESSION_KIT_TAG`) |
| `upgrade` (optional) | The command (`{to}`); the skill path; the pattern for the notes path; the done marker | `rocketflare/upgrade-prompt.ts`, `launch-upgrades.ts` notes URL |
| `plugins` (optional) | Default plugins and a catalogue ref | the scaffold's `default-plugins.mjs` step; [create-app-interview](create-app-interview.md) §2.2 |
| `modules` (optional) | Core modules an app may drop, for the interview's panel | create-app-interview §1 |

Launch's own platform behaviour does not appear in the manifest. That covers OIDC client
registration, Neon branches, DNS, approvals and the deploy gateway. The manifest says only *what
the kit calls things* and *how to drive it*.

Readers tolerate unknown fields, as the gate list already does. A kit raises `schema` only for a
change a reader cannot ignore.

## 5. What a kit must contain

**Must have.** Conformance fails without these.

- `launch.kit.json`.
- The `init` script. It must be idempotent on a clean copy and refuse a dirty tree unless forced.
- A gate script that answers `--list --json` (schema 1) and runs steps by id.
- `.github/workflows/ci.yml`. It must have a job whose check name matches `ci.requiredCheck`, and
  it must honour the gate-verified variable.
- `.github/workflows/deploy.yml`, implementing deployer protocol v1:
  - a tag `X.Y.Z` equal to the version deploys staging;
  - a published release deploys production;
  - `workflow_dispatch` takes the declared environment input;
  - it requests `id-token: write` and runs `start → upload → activate → finish` against
    `DEPLOYER_URL`.
- Both tomls, with placeholder ids and names that follow the naming rule, using only binding
  kinds Launch provisions: KV, Queues, R2, Durable Objects, Workflows, AI, assets
  (`deploy/binding-check.ts`).
- The `live` and `ready` routes. `ready` must reach the database.
- A sign-in driven by the mapped OIDC vars, with a mode where OIDC is the only method.
- `CLAUDE.md` or `AGENTS.md`. The session system prompt tells agents to follow the repo's own
  instructions (`services/prompts.ts:104-124`), so this file is how a kit governs what gets built
  with it.

**Should have.**

- An upgrade skill and command.
- A setup skill.
- Per-release porting notes.

Without the upgrade block, the app shows no "behind" state and no upgrade action.

**One structural constraint.** The deployer verifies that the OIDC token's `job_workflow_ref` starts
with `<owner>/<repo>/.github/workflows/deploy.yml@`. A reusable workflow called with `uses:` changes
that claim to the reusable workflow's ref, so a kit cannot share one deploy workflow across apps
that way. v1 copies the deployer client (`deployer.mjs`, `bundle.mjs`) into each kit, as
Rocketflare does today. Later, ship the client as a pinned **composite action**: a composite
action keeps the caller's `job_workflow_ref` and needs no change to the deployer.

## 6. The meta-kit: `rocketflare-dev/launch-kit`

The meta-kit is a GitHub template repository. It is the smallest app that passes conformance, and a
company forks it and fills it in.

- A Hono Worker with the health routes, an OIDC-only sign-in, a Neon client (HTTP plus a WebSocket
  pool for transactions), one migration with the `migrator`/`app` roles, and a placeholder page.
- Both tomls, `ci.yml` and `deploy.yml` (deployer path only), `scripts/{init,gate,bootstrap,dev,
  deployer,bundle}.mjs`, and a filled-in `launch.kit.json`.
- `.claude/skills/{setup,upgrade}` and a `CLAUDE.md` that states its rules to session agents. The
  `CLAUDE.md` is the part a company most wants to rewrite.
- `scripts/kit-check.mjs`, the conformance check (§7), run in its own CI. A fork knows it still
  conforms before it ever registers with Launch.
- `FORKING.md`, which says what to replace, what not to touch (the deploy workflow's protocol
  steps, the health routes, the manifest's `launchProvides` names) and how to register the fork in
  Launch.

**Rocketflare adopts the contract** with a kit PR that adds `launch.kit.json` (Appendix A) and
reuses `kit-check.mjs` in `kit.yml`. Launch keeps that manifest built in as a **fallback** for
Rocketflare releases up to 0.17.x, which have none. Every existing app therefore resolves to a
manifest with no migration of its repo.

## 7. Conformance

One checker, shared by Launch and the meta-kit:

- **Static checks.** These run over the GitHub contents API at the pinned commit.
  - The manifest parses.
  - Every must-have file exists.
  - `ci.yml` has the required job.
  - `deploy.yml` has the triggers, the dispatch input and `id-token: write`.
  - Both tomls parse, every id is a placeholder, every name follows the naming rule, and every
    binding kind is provisionable.
  - The two tomls have the same shape.
- **Dynamic check.** The existing scaffold job runs against a throwaway private repo: init →
  postInit → the gate's lint and typecheck steps. The job then reports the copy's
  `appManifest`, and the repo is deleted.

A kit is `verified` only when both pass at its current pin. Re-pinning runs the check again.
Create app offers verified kits only. The result and its reasons are shown on the kit's row and
returned by `launch kits check`.

## 8. Launch-side changes, in phases

Each phase is shippable on its own, and Rocketflare-only Launch keeps working after every phase.

- **K1: contract and catalogue.**
  - `@launch/shared/kit-manifest` (zod, the contract) and `@launch/shared/kits` (API).
  - A platform-scoped `kits` table, the same class as `launch_settings`: `id`, `slug`, `name`,
    `repo`, `pin` (`tag | commit | follow`), the manifest snapshot, the contract version,
    `is_default`, `status`, `checked_at`, `problems`.
  - A migration backfills the `template_pin` setting into the default Rocketflare row.
  - `apps.kit_id` is added and backfilled. `apps.template` stays as history.
  - `kit-pin.ts` resolves per kit, and the follow-latest cron loops over kits.
  - **Private kit repos.** A company's kit is likely private, so read it through the GitHub App's
    installation. Today the code assumes the repo is public (`kit-pin.ts:20-23`), and the scaffold
    job clones anonymously.
  - `/api/platform/kits`, with `launch kits ls|add|check|pin|default` (CLI parity).
- **K2: an adapter built from the manifest.**
  - `manifestAdapter(manifest)` builds a `TemplateAdapter`, and `adapterFor(app)` resolves it. `id`
    widens to `string`.
  - `pipeline/ports.ts` carries the whole adapter. The ~30 direct importers move behind it.
  - `scaffoldProblems` checks names from `worker.naming` rather than `KIT_BINDINGS`.
  - What is left of `rocketflare/` is the fallback manifest and the legacy steps in K3.
- **K3: a generic scaffold.**
  - `scaffold-job.ts` runs `init` → delete `kitOnly` → stamp `appManifest` → `postInit` →
    `plugins` → the gate's lint and typecheck.
  - `patchPreserved`, `kitTestPatches` and the plugin declarations stay as Rocketflare-legacy
    steps, gated on kit id and version, until their fixes land upstream
    ([upstream-kit-issues](upstream-kit-issues.md)).
- **K4: sessions.**
  - `sessions/rocketflare-dev.ts` becomes `kit-dev.ts`, driven by `manifest.session`.
  - `sessions/gate.ts` and `gate-branch.ts` read `ci`, and `neon-session-db.ts` reads `database`.
  - The session image keeps Rocketflare's warm pnpm store (`containers/session/Dockerfile:56-58`).
    Any other kit installs cold, which is a stated gap. A per-kit store cached in R2 can follow
    later.
- **K5: UI.**
  - Platform → Kits: list, add, check, pin, set default.
  - A kit picker in Create app, which is the first field of the interview's brief. The chosen
    kit's manifest supplies the "kit defaults" layer that create-app-interview §2.4 resolves
    against.
  - Import detects the kit from `appManifest`.
  - Upgrades run against each app's own kit.
  - Copy that names "Rocketflare" (`KitVersionCard`, `CataloguePage`, `CreateAppModal`,
    `ImportAppModal`) names the app's kit instead.
- **K6: kit-side work, landed by PR.**
  - The `launch-kit` repo.
  - Rocketflare's `launch.kit.json`.
  - `kit-check.mjs` in Rocketflare's CI.

`docs/CONCEPTS.md` §13 and §18.6, and spec/02, are rewritten with K2. Until then spec/02 carries a
pointer to this doc.

## 9. Known gaps and open questions

1. **The resource kinds are fixed.** A kit that needs D1, Hyperdrive, Vectorize or a service
   binding fails conformance. Widening the set is Launch provisioning work, not a contract
   change.
2. **Moving a kit's contract under existing apps.** An app records the contract version it was
   created with. An upgrade that crosses a `schema` change must be refused or migrated
   explicitly, never silently. The open question is what "migrated" means.
3. **Trusting a kit's plugins.** A kit's default plugins may come from another repo. Trusting and
   pinning that repo follows the catalogue decision in create-app-interview.
4. **Who registers kits.** Proposed: platform admins only (`canAdministerPlatform`). Is a kit ever
   scoped to a team?
5. **Cold sessions.** See K4.
6. **Changing an app's kit.** Moving an app from kit A to kit B is not supported. That is a
   rewrite, done by a session if at all.

## Appendix A: Rocketflare 0.18 expressed as a manifest

Values are taken from the kit and from Launch's current constants.

```json
{
  "schema": 1,
  "kit": {
    "id": "rocketflare",
    "name": "Rocketflare",
    "description": "Multi-tenant SaaS starter for internal tools and B2B products",
    "version": { "file": "package.json", "field": "version" },
    "tagPattern": "^\\d+\\.\\d+\\.\\d+$"
  },
  "scaffold": {
    "init": "node scripts/rename.mjs {slug} {display} --domain {domain} --force --skip-install",
    "kitOnly": [
      "apps/web/tests/kit-only/**",
      ".github/workflows/kit.yml",
      ".github/workflows/plugin-ci.yml",
      ".github/workflows/notify-plugins.yml"
    ],
    "postInit": ["pnpm install --no-frozen-lockfile", "pnpm lint:fix"],
    "appManifest": ".rocketflare.json"
  },
  "worker": {
    "tomls": { "production": "apps/web/wrangler.toml", "staging": "apps/web/wrangler.staging.toml" },
    "naming": { "pattern": "{slug}-{suffix}", "stagingSuffix": "-staging" }
  },
  "launchProvides": {
    "appUrl": "APP_URL",
    "emailFrom": "EMAIL_FROM",
    "databaseUrl": "DATABASE_URL",
    "databaseDriver": { "name": "DATABASE_DRIVER", "value": "neon" },
    "oidc": {
      "issuer": "OIDC_ISSUER",
      "clientId": "OIDC_CLIENT_ID",
      "clientSecret": "OIDC_CLIENT_SECRET",
      "only": "AUTH_OIDC_ONLY"
    },
    "bootstrapAdmins": "BOOTSTRAP_ADMIN_EMAILS",
    "emailApiKey": "RESEND_API_KEY",
    "generated": [{ "name": "OAUTH_ENCRYPTION_KEY", "kind": "hex64" }],
    "vars": { "TENANCY_MODE": "single", "SIGNUP_MODE": "open" }
  },
  "declaredConfig": {
    "optional": ["ANTHROPIC_API_KEY", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "OTEL_EXPORTER_OTLP_HEADERS"],
    "pluginManifests": "apps/web/src/plugins/*/plugin.json"
  },
  "database": {
    "roles": ["migrator", "app"],
    "extensions": ["vector"],
    "migrate": "pnpm db:migrate:ci",
    "rlsRole": "{slug_snake}_app"
  },
  "health": { "live": "/api/health", "ready": "/api/ready" },
  "ci": {
    "requiredCheck": "Gate",
    "gateList": "pnpm gate --list --json",
    "gateRun": "pnpm gate {step}",
    "verifiedVariable": "LAUNCH_GATE_APP_ID",
    "testEnv": { "branch": "TEST_DATABASE_BRANCH", "endpoint": "TEST_DATABASE_ENDPOINT" }
  },
  "release": { "workflow": "deploy.yml", "environmentInput": "environment", "deployerProtocol": 1 },
  "session": {
    "install": "pnpm install --frozen-lockfile --prefer-offline",
    "bootstrap": "node scripts/bootstrap.mjs --db-url {dbUrl} --driver neon --offline --no-dev --no-open --no-plugins --yes",
    "devStart": "node apps/web/scripts/dev-server.mjs --start",
    "devStop": "pnpm dev:stop",
    "ports": { "ui": "DEV_UI_PORT", "api": "DEV_API_PORT", "allowedHosts": "DEV_ALLOWED_HOSTS" },
    "writes": ["apps/web/.dev.vars", "apps/web/wrangler.session.toml"],
    "env": { "skip": "ROCKETFLARE_BOOTSTRAP_SKIP", "allowRoot": "ROCKETFLARE_ALLOW_ROOT" }
  },
  "upgrade": {
    "command": "pnpm kit:upgrade --to {to} --apply",
    "skill": ".claude/skills/rf-upgrade/SKILL.md",
    "notes": "docs/upgrades/{version}.md",
    "doneMarker": "LAUNCH-UPGRADE:"
  },
  "plugins": {
    "defaults": [
      {
        "id": "analytics",
        "repo": "https://github.com/rocketflare-dev/rocketflare-plugins.git",
        "ref": "3.4.2",
        "subdir": "plugins/analytics"
      }
    ],
    "add": "pnpm plugin add {repo} --apply --allow-dirty"
  }
}
```

Two things Launch does to Rocketflare today have no field, on purpose:

- **The bootstrap preload** (`rocketflare-dev.ts:256-304`) rewrites `db:migrate`, `seed` and
  `wrangler whoami` for the sandbox. A conforming kit's `bootstrap` must work with `--db-url` and
  no preload. Rocketflare's preload stays a legacy step until the kit does.
- **The scaffold's test patches and preserved-org patch.** Launch edits these Rocketflare files
  at scaffold time. A conforming kit's own tests must pass on a fresh copy, which is what the
  dynamic check proves.
