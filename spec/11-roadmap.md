# 11. Roadmap

Status: spec, not built. Each phase ends with a test someone can watch pass, and each phase is
useful on its own.

## P0: spec and spikes

- This repository, reviewed.
- **Spikes that decide feasibility**, each about one day:
  1. Mint a Cloudflare token scoped to one Worker and deploy with it; confirm the policy format.
  2. Custom Domain certificates on `x.apps.<domain>` and `x.staging.apps.<domain>`.
  3. A custom deployment protection rule on a private repo in the target GitHub plan.
  4. Sandbox cold start: clone a Rocketflare app, bootstrap, and time `pnpm dev` to a ready
     preview.
  5. An OpenAuth issuer producing a standard `id_token` and discovery document, used as the login
     for a Rocketflare app.

**Exit:** each spike reports yes, no, or yes-with-a-workaround, and the design is updated to
match.

## P1: foundation

- Seed the Launch codebase ([01](01-overview.md)).
- A setup wizard:
  - the domain and zone check;
  - admin credentials, with a check of their permissions;
  - the GitHub App install;
  - the upstream IdP.
- The OIDC issuer and per-app access policy ([05](05-identity-sso.md)).
- The registry, importing existing Rocketflare apps, the catalogue and the health cron.
- The `audit_events` table from day one.

**Exit:** an existing Rocketflare app is listed with live health, and after its OIDC settings are
switched, its users sign in through Launch.

## P2: create an app

- Rocketflare adapter v1 ([02](02-template-contract.md)).
- The `APP_LAUNCH` Workflow, every step ([06](06-registry-and-pipeline.md)), with resume and
  rollback.
- The kit's generic OIDC login, contributed upstream if the kit takes it; otherwise carried by the
  adapter.

**Exit:** a user clicks "Create app", and minutes later `<slug>.staging.apps.<domain>` serves the
app. They sign in through Launch. Nobody opened a terminal.

## P3: coding sessions

- The SessionDO, the Sandbox image, the live preview, streaming and a PR at the end
  ([07](07-coding-sessions.md)).
- Budgets and metering.

**Exit:** a non-engineer changes a screen in the browser, sees it in the preview, and ends with a
green PR.

## P4: approvals and shipping

- The approvals engine, the inbox and policies ([08](08-approvals-audit-ship.md)).
- Release and promote from Launch; production gated by the protection rule, or by the fallback.

**Exit:** a production deploy waits in the Launch inbox and is released by the approval. The
audit log shows the whole chain from PR to production.

## P5: shared config and grants

- The catalogue, detecting declared needs, `GRANT_PUSH`, rotation and revocation
  ([09](09-config-and-grants.md)).

**Exit:** an app that installs the M365 connector is prompted to request M365. The owner team
approves it and the app works. One rotation updates every app that holds the grant.

## P6: fleet

- Template upgrades through sessions, rotation of minted credentials, teardown, the cost view and
  per-PR previews ([10](10-fleet-operations.md)).

**Exit:** "upgrade all" opens upgrade PRs across the fleet. An archived app leaves no Cloudflare
resources behind.
