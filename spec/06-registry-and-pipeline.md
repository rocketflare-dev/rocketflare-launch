# 6. App registry and the launch pipeline

Status: spec, not built.

## Registry (Launch's own Postgres)

The shapes below are illustrative.

| Table | Holds |
|---|---|
| `teams`, `team_members` | Ownership and policy groups (from IdP groups, or managed in Launch) |
| `apps` | `slug` (unique, reserved-word checked; the naming key for every resource), display name, team, owners, template adapter + contract version, template version (e.g. kit `0.12.1`), repo, status (`requested → provisioning → live → archived`, or `failed`) |
| `app_environments` | per app × `staging\|production`: URL, Worker name, Hyperdrive/KV/Queue/R2 ids, Neon project/branch/role, Resend domain id, custom domain ids, last deploy (version, at, by), health |
| `app_operations` | a durable, per-step log of each pipeline run: step, status, attempt, error, external ids created (this is what makes retry and teardown exact) |
| `oidc_clients` | client id, hashed secret, redirect URIs, app, access policy |
| `grants`, `approvals`, `audit_events` | [08](08-approvals-audit-ship.md), [09](09-config-and-grants.md) |
| `sessions`, `session_events` | [07](07-coding-sessions.md) |

**Resource ids are recorded when created, never looked up by name later.** The kit's provisioning
finds resources by name, and that is how two apps with the same slug end up sharing one. Launch
always acts on the ids it recorded.

### Importing existing apps (phase 1)

Launch can register an app that already exists. The adapter reads its `.rocketflare.json` and
tomls through the GitHub API, matches the resource ids to the account, and records it. From then
on the app is in the catalogue with live health. An imported app can switch to Launch sign-in
later, and doesn't need to be re-provisioned.

## The launch pipeline

"Create app" starts the `APP_LAUNCH` **Cloudflare Workflow**:

- Each step is an idempotent `step.do` that records what it created in `app_operations` before
  moving on.
- A crash or retry resumes at the failed step.
- The Workflow can park on `step.waitForEvent` for an approval.

| # | Step | How |
|---|---|---|
| 0 | Approval (policy) | `app.create`, if the company requires it ([08](08-approvals-audit-ship.md)) |
| 1 | Reserve slug | Unique insert; reserved words refused |
| 2 | Create repo | GitHub App: create an empty private repo in the org (or `generate` from a template repo), plus team access |
| 3 | Scaffold | **Scaffold sandbox**: holds only a 1-hour token for this repo, and no model key. Runs `adapter.scaffold` (Rocketflare: clone the kit at the pinned tag → `rename.mjs` → default plugins), commits "Start from Rocketflare <tag>" and pushes to `main` |
| 4 | Neon | Org key: create a project `<slug>` (Postgres 17) and a `staging` branch; create a dedicated role per branch; build the **direct** (unpooled) connection strings, which Hyperdrive requires |
| 5 | Cloudflare resources | REST: Hyperdrive × 2 (one per environment's connection string), KV × 2, Queue × 2, R2 × 2, plus any resources `adapter.resources()` declares for plugins |
| 6 | Write config | `adapter.writeConfig` for both environments (ids, `APP_URL`, `EMAIL_FROM`, custom domain routes) → one commit through the Git Data API |
| 7 | Per-app deploy token | Mint an account token scoped to Workers `<slug>` and `<slug>-staging` |
| 8 | GitHub environments | Create `staging` and `production`; set `DATABASE_URL`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (sealed with the repo's public key); register Launch's **deployment protection rule** on `production` ([08](08-approvals-audit-ship.md)) |
| 9 | OIDC client | Register the client with redirect URIs for both hosts ([05](05-identity-sso.md)) |
| 10 | First deploy (staging) | `workflow_dispatch` on the deploy workflow with `environment=staging`; wait for completion through webhooks, with polling as a fallback. For Rocketflare, the deploy job runs migrations itself |
| 11 | Worker secrets | Set `OAUTH_ENCRYPTION_KEY` (generated), OIDC client id and secret, and `BOOTSTRAP_ADMIN_EMAILS` (the creator) on the now-existing Worker |
| 12 | Email | Create a Resend domain → write DNS records → verify in a **`step.sleep` loop** (minutes, not a blocking call) → mint a domain-bound sending key → set it as a Worker secret. A failure here doesn't block go-live; email falls back to "not configured" |
| 13 | Health | Poll `/api/health` and `/api/ready` on the staging URL |
| 14 | Production | Same as steps 10–13 for production, **if** the policy allows it at creation; otherwise it waits for the first release ([08](08-approvals-audit-ship.md)) |
| 15 | Live | Status `live`; notify the creator; audit event |

**Ordering note.** Worker secrets can only be set once the Worker exists, so they come after the
first deploy (step 11). The app has to boot without them. Rocketflare already does, because of its
zero-credential design: no email key means magic links are logged, and no AI key means AI returns
503.

**Failure and retry.** Each step's external ids are in `app_operations`, so a failed run can be
**resumed** (same Workflow, retry the step) or **rolled back** (the teardown Workflow walks the
recorded ids in reverse; see [10](10-fleet-operations.md)).

## Why not Workers Builds, and why Actions

Cloudflare Workers Builds can build from a connected repo, but its Git-connection API needs a
user-scoped token (account tokens aren't supported), and automating the connection was still an
open request as of September 2026. Every Rocketflare app already ships a GitHub Actions deploy
workflow with a gate, migrations and a release flow. Launch triggers and watches it, and has no
need to replace it.

## Known gaps

- No per-PR preview environments yet. The design supports them: a Neon branch per PR plus a
  Worker version preview URL. They are tracked in [10](10-fleet-operations.md).
- Scaffold depends on the kit's `rename.mjs` staying non-interactive. It is contract-tested by
  pinning the tag.
- No bring-your-own-repo for apps not built from a template. They can be imported, but not
  created.
