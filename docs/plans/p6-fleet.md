# P6 fleet operations: implementation plan

This is the P6 build plan ([spec/10](../../spec/10-fleet-operations.md), [spec/11](../../spec/11-roadmap.md) P6, [spec/02](../../spec/02-template-contract.md) `upgradePrompt`, [spec/08](../../spec/08-approvals-audit-ship.md) `app.teardown`, [spec/12](../../spec/12-open-questions.md) #10, #12, #19). It was checked against `phase-5-grants` at 7370ec0 and the kit's `rf-upgrade` skill and `scripts/upgrade.mjs` at 0.15.0.

It follows the P1–P5 process: 6a runs first and alone, then 6b–6g in parallel with strict file ownership, everything against fakes, nothing deployed.

**Exit test** (spec/11): "upgrade all" opens upgrade PRs across the fleet. An archived app leaves no Cloudflare resources behind.

**Scope against spec/10.** spec/11 P6 names five things; spec/10 also has "Health and status". All six are here, with these differences:
- **Health** is mostly P1 (§18.4). P6 adds only what is missing: an alert after N failed probes and the catalogue's fleet columns. GitHub deploy webhooks stay unbuilt (Open question 4).
- **"Teardown at scale"** is not in spec/10, which scopes one app at a time behind an approval. P6 builds that and no bulk archive.
- **Credential rotation** of minted credentials is in spec/11 P6. Shared grant values rotated in P5.
- **Out of scope:** `config.change` (P5 §1.16 deferred it here, but no spec/10 item needs it), the SIEM stream (§18.1 gap), fleet-wide policy checks (a spec/10 gap), and a cross-organisation operator view.

**Where things live.** Launch stays single-tenant (spec/01). `admin_credentials` and `launch_settings` stay deployment-wide, and every vendor call goes through `loadPipelineVendors(db, cfg)` (`pipeline/context.ts`) as today. The fleet pages are in the organisation's UI for its owner and admins (`/fleet`, Settings → Fleet), not `/admin`. We assume the admin collapse lands first (the setup wizard moves into the tenant's Settings, where the tenant admin is the admin). P6 touches the wizard only for one new Cloudflare probe (§1.13).

## 1. Decisions

### Upgrades

1. **The fleet's target is the template pin.** An app has an upgrade available when `apps.template_version` is semver-below `launch_settings.template_pin.tag`: the kit every new app is cut from, which an admin already sets. Launch never chases the kit's latest release. Moving the pin is the admin's "we are on 0.16 now". Release notes come from `getReleaseByTag` on the pin's repo. Why: one version the admin chose, not one per app. Plugins follow the same rule: an installed plugin (`launch.plugins.json` `plugins[]`) is behind when its version is below the source repo's latest release tag. Plugins are detected and upgraded one plugin at a time.
2. **An upgrade is a coding session with a kickoff message and auto-ship.** `createSession` gains `kind: 'upgrade'` (`SESSION_KINDS` + the pgEnum, append only), `upgrade_id` and `auto_ship`, and it inserts the row with `pending_message` = `adapter.upgradePrompt(from, to)`. A message waiting on the row already runs as soon as the session is `ready` (§18.9). After that turn, `inspectStep` requests `ship` when `auto_ship` is set and the turn ended cleanly. Ship's gate and PR flow are unchanged (§18.13), so the PR is proven by Launch's own gate run, then by the app's CI.
   - A red gate, a turn that ends with a question (rf-upgrade stops at `AskUserQuestion` and at exit 6), or a budget stop leaves the session `ready` or `blocked` and marks the upgrade `needs_attention`. The owner finishes it in the normal session page.
   - Why: spec/10 step 3, reusing all of P3.
3. **The upgrade prompt** is `rocketflare/upgrade-prompt.ts` (the `upgradePrompt` row in `adapter.ts`'s table):
   - kit: `/rf-upgrade --to <tag>`, answering its hand-back by shipping when the gate is green;
   - plugin: `pnpm plugin upgrade <id> --apply`.
   
   The prompt also sets the unattended rules on top of the skill's own: never `--force`, never apply a kit deletion, never recreate an absent surface. When any of these comes up, stop and explain.
4. **The git proxy lets an upgrade session fetch the kit read-only.** `scripts/upgrade.mjs` fetches `kit.repo` into `.upgrade/kit.git` over `github.com`, and `egress/github.ts` today refuses every repo but the session's own. For `kind = 'upgrade'` only, it also allows `info/refs?service=git-upload-pack` and `POST …/git-upload-pack` on the pin's repo and on the upgrading plugin's `source.repo`, with no token injected (they are public). Pushes stay as they are. Why: least privilege; a normal session gains nothing.
5. **"Upgrade all" is a fleet run, throttled by a cron.** `POST /api/fleet/upgrades {target, appIds?}` (admins; an owner upgrades one app from its page) writes one `fleet_runs` row and one `app_upgrades` row per eligible app. Nothing starts inline. `fleet.tick` (`*/5`) starts queued upgrades up to `fleet_policy.upgradeConcurrency` (default 3) running sessions across the organisation, skipping an app at `maxConcurrentPerApp` or out of budget (it stays `queued`, with the reason recorded). It also advances each upgrade from its session (`shipped` → `pr_open`, `failed`, …). Merge detection comes from `sessions.checks` (§18.17 `pr.merged`), and the version comes from item 6. Sessions are created in the admin's name.
   - **Eligible:** created or imported with a repo, not archived, behind the target, and no open upgrade for the same target (a partial unique index).
   - **No approval to open PRs.** Shipping goes through Release → Promote → `deploy.production` as usual (Open question 3).
6. **The template version is re-read at each Release.** P5's Release hook (`releases/release.ts`) already reads the repo at the new tag for `scanAppConfig`. It also re-reads `.rocketflare.json` (`parseManifest`) and `launch.plugins.json`, updates `apps.template_version` and `apps.plugin_versions`, and settles a matching `pr_open`/`merged` upgrade as `released`. Why: the version only counts once it deploys. `rf-upgrade` writes `kit.version` last, and only after a clean apply.
7. **An upgrade that adds a binding fails loudly.** `rf-upgrade` leaves a new binding's `<PLACEHOLDER>` for `pnpm provision`, and the gateway refuses unknown bindings (§18.7). Launch does not provision mid-fleet. The upgrade's ship runs `scaffoldProblems`-style toml checks at the PR head (`rocketflare/toml.ts` `resources`) and marks it `needs_attention` with the binding named. Provisioning new kinds is a later adapter version (spec/02 `contractVersion`).

### Teardown

8. **Teardown is an `app.teardown` approval.** `POST /api/apps/:id/teardown {confirmSlug, mode: 'archive'|'delete', deleteRepo?, reason?}` (`manage App`) opens the kind (subject `app`). It keeps the default policy already in `DEFAULT_APPROVAL_POLICIES`: owners + admins, N=1, not self, 7 days. `applyAfter` calls today's `startTeardown`, which is idempotent by `approval_id` on the run's first `app_operations` row. The `app.teardown` context (replacing `unbuiltContext`) carries the mode, the live resources (from `gatherLaunchIds`), and the live grants, sessions and previews that will end. `onClosed` does nothing (the app stays as it was).
9. **Archive and Delete differ only in Neon and the repo** (spec/10).
   - **Archive:** delete everything else, keep the Neon project, archive the repo.
   - **Delete:** the same, then after `teardown_policy.deleteRetentionDays` (default 30) a `purge` run deletes the Neon project (and the repo, if `deleteRepo`) and moves the app to `deleted` (`APP_STATUSES`, append only). `apps.purge_after` is set by the teardown. `teardown.sweep` (`0 4 * * *`) starts due purges on the same `APP_TEARDOWN_WORKFLOW` with `params.mode = 'purge'`. The run kind is `purge` (`PIPELINE_KINDS`; `app_operations.kind` is text).
   - An admin may "Delete permanently" an archived app later, which is a new `app.teardown` with `mode: 'delete'` that only schedules the purge.
10. **The Workflow gains a `quiesce` step first and a `verify` step last.**
    - **`quiesce`:**
      - end every active session (`requestAction(end)` + wake; the session's own `cleanup` deletes its Neon branch);
      - cancel the app's pending approvals (engine `cancel`, system actor), except the teardown's own;
      - move live grants to `revoked` with reason `app_archived`, with no push (the Worker is about to go);
      - close open previews (§1.17);
      - reject pending deploy tickets.
    - **`dev_branch`:** delete `apps.session_db`'s branch, which matters once the project is kept.
    - **`verify`:** lists the account's scripts, KV, queues, R2 buckets and zone routes (`CloudflareClient.list*`, plus `listWorkerRoutes`), and records on the step every one whose name `names.ts` `appResourceNames(slug)` claims. A leftover fails the step, and so the run: `app.teardown_failed` with the names. It deletes nothing by name (spec/06), so the fix is a human's.
    - Why: "leaves no Cloudflare resources behind" becomes a checked fact, not a hope.
11. **Imported apps are unchanged.** Their teardown still only disables sign-in (§18.8). The approval context says so. `verify` runs for them too and reports without failing.

### Rotation

12. **`APP_ROTATE_WORKFLOW` rotates the credentials Launch minted, with overlap.** It is `AppRotateWorkflow` (`launch-app-rotate[-staging]`), with one run per app × environment, its steps in `app_operations` (kind `rotate`) through `runStep`. The steps are mint → record → push → wait → retire. `credential_rotations` holds each credential's state, and `retire` runs no earlier than `rotation_policy.graceMinutes` (default 60) after the push. The three kinds:
    - **`neon_app`:** create role `app_b` (or `app`, alternating), `GRANT migrator TO` it over the HTTP SQL endpoint as `neondb_owner` (the `provisionNeon` pattern), then put `DATABASE_URL` on the Worker. At retire, drop the old role. There is no reset-in-place, because a reset breaks every new connection until the secret lands. `app_environments.neon.appRole` records the live role.
    - **`resend_key`:** `createSendingKey`, put `RESEND_API_KEY`, then at retire `deleteApiKey(old)`. The new id is recorded before the push, so a retry never mints twice.
    - **`oidc_secret`:** `oidc_clients` gains `previous_secret_hash` and `previous_secret_expires_at`, and `clientSecretMatches` (`services/oidc/tokens.ts`) accepts either until expiry. Launch mints the secret, puts `OIDC_CLIENT_SECRET` on both Workers (one secret per client, as in `worker_secrets`), then clears the previous hash at retire.
    - **Never** `OAUTH_ENCRYPTION_KEY`.
    - Pushes use `WorkerSecretsBacking.put` (`grants/backing.ts`), which also settles the 10053 clash.
    - **The race with a deploy** is P5 §1.6 again: `keep_bindings` copies secrets as of the upload. The gateway's `activateDeploy` starts a `repair` rotate step when a rotation pushed after `ticket.uploaded_at`. `retire` refuses while any ticket for that environment uploaded before the push is still unactivated, and waits for the next sweep.
    - **Created apps only.** An imported app's secrets were set by hand.
13. **The schedule** is `rotation_policy {neonAppDays: 90, resendKeyDays: 180, oidcSecretDays: 180, graceMinutes: 60}`. `rotation.sweep` (`*/5`) starts due rotations (at most 5 per tick, staging before production) and retires those past their grace. Owners and admins can also start one by hand: `POST /api/apps/:id/rotate {kinds[], environment}`.

### Cost

14. **Cost is a daily estimate per app, collected by a job.** `cost.collect` (a `JOBS_QUEUE` job, enqueued by the `0 4 * * *` cron for yesterday, and by "Refresh") writes `app_cost_daily`, upserting by `(app_id, day, source, metric)`. The sources:
    - **model:** `sum(ai_usage.cost_microcents)` joined to `sessions` by `session_id`, per app;
    - **container:** `sessions.container_seconds` × `cost_rates.containerUsdPerHour`, attributed to the day the session ended;
    - **neon:** on a Scale plan or above, Neon's consumption history per project (`GET /consumption_history/projects`). Otherwise, the project's own period counters (`GET /projects/:id`: compute seconds, storage bytes-hour), differenced day to day. Both are priced by `cost_rates`;
    - **workers:** the Cloudflare GraphQL Analytics `workersInvocationsAdaptive` (requests, `cpuTimeP50`/sum) per `worker_name`, priced by `cost_rates`.
    
    The rates are admin-set, with defaults from the public price lists. Every figure is labelled an estimate (spec/10: "not billing").
15. **Who sees cost.** `GET /api/costs?from&to&groupBy=app|team` returns every app to admins, and to anyone else the apps they own. `GET /api/apps/:id/costs` is for the app's readers. Teams are the app's `owner_group_id`. Only tenant rows are read.

### Previews

16. **Per-PR previews are opt-in per app** (`apps.previews_enabled`, owners), off by default (spec/10 "later"; Open question 2). Enabling one commits `.github/workflows/launch-preview.yml` (`rocketflare/preview-job.ts`) to the default branch through `commitFiles`. On `pull_request` (opened, synchronize), it runs the kit's own build and `scripts/deployer.mjs start` → `upload`, never `activate`.
17. **The gateway has a preview purpose.** `CI_TICKET_PURPOSES` gains `preview`, and `deploy_tickets.preview_id` points at `app_previews`.
    - **The caller** (`ci/caller.ts`): for `workflowFile: 'launch-preview.yml'` only, it accepts `ref = refs/pull/<n>/merge` and defaults the environment to `staging`.
    - **`startDeploy`** finds or creates the `app_previews` row for the PR. It refuses with `preview_branch_budget` (spec/12 #19) when the app's live previews plus its active sessions would pass `preview_policy.neonBranchBudget` (default 10, less the 3 standing branches). Otherwise it creates a Neon branch `pr-<n>` from `staging`.
    - **`uploadDeploy`** passes the same `binding-check`. It returns a `migratorUrl` for the preview branch (`issueMigratorUrl`) and uploads the version to the staging script with its own `secret_text` `DATABASE_URL` (the branch's `app` URI), the `APP_URL` var set to the preview URL, and the annotation `workers/alias = pr-<n>`. It never deploys the version.
    - **`finish`** marks the preview `ready`, registers the preview URL's callback on the app's OIDC client (`updateAppRedirectUris`), and comments the link on the PR (`createIssueComment`, new in `github-app.ts`).
    - **`previews.sweep`** (`*/5`) reads each live preview's PR (`getPullRequest`). On closed, or `preview_policy.ttlDays` without a push, it deletes the branch and the redirect URI and closes the row. Versions are not deletable on Cloudflare and simply age out.

### Health, the catalogue, and the platform

18. **Health alerts after N failures.** `app_environments.health_failures` counts consecutive non-`up` probes. At `health_policy.alertAfterFailures` (default 3), the app's owners get `app_health_alert` (in-app and email, once until recovery), and recovery sends `app_health_recovered`. The catalogue's `appSummarySchema` gains `fleet`: open upgrade, active sessions, pending approvals, live grants, and live previews. These are counts from one grouped query each, not per app.
19. **Reused, not reinvented:** the approvals engine (`app.teardown`), `recordAudit` and the chain, `runStep`/`app_operations` (rotate and purge runs), `gatherLaunchIds` and the `CLOUDFLARE_DELETIONS` table, sessions (upgrades), `WorkerSecretsBacking` (rotation pushes), the deploy gateway and `issueMigratorUrl` (previews), `sessions.checks` (merge detection), `notifyMany` and `email.send`, `entity.changed` nudges, `loadPipelineVendors`.

## 2. Schema and bindings

**Migration:** one, from `pnpm db:generate --name launch-p6-fleet` (0027). Every new table is a tenant table with `tenantIsolation()`, and its status columns are text typed by shared closed sets.

### `fleet_runs`

- **Columns:** id, tenant_id, `kind` (`upgrade`), `target` jsonb `{kind: kit|plugin, pluginId?, toVersion}`, `status` (`running | finished | cancelled`), total, succeeded, failed, skipped, started_by_user_id, timestamps.

### `app_upgrades`

- **Columns:** id, tenant_id, app_id (cascade), fleet_run_id (set null), `target_kind`, plugin_id, from_version, to_version, `status` (`queued | running | pr_open | needs_attention | released | failed | cancelled`), session_id (set null), pr_number, pr_url, wait_reason, error, requested_by_user_id, timestamps.
- **Indexes:** partial unique `(app_id, target_kind, coalesce(plugin_id,''))` over the open statuses.

### `credential_rotations`

- **Columns:** id, tenant_id, app_id (cascade), environment, `kind` (`neon_app | resend_key | oidc_secret`), `status` (`running | pushed | retired | failed`), run_id, `old_ref`/`new_ref` (a role name or key id, never a secret), pushed_at, retire_after, retired_at, error, timestamps.
- **Indexes:** partial unique `(app_id, environment, kind) WHERE status IN ('running','pushed')`.

### `app_cost_daily`

- **Columns:** tenant_id, app_id (cascade), `day` date, `source` (`model | container | neon | workers`), `metric`, `quantity` numeric, `estimated_microcents` bigint, collected_at.
- **Keys:** PK `(app_id, day, source, metric)`.

### `app_previews`

- **Columns:** id, tenant_id, app_id (cascade), pr_number, head_sha, `status` (`building | ready | failed | closed`), neon_branch_id, cf_version_id, preview_url, last_ticket_id, error, opened_at, closed_at.
- **Indexes:** partial unique `(app_id, pr_number) WHERE status <> 'closed'`.

### Columns on existing tables

- **`apps`:** `purge_after`, `teardown_mode`, `plugin_versions` jsonb, `previews_enabled`, and `deleted` added to `app_status`.
- **`sessions`:** `upgrade_id`, `auto_ship`, and `upgrade` added to `session_kind`.
- **`deploy_tickets`:** `preview_id`, and `preview` added to `ci_ticket_purpose`.
- **`oidc_clients`:** `previous_secret_hash`, `previous_secret_expires_at`.
- **`app_environments`:** `health_failures`, `health_alerted_at`.

### Settings

`launch_settings` keys: `fleet_policy`, `rotation_policy`, `teardown_policy`, `preview_policy`, `cost_rates`, `health_policy`. Each is a zod schema with defaults in `launch-setup.ts`.

### Bindings

- **`[[workflows]]`:** `APP_ROTATE_WORKFLOW` in both tomls, exported from `src/worker.ts`. A missing binding answers 503 `rotation_not_configured`.
- **Crons:** no new expressions.
  - `*/5`: `fleetTick`, `rotationSweep`, `previewsSweep` (before `auditSeal`);
  - `0 4 * * *`: `teardownSweep`, `costEnqueue`.
- **Unscoped allowlist:** none. Every task iterates tenants the way `healthPoll` does.

## 3. Slices

**Rule:** only 6a runs `db:generate` or edits the shared files. A later slice that needs a change there stops and reports. The shared files are:
- `packages/shared/*`, the `db/schema` index, `permissions`, `query-keys.ts`, `notificationLink.ts`;
- `api/index.ts`, `scheduled.ts`, `worker.ts`, both tomls, `config.ts`;
- `approvals/kinds/index.ts`, `rocketflare/adapter.ts`;
- `cloudflare.ts`, `neon.ts`, `github-app.ts`, `tests/helpers/fake-cloud/*`, `tests/helpers/fake-sandbox.ts`;
- `App.tsx`, `SideNav.tsx`, `apps/cli/src/cli.ts`.

### 6a: foundations (runs first, alone)

**Schema:** as in §2, with `rls-coverage`, `schema-invariants` and `unscoped-allowlist` green.

**Contracts:**
- **`packages/shared/src/launch-fleet.ts`:** the closed sets; the upgrade, fleet run, rotation, cost and preview schemas; the request bodies (`startFleetUpgradeSchema`, `rotateRequestSchema`, `costQuerySchema`); the realtime entities `fleet_run`, `app_upgrade` and `rotation`; the error codes.
- **`launch-approvals.ts`:** `app.teardown` moves to `BUILT_APPROVAL_KINDS` with `appTeardownContextSchema`.
- **`launch-pipeline.ts`:** the teardown request gains `mode`, the `purge`/`rotate` kinds, `APP_ROTATE_STEPS`, and the teardown's `quiesce`, `dev_branch` and `verify` steps.
- **`launch-sessions.ts`:** `upgrade`.
- **`launch-apps.ts`:** the `fleet` summary block.
- **Query keys and notification links:** `appUpgradeNeeds` and `app_health_alert|recovered`, `upgrade_needs_attention`, `rotation_failed`, `teardown_leftovers`.

**Vendor, each with its FakeCloud half:**
- **`cloudflare.ts`:** `workerAnalytics(accountId, scripts, day)` (GraphQL; the fake returns seeded numbers), and `uploadVersion` annotations (`workers/alias`, with the fake recording the alias and serving `pr-<n>-<script>.<sub>.workers.dev` through `onHost`).
- **`neon.ts`:** `deleteRole` and `consumption` (the fake counts compute seconds per project); `createBranch` from a named parent already exists.
- **`github-app.ts`:** `createIssueComment` and `listReleases`.
- **FakeGitHub:** `upload-pack` on a second, public repo; the kit at two tags.
- **FakeSandbox:** an `upgradeScript` that edits `.rocketflare.json` to the target tag.

**Stubs:**
- `services/fleet/{upgrades,fleet-run,tick}.ts`, `services/launch/rotation/*`, `services/costs/*`, `services/launch/previews/*` throw `NotWiredError('…','6x')`;
- `workflows/app-rotate.ts`, `approvals/kinds/app-teardown.ts` and `rocketflare/{upgrade-prompt,preview-job}.ts` exist as stubs;
- the routes are mounted: `routes/fleet.ts` (`/api/fleet`), `routes/costs.ts` (`/api/costs`), `routes/app-fleet.ts` (on `appsRouter` before `/:slug`);
- the cron tasks are no-ops.

**Done when:** the gate is green and `GET /api/fleet/upgrades` answers `{items: []}`.

### 6b: teardown behind an approval

**Owns:** `approvals/kinds/app-teardown.ts`, `pipeline/{create,teardown-steps}.ts` (the teardown half), `workflows/app-teardown.ts`, `services/launch/teardown-sweep.ts`, the `/:id/teardown` handler in `routes/app-pipeline.ts`.

**Behaviour:** §1.8–1.11.
- `quiesce` calls `sessions/lifecycle.requestAction`, `approvals/engine.cancel` and the `grants/revoke` status write (no push). The P5 revoke path gains a `skipPush` input, owned here.
- `verify` uses `names.ts`.

**Tests:**
- `app-teardown-approval.test.ts`: an owner asks and a second owner approves; self-approval is refused; the imported-app context.
- `teardown-e2e.test.ts` (FakeCloud):
  - archive leaves `resourcesFor(slug)` with only the Neon project;
  - a planted leftover script fails `verify` by name;
  - delete plus the sweep past retention purges Neon, and the app is `deleted`;
  - the session, grants and approvals are closed;
  - retry `-rN`.

### 6c: fleet upgrades

**Status: the single-app half is built** (`docs/CONCEPTS.md` §18.23): `app_upgrades` (without
`fleet_run_id` and `wait_reason`, which the fleet half adds), `sessions.upgrade_id` / `auto_ship` and
the `upgrade` session kind, `POST /api/apps/:id/upgrade` (in `routes/app-upgrades.ts`, with
`GET /:id/upgrades`), `rocketflare/upgrade-prompt.ts`, auto-ship in `sessions/steps.ts`, the
read-only kit fetch in `sessions/egress/`, the manifest re-read in `releases/release.ts`, the
"Requires upgrade" kit status on the app summary, the app page's Kit section and `launch apps
show|upgrade`. Still open: "Upgrade all" — `fleet_runs`, `routes/fleet.ts`, `services/fleet/*`,
`fleet.tick`, the `queued` path, plugin upgrades, the fleet page — and item 7 (a new binding).
Item 4's plugin `source.repo` allowance waits for plugin upgrades.

**Owns:** `services/fleet/*`, `routes/fleet.ts`, the upgrade routes in `routes/app-fleet.ts`, `rocketflare/upgrade-prompt.ts`, the `upgrade`/`auto_ship` paths in `sessions/{lifecycle,steps}.ts`, the upload-pack allowance in `sessions/egress/github.ts`, the manifest re-read in `releases/release.ts`.

**Routes:**
- `GET /api/fleet/upgrades` (the target, per-app state, release notes);
- `POST /api/fleet/upgrades` (admins) → 202 `{runId}`;
- `GET /api/fleet/runs/:id`;
- `POST …/runs/:id/cancel` (dequeues `queued` rows; running sessions are left to finish);
- `POST /api/apps/:id/upgrade` (owners) → 202 `{upgradeId}`.

**Audit:** `fleet.upgrade.started|finished`, and `app.upgrade.queued|started|pr_opened|released|failed`.

**Tests:**
- `fleet-upgrade.test.ts`: eligibility (archived, current and already-open apps are skipped); concurrency 2 over 5 apps; a budget-exhausted app waits; `needs_attention` on a red gate and on an ending question; cancel.
- `upgrade-egress.test.ts`: the kit's upload-pack is allowed for an upgrade session only, and a push to it is refused.

### 6d: credential rotation

**Owns:** `services/launch/rotation/*`, `workflows/app-rotate.ts`, the `previous_secret` check in `services/oidc/tokens.ts` (`clientSecretMatches` only), the rotate-repair call in `deploy/gateway.ts` `activateDeploy` (one hunk, marked for 6f), `POST /api/apps/:id/rotate` in `routes/app-fleet.ts`.

**Audit:** `credential.rotation.started|pushed|retired|failed`; summaries carry refs, never values.

**Tests:** `app-rotate.test.ts`:
- each kind end to end on FakeCloud: `envOf` changes, the old role, key or hash works until retire, then fails;
- the deploy race: a repair, and retire waits;
- a sentinel secret appears in no step result, row or log;
- `OAUTH_ENCRYPTION_KEY` is never touched;
- imported apps are refused.

### 6e: cost view and fleet status

**Owns:** `services/costs/*`, `queues/handlers/cost-collect.ts`, `routes/costs.ts`, `GET /api/apps/:id/costs`, the `health_failures` alert in `services/launch/health.ts`, the `fleet` block in `services/launch/apps.ts`, and the setup wizard's Analytics Read probe.

**Tests:**
- `cost-collect.test.ts`: every source on seeded rows and the fake, the Scale fallback, idempotent re-collection, owner vs admin visibility, and tenant isolation;
- `health-alert.test.ts`: 3 failures notify once, and recovery notifies.

### 6f: per-PR previews

**Owns:** `services/launch/previews/*`, `rocketflare/preview-job.ts`, the preview branches in `deploy/gateway.ts` (`startDeploy`, `uploadDeploy`, `finishDeploy`) and `ci/caller.ts`, the `previews_enabled` toggle route, and the `previewsSweep` body.

**Tests:** `ci-deploy-preview.test.ts` through the real `scripts/deployer.mjs`:
- the PR ref is accepted only for `launch-preview.yml`;
- no deployment is created, and the alias host serves the version;
- the migrator URL targets the preview branch;
- the budget is refused;
- close → branch and redirect URI gone;
- a second push reuses the row.

### 6g: UI and CLI

**Owns:**
- `ui/pages/fleet/{FleetPage,FleetRunPage}.tsx` (the Upgrades and Costs tabs), `components/{UpgradeTable,CostChart,CostTable}.tsx`;
- `ui/pages/settings/Fleet.tsx` (the six policies and the cost rates, admins);
- on the app page: `UpgradeCard`, `CostCard`, `PreviewsCard`, `RotationCard`, and the reworked `TeardownModal` (mode, what will end, → the approval);
- the `app.teardown` renderer in `ApprovalContext.tsx`;
- the catalogue's fleet columns in `CataloguePage.tsx`;
- `ui/hooks/{useFleet,useCosts}.ts`;
- `apps/cli/src/commands/{fleet,costs}.ts`: `launch fleet upgrades|upgrade [--all] [--wait]|runs`, `launch costs [--by team] [--from]`, `launch apps rotate|archive`.

**Tests:** `tests/ui/{fleet,costs,teardown}.test.tsx` and the CLI tests.

## 4. Integration pass

A worker merges 6b–6g in order: b, d, f (the gateway hunks), c, e, g. It resolves the `gateway.ts` hunks (6d's `activateDeploy` versus 6f's start, upload and finish, which touch different functions), wires the real bodies behind the 6a stubs, and runs the gate. Then CONCEPTS gets §18.21 (fleet upgrades), §18.8 rewritten (teardown), §18.22 (rotation), §18.23 (cost and previews), and §18.4's health gaps updated. SETUP/DEPLOY get the new workflow binding and the Analytics Read permission. There is a CHANGELOG line, and the plans README moves P6 to Built.

## 5. Exit test

`tests/api/fleet-e2e.test.ts` (`// @vitest-isolate`), with FakeCloud as the global fetch, `LaunchHarness`, FakeSandbox and the fake Anthropic.

1. **Setup:** three apps (`shop`, `crm`, `wiki`) are launched on kit 0.15.0, and `wiki` holds a P5 grant. The admin moves `template_pin` to 0.16.0, and the fleet page shows 3 upgrades available with the release notes.
2. The admin clicks **Upgrade all** with concurrency 2. `fleet.tick` starts two upgrade sessions, then the third. Each runs the kickoff turn (`upgradeScript`, fetching the kit through the git proxy), ships with a green gate, and opens a PR changing `.rocketflare.json` to 0.16.0. The run ends 3/3 `pr_open`. **Exit part one.**
3. `shop`'s PR merges (`sessions.checks`), its owner cuts a Release, and `template_version` reads 0.16.0 with the upgrade `released`.
4. `crm`'s owner rotates `neon_app` and `resend_key` on staging: the new values are live, the old ones work until the grace ends, then are gone.
5. `wiki`'s owner asks to archive it. A second owner approves. The teardown ends its session, revokes its grant, cancels a pending release approval, and deletes everything. `verify` passes. `cloud.resourcesFor('wiki')` holds no `cloudflare:` entry (only the retained Neon project), and the repo is archived. **Exit part two.**
6. `cost.collect` for the day shows model and container cost for the three upgrade sessions and Workers and Neon estimates per app. A member sees only their own apps.
7. `audit.seal` runs, then verify.

**Assertions:** no secret in any response, row, step result or log; every teardown audit row carries `approval_id`.

**Variants:** an upgrade whose turn ends in a question (`needs_attention`); a planted leftover failing `verify`; delete then purge; a preview opened, used and closed on `shop`.

**Browser pass:** `pnpm dev` with `SESSION_BACKEND=local`, `GRANT_BACKEND=local`, and two dev-login users. Upgrade one app from its page and watch the session ship. Archive through the inbox. Look at the Costs tab.

## 6. What is left for real infrastructure

1. **The kit:** a real `/rf-upgrade` run, unattended under `claude -p`, from 0.15.0 to a later tag in a sandbox. Does it stop at `AskUserQuestion` cleanly? Does `upgrade.mjs`'s fetch work through `interceptHttps`? And the time and cost of one upgrade turn.
2. **Neon:**
   - a second login role with `GRANT migrator TO` behaving identically to `app` under the kit's migrations;
   - `DROP ROLE` with open pooled connections;
   - `consumption_history` on the org's plan;
   - branch caps with sessions and previews together.
3. **Cloudflare:**
   - version preview URLs and aliases on a script with `workers_dev = false` (`preview_urls` separately enabled);
   - a `secret_text` in a version upload overriding the script's secret of the same name, for that version only;
   - GraphQL `workersInvocationsAdaptive` with an account token (the permission name);
   - `verify`'s listings at fleet size (paging).
4. **GitHub:** whether the App may push `.github/workflows/launch-preview.yml` (the same question as §18.5), OIDC claims on `pull_request` (`ref`, and no `environment`), and PR comments by the App.
5. **The exit run on staging:** move the pin on three real apps, merge one upgrade PR through Release → Promote, archive a scratch app and inspect the account by hand.

## 7. Open questions

Decided on 2026-09-28: the user took every recommendation below (questions 1–3 and 5 explicitly; 4, polling, by default).

1. **The upgrade target: the pin, or the kit's latest release?** Recommend **the pin** (§1.1). An admin decides when the fleet moves, and new and old apps converge on one version. "Latest" would open PRs the moment the kit tags.
2. **Per-PR previews: build them in P6, and on workers.dev?** spec/10 marks them "later", and they are the only P6 item that puts app code on a host outside the apps domain (a `*.workers.dev` alias, reachable to anyone with the URL, though the app still asks for Launch sign-in). Recommend **building 6f last, opt-in per app, off by default**. The exit test doesn't depend on it. Drop the slice if you'd rather not enable `preview_urls` on any app Worker.
3. **Does "upgrade all" itself need an approval?** Recommend **no**. It only opens PRs. What ships still passes the production gate, and each session is metered against its app's budget. A cap per run (`fleet_policy.upgradeConcurrency`) bounds the spend.
4. **GitHub webhooks (deferred from P4).** Recommend **keep polling**. Merge detection, preview close and CI all work on the `*/5` cron at this fleet size. Webhooks add a public endpoint, a secret and replay handling for minutes of latency.
5. **Delete retention.** Recommend **30 days** before a deleted app's Neon project is purged, with Archive keeping the project indefinitely (its storage shows in the cost view). Say if the company has a data-retention rule that should set this instead.
