# 2. The kit contract

Status: built through D36 K2 (2026-10-10). The design is
[docs/plans/multi-kit.md](../docs/plans/multi-kit.md); what runs is described in
[CONCEPTS §18.24](../docs/CONCEPTS.md).

The contract is the **only** coupling between Launch and the kind of app it manages. Launch
supports **any kit that conforms to it**: a kit declares how it conforms in a root
`launch.kit.json`, a conformance check proves it before the kit can be picked, and Launch drives
each app through a `TemplateAdapter` built from its kit's manifest. Rocketflare is conforming kit
#1, not a special case. Launch's code holds no knowledge of a particular kit except one built-in
fallback manifest for Rocketflare releases that predate `launch.kit.json`.

## The manifest: `launch.kit.json`

The schema is `@launch/shared/kit-manifest` (`kitManifestSchema`, `schema: 1`); readers tolerate
unknown fields, and a kit raises `schema` only for a change a reader cannot ignore. Each block says
what the kit calls things and how to drive it — Launch's own platform behaviour (OIDC client
registration, Neon branches, DNS, approvals, the deploy gateway) is not in it.

| Block | Declares |
|---|---|
| `kit` | id, name, repo, version source, release tag pattern |
| `scaffold` | the non-interactive `init` command (`{slug}`, `{display}`, `{domain}`), `kitOnly` paths, `postInit` commands, and `appManifest` — where a copy records `app {slug, display, domain}` and `kit {id, version, commit}` |
| `worker` | the toml per environment; the naming rule (`{slug}-{suffix}` plus a staging suffix); KV title suffixes |
| `launchProvides` | Launch's vocabulary → the kit's var and secret names: app URL, sender, `DATABASE_URL`, the driver var, the OIDC vars (issuer, client id, client secret, label, OIDC-only), bootstrap admins, the email key, ONE generated secret (`hex64` or `base64-32`), fixed vars |
| `declaredConfig` | optional secrets and vars (and which are `plain`), where plugin manifests live |
| `database` | the migrator and app roles, extensions, the CI migrate command, the RLS role rule |
| `health` | `live` and `ready` routes |
| `ci` | the required check, the gate list and run commands, the gate-verified variable, the test env names |
| `release` | the deploy workflow file, its environment input, `deployerProtocol: 1` ([DEPLOYER.md](../docs/DEPLOYER.md)) |
| `session` | install, bootstrap (`{dbUrl}`), dev start and stop, the port env names, the files Launch may write |
| `upgrade` (optional) | the command (`{to}`), skill, notes path, done marker — without it an app is never "behind" and never upgraded |
| `plugins`, `modules` (optional) | default plugins; core modules an app may drop |

Rocketflare's manifest is [multi-kit.md Appendix A](../docs/plans/multi-kit.md#appendix-a-rocketflare-018-expressed-as-a-manifest),
which Launch also ships as the fallback (`services/launch/kits/rocketflare-fallback.ts`).

## The adapter

`services/launch/kits/adapter.ts` `manifestAdapter(manifest)` builds a `TemplateAdapter`: the
app manifest and toml paths and their parsers, the resource names and the naming check, the toml
writer, the Worker secret names, the Neon roles, the release workflow, the health routes, the
required check, the declared config and the upgrade prompt. `adapterFor(db, app)` resolves an
app's adapter from the manifest snapshot ON the app (`apps.kit_manifest`, set at create or import
and refreshed when a Release records an upgrade to the kit's pinned version), else its kit row's,
else the fallback — never from GitHub, so a Workflow step resolves the same adapter on every retry
and an app keeps its release's contract while its kit's pin moves on.

`contractVersion` is the manifest's `schema`; each app records it (`template_contract_version`)
with its kit (`kit_id`) and kit version. An upgrade moves an app forward within its own kit only.

## What a kit must contain

[multi-kit.md §5](../docs/plans/multi-kit.md): the manifest; the init script; a gate that answers
`--list --json`; `ci.yml` with the required check; the deploy workflow (deployer protocol v1: a
version tag deploys staging, a published release deploys production, `workflow_dispatch` takes the
environment input, `id-token: write`); both tomls with placeholder ids, names that follow the
naming rule and only binding kinds Launch provisions (KV, Queues, R2, Durable Objects, Workflows,
AI, assets); the `live` and `ready` routes; sign-in driven by the mapped OIDC vars; a `CLAUDE.md`
or `AGENTS.md`. The static conformance check (`services/launch/kits/conformance.ts`) proves the
files; the dynamic check (scaffold a throwaway copy) is K3.

## What Launch deliberately does not reuse

A kit's own provisioning scripts are a reference, not something Launch runs: they assume one
checkout is one app with state in local files, and find resources by name. Launch provisions
against the vendor REST APIs itself ([06](06-registry-and-pipeline.md)); the adapter only says
*what* an app needs and *where* the answers go.

## Known gaps

- The scaffold job and coding sessions still use Rocketflare's own steps (D36 K3, K4), so an app
  of another kit registers, checks and resolves its adapter but cannot yet be created end to end.
- The resource kinds are fixed: a kit that needs D1, Hyperdrive, Vectorize or a service binding
  fails conformance. Moving a kit's `schema` under existing apps is an open question
  ([multi-kit.md §9](../docs/plans/multi-kit.md)).
