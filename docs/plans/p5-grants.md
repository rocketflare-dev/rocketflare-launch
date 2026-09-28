# P5 shared config and grants: implementation plan

This is the P5 build plan ([spec/09](../../spec/09-config-and-grants.md), [spec/11](../../spec/11-roadmap.md) P5, [spec/02](../../spec/02-template-contract.md) `declaredConfig`, [spec/03](../../spec/03-trust-and-credentials.md) "values Launch can't re-mint", [spec/12](../../spec/12-open-questions.md) #8, #9, #11, #16). It was checked against `phase-5-grants` at 1a8aa0c.

It follows the P1–P4 process: 5a runs first and alone, then 5b–5f in parallel with strict file ownership, everything against fakes, nothing deployed.

**Exit test:** an app that installs the M365 connector is prompted to request M365. The owner team approves it and the app works. One rotation updates every app that holds the grant.

"Catalogue" already means the apps list (`CataloguePage.tsx`, `/apps`), so the spec's catalogue is called **shared config** here: tables `shared_resource*`, routes `/api/shared-resources`, page `/shared-config`.

## 1. Decisions

1. **A shared resource is a named bundle of items.** Each item is `{key, kind: var|secret, description?, rotationDays?}` (M365: `M365_TENANT_ID` var, `M365_CLIENT_ID` var, `M365_CLIENT_SECRET` secret). It has an owner group (a kit `group`, required) and values per environment. Grants take the whole bundle (spec/12 #8). Why: one approval, one push and one rotation per credential set.
2. **Values are versioned per environment and sealed as one blob.** A `PUT` of values writes version N+1 for that environment: `encryptToken(cfg, JSON)` (`api/auth/oauth-encryption.ts`, the P1 `admin_credentials` pattern). A blank field keeps the previous version's value (decrypted and merged on the server). Why: Launch can't re-mint these values (spec/03), so it must keep them, and a version tells us exactly what each holder has.
3. **Values are write-only.** No route ever returns a secret. A var's value is returned only to the resource's owners and admins (it is not secret, and owners need to check a tenant id). Everyone else sees "set, version N, rotated <date> by <who>". Members can read the list, the item names and the policy, which is what they need to ask. Only owners and admins see who holds a resource.
4. **Granted vars are pushed as Worker secrets too, not through a PR.** This departs from spec/09. Why:
   - `uploadVersion` already sends `keep_bindings: ['secret_text']`, so secrets survive every deploy;
   - a `plain_text` var would be overwritten by the app's own toml on the next deploy;
   - a PR per rotation would add a merge, a release and a deploy.

   The code reads `env.M365_TENANT_ID` either way.
5. **The gateway drops toml vars that a grant shadows.** A plugin install writes its non-secret vars into both tomls (`scripts/lib/plugin-lib.mjs` `platformSummary`). A `plain_text` and a kept `secret_text` with the same name would clash. So `uploadDeploy` removes the `plain_text`/`json` bindings whose name is a key of a live grant for that app and environment, and records them as `shadowedVars` on the ticket and in `deploy.uploaded`. Why: the grant wins, and the app's repo needs no change.
6. **Activating a deploy re-pushes if its upload predates a push.** `keep_bindings` copies the secrets at upload time. A rotation that lands between `upload` and `activate` would be undone by activating. `activateDeploy` checks for a grant on that environment pushed after `ticket.uploaded_at`, and if it finds one, starts a `repair` push for that app and environment. Why: without this, a rotation silently reverts on one app.
7. **Grants are per app × resource × environment, with one approval each.** "Request M365" for staging and production opens two `grant.request` approvals (subject `grant`, the grant's id). Why: spec/09's "prod needs 2" is a per-environment policy, and the engine snapshots one policy per request.
8. **Approvers are the resource's owner group.** They come from the kind's `eligibleExtra`. The code default is `approvers: {appOwners: false, admins: false}`, N=1, 7 days, and both environments need approval (spec/12 #9). A resource may carry `policies: {staging?, production?}` (full `ApprovalPolicy` values), set by admins only (the P4 rule). Self-served staging is `autoApproveRole: 'member'` on the staging policy. Why: the team that owns the credential decides who holds it.
9. **Resolving the policy needs one small engine change.** `OpenApprovalInput` gains an optional `policy`, snapshotted in place of `resolvePolicy` when present. The grant service passes `resource.policies[env] ?? resolvePolicy(...)`, so any `approval_policies` rows for `grant.request` still apply below the resource's own. Why: `resolvePolicy` knows only app, group and tenant scopes.
10. **`GRANT_PUSH` is a Workflow** (`GrantPushWorkflow`, `launch-grant-push[-staging]`), shaped like `APP_LAUNCH`. One `grant_pushes` row is one push: `grant | rotate | revoke | expire | repair`, for a resource environment or a single grant.
    - **Steps:** `plan` materialises `grant_push_targets` (one per live grant, idempotent insert). Then `push#N` handles up to 10 targets per step. `finish` sets the status and the counts, and audits.
    - **Resumable:** a succeeded target is skipped, and so is a target whose grant already holds a newer version. Retry starts `<pushId>-rN`.
    - **Concurrency:** one running push per resource environment (a partial unique index); a second rotation gets 409 `push_in_progress`.
    - Why: resumable and idempotent per app and environment, following P2's `runStep` rules. Values are decrypted inside the step, never returned, and registered for redaction.
11. **The backing sits behind a seam** (spec/12 #11). `GrantBacking {put(script, entries), remove(script, names)}`:
    - `WorkerSecretsBacking` uses `CloudflareClient.putWorkerSecret`, plus a new `deleteWorkerSecret`, where a 404 counts as done;
    - `LocalGrantBacking` (`GRANT_BACKEND=local`, development only, refused elsewhere by `loadConfig`, like `SESSION_BACKEND`) records the names and calls no vendor.

    Secrets Store stays out: its GA status is still unclear, and it needs a toml binding per app.
12. **Rotation writes a new version and pushes to every holder.** When all targets succeed, the previous version is `retired` (audited), and resource owners get a notification: "revoke the old credential at the vendor". Launch can't do that. If a push is partial, the previous version stays `retiring`, the failed holders are listed, and a retry is offered.
13. **Revocation removes the secrets from the Worker.** The app's owners, the resource's owners or an admin may revoke. The status goes `revoking` → `revoked`, and the app answers 503 by the kit's convention. **Expiry** is optional per grant. The `grants.sweep` task (`*/5`) reminds the app's owners 7 days before, then expires the grant with an `expire` push. It also reminds the resource's owners when a secret's version is older than its `rotationDays`.
14. **Detecting declared needs is read-only and uses the adapter.** `rocketflare/declared-config.ts` implements spec/02's `declaredConfig`:
`launch.plugins.json` `surfaces[]` → each `anchor` (`plugin.json`) → `vars[]`, parsed as `plugin-lib.mjs` validates them (`{key|name, example?, secret?}` or a string), plus the kit's optional secrets (`ANTHROPIC_API_KEY`, `LANGFUSE_*`, …) as plugin `kit`.

    Keys are matched to resource items by exact name. A scan runs:
on import, on Release (at the new tag), on "Re-scan", and on session ship at the PR head (reported as a `ship.config_needs` event, never stored).

    When a matched resource that no environment holds appears, the app's owners are notified once (`grant_needed`). Why: spec/09's exit path goes through the kit's existing surface, and the kit doesn't change.
15. **Sessions never receive grant values** (spec/03). The sandbox runs on the kit's missing-config 503. Ship only tells the author that the PR needs M365, with a link to request it.
16. **`config.change` (an app's own config) stays unbuilt.** Why: it is not on the P5 exit path. It will reuse the push path in P6.

## 2. Schema and bindings

One migration: `pnpm db:generate --name launch-p5-grants` (0025). Every table below is a tenant table with `tenantIsolation()`. Status columns are text typed by shared closed sets, as P4 does.

### `shared_resources`

**Columns:** id, tenant_id, `slug` (unique per tenant), display_name, description, `owner_group_id` (FK groups, `restrict`), `items` jsonb (`sharedResourceItemSchema[]`), `policies` jsonb, created_by_user_id, archived_at, timestamps.

### `shared_resource_values`

**Columns:** id, tenant_id, resource_id (cascade), `environment` (`app_environment_name`), `version` int, `sealed` text, `status` (`active | retiring | retired`), set_by_user_id, set_at, retired_at.

**Indexes:**
- unique `(resource_id, environment, version)`;
- partial unique `(resource_id, environment) WHERE status='active'`.

### `app_grants`

**Columns:**
- id, tenant_id, app_id (cascade), resource_id (`restrict`), environment;
- `status` (`requested | active | revoking | revoked | rejected | expired`);
- approval_id (set null), requested_by_user_id, reason, expires_at, expiry_reminded_at;
- `pushed_version_id` (FK values), pushed_at, push_error, revoked_at, revoked_by_user_id, timestamps.

**Indexes:**
- partial unique `(app_id, resource_id, environment) WHERE status IN ('requested','active','revoking')`;
- `(tenant_id, resource_id, environment, status)`.

### `grant_pushes`

**Columns:** id, tenant_id, resource_id, environment, `reason`, `grant_id` (null = the whole environment), `version_id`, `approval_id` (unique where not null, so a retried `applyAfter` finds its push), `status` (`queued | running | succeeded | partial | failed`), total, succeeded, failed, instance_id, started_by_user_id, timestamps.

**Indexes:** partial unique `(resource_id, environment) WHERE status IN ('queued','running')`.

### `grant_push_targets`

**Columns:** id, tenant_id, push_id (cascade), grant_id, app_id, `status` (`pending | succeeded | failed | skipped`), attempts, error (scrubbed), `names` jsonb (the keys put or removed), finished_at.

**Indexes:** unique `(push_id, grant_id)`.

### `app_config_scans`

**Columns:** tenant_id, app_id (unique, cascade), ref, sha, scanned_at, `declared` jsonb `[{key, secret, pluginId, example?}]`, `needs` jsonb (the resource ids matched and not held), error.

### Bindings and settings

- **`[[workflows]]`:** `GRANT_PUSH_WORKFLOW` (`launch-grant-push[-staging]`, class `GrantPushWorkflow`) in both tomls, exported from `src/worker.ts`. A missing binding is 503 `grants_not_configured` before any row is written.
- **`[vars]`:** `GRANT_BACKEND = "cloudflare"` in both tomls, and `local` in `.dev.vars.example`.
- **Cron:** `grants.sweep` on `*/5`.
- **Unscoped allowlist:** `services/grants/sweep.ts`.

## 3. Slices

**Rule:** only 5a runs `db:generate` or edits the shared files:
- `packages/shared/*`, the `db/schema` index, `permissions`, `query-keys.ts`, `notificationLink.ts`;
- `api/index.ts`, `scheduled.ts`, `worker.ts`, both tomls, `config.ts`;
- `approvals/{types,engine}.ts`, `kinds/index.ts`;
- `cloudflare.ts`, `tests/helpers/fake-cloud/*`;
- `App.tsx`, `SideNav.tsx`, `apps/cli/src/cli.ts`.

A later slice that needs a change there stops and reports.

### 5a: foundations (runs first, alone)

**Schema:** as in §2, with `rls-coverage`, `schema-invariants` and `unscoped-allowlist` green.

**Contracts:** `packages/shared/src/launch-grants.ts`:
- the closed sets, `sharedResourceItemSchema`, the create/patch/values bodies, and the detail schema (per-environment value status, `holders?`, `canManage`, `canSetValues`);
- `appConfigSchema` (declared, matched, needs, grants per environment), `requestGrantSchema {resourceId, environments[], reason, expiresAt?}`, `grantPushSchema` (with its targets);
- the realtime entities `grant_push` and `app_config`, and the error codes.

**Other shared changes:**
- **`launch-approvals.ts`:** `grant.request` moves into `BUILT_APPROVAL_KINDS`, `grant` joins `APPROVAL_SUBJECT_TYPES`, and `grantRequestContextSchema {resourceId, resourceName, environment, items[{key, kind}], declaredBy[pluginIds], appSlug, expiresAt}` replaces the unbuilt stub. The `grant.request` default becomes §1.8.
- **`launch-sessions.ts`:** the `ship.config_needs` event.
- **Permissions:** the `SharedResource` subject (members read, admins manage). The owner group's rights are checked in the service.
- **Query keys and notification links:** keys `sharedResources.*`, `appConfig.*` and `grantPushes.*`; `notificationLink` cases `grant_needed`, `grant_push_failed`, `grant_expiring` and `grant_rotation_due`.

**Engine:** `OpenApprovalInput.policy?` (§1.9) in `approvals/types.ts` and `engine.open`. `kinds/grant-request.ts` is a stub handler, registered.

**Vendor:**
- `CloudflareClient.deleteWorkerSecret` and `listWorkerSecrets`;
- FakeCloud gains secret `DELETE` and list. A secret `PUT` or `DELETE` creates and deploys a new version, carrying the active version's bindings, as Cloudflare does. `cloud.cloudflare.envOf(script)` returns the active version's names and the secret values.

**Stubs:**
- `services/grants/*`, which throw `NotWiredError('…', '5x')`;
- `workflows/grant-push.ts`;
- `routes/shared-resources.ts` at `/api/shared-resources`;
- `routes/app-config.ts` on `appsRouter` before `/:slug`;
- `grants.sweep` as a no-op.

**Done when:** the gate is green and `GET /api/shared-resources` answers `{items: []}`.

### 5b: shared resources and values

**Owns:** `services/grants/{resources,values,access}.ts` and `routes/shared-resources.ts`.

**Routes:**
- `GET /` (members) and `POST /` (admins);
- `GET /:id` and `PATCH /:id`: owners edit the description and items; admins edit the owner group and the policies;
- `PUT /:id/values/:env` (owners and admins; `{values: {KEY: string}}`), which writes a new version. If the environment has holders, it starts a `rotate` push → 202 `{versionId, pushId}`;
- `DELETE /:id` (admins): archives, or 409 `resource_has_holders`.

**Access:** `access.ts` provides `isResourceOwner` (a member of the owner group) and `canSeeHolders`.

**Audit:** `shared_resource.created|updated|archived`, and `shared_resource.values.set {environment, version, keys, values: 'set'}`. No value ever appears in a summary.

**Tests:** `shared-resources.test.ts`: a sentinel secret is in no response, audit row or log; a blank field keeps the previous value; a member sees no holders or var values; an owner may not edit policies; tenant isolation.

### 5c: `GRANT_PUSH`, rotation, revocation and the sweep

**Owns:** `workflows/grant-push.ts`, `services/grants/{push,backing,revoke,sweep}.ts`, the `grants.sweep` task body, and the push routes in `routes/shared-resources.ts`: `GET /:id/pushes[/:pushId]` and `POST …/:pushId/retry`.

**Reuses:**
- `loadPipelineVendors` and `cloudflareClient` (`pipeline/context.ts`);
- the `putWorkerSecrets` redaction pattern (`pipeline/worker-secrets.ts`);
- `PIPELINE_STEP_CONFIG` and `LooseStep` (`workflows/app-launch.ts`);
- `withStepDatabase` (`workflows/agent-run.ts`);
- `recordAudit` and `notifyMany`.

**Workflow and pushes:**
- `startPush(db, env, {resourceId, environment, reason, grantId?, versionId, approvalId?})` inserts the row and creates the instance.
- **The script** comes from `app_environments.worker_name`. A missing one is a failed target, `app_has_no_worker`.
- **Audit:** per target, `grant.pushed` or `grant.revoked`, or `grant.push_failed`; per push, `grant.push.started|finished`.
- **Progress:** an `entity.changed {entity: 'grant_push'}` nudge per target.

**Tests:** `grant-push-workflow.test.ts`: a rotation reaches 3 holders (`envOf` shows the new secret); `failNext` on one app → `partial` → retry → `succeeded` with no second `PUT` for the rest; a second rotation is 409; revoke leaves no secret; expiry, the reminder, `rotationDays` due.

### 5d: the `grant.request` kind, the app's grants, and the gateway

**Owns:**
- `approvals/kinds/grant-request.ts`, `services/grants/{requests,holders}.ts`;
- `routes/app-config.ts`, except `/scan`;
- `deploy/gateway.ts` (`uploadDeploy` and `activateDeploy` only).

**The kind:**
- `eligibleExtra`: the members of the owner group;
- `applyInTx`: the grant goes `requested → active`, pending its push (`pushed_version_id` null), audited `grant.approved`;
- `applyAfter`: `startPush(reason 'grant', grantId, approvalId)`, idempotent by `approval_id`;
- `onClosed`: the grant goes `rejected` (or `expired`).

**Routes:**
- `GET /api/apps/:id/config` (app readers);
- `POST /api/apps/:id/grants` (app owners and admins): one grant plus one `engine.open` per environment → 202 `{grants: [{id, environment, approvalId, status}]}`;
- `DELETE …/grants/:gid` (revoke) and `POST …/grants/:gid/repush`.

**Gateway:** `holders.grantedKeys(db, tenantId, appId, env)` feeds the var drop (§1.5), and the repair check runs on `activate` (§1.6).

**Tests:**
- `grant-requests.test.ts`: the owner group decides and admins do not by default; a production policy with N=2; staging self-served under `autoApproveRole: 'member'`; the requester is excluded;
- `ci-deploy-grants.test.ts`: a shadowed var is dropped and recorded; a push between upload and activate triggers a repair.

### 5e: detection

**Owns:**
- `rocketflare/declared-config.ts` (plus the `declaredConfig` row in `adapter.ts`'s table) and `services/grants/detect.ts`;
- the `POST /api/apps/:id/config/scan` handler;
- the scan calls added after commit in `import.ts` (`importApp`), `releases/release.ts` (`createRelease`, at the tag) and `sessions/ship.ts` (after `openPullRequest`).

**Reuses:** `withRepoToken(…, {contents: 'read'})` (`releases/github.ts`) and `getRepoFile` (`github-app.ts`).

**Behaviour:** a scan failure is recorded on `app_config_scans.error`; it never fails an import, a Release or a ship.

**Tests:**
- `declared-config.test.ts`: string and object vars, `secret` flags, a missing anchor, the kit's optional secrets;
- `grant-detect.test.ts`: a match, notifying once, no notification when already held, and the ship event.

**Fixture:** `tests/fixtures/plugins/m365-connector/plugin.json` (the two vars and the secret).

### 5f: UI and CLI

**Owns:**
- `ui/pages/shared-config/{SharedConfigPage,SharedResourcePage}.tsx` and `components/{ValuesModal,HoldersTable,PushProgress,ResourcePolicyForm}.tsx`;
- `ui/pages/apps/AppConfigPage.tsx` (`/apps/:slug/config`) and `components/ConfigCard.tsx` (on `AppDetailPage`);
- `ui/hooks/{useSharedResources,useAppConfig}.ts`;
- the `grant.request` renderer in `approvals/components/ApprovalContext.tsx`;
- the needs line in `sessions/components/ShipPanel.tsx`;
- `apps/cli/src/commands/{shared,grants}.ts`.

**Behaviour:**
- **The values form** uses `type=password` inputs that are never pre-filled; "blank keeps current"; and "Use the same values for staging".
- **Config page:** the declared keys grouped by plugin. Each matched resource shows a per-environment status with a Request button (reason and environments) and the pending approval's link. Keys that match no resource are shown with the hint "ask an admin to add it".
- **Push progress:** an N/M bar and the failed apps with Retry, driven by the realtime nudge and a poll only while running.
- **CLI:**
  - `launch shared ls|show|set <slug> --env` (values from a hidden TTY prompt or stdin, never argv);
  - `launch shared pushes <slug> [--wait]`;
  - `launch grants needs|ls|request|revoke <app>`.

**Tests:** `tests/ui/{shared-config,app-config}.test.tsx` (no value is ever rendered; the request flow), `approvals-inbox` for the grant context, and the CLI tests.

## 4. Local end-to-end

**Automated:** `tests/api/grants-e2e.test.ts` (`// @vitest-isolate`), with FakeCloud as the global fetch and the helpers `launch-pipeline.ts`, `deploy-gateway.ts` and a new `tests/helpers/grants.ts`:
- `seedM365(cloud)`: a resource owned by the "IT Identity" group (carol), with staging and production values;
- `installM365(cloud, owner, repo)`: pushes `launch.plugins.json` plus the fixture's `plugin.json`, and the M365 vars into both tomls;
- `m365Host(cloud, host)`: an `onHost` handler standing in for the connector plugin. `GET /api/connectors/m365/status` answers 503 unless `envOf(script)` has all three keys. Otherwise it exchanges the client credentials at `login.microsoftonline.com` (a second `onHost` that accepts only the currently valid secret) and answers 200.

**Setup:** alice owns `shop` and `crm`, and both are launched through `LaunchHarness`.

1. `installM365` on `shop`, then alice cuts a Release. The scan finds the three keys, alice gets a `grant_needed` notification, and `/config` shows M365 as needed for both environments. `status` is 503.
2. Alice requests M365 for staging and production. Two approvals open, and carol is notified, not the admins.
3. Carol approves both. `GRANT_PUSH` runs, and `envOf('shop-staging')` holds the three keys. `status` is 200 on both hosts.
4. The staging deploy of the release runs through the gateway. The toml's `M365_TENANT_ID` var is dropped (`shadowedVars`), the secrets survive, and `status` is still 200.
5. `crm` gets the grant the same way.
6. Carol rotates the production secret. One push reaches `shop` and `crm`, the old version becomes `retired`, "Azure" revokes the old secret, and both apps are still 200.
7. Alice revokes `crm` production. The secrets are gone and `status` is 503.
8. `audit.seal` runs, then verify.

**Assertions:** no secret in any response, audit row, `grant_push_targets` row or log line (a sentinel search); every grant's audit rows carry `approval_id`.

**Variants:** reject; expiry via the sweep; one target failing, then retry; a rotation between upload and activate, caught by the repair.

**Browser pass:** `pnpm dev` with `GRANT_BACKEND=local`, two dev-login users. Create the resource, set values (nothing is echoed back), import a repo carrying the connector, check the Config page, then request → the inbox → approve → watch the push progress → rotate → revoke.

## 5. What is left for real infrastructure

1. **Cloudflare:**
   - each secret `PUT` or `DELETE` creates and deploys a version, so a three-item push is three versions (a mixed state lasting seconds, which is a known gap);
   - its behaviour while a gradual deployment is in progress;
   - the per-script version count and rate limits across a fleet-wide rotation;
   - whether an upload with `keep_bindings` copies the secrets as of the upload (which is what §1.6 assumes).
2. **Imported apps:** their Workers must be in Launch's account with a recorded `worker_name`. An app still deploying with its own `wrangler deploy` must remove the shadowed vars from its toml itself, or the deploy fails on a binding-name clash.
3. **Secrets Store:** re-check GA and the per-account limits before adding a `SecretsStoreBacking`.
4. **The exit run on staging:** a real app installs the connector through a session → merge → Release → request → the owner team approves → real Entra credentials work → rotate in Entra and in Launch → every holder keeps working → revoke the old secret.
