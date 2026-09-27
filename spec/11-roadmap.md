# 11. Roadmap

Status: spec, not built. Each phase ends with a test someone can watch pass, and each phase is
useful on its own.

## P0: spec and spikes

- This repository, reviewed.
- **Spikes that decide feasibility**, each about one day:
  - S0, fleet limits: done ([spikes/s0-limits](../spikes/s0-limits/RESULT.md)).
  - S1, a Cloudflare token scoped to one Worker: done. The format works, but it doesn't isolate
    apps, so Launch deploys ([spikes/s1-worker-token](../spikes/s1-worker-token/RESULT.md)).
  - S2, flat hosts on the apps domain: done ([spikes/s2-flat-routes](../spikes/s2-flat-routes/RESULT.md)).
  - S3, Neon + Hyperdrive: done ([spikes/s3-neon-hyperdrive](../spikes/s3-neon-hyperdrive/RESULT.md)).
  - S4, one shared Resend domain: done ([spikes/s4-resend-shared-domain](../spikes/s4-resend-shared-domain/RESULT.md)).
  - S5, deploying through Launch from a private repo on a non-Enterprise GitHub plan: done
    ([spikes/s5-deploy-via-launch](../spikes/s5-deploy-via-launch/RESULT.md)).
  - S6, the OIDC issuer: done. OpenAuth isn't an OIDC provider, and a `jose` issuer passes
    `openid-client` ([spikes/s6-oidc-issuer](../spikes/s6-oidc-issuer/RESULT.md)).
  - S7, the session sandbox: done. 24 s to a live, gated preview; a streamed, resumable Claude Code
    chat with no model key in the sandbox ([spikes/s7-sandbox](../spikes/s7-sandbox/RESULT.md)).
     for a Rocketflare app.

**Exit:** each spike reports yes, no, or yes-with-a-workaround, and the design is updated to
match. **Done 2026-09-27**: every spike reported, and the spec was updated
([spikes/SUMMARY.md](../spikes/SUMMARY.md)). What P0 leaves for the kit: an OIDC login, a Neon
driver client, a deploy mode that goes through Launch, and configurable dev ports.

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

**Exit:** a user clicks "Create app", and minutes later `<slug>-staging.<apps domain>` serves the
app. They sign in through Launch. Nobody opened a terminal.

## P3: coding sessions

- The SessionDO, the Sandbox image, the live preview, streaming and a PR at the end
  ([07](07-coding-sessions.md)).
- Budgets and metering.

**Exit:** a non-engineer changes a screen in the browser, sees it in the preview, and ends with a
green PR.

## P4: approvals and shipping

- The approvals engine, the inbox and policies ([08](08-approvals-audit-ship.md)).
- Release and promote from Launch; every deploy goes through Launch, which is the production gate.

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
