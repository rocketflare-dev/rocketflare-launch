# P1 foundation: implementation plan

This is the P1 build plan ([spec/11](../../spec/11-roadmap.md)), checked against the seeded tree. It is split into four slices:

- **1a** runs first and alone.
- **1b, 1c and 1d** then run in parallel, each on its own branch.

**Exit test:** an existing Rocketflare app is listed with live health. After its `OIDC_*` settings are switched, its users sign in through Launch.

## Decisions for every slice

1. **Launch tables carry `tenant_id`, scoped to the single company tenant.**
   - Use `tenantRef(tenants)` first and `tenantIsolation('<t>')`, from `apps/web/src/db/schema/_helpers.ts` and `rls.ts`.
   - Why:
     - `rls-coverage`, `schema-invariants` and `unscoped-allowlist` all enforce `tenant_id`.
     - Access policies point at the kit's `groups` and `tenant_users`, which are tenant-scoped.
     - Tests run multi-tenant on one shared database, so a tenant per test keeps each test's data apart.
   - Handlers get the tenant from `withAuthAndDb(c)` (`api/utils/routes/route-helpers.ts`).
   - **Exceptions** are issuer-wide or platform infrastructure. They have no `tenant_id` and go in `RLS_REVOKED_TABLES`: `oidc_signing_keys`, `admin_credentials`, `launch_settings`.
2. **Teams are the kit's `groups` / `group_members` (D29).**
   - There is no `teams` table.
   - `apps.owner_group_id` points at `groups.id`.
   - Use `listUserGroups()` (`services/groups.ts`) and `auth.groups`.
3. **Authorization codes live in Postgres (`oidc_codes`), not a Durable Object.**
   - A code is single-use through `UPDATE … SET consumed_at=now() WHERE code_hash=$1 AND consumed_at IS NULL RETURNING`.
   - The row keeps the history needed to revoke tokens issued from a replayed code.
   - The worker needs no new binding.
4. **Sealing** uses `encryptToken` / `decryptToken` / `requireEncryptionKey` from `apps/web/src/api/auth/oauth-encryption.ts`, keyed by `OAUTH_ENCRYPTION_KEY`.
5. **The issuer is `cfg.APP_URL`**, with no trailing slash.
   - Launch's own `OIDC_*` config is Launch's upstream login.
   - Add a `loadConfig` refine so that `OIDC_ISSUER !== APP_URL`.
6. **An app's side of the exit test is configuration only**, because the kit 0.15 OIDC relying party (`api/auth/providers/oidc.ts`) already exists:
   - Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, the `OIDC_CLIENT_SECRET` secret and `AUTH_OIDC_ONLY=true`.
   - The RP redirects to `{APP_URL}/auth/oidc/callback` and logs out to `{APP_URL}/login?signedOut=1`.
   - It requires `email_verified: true` and a `nonce`, and sends the client secret with HTTP Basic.
7. **Only 1a** runs `pnpm db:generate` or `pnpm install`. If 1b, 1c or 1d needs a schema change or a dependency, it stops and reports.

## 1a: schema, audit, shared wiring and foundations

### Schema

One file per table in `apps/web/src/db/schema/`, each exported from `index.ts`.

**`apps.ts`**

`apps` columns:
- id, tenant_id
- `slug`, unique across the whole database as `apps_slug_key`, because hostnames are global
- display_name, description
- owner_group_id → `groups` (set null)
- `source` enum: imported | created
- template (default `rocketflare`), template_contract_version, template_version
- repo_owner, repo_name, default_branch
- `status` enum `app_status`: requested | provisioning | live | archived | failed
- created_by_user_id → users (set null)
- timestamps

Index: (tenant_id, status).

`app_owners`:
- tenant_id, app_id (cascade), user_id (cascade)
- PK (app_id, user_id)
- a composite FK (tenant_id, user_id) → `tenant_users`, copying `group_members`

**`app-environments.ts`**

`app_environments` columns:
- id, tenant_id, app_id (cascade)
- `name` enum: staging | production
- url, worker_name
- `resources` jsonb, typed: the kv / queues / r2 / durable_objects / workflows / hyperdrive ids declared in the toml
- neon jsonb (nullable), resend_key_id, route_ids jsonb
- last_deploy_version, last_deploy_at, last_deploy_by
- `health_status` enum: unknown | up | degraded | down
- health_checked_at, health_changed_at, health_version, health_latency_ms, health_error
- timestamps

Unique: (app_id, name).

`app_health_checks`:
- id, tenant_id, environment_id (cascade)
- checked_at, status, http_status, ready_status, latency_ms, version, error
- Index: (tenant_id, environment_id, checked_at desc)

**`app-operations.ts`**

`app_operations`:
- id, tenant_id, app_id (cascade), run_id uuid
- kind (import | create | …), step
- `status` enum: pending | running | succeeded | failed | skipped
- attempt, error, external_ids jsonb
- started_at, finished_at, timestamps
- Unique: (run_id, step)

**`oidc.ts`**

`oidc_clients`:
- id, tenant_id, app_id (cascade, unique)
- client_id (unique, `lc_…`), secret_hash, secret_hint (last 4 characters), secret_rotated_at
- redirect_uris and post_logout_redirect_uris, both jsonb string arrays. Use jsonb, not `text[]`, so both database drivers handle them.
- `access_policy` enum: company | restricted (default company)
- disabled_at, created_by_user_id, timestamps

`oidc_client_grants`:
- id, tenant_id, client_id → oidc_clients (cascade)
- group_id → groups (cascade, nullable), user_id → users (cascade, nullable), with a CHECK that exactly one of the two is set
- unique nulls-not-distinct on (client, group, user)
- created_by, created_at

`oidc_codes`:
- id, tenant_id, client_row_id (cascade)
- code_hash (unique), user_id (cascade), session_id uuid (no FK)
- redirect_uri, code_challenge, nonce, scope, auth_time
- expires_at, consumed_at, access_token_jti, revoked_at, created_at

`oidc_signing_keys` (no tenant):
- id, kid (unique), alg (`ES256`), public_jwk jsonb, private_jwk_sealed
- `status` enum: next | active | retiring | retired
- activated_at, retire_after, created_at, created_by_user_id
- Partial unique index where `status='active'`

`app_access_requests` (the P1 stand-in for P4 approvals):
- id, tenant_id, app_id (cascade), user_id (cascade), message
- status: pending | approved | rejected
- decided_by_user_id, decided_at, created_at
- Partial unique (app_id, user_id) where pending

**`admin-credentials.ts`** (no tenant)

`admin_credentials`:
- id
- `kind` enum, unique: cloudflare_api_token | neon_org_api_key | resend_api_key | github_app
- sealed text: the sealed JSON
- metadata jsonb: non-secret facts only (account id, app id, installation id, fingerprint)
- last_check_status (ok | warning | failed), last_check jsonb, last_checked_at
- set_by_user_id (set null), set_at, rotated_at, timestamps

`launch_settings`: key (PK), value jsonb, updated_by_user_id, updated_at.

**`audit-events.ts`**

`audit_events` columns:
- id, tenant_id, at
- actor_type: user | system | app
- actor_user_id uuid with **no FK**, so deleting a user never rewrites the log
- actor_email
- action (dotted), target_type, target_id
- app_id uuid (no FK)
- summary jsonb `{before?, after?}`; never secret values
- request_id, approval_id, ip, user_agent

Indexes: (tenant_id, at desc), (tenant_id, target_type, target_id), (tenant_id, app_id, at desc).

### Migration

Run `pnpm db:generate --name launch-p1-foundation`, then append custom SQL to the same generated file:
- a `BEFORE UPDATE OR DELETE` row trigger on `audit_events` that raises unless `pg_trigger_depth() > 1`, so the tenant cascade still works;
- no TRUNCATE trigger, because test cleanup truncates.

The Worker connects as the table owner, so the trigger is the real enforcement.

`rls.ts` changes:
- Add the three tenant-less tables to `RLS_REVOKED_TABLES`.
- Add `APPEND_ONLY_TABLES = ['audit_events']`.

The `db-roles.ts` grants phase runs `REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM launch_app`.

### Services

`api/services/launch/audit.ts`:
- `recordAudit(db, input)` is awaited, unlike `recordActivity`.
- `auditActor(c)` returns `{actorUserId, actorEmail, ip, userAgent, requestId}`; `ip` comes from `clientIpOf` in `routes/auth/helpers.ts`.
- Also exports `SYSTEM_ACTOR` and `listAudit(db, tenantId, filters, cursor)`.

`services/launch/credentials.ts`:
- `putCredential(db, cfg, kind, secretJson, metadata, userId)`
- `getCredential(db, cfg, kind)`: unsealed, server only
- `credentialStatus(db)`: never returns values
- `recordCheck`, `getSetting`, `putSetting`
- Zod payloads per kind live in `packages/shared/src/launch-setup.ts`.

`services/launch/github-app.ts`:
- `toPkcs8Pem(pem)`: GitHub issues PKCS#1 keys (`BEGIN RSA PRIVATE KEY`), so wrap the DER as PKCS#8 for WebCrypto and jose.
- `appJwt(appId, pem)`: RS256, iat = now−60, exp = now+540.
- `getApp`, `listInstallations`, `installationToken(installationId, {repositories, permissions})`, `getRepoFile(token, owner, repo, path, ref)` (accept `application/vnd.github.raw+json`).
- Always send a `User-Agent`.
- Every function takes `opts.fetch ?? fetch`.

### Audit API and page

- `GET /api/audit?appId&action&cursor` (`routes/audit.ts`), for admins and above. The schema is in `packages/shared/src/launch-audit.ts`.
- `ui/pages/Audit.tsx`.

### Shared wiring (only 1a edits these files)

**`api/index.ts`:**
- public `app.use('/oidc/*', jsonBodyLimit)`, `app.route('/.well-known', wellKnownRouter)`, `app.route('/oidc', oidcRouter)`;
- `app.route('/api/admin/setup', setupRouter)` and `app.route('/api/admin/oidc', oidcAdminRouter)`, both **before** `/api/admin`;
- mount-table entries for `/api/apps`, `/api/app-access`, `/api/audit`.

**Stub routers** (`createRouter()`):

| File | Owner |
|---|---|
| `routes/oidc.ts` (exports `oidcRouter`, `wellKnownRouter`), `routes/oidc-admin.ts`, `routes/app-access.ts` | 1b |
| `routes/setup.ts` | 1c |
| `routes/apps.ts` | 1d |

**Prefixes:** add `'/oidc'` and `'/.well-known'` to `CORE_API_PREFIXES` in `api/utils/routes/api-prefixes.ts`. In both tomls, add `"/oidc","/oidc/*","/.well-known","/.well-known/*"` to `run_worker_first`.

**Cron:** in `api/scheduled.ts`, map `'*/5 * * * *'` to `[healthPoll]`, from a stub `services/launch/health.ts` that 1d owns. Add the cron to both tomls and extend `tests/api/scheduled.test.ts`.

**UI:**
- Lazy routes in `ui/App.tsx`: `/apps`, `/apps/:slug` (1d); `/apps/:slug/access`, `/request-access` (1b); `/audit` (1a); `/admin/setup` (1c); `/admin/identity` (1b).
- Placeholders:
  - `ui/pages/apps/CataloguePage.tsx`, `AppDetailPage.tsx`, `AppAccessPage.tsx`
  - `ui/pages/RequestAccess.tsx`
  - `ui/pages/admin/Setup.tsx`, `Identity.tsx`
- `components/SideNav.tsx` `CORE_NAVIGATION`: an "Apps" entry, and "Audit" (admin guard) under Organisation.
- `pages/admin/AdminLayout.tsx`: Setup and Identity tabs.
- `ui/lib/query-keys.ts`: families `apps`, `appAccess`, `setup`, `oidcAdmin`, `audit`.

**Permissions:**
- Add `App` and `AuditEvent` to `CORE_SUBJECTS` in `packages/shared/src/permissions.ts`.
- In `apps/web/src/permissions/abilities.ts`: members can `read App`; admins can `manage App` and `read AuditEvent`.
- Update `tests/config/permissions.test.ts`.

**Allowlist:** pre-register `src/api/services/oidc/store.ts` in `tests/config/unscoped-allowlist.test.ts`, with the reason "the pre-tenant OIDC protocol path: client_id / code-hash lookups before any session; the tenant is then taken from the row".

**Shared zod files:** `packages/shared/src/launch-{apps,oidc,setup,audit}.ts`.

**Dependencies:** `smol-toml` (apps/web dependency), `openid-client@^6` (devDependency).

### 1a tests

- `audit.test.ts`:
  - insert and list;
  - UPDATE and DELETE raise, but a tenant delete cascades;
  - tenant isolation;
  - 401 and 403;
  - the error envelope.
- `launch-credentials.test.ts`: the stored value is sealed, and status never returns values.
- `github-app.test.ts`: the JWT verifies, PKCS#1 input works, and `User-Agent` is sent.
- A roles test: `launch_app` has no UPDATE or DELETE on `audit_events`.

## 1b: OIDC issuer (spec/05)

**Owns:**
- `routes/oidc.ts`, `routes/oidc-admin.ts`, `routes/app-access.ts`
- `api/services/oidc/{store,keys,tokens,policy,discovery}.ts`
- `packages/shared/src/launch-oidc.ts`
- `ui/pages/RequestAccess.tsx`, `ui/pages/apps/AppAccessPage.tsx`, `ui/pages/admin/Identity.tsx`
- `tests/api/oidc-*.test.ts`, `tests/api/app-access.test.ts`
- the `config.ts` refine from decision 5

### Endpoints

Ported from `spikes/s6-oidc-issuer/issuer/src/index.js`.

`GET /.well-known/openid-configuration` and `GET /.well-known/jwks.json`. The JWKS publishes keys that are next, active or retiring.

`GET /oidc/authorize`, modelled on `routes/auth/cli.ts`:
- An unknown client, or a `redirect_uri` that isn't registered, gets an HTML error page and **no redirect**.
- It requires `response_type=code`, the `openid` scope and PKCE S256.
- If `resolveCookieAuth(c)` finds no session, redirect with 302 to `/login?returnUrl=<encoded authorize URL>`. `Login.tsx` forwards `returnUrl`.
- `prompt=none` with no session returns `error=login_required`.
- If the policy denies access, redirect with 302 to `/request-access?client_id=…&return=…`.
- Otherwise:
  - generate a code with `randomToken` and store its `hashToken` hash (both in `utils/core/{hash,ids}.ts`);
  - store it in `oidc_codes` with a 60 s TTL;
  - redirect with `code`, `state` and `iss`.

`POST /oidc/token`:
- Client authentication uses Basic or post, checked against `secret_hash` in constant time.
- Codes are single-use. A replay sets `revoked_at` on the original code, so userinfo then refuses its access token.
- It checks the code belongs to this client, the `redirect_uri` matches, and PKCE verifies.
- The ES256 `id_token` carries:
  - `sub`: the Launch user id
  - email, `email_verified: true`, name
  - `groups`, from `listUserGroups` in the client's tenant
  - nonce
  - `auth_time`, from `user_sessions.created_at`
- The access token is an `at+jwt` with a `jti`. The response sets `Cache-Control: no-store`.
- Expired codes are pruned opportunistically.
- Do **not** use the IP-keyed `authRateLimit`: every app calls from shared Cloudflare egress.

`GET/POST /oidc/userinfo`.

`GET /oidc/logout`: runs `deleteSession` + `clearSessionCookie`, and only redirects to a registered post-logout URI.

### Policy, keys and access requests

**Access policy:**
- The user must be a member of the client's tenant.
- `company` allows every member.
- `restricted` requires either a user grant, or a group grant that intersects `auth.groups`.
- App owners are always allowed.

**Signing keys:**
- `ensureActiveKey` creates the first key lazily.
- `rotate()` sets the old key to `retiring` with `retire_after` = now + the maximum token lifetime + a margin, and activates the next key.
- The private JWK is sealed. The isolate caches only plain JWK data.
- `oidcAdminRouter` (global admin): list keys, and `POST /rotate`.

**Request access:**
- `POST /api/app-access/requests`
- `GET/POST /api/app-access/:appId/{policy,grants,requests/:id/decide}`, for owners and admins. Approving a request adds a user grant.

**Audit actions:** `oidc.signin`, `oidc.denied`, `oidc.code_replayed`, `app.access.requested`, `app.access.decided`, `app.access.policy_changed`, `oidc.key.rotated`.

### 1b tests

`oidc-issuer.test.ts` uses **openid-client**, with `customFetch` routed into `tests/helpers/request.ts` `request()` and the session from `createTestSession`. It covers every S6 check:
- replay, and revocation of the first code's token;
- wrong verifier;
- a code used by a different client;
- the unregistered-redirect page;
- missing PKCE;
- `login_required`;
- a policy deny leading to request-access;
- SSO across two clients;
- logout only to a registered URI;
- JWKS overlap after rotation;
- tenant isolation;
- audit rows.

`oidc-loopback.test.ts` (`// @vitest-isolate`) drives the kit's own `/auth/oidc` relying party flow against the issuer. It proves a Rocketflare 0.15 app accepts Launch as its issuer.

`app-access.test.ts` covers request access.

## 1c: setup wizard and admin credentials (spec/03, spec/04)

**Owns:**
- `routes/setup.ts`
- `api/services/launch/{setup,cloudflare,neon,resend}.ts`
- `packages/shared/src/launch-setup.ts`
- `ui/pages/admin/Setup.tsx` and `ui/pages/admin/setup/*`
- `tests/api/setup*.test.ts`

**Vendor clients** are Worker-safe and take an injected `fetch`. Use `apps/web/scripts/provision/{cloudflare-dns,neon,resend,tokens}.ts` as reference only; **don't import them**, because they depend on Node.

**Checks** return `[{id, label, status: ok|warning|failed, detail}]`.

Cloudflare (account-owned token plus account id):
- `GET /accounts/{id}/tokens/verify`
- read probes on workers scripts, KV, queues and R2
- `GET /zones?name=<apps domain>`: the zone exists, and `zone.account.id` matches
- a proxied wildcard `*` DNS record exists
- `GET /zones/{id}/workers/routes`

Write scope is reported as "warning: write scope unverified".

The other credentials:
- **Neon:** list projects (limit 1). Store `org_id` and the pinned `region_id` in `launch_settings`.
- **Resend:** `GET /api-keys` succeeds only with a full-access key. `GET /domains` must show `notifications.<apps domain>` as `verified`.
- **GitHub App:** app id, PEM and org, checked through 1a's `github-app.ts`:
  - `GET /app`;
  - the org's installation from `/app/installations`;
  - its permissions compared with the required write set: administration, contents, workflows, pull_requests, actions, environments, actions_variables, deployments;
  - the installation id stored in metadata.
- **Upstream IdP:** read-only status from `configuredProviders(cfg)`, `hasOidc` and `isOidcOnly`.

**API** (`/api/admin/setup`; the global-admin guard already applies):

| Method and path | What it does |
|---|---|
| `GET /` | Every step, with set / when / by whom, `last_check` and settings. Never returns values. |
| `PUT /settings` | Apps domain, Cloudflare account id, Neon region, notifications domain, GitHub org |
| `PUT /credentials/:kind` | Validate → seal → check → audit `credential.set` or `credential.rotated` |
| `POST /credentials/:kind/check` | Re-run the checks |
| `DELETE /credentials/:kind` | Audit `credential.removed` |

The audit tenant is `auth.tenantId ?? getSingleTenant(db)`. If neither exists, return 409.

**UI:** a stepper (Domain and zone → Cloudflare → Neon → Resend → GitHub App → IdP). Secret fields are write-only, with a "Replace" action. Status dots show each check result.

**Tests:**
- vendor happy paths and failures: zone in the wrong account, no wildcard record, domain unverified, a GitHub permission missing;
- 401 and 403;
- no secret in any response;
- audit rows;
- the stored credential is sealed.

## 1d: registry, import, catalogue, health, OIDC clients

**Owns:**
- `routes/apps.ts`
- `api/services/launch/{apps,import,rocketflare-manifest,health,oidc-clients}.ts`
- `packages/shared/src/launch-apps.ts`
- `ui/pages/apps/{CataloguePage,AppDetailPage}.tsx` and `ui/pages/apps/components/*`
- the tests

**Slugs** (spec/04): must start with a letter; must not end in `-staging`; reserved: `launch|notifications|www|api|auth|admin|mail`.

**Import** (`POST /api/apps/import {repo:"owner/name", ref?, ownerGroupId?}`, admins and above):
1. Get an installation token scoped to the repo with `contents: read`.
2. Read `.rocketflare.json`, `apps/web/wrangler.toml` and `apps/web/wrangler.staging.toml`.
3. Parse the manifest leniently with a zod passthrough: `app{slug,display,domain}`, and the kit version from `kit.version` or `kitVersion`.
4. Parse the tomls with `smol-toml`: name, `[vars].APP_URL`, and the binding ids.
5. In one transaction, write `apps` (imported, live), two `app_environments` rows and `app_operations`.
6. Audit `app.imported`.

There is no Cloudflare verification in P1.

**Health** (`health.ts`):
- Poll per tenant, at most 10 tenants at a time, following the `runPruneAiSpans` pattern.
- For each environment, `GET {url}/api/health` and `/api/ready` with a 5 s timeout.
- Status:
  - `up`: both return 200;
  - `degraded`: health returns 200 but ready doesn't;
  - otherwise `down`.
- Update the environment, insert an `app_health_checks` row, and audit `app.health.changed` only when the status changes.
- Prune checks older than 7 days.
- `POST /api/apps/:id/health-check` runs a poll immediately.

**OIDC client:**
- `POST /api/apps/:id/oidc-client` registers the client:
  - redirect URIs are `{url}/auth/oidc/callback` for each environment;
  - post-logout URIs are `{url}/login?signedOut=1`;
  - the secret comes from `randomToken` and is stored as a `hashToken` hash.
- The response returns `{clientId, clientSecret, issuer}` **once**, with a config snippet.
- `POST …/rotate-secret` and `PATCH …/redirect-uris`.
- Audit `oidc_client.created` and `oidc_client.secret_rotated`.

**API:** `GET /api/apps`, `GET /api/apps/:slug`, `PATCH /api/apps/:id`. Members can read; admins can manage.

**UI:**
- Catalogue: a table with name, team, kit version, staging and production status dots with last-checked time, and an Import modal.
- Detail page:
  - environments and resources;
  - health history and the operations log;
  - the OIDC card, with a secret shown once in a modal;
  - a link to the access page.

**Tests:**
- `apps-import.test.ts` (fetch spy; the repo's own tomls are the fixtures): bad, reserved and duplicate slugs; a missing file; audit rows.
- `apps-health.test.ts`: `dispatchScheduled('*/5 * * * *', …)` with up, degraded, down and timeout responses; pruning.
- `apps.test.ts`: tenant isolation, 401 and 403, and the secret returned once.

## Verification

Run:
- `pnpm test:db:up`
- `pnpm db:migrate`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm web build:api`

**Manual exit check on staging:**
1. Import a real Rocketflare 0.15 app and wait for green health.
2. Register its OIDC client and set the app's `OIDC_*`.
3. Sign in to the app through Launch.
4. Check the `oidc.signin` audit row.
