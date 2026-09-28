# P4 approvals and shipping: implementation plan

This is the P4 build plan ([spec/08](../../spec/08-approvals-audit-ship.md), [spec/11](../../spec/11-roadmap.md) P4, [spec/12](../../spec/12-open-questions.md) #7, #9, #16). It was checked against `phase-4-approvals` at 2276a7e and the kit's `deploy.yml` / `scripts/deployer.mjs` at 0.15.0.

It follows the P1–P3 process:
- 4a runs first and alone;
- then 4b–4f run in parallel, with strict file ownership;
- everything is built against fakes, and nothing is deployed.

**Exit test:** a production deploy waits in the Launch inbox and is released by the approval. The audit log shows the whole chain from PR to production.

## 1. Decisions

1. **One engine, four stand-ins retired.** `approval_requests` + `approval_decisions` replace:
   - `app_access_requests` (P1) → kind `app.access`;
   - the `deploy_tickets` decide route and "Deploy to production" pre-approval (P2) → `deploy.production`;
   - the `app_create_role` 403 (P2) → `app.create`;
   - `POST /api/sessions/:id/budget` (P3) → `session.budget`.

   `grant.request`, `config.change` and `app.teardown` are named in the contract but not built (P5/P6). Why: one inbox, one audit shape, one approver rule.
2. **The engine is generic; kinds are handlers.** `services/approvals/engine.ts` knows nothing about apps or deploys. Each kind is a `KindHandler` in `services/approvals/kinds/<kind>.ts`:
   - `defaultPolicy`, `describe()` (the inbox's context), `eligibleExtra()`;
   - `applyInTx(tx, req)` for database effects (ticket CAS, grant, budget);
   - `applyAfter(req, deps)` for vendor effects (publish a release, dispatch, start a Workflow, wake a session).

   Why: spec/12 #16 keeps the engine liftable into a plugin later.
3. **Decide is one transaction; vendor effects run after commit.**
   1. `SELECT … FOR UPDATE` the pending request.
   2. Check eligibility (evaluated now: owners and group membership) and the excluded set.
   3. Insert the decision (unique `(request_id, user_id)` → 409 `already_decided`).
   4. One reject vetoes. N approvals approve.
   5. `applyInTx`, then audit `approval.decided` (+ `approval.approved|rejected`), all in the same transaction.

   After commit, `applyAfter` runs with `applied_at` as a compare-and-set. A failure sets `apply_error`, and the `*/5` sweep retries up to 5 times, then audits `approval.apply_failed` and notifies. Why: a deploy decision must be on the ticket before the job's next 10 s poll, and nothing external should run inside a transaction.
4. **No Workflow waits on an approval.** Every waiter already polls or is woken:
   - the deploy job polls `GET /ci/deploy/:id`;
   - a session is woken with `wakeOrRestart`;
   - `app.create` starts `APP_LAUNCH_WORKFLOW` only on approval.

   Why: spec/08's `waitForEvent` adds nothing here, and it would add a binding.
5. **Policies** live in `approval_policies`, per kind, at scope `tenant | group | app`. They are resolved app → the app's owner group → tenant → code default.
   - **Fields:** `approvers {appOwners, admins, groupIds[], userIds[]}`, `minApprovals` (N), `allowSelfApproval` (default false), `expiresAfterMinutes`, `autoApproveRole` (`member|admin|owner|null`).
   - **At open:** the policy is snapshotted onto the request.
   - **Who edits:** only admins, at every scope. Why: an owner loosening their own production gate defeats it.
6. **"Approver is not the author" is enforced** through `excluded_user_ids`, snapshotted at open:
   - the requester;
   - the person who clicked Release or Promote;
   - the creators of the sessions whose PRs are in the release.

   GitHub-only authors are not mapped to Launch users (a known gap).
7. **Defaults** (code):

   | Kind | Approvers | Auto-approve | Expiry |
   |---|---|---|---|
   | `app.create` | admins | `autoApproveRole` = `launch_settings.app_create_role ?? 'admin'` | 7 days |
   | `app.access` | owners + admins (P1 parity; `0024` widens the rows `0023` moved) | — | 14 days |
   | `deploy.production` | owners + admins, N=1, not self | — | 24 h, or the ticket's `expires_at` |
   | `session.budget` | owners + admins | — | the session's `suspendedExpiryHours` |

   So members who got 403 before now *ask*, which is spec/12 #7 without silently opening creation to everyone. Staging stays automatic in the gateway and outside the engine (spec/12 #9).
8. **Release and promote in Launch** follow the kit's release dance: a tag starts `staging`, and a published GitHub Release starts `production`.
   - **Release** (`POST /api/apps/:id/releases {bump}`, owners):
     1. read the root `package.json` on the default branch;
     2. `commitFiles` the bump (the job refuses a tag that doesn't equal the version);
     3. `createRef refs/tags/X.Y.Z`;
     4. `compareCommits(prevTag…sha)` + `listPullRequestsForCommit` (capped at 100) → `app_releases.prs`;
     5. audit `release.created`, plus `pr.merged` for any PR not yet recorded.
   - **Promote** (`POST …/releases/:rid/promote`) needs staging `lastDeployVersion` = the release and staging `up`. It opens `deploy.production` with the subject `release`.
   - **On approval:**
     1. `insertIntent` bound to `ref = refs/tags/X.Y.Z` and `approval_id`;
     2. `createRelease` on the tag;
     3. the production run's `start` claims the intent (it must match `ref`) → approved at once → upload → activate.
   - Why promote-first: the approval happens before any runner is waiting, so the job's `WAIT_SECONDS` (default 300) stops mattering.
9. **A job-originated production ticket** (a release published or dispatched by hand in GitHub) still opens `pending`. `startDeploy` then opens a `deploy.production` request with subject `deploy_ticket`, expiring with the ticket. Approval runs `decidePending(source: 'approval')` in `applyInTx`. If the ticket is no longer pending, decide answers 409 `deploy_run_gone`, and the approver uses Promote. Re-dispatch-on-approval is deferred.
10. **GitHub: poll, not webhooks.** Launch performs the tag and the release itself, so only the merge is external.
    - `sessions.checks` keeps reading a shipped session's PR until it is merged or closed (≤14 days), and audits `pr.merged` with the merge SHA.
    - Release's compare catches every non-session PR.

    Why: webhooks need a public endpoint, a secret and replay handling. Deferred to P6 with SIEM.
11. **The audit chain is linked, not inferred.**
    - `deploy_tickets.release_id` is set at `start` by matching the run's tag to `app_releases.tag`.
    - Every approval audit carries `approval_id`.
    - `GET /api/apps/:id/releases/:rid/chain` returns, in time order: the PRs' `session.*` and `pr.merged`, `release.*`, both tickets' `deploy.*`, and the approval's `approval.*`.
12. **Hash chain: yes, sealed by cron.** spec/08 lists it with export.
    - `audit_chain(tenant_id, seq, audit_event_id, prev_hash, hash)` is appended by `audit.seal` (`*/5`, `pg_advisory_xact_lock` per tenant, batches of 1,000).
    - `hash = sha256(prev_hash ‖ canonical JSON of the row)`.
    - `GET /api/audit/verify` and `GET /api/audit/export?format=csv|json` carry `seq` and `hash`.

    Why a sealer rather than a trigger: a trigger would serialise every audit insert in the tenant behind one lock. Tampering becomes evident within 5 minutes, not instantly.
13. **Notifications:**
    - **In app:** `notifyMany` to the eligible approvers (`approval_requested`) and to the requester (`approval_decided`, `approval_expired`); `notificationLink` → `/approvals/:id`; realtime `entity.changed {entity:'approval'}`.
    - **Email:** the kit's `email.send` job with an `emailShell` template, to approvers on open and to the requester on decision.
    - Approving by email reply or Slack is out of scope (spec/08).
14. **Session permission prompts (`canUseTool` / `--permission-prompt-tool`) are NOT P4.** Why:
    - they are questions to the session's own driver mid-turn, not a second person's approval;
    - they need an MCP permission tool in the sandbox calling back into Launch (a new egress path) while a `turn#N` step holds its timeout;
    - the sandbox is already network-locked, with Launch doing every push.

    They belong in a small P4.5 or P6 slice that reuses the `agent_run_interrupts` pattern with a `session_id` sibling column (the schema's own comment describes that migration) and `ActionRequiredPanel`.
15. **Reused from issue #17:** the CAS-on-`pending` settle and unique-key idempotency (`services/agents/interrupts.ts`), a text column typed by a shared closed set, `ActionRequiredPanel`'s behaviours (409 as info, no optimistic write, no buttons for non-approvers, `expiryState` from `pages/agents/run/interrupts/expiry.ts`) and `notificationLink`.

## 2. Schema and bindings

One migration: `pnpm db:generate --name launch-p4-approvals`, with hand-written SQL appended (as P1 did for the audit trigger).

### `approval_requests` (tenant)

**Columns:**
- id, tenant_id;
- `kind` text typed by `APPROVAL_KINDS`, `app_id` (cascade, nullable), `subject_type`, `subject_id`;
- `status` text (`pending|approved|rejected|expired|cancelled`);
- `requested_by_user_id` (set null), `requested_by_label` (`github:<actor>` for CI), `reason`;
- `context` jsonb (`approvalContextSchema`), `policy` jsonb, `required_approvals`, `excluded_user_ids` jsonb;
- `expires_at`, `decided_at`, `applied_at`, `apply_error`, `apply_attempts`, timestamps.

**Indexes:**
- unique pending `(tenant_id, kind, subject_type, subject_id) WHERE status='pending'`, so an open is idempotent;
- `(tenant_id, status, created_at desc)`;
- `(tenant_id, app_id, created_at desc)`.

### `approval_decisions` (tenant, append-only)

Columns: id, tenant_id, request_id (cascade), user_id (no FK, as in `audit_events`), user_email, decision `approve|reject`, comment ≤1000, at.

- Unique `(request_id, user_id)`.
- The `audit_events` trigger function is attached, and the table is added to `APPEND_ONLY_TABLES` in `scripts/db-roles.ts`.

### `approval_policies` (tenant)

Columns: id, tenant_id, kind, scope_type, scope_id, approvers jsonb, min_approvals, allow_self_approval, expires_after_minutes, auto_approve_role, updated_by_user_id, timestamps.

- Unique `(tenant_id, kind, scope_type, scope_id)` with `.nullsNotDistinct()`.

### `app_releases` (tenant)

Columns: id, tenant_id, app_id (cascade), version, tag, sha, previous_tag, prs jsonb `[{number, title, author, mergedAt, mergeSha, sessionId?}]`, status, created_by_user_id, approval_id, staging_ticket_id, production_ticket_id, error, timestamps.

- `status` is the enum `release_status`: `tagged | staging | staging_active | awaiting_approval | promoting | production_active | rejected | failed`.
- Unique `(app_id, tag)`.

### `audit_chain` (tenant, append-only)

Columns: tenant_id, seq bigint, audit_event_id uuid unique (FK cascade), prev_hash, hash, sealed_at.

- The primary key is `(tenant_id, seq)`.

### Other schema changes

- **`deploy_tickets`:** add `release_id` and `approval_id` (set null). `DEPLOY_DECISION_SOURCES` gains `'approval'`, appended.
- **Appended SQL:**
  1. copy the pending `app_access_requests` into `approval_requests` (kind `app.access`, subject `user`);
  2. drop `app_access_requests` and its enum;
  3. attach the append-only triggers.
- **Unscoped allowlist:** `services/approvals/sweep.ts` and `services/launch/audit-chain.ts`, with the reason "cron: iterates tenants, every write names the row's tenant".

### Bindings

None new. The `*/5` cron gains `approvals.sweep` (expiry + apply retries) and `audit.seal`; both tomls are unchanged.

## 3. Slices

**Rule:** only 4a runs `db:generate` or edits the shared files:
- `api/index.ts`, `scheduled.ts`, the `db/schema` index;
- `packages/shared/*`, `permissions`, `query-keys.ts`;
- `github-app.ts`, `tests/helpers/fake-cloud/github.ts`;
- `db-roles.ts`, `notificationLink.ts`, `App.tsx`, `SideNav.tsx`.

A later slice that needs a change there stops and reports.

### 4a: foundations (runs first, alone)

**Schema:** §2, with `rls-coverage` and `schema-invariants` green.

**Contracts:**
- `packages/shared/src/launch-approvals.ts`:
  - `APPROVAL_KINDS`, `APPROVAL_STATUSES`;
  - `approvalPolicySchema` and `DEFAULT_APPROVAL_POLICIES`;
  - `approvalRequestSchema`, `approvalDetailSchema` (with decisions, `canDecide`, `whyNot`);
  - `decideApprovalSchema {decision, comment?}`, `approvalListQuerySchema {box: mine|requested|all, status, kind, appId}`;
  - `approvalContextSchema`, a discriminated union per kind.
- `packages/shared/src/launch-releases.ts`: `createReleaseSchema {bump: patch|minor|major}`, `releaseSchema`, `releaseChainSchema`.
- Audit: `auditVerifySchema`, `auditExportQuerySchema`.

**Other shared changes:**
- permission subjects: `Approval` (members read; the service filters rows) and `ApprovalPolicy` (admins manage);
- query keys `approvals.*` and `releases.*`;
- `notificationLink` cases `approval_requested`, `approval_decided` and `approval_expired`.

**Engine skeleton:**
- `services/approvals/{engine,policy,notify,sweep}.ts`, with typed stubs;
- `services/approvals/kinds/index.ts`: the registry, with stub handlers `app-create.ts`, `app-access.ts`, `deploy-production.ts`, `session-budget.ts`.

**Vendor additions** (`github-app.ts`): `createRef`, `createRelease`, `getReleaseByTag`, `compareCommits`, `listPullRequestsForCommit`. FakeCloud GitHub gains refs, releases, compare, commit→pulls, `merged_at`, and the `merge()` / `publish()` test hooks.

**Wiring:**
- routers mounted as stubs:
  - `routes/approvals.ts` at `/api/approvals`;
  - `routes/admin-approval-policies.ts` at `/api/admin/approval-policies`;
  - `routes/app-releases.ts` on `appsRouter` before `/:slug`;
- the two cron tasks registered as no-ops.

**Tests:** contracts, github-app, the append-only triggers, the migrated access rows, permissions.

**Done when:** the gate is green, the stubs are typed and mounted, and `/api/approvals` answers `{items:[]}`.

### 4b: engine, policies, notifications

**Owns:** `services/approvals/{engine,policy,notify,sweep}.ts`, `routes/approvals.ts`, `routes/admin-approval-policies.ts`, `services/approvals/email.ts`.

**Engine** (`engine.ts`):
- `open(db, {kind, subject, appId, requester, context, excluded})`:
  - resolves the policy;
  - auto-approves if `autoApproveRole` is met (still a request row, `decided_by: system`, audited);
  - an idempotent insert;
  - audit `approval.requested`;
  - notify.
- `decide`, `cancel` (requester or admin), `expire`, `list(box)`, `detail`.

**Also:**
- **Policy** (`policy.ts`): `resolvePolicy(db, tenantId, kind, appId)` and `eligibleApprovers(db, req)`, reusing `isAppOwner` / `memberGroupIds` (`services/oidc/policy.ts`) and `isGlobalAdmin`.
- **Notify** (`notify.ts`): `notifyMany`, `nudgeUsers`, and `enqueueJob(email.send)` with `emailShell` (`services/email.ts`).
- **Sweep** (`sweep.ts`): expire due requests (kind `onClosed`), then retry `applyAfter` where `approved AND applied_at IS NULL AND apply_attempts < 5`.

**Routes:**
- `GET /api/approvals?box=&status=&kind=&appId=`, `GET /count` (the badge), `GET /:id`;
- `POST /:id/decide` (403 `not_an_approver` / `self_approval`; 409 `already_decided` / `not_pending`);
- `POST /:id/cancel`;
- `GET|PUT|DELETE /api/admin/approval-policies[/:id]`, audited `approval.policy.set|removed`.

**Tests:** `approvals-engine.test.ts`:
- N=2 needs two different people;
- a single reject vetoes;
- the requester and the excluded are refused;
- a racing decide gives one 200 and one 409;
- expiry;
- `applyAfter` failure → sweep retry → `apply_failed`;
- an auto-approved request.

Also `approvals-routes.test.ts` (tenant isolation, visibility) and `approval-policies.test.ts` (resolution order, admin only).

### 4c: the stand-ins moved onto the engine

**Owns:**
- `kinds/{app-create,app-access,session-budget}.ts`;
- the request/decide half of `services/oidc/policy.ts` (`requestAccess`, `listRequests`, `decideRequest` → engine);
- the request handlers of `routes/app-access.ts`;
- the create handler of `routes/app-pipeline.ts`;
- the budget handler of `routes/session-chat.ts`;
- `services/sessions/budget.ts`.

**The kinds:**
- **`app.access`:** `applyInTx` = `addGrant` (user). The `/request-access` flow is unchanged for the requester. `GET /:app/requests` now reads approvals, and `/:app/requests/:id/decide` is removed (410 with a pointer).
- **`app.create`:**
  - `POST /api/apps` writes the app as `requested` plus `app.create.requested`, then `open`;
  - auto-approve → `applyAfter` starts `APP_LAUNCH_WORKFLOW` exactly as today (→ 202);
  - otherwise 202 `{approvalId}`, with the app `requested`;
  - reject/expire → the app `archived` with `app.create.rejected`.
  - `meetsAppCreateRole` survives only as the code default.
- **`session.budget`:**
  - `POST /api/sessions/:id/budget {extraUsd, reason?}` opens (or joins) a request whose requester is the session's creator;
  - if the caller is an eligible approver other than the requester, their approve is recorded in the same call (the P3 one-click behaviour);
  - `applyInTx` = `extendBudget`, and `applyAfter` = `wakeOrRestart`.

**Tests:** `app-access.test.ts` and `sessions-routes.test.ts` updated, plus:
- `approvals-kinds.test.ts`: a member creates an app → pending → an admin approves → the Workflow starts; the creator extending their own session waits for an owner.

### 4d: releases, promote, and the production gate

**Owns:**
- `kinds/deploy-production.ts`;
- `services/launch/releases/{release,promote,prs,chain}.ts`;
- `routes/app-releases.ts`;
- `deploy/{gateway,tickets,decisions}.ts`, `routes/app-deploys.ts`;
- `services/sessions/checks-cron.ts`.

**Services:**
- **Release** (`release.ts`): the bump commit, tag, PR list and audits (§1.8), reusing `installationFor` / `installationToken` / `commitFiles` / `revokeInstallationToken`.
- **Promote** (`promote.ts`): the staging preconditions, then `open(deploy.production, subject release)`, with context `{version, tag, sha, compareUrl, prs[+checks], stagingHealth, stagingVersion}`.
- **The kind:**
  - `applyInTx`: a release subject gets the intent (`insertIntent` + `ref` + `approval_id`); a ticket subject gets `decidePending(source:'approval')`.
  - `applyAfter`: a release subject → `createRelease` (idempotent by `getReleaseByTag`).
  - `onClosed`: the release goes `rejected`; a ticket subject → `expirePending`, or a rejection.

**Changes to the P2 deploy code:**
- **`tickets.ts`:** `claimIntent` requires `ref IS NULL OR ref = run.ref`.
- **`gateway.ts` `startDeploy`:** sets `release_id` from the tag. A production `pending` ticket opens the approval (the requester label is `github:<actor>`, the excluded set is the release's).
- **`activateDeploy`:** moves the release to `staging_active` / `production_active`, audited `release.staging_active` / `release.production`.
- **`decisions.ts`:**
  - `decideDeploy` becomes a thin redirect to `engine.decide` on the ticket's approval;
  - `requestProductionDeploy` opens `deploy.production` with subject `app` and ref the default branch (approve → intent + `dispatchWorkflow`), so an imported app without releases can still ship.
- **`checks-cron.ts`:** follows shipped PRs to merge → `pr.merged`.

**Routes:** `GET|POST /api/apps/:id/releases`, `GET …/:rid`, `POST …/:rid/promote` and `GET …/:rid/chain`.

**Tests:**
- `releases.test.ts`: the bump, tag, PR list and idempotent release.
- `deploy-approval.test.ts`:
  - promote → approve → claim → activate;
  - an intent for tag A is not claimable by a run on tag B;
  - the author can't approve;
  - a job-originated ticket approved within its window, and 409 after;
  - reject → the release is `rejected` and no GitHub release exists.
- `ci-deploy*.test.ts` updated.

### 4e: audit chain and export

**Owns:** `services/launch/audit-chain.ts` (seal, verify, canonicalise), the `audit.seal` task body, the export and verify handlers in `routes/audit.ts`, and `apps/cli/src/commands/audit.ts` (`launch audit export --format --out`, `launch audit verify`).

**Export:** streams CSV or JSON Lines with `seq`/`hash` for sealed rows, and `hash: null` for unsealed ones. Admin+, audited `audit.exported`.

**Tests:** `audit-chain.test.ts`:
- sealing is deterministic across batches;
- concurrent seals don't fork (the advisory lock plus the unique `seq`);
- verify finds a row altered with the trigger disabled (as the owner, in the test);
- the export round-trips.

### 4f: UI

**Owns:**
- `ui/pages/approvals/{InboxPage,ApprovalPage}.tsx` and `components/{ApprovalPanel,ApprovalContext,DecisionList}.tsx`;
- `ui/hooks/useApprovals.ts`;
- `pages/admin/ApprovalPolicies.tsx`;
- `pages/apps/components/{ReleasesCard,ReleaseChain,PromoteButton}.tsx`, plus edits to `DeploysCard.tsx`, `AppAccessPage.tsx` and `AppDetailPage.tsx`;
- the session header's "Ask for more budget";
- the Audit page's Export/Verify;
- `apps/cli/src/commands/{approvals,releases}.ts`.

**Behaviour:**
- **Inbox:** `/approvals` with the tabs Waiting on me / Requested by me / All (admins), and a nav badge from `/count` refreshed by the realtime nudge.
- **`ApprovalPanel`:** follows `ActionRequiredPanel`'s rules and shows N-of-M progress and the reason a person may not decide.
- **CLI:** `launch approvals ls|show|approve|reject` and `launch releases ls|create|promote [--wait]`.

**Tests:**
- `tests/ui/approvals-inbox.test.tsx`: tabs, a 409 shown as info, no buttons for the ineligible;
- `release-chain.test.tsx`;
- the updated `apps-pages` / `session-page` tests;
- the CLI tests.

## 4. Local end-to-end

**Automated:** `tests/api/approvals-e2e.test.ts` (`// @vitest-isolate`), with FakeCloud as the global fetch and the `tests/helpers/deploy-gateway.ts` and `github-oidc.ts` helpers.

**Setup:** alice and bob own the app. Alice's shipped session has PR #1.

1. FakeCloud `merge(#1)`, then the `sessions.checks` cron → `pr.merged`.
2. Alice `POST /releases {bump:'patch'}` → the tag `0.1.1` in FakeCloud and `prs=[#1]`.
3. A staging run on `refs/tags/0.1.1`: start → upload → activate → finish. The release is `staging_active`.
4. Alice promotes. The request is pending, bob has a notification and an `email.send` job, and alice's decide gets 403 `self_approval`.
5. Bob approves. FakeCloud has a published release, and the intent is bound to the tag.
6. The production run on the same tag claims the intent, then upload → activate → finish. The release is `production_active`.
7. `audit.seal`, then `GET /api/audit/verify` → ok.

**Assertions:**
- `/chain` returns, in order: `session.shipped` → `pr.merged` → `release.created` → `deploy.started`/`deploy.activated` (staging) → `approval.requested` → `approval.decided` → `approval.approved` → `deploy.started`/`deploy.activated` (production) → `release.production`;
- the approval rows carry `approval_id`;
- no migrator URL appears anywhere.

**Variants:** reject, expiry, N=2, and a job-originated ticket (approved in its window; 409 after).

**Browser pass:** `pnpm dev`, two dev-login users, `SESSION_BACKEND=local`: an `app.access` request, a `session.budget` request from a blocked session, and a member's `app.create` each reach the other user's inbox and bell, and each decision takes effect.

## 5. What is left for real infrastructure

1. **GitHub:**
   - a tag ref created by the App triggers `deploy.yml` staging, and a release it publishes triggers `release: published`;
   - the production job's OIDC `ref` on a release event is `refs/tags/X.Y.Z`;
   - branch protection or rulesets must let the App push the version bump to `main` (a bypass for the App, or a release PR instead);
   - rate limits on compare/pulls for large releases.
2. **Timing:** `WAIT_SECONDS` against human latency on the job-originated path.
3. **Email** through Resend; **Neon:** `audit.seal` advisory locks over the WebSocket pool.
4. **The exit run on staging:** a real session PR → merge → Release → staging → Promote → a second owner approves → production. Then export and verify the log.
