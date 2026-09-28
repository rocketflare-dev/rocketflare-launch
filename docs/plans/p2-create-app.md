# P2 create an app: implementation plan

This is the P2 build plan ([spec/11](../../spec/11-roadmap.md)). It was checked against the tree and the kit at 0.15.0 (`c7fd5dfbf9cfbc197c60f1993f18d524ec28bd66`), including the kit's `docs/DEPLOYER.md` and `scripts/deployer.mjs`.

**Everything runs locally against fakes.** Nothing is deployed in this phase.

**Slice order:** 2a runs first and alone. 2b, 2c, 2d and 2e then run in parallel.

**Exit test:** "Create app" leads to a working `<slug>-staging.<apps domain>` with Launch sign-in, and nobody opens a terminal.

## 0. What changes the spec's step list

1. **A scaffold job can't push its result with `GITHUB_TOKEN`.** The rename rewrites `.github/workflows/*`, and `GITHUB_TOKEN` can never have the `workflows` permission. So Launch issues a repo-scoped installation token (`contents` + `workflows` write) to the job.
2. **The Versions API doesn't do everything `wrangler deploy` does.** It doesn't apply DO `[[migrations]]`, register `[[workflows]]`, create queue consumers or set crons. The kit uses all four, so the work is split:
   - the placeholder Worker applies the toml's DO migrations and exports stub classes;
   - Launch registers the workflows and queue consumers itself;
   - `activate` applies the schedules.

   A later build that adds a new migration tag is refused with a clear error (known gap).
3. **Database roles.** Kit 0.15's Worker needs owner-level rights, because RLS is inert for the owner.
   - `migrator` owns the database `app`, and `app` is `GRANT migrator TO app`, run once on `main` before branching.
   - The grant runs as `neondb_owner` (password reset on demand, never stored) over Neon's HTTP SQL endpoint: `fetch https://<host>/sql` with the `Neon-Connection-String` header, one statement per call. It never imports a driver.
   - Both roles are created IN SQL by `neondb_owner`, not through Neon's role API: an API role is a `neon_superuser` member that `neondb_owner` cannot grant on PG16+ (verified on real Neon, Postgres 17.11). `neondb_owner` also creates `vector` in `app`.
4. **The app's first deploy runs its whole gate** (`ci.yml`, then `test:config` with `REQUIRE_PROVISIONED=1`), so the scaffold must leave lint, typecheck and config tests green.
   - rocketflare#37 must be patched around.
   - `write_config` sets `TENANCY_MODE="single"`, `SIGNUP_MODE="open"`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `AUTH_OIDC_ONLY="true"` and `workers_dev=false`.

## 1. Decisions

**Scaffold: a one-shot GitHub Actions job in the new repo.**
1. Launch creates an empty private repo (`auto_init`).
2. Launch commits `.github/workflows/launch-scaffold.yml` and `.launch/scaffold.mjs` through the Git Data API, then dispatches the job.
3. The job trades its GitHub OIDC token at `POST /ci/scaffold/token` for:
   - a **1-hour installation token scoped to that one repo** (`contents` + `workflows` write);
   - the plan: slug, display name, domain, kit repo, tag and commit.
4. The job then:
   - clones the kit at the tag and checks the SHA;
   - patches `KIT.preserved` (#37);
   - runs `node scripts/rename.mjs … --force`;
   - installs the default plugins (`default-plugins.mjs --tsv` → `pnpm plugin add … --apply` → `pnpm db:generate`);
   - deletes the kit-only workflows (`notify-plugins.yml`, `plugin-ci.yml`) and `.launch/`;
   - runs the gate: `pnpm lint && pnpm typecheck && pnpm web test:config`;
   - commits "Start from Rocketflare <tag>" and pushes `main`;
   - revokes its token (`DELETE /installation/token`) and calls `POST /ci/scaffold/done`.

Why this option:
- Running it in the Worker can't do plugins, the lockfile or biome.
- A Container is P3 work.

**P3 seam:** `ScaffoldRunner { id; start(ctx, plan) → externalIds; poll(ctx, ids) → running|succeeded|failed }`. P2 ships `GitHubActionsScaffoldRunner`. The P3 sandbox runs the same `SCAFFOLD_SCRIPT`, with `LAUNCH_SCAFFOLD_TOKEN` passed through `--token-from-env`.

**Deploy tickets live in Postgres (`deploy_tickets`).** Transitions are compare-and-set (`UPDATE … WHERE status=$from RETURNING`). As with P1's `oidc_codes`, this avoids a DO binding and keeps history.

**Production in P2:**
- Staging tickets are auto-approved.
- A production ticket opens `pending`. An app owner or admin approves it on the app page, inside the job's `WAIT_SECONDS`.
- "Deploy to production" pre-approves:
  1. It inserts an `approved` ticket with no `run_id`, expiring in 15 minutes.
  2. It dispatches `deploy.yml` with `environment=production`.
  3. The next production `start` claims that ticket.
- Pipeline step 14 is `skipped`. P4 later swaps the decision source for the approvals engine.

**Neon:**
- One project per app: `<slug>`, Postgres 17, with the pinned `neon_region_id` and `neon_org_id`.
- `main` serves production and the `staging` branch serves staging.
- Roles: `migrator` owns database `app`; `app` is the Worker role and inherits `migrator`.

**Naming** (computed once in `names.ts`, and checked against the scaffolded tomls):

| Resource | Name |
|---|---|
| Worker | `<slug>[-staging]` |
| KV title | `<slug>-rate-limit[-staging]` |
| Queue | `<slug>-jobs[-staging]` |
| R2 bucket | `<slug>-files[-staging]` |
| Workflow | `<slug>-agent-run[-staging]` |
| Resend key | `<slug>[-staging]` |
| Host | `<slug>[-staging].<apps_domain>` |

**Slugs:** a new rule forbids a `launch-` prefix, because Launch's own account-scoped names share the account.

**Deployer URL:** all GitHub-OIDC routes are public under **`/ci`**. `DEPLOYER_URL=${APP_URL}/ci` and `DEPLOYER_AUDIENCE=${APP_URL}`.

**Secrets never appear in a `step.do` result** (Workflows persist step results). The step that mints a secret puts it on the Worker in that same step.

**Who may create an app:** admins and above (`manage App`), behind `launch_settings.app_create_role`.

## 2. Schema (one migration: `pnpm db:generate --name launch-p2-create-app`)

**New table `deploy_tickets`** (`db/schema/deploy-tickets.ts`, tenant-scoped, `tenantIsolation('deploy_tickets')`):
- Keys: id, tenant_id, app_id (cascade), environment_id (cascade).
- `purpose` enum `ci_ticket_purpose`: deploy | scaffold.
- `status` enum `deploy_ticket_status`: pending | approved | rejected | uploaded | active | finished | failed.
- From the GitHub OIDC token: repository_id, repository, run_id, run_attempt, sha, ref, actor, job_workflow_ref.
- Deploy details: version, cf_version_id, bindings jsonb, refused jsonb.
- Migrator credential: credentials_issued_at, credentials_revoked_at.
- Decision: decided_by_user_id, decided_at, decision_source (auto | user | intent), expires_at.
- Other: launch_run_id uuid, error, created_at, updated_at, finished_at.
- Constraints and indexes:
  - unique (environment_id, purpose, run_id, run_attempt), so a retried start returns the same ticket;
  - index (tenant_id, app_id, created_at desc);
  - partial index on (environment_id) where `run_id IS NULL AND status='approved'`.

**Additions to existing tables:**
- `apps`: `github_repo_id text` (the OIDC `repository_id` survives renames), `template_ref`, `template_commit`, `launch_run_id uuid`, `archived_at`.
- `app_environments`: `encryption_key_sealed text`, which holds the app's `OAUTH_ENCRYPTION_KEY` sealed with `encryptToken` (spec/03).

**jsonb shapes only, no DDL** (`packages/shared/src/launch-apps.ts`):
- `appEnvironmentResourcesSchema` gains `queues[].id`, `kv[].title?`, `queueConsumers[]` and `doMigrationTag?`.
- `appEnvironmentNeonSchema` gains `migratorRole` and `appRole`.

**`LAUNCH_SETTING_KEYS`** gains:
- `template_pin`: `{repo, tag, commit}`; the code default is kit 0.15.0 at the SHA above;
- `app_create_role`.

**Bindings** (both tomls):
- `[[workflows]]` `APP_LAUNCH_WORKFLOW`: class `AppLaunchWorkflow`, name `launch-app-create[-staging]`.
- `[[workflows]]` `APP_TEARDOWN_WORKFLOW`: class `AppTeardownWorkflow`, name `launch-app-teardown[-staging]`.
- `"/ci","/ci/*"` in `run_worker_first`.

Also:
- exports in `src/worker.ts`;
- regenerate `worker-configuration.d.ts`;
- `tests/mocks/bindings.ts`: two `RecordingWorkflow`s, as `stubs(env).launchWorkflow` and `stubs(env).teardownWorkflow`;
- the parity test;
- `docs/DEPLOY.md`.

## 3. Slices

**Rule:** only 2a runs `db:generate` or `pnpm install`, or edits these shared files:
- `api/index.ts`, `routes/apps.ts`, `worker.ts`, `bindings.ts`;
- the tomls, `permissions`, `query-keys.ts`, the shared contracts.

Later slices that need a change there stop and report.

### 2a: foundations (runs first, alone)

**Schema and bindings:** everything in §2. Pre-register `src/api/services/launch/ci/caller.ts` and `src/api/services/launch/deploy/tickets.ts` in `tests/config/unscoped-allowlist.test.ts`, with the reason "pre-tenant GitHub OIDC path: repository_id / ticket id lookups before any session; the tenant is then taken from the row".

**Wiring:**
- `api/index.ts`:
  - `app.use('/ci/*', ciBodyLimit)`: 64 MB for `/ci/deploy/:id/upload`, 1 MB elsewhere, added to `middleware/body-limit.ts`;
  - `app.route('/ci', ciRouter)`, public, beside `/oidc`.
- Add `'/ci'` to `CORE_API_PREFIXES`.
- `routes/ci.ts` mounts `ciDeployRouter` at `/deploy` and `ciScaffoldRouter` at `/scaffold`.
- Stub routers:

  | File | Owner |
  |---|---|
  | `routes/ci-deploy.ts` | 2d |
  | `routes/ci-scaffold.ts` | 2b |
  | `routes/app-pipeline.ts` | 2c |
  | `routes/app-deploys.ts` | 2d |

- `routes/apps.ts`: `appsRouter.route('/', appPipelineRouter)` and `appsRouter.route('/', appDeploysRouter)`, **before** `/:slug`.
- Workflow class stubs `api/workflows/app-launch.ts` and `app-teardown.ts` (owned by 2c).
- Query keys `apps.pipeline(appId)` and `apps.deploys(appId)`.

**Contracts** (`packages/shared/src/launch-pipeline.ts`, new):
- `createAppRequestSchema {slug, displayName, description?, ownerGroupId?, options:{deployStaging:boolean=true}}`
- `APP_LAUNCH_STEPS` and `APP_TEARDOWN_STEPS`: ordered, with labels (see 2c)
- the pipeline view `{appId, runId, kind, status, steps:[{step,label,status,attempt,error,startedAt,finishedAt}]}`
- `retryPipelineRequestSchema`
- `teardownRequestSchema {confirmSlug, deleteRepo?:false}`
- `deployTicketSchema`, `deployDecisionSchema`
- the protocol bodies (`deployStartSchema {protocol}`, `deployUploadSchema`)
- event types `SCAFFOLD_FINISHED_EVENT='scaffold_finished'` and `DEPLOY_FINISHED_EVENT='deploy_finished'`, with a golden test against `/^[A-Za-z0-9_-]{1,100}$/`

**Vendor clients** (Worker-safe, `opts.fetch` and `apiBase`; `spikes/*` is reference only, never imported):
- `cloudflare.ts`: a private `request(method, path, {json|form})`, plus:
  - KV: `createKvNamespace`, `deleteKvNamespace`, `findKvByTitle`
  - Queues: `createQueue`, `deleteQueue`, `putQueueConsumer`, `deleteQueueConsumer`
  - R2: `createR2Bucket`, `emptyAndDeleteR2Bucket`
  - Scripts: `putWorkerScript` (multipart: metadata + modules + migrations), `deleteWorkerScript(force)`, `setWorkersDevSubdomain`, `putWorkerSecret`
  - Workflows and routes: `putWorkflow`, `deleteWorkflow`, `createWorkerRoute`, `deleteWorkerRoute`
  - Deploys: `assetsUploadSession`, `uploadAssetBucket`, `createVersion`, `createDeployment`, `putSchedules`, `patchScriptSettings`
- `neon.ts`: `request()` with **423 retry** through an injectable `sleep`, plus:
  - `waitForOperations`
  - `createProject`, `deleteProject`
  - `createRole`, `resetRolePassword`
  - `createDatabase`, `createBranch`
  - `connectionUri(pooled)`
  - `runSql(uri, query, params, fetch)`: HTTP SQL
- `resend.ts`: `createSendingKey(name, domainId)`, `deleteApiKey`.
- `github-app.ts`: export `githubJson` and `githubRequest`, plus:
  - repos: `createOrgRepo`, `archiveRepo`, `deleteRepo`, `getRepo`
  - Git Data: `getRef`, `createTree` (inline content), `createCommit`, `updateRef`, and `commitFiles(token, owner, repo, branch, files, message)`
  - Actions: `dispatchWorkflow`, `listWorkflowRuns`
  - settings: `putEnvironment`, `upsertRepoVariable`, `revokeInstallationToken`

**Shared services:**
- **`services/launch/ci/github-oidc.ts`:** `verifyGitHubOidc(token, {audience, fetch})`, using jose 6 `createRemoteJWKSet(url, {[customFetch]: fetch})` against `https://token.actions.githubusercontent.com/.well-known/jwks`. A bad token or wrong audience is a 401.
- **`services/launch/ci/caller.ts`:** `resolveCaller(db, claims, {workflowFile})`. Otherwise it answers 403. It maps and checks:
  - `repository_id` → the app, and `repository` must match;
  - `environment` → an `app_environments` row;
  - `job_workflow_ref` must start with `<owner>/<repo>/.github/workflows/<file>@`;
  - `ref` must be `refs/heads/<default_branch>` or `refs/tags/*`.
- **`services/launch/pipeline/operations.ts`:** `runStep(db, {tenantId, appId, runId, kind, step}, fn)` upserts on `(run_id, step)`:
  - A row that already `succeeded` returns its stored `externalIds` and does not call `fn`.
  - Otherwise the row becomes `running` with `attempt+1`.
  - `fn(ctx)` gets `ctx.prior` (the ids from an earlier failed attempt) and `ctx.record(partial)`, which persists each id **immediately**.
  - The row ends `succeeded`, or `failed` with the error passed through `scrub()` from `setup.ts`.

**Test infrastructure:**
- `tests/helpers/fake-cloud/{index,cloudflare,neon,resend,github}.ts`: a **stateful** in-memory vendor simulator behind `fetch`. It keeps resources with ids and answers 404 for deleted ones. It supports `failNext(match, status)`, 423 bursts, recorded calls and a `resourcesFor(slug)` invariant. It builds on `tests/helpers/vendor-fetch.ts`.
- `tests/helpers/github-oidc.ts`: a test RSA key, `mintActionsToken(claims)` and the JWKS route.

**Tests:**
- `launch-vendors.test.ts`: every client method, plus 423 retry.
- `github-oidc.test.ts`: forged, wrong-audience and expired tokens.
- `pipeline-operations.test.ts`: a succeeded step is skipped; a recorded id survives a throw.
- Updates to `launch-wiring`, `wrangler-parity`, `scheduled` and `permissions`.

**Done when:**
- the gate is green;
- both workflow stubs are exported and typed;
- `/ci/*` answers a JSON 404.

### 2b: adapter and scaffold

**Owns:**
- `services/launch/rocketflare/adapter.ts`: a `TemplateAdapter` v1 object. It moves `ROCKETFLARE_CONTRACT_VERSION` here from `import.ts` and re-exports it there.
- `rocketflare/names.ts`.
- `rocketflare/toml.ts`: a port of the pure `patchToml`, `tomlPlaceholders` and `readTomlString` from `apps/web/scripts/provision/patch-toml.ts`, which imports `node:fs`. It provides `writeConfig(tomlText, env, values)` and `resources(tomlText)`, reusing `parseWranglerToml`.
- `rocketflare/placeholder-worker.ts`: `placeholderScript(toml)` returns metadata and a module with a stub class for each DO and Workflow `class_name`, plus `migrations` from the toml. It adapts `spikes/lib/worker.mjs`.
- `rocketflare/scaffold-job.ts`: the `SCAFFOLD_WORKFLOW_YAML` and `SCAFFOLD_SCRIPT` strings, with #37's preserve list (`'rocketflare-dev/rocketflare-plugins'`, `'rocketflare-dev/rocketflare-plugin-'`, `'rocketflare-dev/'`).
- `services/launch/scaffold/{runner.ts, github-actions-runner.ts}`.
- `routes/ci-scaffold.ts`:
  - `POST /ci/scaffold/token`:
    - claims the `approved` scaffold ticket and binds its `run_id`;
    - mints `installationToken(auth, id, {repositories:[repo], permissions:{contents:'write', workflows:'write'}})`;
    - returns the token and the plan once; a second call gets 409;
    - audits `app.scaffold.token_issued`.
  - `POST /ci/scaffold/done {commit}`: marks the ticket `finished` and sends `SCAFFOLD_FINISHED_EVENT` to `APP_LAUNCH_WORKFLOW.get(launch_run_id)`.

**Tests:**
- `tests/api/ci-scaffold.test.ts` (`// @vitest-isolate`):
  - a wrong workflow file, a wrong repo and a second token request are refused;
  - the token is scoped to the one repo;
  - the event is sent.
- `tests/config/rocketflare-adapter.test.ts`, using the kit's real 0.15 tomls committed under `tests/fixtures/rocketflare-0.15/`:
  - `writeConfig` leaves no placeholders and passes the parity rules;
  - staging and production differ only in account-scoped names;
  - the placeholder metadata carries `migrations: v1 NotificationsHub`.
- `tests/config/scaffold-script.test.ts` runs `SCAFFOLD_SCRIPT` with Node:
  - against a fixture kit git repo whose stub `rename.mjs` records its argv, with a local bare repo as origin;
  - with `--token-from-env --skip-install --skip-gate`;
  - it asserts the pushed tree, that `.launch/` and the scaffold workflow are gone, that org refs are preserved, that the kit-only workflows are removed, and that exit codes propagate.

### 2c: the APP_LAUNCH and APP_TEARDOWN workflows

**Owns:**
- `api/workflows/app-launch.ts` and `app-teardown.ts`, following `agent-run.ts`: `withStepDatabase`, one DB client per step, and distinct step names.
- `services/launch/pipeline/`:
  - `create.ts`: `createApp()`. The route calls it synchronously:
    1. It checks the slug with `appSlugProblem` plus the `launch-` rule.
    2. In one transaction it inserts `apps` (`source='created'`, `status='requested'`), both `app_environments` rows (from `names.ts`), `app_owners` (the creator) and audit `app.create.requested`.
    3. It then calls `APP_LAUNCH_WORKFLOW.create({id: runId, params})`.
  - `launch-steps.ts`, `teardown-steps.ts`.
  - `provision-neon.ts`, `provision-cloudflare.ts`, `provision-github.ts`, `provision-resend.ts`, `worker-secrets.ts`.
  - `retry.ts`.
- `routes/app-pipeline.ts`:
  - `POST /api/apps` → 202 `{app, runId}`.
  - `GET /api/apps/:id/pipeline`.
  - `POST /api/apps/:id/pipeline/retry`: a new instance `<runId>-rN` with the same `runId`, so succeeded steps are skipped.
  - `POST /api/apps/:id/teardown`: checks the confirmation slug, then starts `APP_TEARDOWN_WORKFLOW`.

**Steps.** Each is `step.do(name, {retries:{limit:3, delay:'10 seconds', backoff:'exponential'}, timeout:'5 minutes'})` wrapped in `runStep`.

1. **`reserve`**: status `provisioning`.
2. **`repo`**: `createOrgRepo` (private, `auto_init`), then `commitFiles` for the two scaffold files. Record `repoId`.
3. **Scaffold**, in three steps:
   - `scaffold.start`: create the scaffold ticket, then `dispatchWorkflow`; a 404 is retried while GitHub registers the new file.
   - `scaffold.wait`: `waitForEvent(SCAFFOLD_FINISHED_EVENT, 30 min)`.
   - `scaffold.verify`: `.rocketflare.json` must have `app.slug === slug` and `kit.version === tag`, and the toml names must equal `names.ts`. Then set `template_ref` and `template_commit`.
4. **`neon`**:
   - create the project;
   - reset `neondb_owner`'s password and read its direct URI;
   - as `neondb_owner` in SQL: `CREATE ROLE migrator LOGIN CREATEROLE` and `CREATE ROLE app LOGIN` (throwaway passwords), each only if `pg_roles` lacks it — repairing first a project whose roles the API created (see `docs/CONCEPTS.md` §18.5);
   - database `app` owned by `migrator` (API), `CREATE EXTENSION IF NOT EXISTS vector` in it, and `GRANT migrator TO app` unless `pg_auth_members` has it;
   - create branch `staging` and reset both roles' passwords on it (a branch inherits its parent's passwords);
   - record every id.
5. **`cloudflare`**: KV, queue and R2 for each environment, recording each id as soon as it exists. On retry, a name conflict is adopted only if no other app records that id.
6. **`oidc_client`**: `createAppOidcClient`, reused if it exists. The step returns only the client id.
7. **`write_config`**: `adapter.writeConfig` for both tomls, in one commit.
8. **`placeholders`**:
   - `putWorkerScript` for each environment (this applies the DO migration) and `setWorkersDevSubdomain(false)`;
   - `putWorkflow` ×2 and `putQueueConsumer` ×2;
   - `createWorkerRoute` `<host>/*`, with the zone id from the `cloudflare_api_token` metadata;
   - record route ids in `app_environments.route_ids`.
9. **`github_env`**: `putEnvironment` for staging and production; repo variables `DEPLOYER_URL` and `DEPLOYER_AUDIENCE`.
10. **`worker_secrets`**, for each environment:
    - `OAUTH_ENCRYPTION_KEY`, generated once and sealed into `encryption_key_sealed`;
    - `OIDC_CLIENT_SECRET`, from `rotateAppOidcSecret` once and put on both Workers;
    - `BOOTSTRAP_ADMIN_EMAILS` = the creator;
    - `DATABASE_URL`: reset `app`'s password, then the pooled URI.
11. **`email`**: `createSendingKey` bound to the Resend credential's `metadata.domainId`, then `RESEND_API_KEY` and `resend_key_id`. It is **non-blocking**: on failure the row is `failed` and the run carries on.
12. **Deploy staging**, in three steps:
    - `deploy_staging.start`: `dispatchWorkflow('deploy.yml', {environment:'staging'})`.
    - `deploy_staging.wait`: `waitForEvent(DEPLOY_FINISHED_EVENT, 45 min)`.
    - `deploy_staging.check`: the latest staging ticket is `active` or `finished` with a `cf_version_id`, which also makes a lost event safe.
13. **`health#N`**: `checkAppHealth` from `health.ts`, with `step.sleep('health-wait#N','30 seconds')`, up to 20 tries.
14. **`production`**: `skipped` ("waits for the first release and an owner's approval").
15. **`live`**: status `live`, `notify()` the creator, audit `app.launched`.

On an uncaught failure: status `failed` and audit `app.launch_failed`.

**Teardown** (`kind:'teardown'`):
- It gathers the ids from **every** `create` run's `app_operations` plus `app_environments`.
- It deletes in reverse order:
  1. routes;
  2. queue consumers;
  3. Worker scripts (`force`);
  4. workflows;
  5. queues, then R2 (emptied first), then KV;
  6. Resend keys;
  7. the Neon project;
  8. the OIDC client, which is disabled rather than deleted;
  9. the repo, which is archived, or deleted only if `deleteRepo`.
- A 404 counts as success.
- It ends with status `archived`, `archived_at`, and audit `app.archived`.

**Tests:**
- `tests/api/app-launch-workflow.test.ts` (`// @vitest-isolate`, FakeCloud through a global-fetch spy):
  - every step runs and step names are distinct;
  - rows and ids are recorded;
  - no secret appears in `app_operations`, `audit_events` or a step result;
  - 423 bursts are handled;
  - a failure at R2 followed by a retry creates the Neon project and KV only once;
  - an email failure doesn't block the run.
- `app-teardown-workflow.test.ts`: `resourcesFor(slug)` is empty afterwards, and teardown of a half-created app works.
- `app-pipeline-routes.test.ts`:
  - 401 and 403;
  - reserved, `launch-` and duplicate slugs;
  - tenant isolation;
  - retry only when the run is `failed`;
  - a wrong confirmation slug → 400;
  - `createTestEnv({APP_LAUNCH_WORKFLOW: undefined})` → 503.

### 2d: the deploy gateway

**Owns:**
- `services/launch/deploy/tickets.ts`: the compare-and-set transitions from `DEPLOYER.md`.
- `deploy/binding-check.ts` (port `checkBindings` from `spikes/s5-deploy-via-launch/gateway/src/index.js`, and widen it):
  - `name` must equal the environment's `worker_name`.
  - **Allowed:**
    - `kv_namespaces` with a recorded id;
    - queue producers and consumers with a recorded queue name;
    - `r2_buckets` with a recorded `bucket_name`;
    - `durable_objects` with no `script_name`, or their own Worker's;
    - `workflows` with a recorded name, and no `script_name` or their own;
    - `ai`, `assets`, `[vars]`.
  - **Refused:**
    - any other binding kind: `services`, `hyperdrive`, `d1`, `vectorize`, `analytics_engine`, `send_email`, `secrets_store`, `dispatch_namespaces`, `mtls`, `browser`, `tail_consumers`;
    - any `routes` or `custom_domain`;
    - a `[[migrations]]` tag newer than `resources.doMigrationTag`.
  - Each refusal is reported as `"<kind> <binding>=<value>"`.
- `deploy/worker-upload.ts`: port `uploadAssets` and `upload`. The version metadata sets `RELEASE_VERSION` and `keep_bindings:['secret_text']`, and module types follow the protocol.
- `deploy/migrator.ts`: `issueMigratorUrl` (reset `migrator`, return the direct URI to database `app`) and `revokeMigrator`.
- `deploy/gateway.ts`: the five operations.
- `routes/ci-deploy.ts`:
  - `POST /start`:
    - a wrong protocol version gets 400 `{supported:[1]}`;
    - staging tickets go straight to `approved`;
    - production claims a pre-approval, or else opens `pending`.
  - `GET /:id`.
  - `POST /:id/upload`:
    - 409 unless the ticket is `approved`;
    - parse the toml with `smol-toml` and run the binding check;
    - a refusal is 403 `{error, refused}`, the ticket becomes `failed`, and **no Neon call is made**;
    - otherwise upload the assets and version, mark `uploaded`, and return `migratorUrl`.
  - `POST /:id/activate`:
    - deploy at 100%;
    - `putSchedules` from `[triggers]` and `putWorkflow` for the recorded names;
    - `revokeMigrator`;
    - mark `active` and update `last_deploy_*`.
  - `POST /:id/finish`: idempotent. It revokes the migrator credential if still live, marks `finished`, and sends `DEPLOY_FINISHED_EVENT` if `launch_run_id` is set.
  - Every call checks the token's `run_id` and `environment` against the ticket; a mismatch is 403.
- `routes/app-deploys.ts`:
  - `GET /api/apps/:id/deploys`;
  - `POST /:id/deploys/:ticketId/decide`, for owners and admins, auditing `deploy.production.approved` or `rejected`;
  - `POST /:id/deploys/production`: a pre-approval plus the dispatch.

**Tests:**
- `tests/api/ci-deploy.test.ts` (isolated):
  - every status in `DEPLOYER.md`;
  - 401 and 403 claim cases;
  - run binding and the 409s;
  - `finish` is idempotent.
- **The S1/S5 attack:** a `wrangler.evil.toml` binding another seeded app's KV, R2, queue and workflow gets 403, and FakeCloud records zero Neon calls.
- Production: pending → approve → upload; a pre-approval is claimed once.
- `tests/config/binding-check.test.ts`: table-driven.

### 2e: UI

**Owns:**
- `ui/pages/apps/components/`:
  - `CreateAppModal.tsx`: the slug with live `appSlugProblem` checks and a host preview (`<slug>-staging.<apps_domain>`), display name, owner group (`/api/groups`), description, and "deploy staging now".
  - `PipelineProgress.tsx`: the steps from `APP_LAUNCH_STEPS`. It polls `apps.pipeline` every 3 s while provisioning, shows the error, and has **Retry from failed step**.
  - `TeardownModal.tsx`: type the slug to confirm, with a "delete repository" checkbox.
  - `DeploysCard.tsx`: recent tickets, with Approve / Reject for pending production deploys.
- Edits:
  - `CataloguePage.tsx`: "Create app" becomes the `btn-flame` button, and "Import" becomes secondary.
  - `AppDetailPage.tsx`: shows the pipeline progress when the app isn't `live`, and Archive in a danger zone.
- `tests/ui/apps-create.test.tsx`.

## 4. Local end-to-end test (no cloud)

`tests/api/app-create-e2e.test.ts` (`// @vitest-isolate`) uses one FakeCloud as its only `fetch`.

**Seed:**
- a tenant and an admin;
- all four credentials via `putCredential`, with the GitHub App PEM generated for the test;
- `launch_settings`: `apps_domain=clewro.com`, the Cloudflare account and zone.

**Run:**
1. `POST /api/apps`, then check `stubs(env).launchWorkflow.created`.
2. Drive `new AppLaunchWorkflow(ctx, env).run({payload}, createFakeWorkflowStep({onWait}).step)`.
3. On `scaffold_finished`, `onWait` acts as the scaffold job:
   - `/ci/scaffold/token` with `mintActionsToken(...)`;
   - FakeGitHub records a commit containing the kit 0.15 fixture tomls and `.rocketflare.json`, as the rename left them;
   - `/ci/scaffold/done`.
4. On `deploy_finished`, `onWait` runs the **real `scripts/deployer.mjs`** (start → upload → activate → finish) as a child process, following `tests/config/deployer.test.ts`:
   - a `node:http` bridge forwards to `app.request(req, env)`;
   - the same bridge serves `ACTIONS_ID_TOKEN_REQUEST_URL`;
   - the uploaded `TOML` is **the one `write_config` committed to FakeGitHub**;
   - the outdir is a fixture `worker.js` + `index.html`.
5. FakeCloud answers the staging host's `/api/health` and `/api/ready`.

**Assertions:**
- the app is `live`, and every `app_operations` row is as expected;
- the ids in `app_environments` match FakeCloud's, and routes point at the right scripts;
- secrets were PUT by name only;
- the active staging deployment is the uploaded version, with `keep_bindings`;
- the migrator password was reset 3× (create, issue, revoke);
- the OIDC client has both redirect URIs;
- the audit chain runs `app.create.requested` → `deploy.activated` → `app.launched`.

**Variants:**
- the evil toml → 403, with no migrator reset;
- a production release: pending → approved → deployed;
- a failure at `placeholders`, then a retry: no duplicate resources;
- teardown: `resourcesFor(slug)` is empty and the repo is archived.

## 5. What is left for the real-infrastructure exit

1. **Neon:**
   - ~~check `GRANT migrator TO app` as `neondb_owner` on Postgres 17~~ — verified on 17.11: it FAILS for API-created roles (`neon_superuser` members); roles created in SQL by `neondb_owner` work, and the API lists them, resets their passwords and accepts `migrator` as the database owner. The step now creates them in SQL;
   - check that `db:migrate:ci` runs as `migrator` (the statements it needs — `CREATE EXTENSION IF NOT EXISTS vector` as a no-op, `CREATE TABLE`, `CREATE ROLE`, `GRANT <rls role> TO app` — were verified one by one);
   - check that the repair path's `DELETE …/roles/{name}` removes an API-created role.
2. **Cloudflare:**
   - a version upload onto a placeholder that already has migration `v1`;
   - `putWorkflow` and queue consumers on a script created by version upload;
   - schedules and script settings;
   - an upload body of 5–10 MB;
   - per-app routes taking precedence over Launch's catch-all.
3. **GitHub:**
   - the App needs `administration`, `workflows`, `actions`, `environments` and `actions_variables`;
   - how long a newly pushed workflow takes to become dispatchable;
   - whether an installation token can push workflow files;
   - the shapes of the `repository_id` and `job_workflow_ref` claims;
   - `ci.yml`'s duration against the 45-minute wait;
   - team access for the owner group (not mapped in P2).
4. **The real scaffold of kit 0.15.0:** the rename, the #37 patch, the analytics plugin and a green gate all on the runner; first sign-in through `BOOTSTRAP_ADMIN_EMAILS` + `TENANCY_MODE=single`.
5. **Launch's own deploy:** `launch.clewro.com` with the `/ci` route, the `launch-app-create[-staging]` and `launch-app-teardown[-staging]` workflow names, and the Resend `notifications.clewro.com` domain verified.
6. **Exit run:**
   1. Create an app; `<slug>-staging.clewro.com` serves it, and sign-in goes through Launch.
   2. An evil toml is refused.
   3. A production release is approved in Launch.
   4. Archiving leaves no Cloudflare or Neon resources behind.

**Upstream in the kit:**
- #37;
- the `update-check-lib.test.ts` assumption that `app` is `null`;
- a deployer-protocol note on what the Versions API can't do (DO migrations, workflows, queue consumers, crons).
