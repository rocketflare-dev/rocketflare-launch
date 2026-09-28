# P3 coding sessions: implementation plan

This is the P3 build plan ([spec/07](../../spec/07-coding-sessions.md), [spec/11](../../spec/11-roadmap.md) P3). It was checked against `phase-3-sessions` at 1338d35, the S7 spike ([spikes/s7-sandbox](../../spikes/s7-sandbox/RESULT.md)), and the kit at 0.15.0.

It follows the P1/P2 process:
- 3a runs first and alone;
- then 3b–3e run in parallel, with strict file ownership;
- everything is built against fakes, and nothing is deployed.

**Exit test:** a non-engineer changes a screen in the browser, sees it in the preview, and ends with a green PR.

## 1. Decisions

1. **Stable `@cloudflare/sandbox`, pinned exactly to the version S7 proved: 0.12.10**, with containers 0.3.7 and the matching `cloudflare/sandbox:<same>` base image.
   - Stable has everything needed:
     - `exec`, `startProcess` / `streamProcessLogs` / `killProcess`;
     - `waitForPort`, `containerFetch`, `setAllowedHosts`, `destroy`;
     - `outboundByHost` / `setOutboundByHost`, `interceptHttps`.
   - `@next` is still a preview.
   - The SDK is imported in exactly two files (the DO class and one adapter), behind a `SandboxPort`.
   - Set `interceptHttps = true` explicitly.
2. **The session's DO is the Sandbox subclass itself**: `SessionSandbox extends Sandbox`, reached with `getSandbox(env.SESSION_SANDBOX, session.id)`.
   - Postgres holds the state: `sessions` and `session_events`.
   - A `SessionWorkflow` instance per session drives the lifecycle: boot, then the turn loop, then ship or end.
   - This follows the kit's own pattern (AgentRunWorkflow + run-stream), survives deploys, and tests under Node.
3. **The chat is Claude Code, run headless in the sandbox.** Each message is one command, as S7 proved:

   ```
   claude -p … --resume <id> --output-format stream-json --verbose --permission-mode acceptEdits --model <policy model>
   ```

   - It runs through `startProcess` + `streamProcessLogs`; `killProcess` cancels it.
   - Pushing is disallowed (`--disallowedTools "Bash(git push:*)"`); Launch does the commits and pushes.
   - Allowed Bash commands are pre-approved in `.claude/settings.local.json`, written at boot.
   - Permission prompts in the UI, and the Agent SDK's `canUseTool`, come in P4.
4. **The model key is injected by an outbound handler on `api.anthropic.com`, in Launch's Worker.**
   - The sandbox only has `ANTHROPIC_API_KEY=launch-session-placeholder`.
   - The handler finds the session from `ctx.containerId` → `sessions.sandbox_id` (unique). That lookup is server-side, so the sandbox can't forge who it is.
   - It allows only `POST /v1/messages` and `/v1/messages/count_tokens`, and only the policy's models.
   - It checks the budget, swaps in the real key, and meters usage from the SSE or JSON response (ported from `spikes/s7-sandbox/worker/src/index.js`).
   - Usage goes through `recordUsage` (`services/ai/usage.ts`) with a new `ai_usage.session_id`. The session's totals are updated atomically.
   - **Key source:** a new admin credential `anthropic_api_key`, falling back to `cfg.ANTHROPIC_API_KEY` (in `.dev.vars` locally).
5. **The sandbox gets no GitHub token either.** An outbound handler on `github.com`:
   - allows only git smart-HTTP on the one repo;
   - injects `Authorization: Basic x-access-token:<token>` with a 1-hour installation token scoped to that repo (`contents: write`, `pull_requests: write`);
   - keeps the token sealed on the session row and re-mints it when under 10 minutes remain.

   Opening the PR and reading checks are Launch-side API calls. **Fallback:** a git credential helper reading a file that Launch refreshes each turn.
6. **Previews are gated:**
   - **Host:** `<port>-<shortId>-<token>.<preview domain>`. `shortId` is 12 base32 characters and `token` 10 random characters, stored on the row.
   - **Routing:** `worker.ts` sends preview hosts to `handlePreview()` before `app.fetch`, so no `X-Frame-Options`.
   - **Grant exchange:**
     1. `POST /api/sessions/:id/preview-grant` mints a 60 s HMAC grant `{sid, uid, host}`.
     2. The iframe loads `…/__launch/grant?g=…`.
     3. That sets the host-only cookie `__Host-launch-preview` (HttpOnly, Secure, SameSite=None; in development it is `launch-preview`, Lax, not Secure) and 302s to `/`.
   - **Every later request** checks the signature and that the host belongs to the session, using a 15 s in-isolate status cache.
   - **Proxying:** `containerFetch(req, uiPort)`, with an attempt at WebSocket upgrades for HMR.
   - **Frame and reload:** the response adds `frame-ancestors <APP_URL>`. The UI reloads the iframe after every turn.
   - **Assets trap:** `[assets]` SPA fallback would answer a preview navigation to `/` with Launch's own `index.html`. So set `run_worker_first = true` in both tomls; the Hono catch-all already serves `ASSETS`. The parity test changes to "is `true`, and `API_PREFIXES` still JSON-404".
   - **Who can view:** the creator, the app's owners and admins.
7. **Each session gets a Neon branch of the app's `dev` branch.**
   - `dev` is created `init_source: 'schema-only'` from `main`, with role `session_owner` and an empty database `session_app`.
   - A one-time **prepare** run (the same Workflow with `kind: 'prepare'`, no chat, no dev server) runs the kit bootstrap migrate + seed into `session_app`.
   - Sessions then branch from `dev`, and `session_owner`'s password is reset per branch.
   - **Locally:** `LocalSessionDb` runs `CREATE DATABASE launch_sess_<short> TEMPLATE launch_sessdev_<slug>`. The sandbox reaches it through the kit's local Neon proxy. **Superseded (2026-09-28):** a session's database is always a real Neon branch, reached directly from the sandbox with exactly its endpoint allow-listed; `LocalSessionDb` and the proxy route are gone (`docs/CONCEPTS.md` §18.10).
   - Both sit behind a `SessionDbPort`.
8. **Checkpoint, drain and rollouts:**
   - **After every turn:** Launch commits (a Launch author, with the user as `Co-Authored-By`), pushes `session/<short>`, and copies Claude's transcript `~/.claude/projects/<cwd>/<id>.jsonl` to R2 at `sessions/<id>/claude.jsonl`.
   - **After 30 minutes idle:** checkpoint, destroy the sandbox (the branch is kept), status `suspended`.
   - **Resume:** boot again from the branch, restore the transcript, and carry on with `--resume`.
   - **Drain:** `POST /api/admin/sessions/drain` sets `launch_settings.sessions_paused` (new sessions get 409) and suspends every live session. The operator deploys, then undrains, and users resume. `docs/DEPLOY.md` makes drain a required step before any deploy that touches the image or `[[containers]]`.
   - **A turn cut off by a rollout** emits `turn.interrupted`, and the session goes to `suspended`.
   - `sessions.image_version` records which image a session ran on.
9. **The image** is `apps/web/containers/session/Dockerfile`:
   - Node 24 first on `PATH`, corepack pnpm 10, and a pinned `@anthropic-ai/claude-code`;
   - a `pnpm fetch` store for `KIT_TAG=0.15.0`;
   - `EXPOSE 5173 8787` (not 3000).

   `wrangler deploy` builds and pushes it with Launch; `wrangler dev` builds it with Docker.
10. **Ship** is a ship turn using the prompt `session-ship`:
    1. run the gate, `pnpm lint && pnpm typecheck && pnpm test`;
    2. fix failures, up to N tries;
    3. print `{title, body}` JSON.

    Then Launch does a final checkpoint and `createPullRequest`, recording `pr_number` and `pr_url`. CI status comes from check runs plus the combined status. It is refreshed when read (at most every 30 s) and by the `*/5` cron while checks are pending.
11. **Budgets.** The policy is `launch_settings.session_policy`, with code defaults, snapshotted on the session row at create:

    ```
    { model, maxSessionUsd: 10, appMonthlyUsd: 200, maxConcurrentPerApp: 3,
      maxTurnMinutes: 20, idleSuspendMinutes: 30, suspendedExpiryHours: 24,
      maxSessionHours: 8, maxTurns: 100 }
    ```

    - **Per-app override:** `apps.session_monthly_budget_microcents`.
    - **At create:** app month spend and concurrency are checked; failures are 409 `session_budget_exhausted` or `session_limit`.
    - **Before each turn:** over budget moves the session to `blocked`, with `budget.reached` and audit `session.budget.reached`.
    - **Mid-turn, in the handler:** an Anthropic-shaped 403 `permission_error`.
    - **Extending:** `POST /api/sessions/:id/budget {extraUsd}`, for owners and admins, audited `session.budget.extended`.
    - Container time accumulates as `container_seconds`.

## 2. Schema and bindings

One migration: `pnpm db:generate --name launch-p3-sessions`.

### `sessions`

A tenant-scoped table (`tenantIsolation('sessions')`).

**Columns:**
- Identity and ownership: id, tenant_id, app_id (cascade), created_by_user_id.
- `kind` enum `session_kind`: session | prepare.
- short_id (unique), preview_token, title.
- `status` enum `session_status`: requested | booting | ready | working | blocked | suspended | shipping | shipped | ending | ended | failed.
- Git: base_ref, base_sha, branch, head_sha.
- Sandbox: instance_id, sandbox_id (unique).
- Database: db jsonb `{provider, projectId, branchId, host, database, role}`, db_uri_sealed.
- GitHub token: github_token_sealed, github_token_expires_at.
- Claude: claude_session_id, transcript_key.
- Runtime: image_version, policy jsonb.
- Turns: turn_count, pending_message, requested_action (ship | end | resume | null), cancel_requested_at.
- Metering: tokens_in, tokens_out, cache_read, cache_write, cost_microcents, budget_extra_microcents, container_seconds.
- PR: pr_number, pr_url, pr_checks jsonb.
- Timing: error, last_activity_at, ready_at, suspended_at, ended_at, timestamps.

**Indexes:**
- (tenant_id, app_id, created_at desc);
- a partial index on (app_id) over the active statuses, for the concurrency check.

### `session_events`

Columns: id, session_id (cascade), tenant_id, seq, turn, type, data jsonb, at. Unique (session_id, seq).

- **One writer:** the Workflow. The route stores `pending_message`, and the turn step writes `user.message` first.
- **Types:** `user.message`, `turn.start`, `text`, `tool.start`, `tool.end`, `turn.end`, `turn.failed`, `turn.interrupted`, `step`, `status`, `preview.ready`, `budget.reached`, `ship.gate`, `ship.pr`, `error`.
- The shapes match `AgentRunEvent`, so the UI's `timelineModel` and `ToolCallRow` fold them.

### Other schema changes

- `ai_usage`: `session_id` uuid FK (set null), indexed.
- `apps`:
  - `session_db` jsonb `{devBranchId, database, preparedCommit, preparedAt, status}`;
  - `session_monthly_budget_microcents` bigint (nullable).
- `admin_credentials` kind enum: add `anthropic_api_key`, and add it to `CREDENTIAL_KINDS`.
- `LAUNCH_SETTING_KEYS`: add `session_policy` and `sessions_paused`.
- Unscoped allowlist: `services/sessions/egress/*.ts` and `api/preview/gateway.ts`, with the reason "pre-tenant: sandbox id / signed preview cookie → the session row; tenant taken from the row".

### Bindings

The same in both tomls, apart from account-scoped names:

```toml
[[containers]]
class_name = "SessionSandbox"
image = "./containers/session/Dockerfile"
instance_type = "standard-3"
max_instances = 10
[[durable_objects.bindings]]
name = "SESSION_SANDBOX"
class_name = "SessionSandbox"
[[migrations]]
tag = "v2"
new_sqlite_classes = ["SessionSandbox"]
[[workflows]]
name = "launch-session"            # -staging in wrangler.staging.toml
binding = "SESSION_WORKFLOW"
class_name = "SessionWorkflow"
```

**Also in the tomls:**
- `[assets] run_worker_first = true`.
- `[vars]`: `SESSION_BACKEND = "cloud"`, `SESSION_PREVIEW_URL = "https://{label}.clewro.com"`.

**Local `.dev.vars.example`** (`loadConfig` refuses `local` unless `APP_ENV=development`):
- `SESSION_BACKEND=local`
- `SESSION_PREVIEW_URL=http://{label}.localhost:3001`
- `SESSION_LOCAL_DB_URL`
- `SESSION_LOCAL_NEON_PROXY=http://host.docker.internal:<port>`
- `SESSION_LOCAL_GIT_URL=http://localhost:9420`
- `ANTHROPIC_API_KEY`

**Worker and test wiring:**
- `worker.ts` exports `SessionSandbox`, `ContainerProxy` (outbound handlers need it) and `SessionWorkflow`, and wraps `fetch` to send preview hosts to the gateway.
- Regenerate `worker-configuration.d.ts`; the parity test checks `[[containers]]`.
- Tests alias `@cloudflare/sandbox` → `tests/mocks/cloudflare-sandbox.ts`.
- `createTestEnv` gains `SESSION_SANDBOX` (a fake namespace) and `SESSION_WORKFLOW` (`stubs(env).sessionWorkflow`).

## 3. Slices

**Rule:** only 3a runs `db:generate` or `pnpm install`, or edits these shared files:
- `api/index.ts`, `worker.ts`, `tests/mocks/bindings.ts`, `vitest.config.ts`;
- the tomls, `config.ts`, `permissions`, `query-keys.ts`, `packages/shared/*`;
- `setup.ts`, `github-app.ts`, `neon.ts`, `CORE_PROMPT_REGISTRY`.

A later slice that needs a change there stops and reports.

### 3a: foundations (runs first, alone)

**Schema and dependency:** §2, plus `pnpm --filter @launch/web add @cloudflare/sandbox@0.12.10`.

**Contracts:** `packages/shared/src/launch-sessions.ts`:
- `SESSION_STATUSES`, `ACTIVE_SESSION_STATUSES`, `SESSION_EVENT_TYPES`
- request schemas: `createSessionRequestSchema {title?, baseRef?}`, `sessionTurnRequestSchema {message ≤ 20k}`, `extendBudgetSchema`
- response schemas: `sessionSchema`, `sessionSummarySchema`, `sessionEventSchema`, `prChecksSchema`
- `sessionPolicySchema` and `DEFAULT_SESSION_POLICY`
- `SESSION_WAKE_EVENT = 'session_wake'`, with a golden test against `/^[A-Za-z0-9_-]{1,100}$/`
- pure `previewLabel()` and `parsePreviewHost()`

**Other shared changes:**
- a `Session` subject: members read their own, owners and admins manage;
- query keys `sessions.*`;
- realtime `entity.changed {entity:'session'}`;
- prompts `session-ship` and `session-system-note`.

**Ports** (`services/sessions/ports.ts`):
- `SandboxPort`: start, exec, startProcess, streamLogs, kill, waitForPort, writeFile, readFile, setAllowedHosts, fetch(port, req), destroy, id
- `SessionDbPort`: ensureDev, createBranch, deleteBranch, devUriFor
- `RepoHostPort`: gitAuth / gitUpstream, openPullRequest, getChecks
- `ModelUpstream`: `{fetch}`
- `defaultSessionPorts(env, cfg)`: the one place the ports are bound

**Vendor additions:**
- `github-app.ts`: `createPullRequest`, `getPullRequest`, `listCheckRuns`, `getCombinedStatus`.
- `neon.ts`: `createBranch` gains `initSource` and endpoints; add `deleteBranch`.
- `setup.ts`: an Anthropic credential probe; `checks: read` and `statuses: read` as required GitHub App READ permissions.

**Wiring:**
- `routes/sessions.ts`, mounted at `/api/sessions`, which mounts the stub sub-routers `routes/session-chat.ts` (3c) and `routes/session-ship.ts` (3d);
- `routes/app-sessions.ts`, on `appsRouter` before `/:slug`;
- `routes/admin-sessions.ts`, under `/api/admin/sessions`;
- stubs for `workflows/session.ts`, `durable-objects/session-sandbox.ts`, `api/preview/gateway.ts` and `services/sessions/egress/{anthropic,github}.ts`;
- the host dispatch in `worker.ts`.

**Fakes:**
- `tests/helpers/fake-sandbox.ts`: `FakeSandbox` implements `SandboxPort`.
  - Scripting: `onExec(re, result)` and `onProcess(re, lines[])`.
  - It keeps files and ports, and records `killed` and `destroyed`.
  - `interruptNext()` simulates a rollout.
- `tests/helpers/fake-anthropic.ts`: SSE and JSON message streams with usage, plus `claudeStreamJson(turn)`, shaped like `spikes/s7-sandbox/output-locked-session.txt`.
- FakeCloud extensions:
  - Neon: `init_source`, branch delete, endpoints;
  - GitHub: `POST /pulls`, check-runs, status.
- `tests/helpers/sessions.ts`: seeds an app with a repo, a Neon project and `session_db`.

**Tests:** vendor additions, the contract and golden tests, parity (containers, `run_worker_first = true`), permissions, and the env schema (`SESSION_BACKEND=local` refused outside development).

**Done when:**
- the gate is green;
- the stubs are exported and typed;
- a preview host answers a JSON 404 from the stub gateway;
- `pnpm build:api` works with `[[containers]]`. Check early whether `--dry-run` needs Docker.

### 3b: sandbox image and session runtime

**Owns:**
- `apps/web/containers/session/Dockerfile` and `.dockerignore`.
- `durable-objects/session-sandbox.ts`:
  - `interceptHttps = true`, `enableInternet = false`;
  - base `allowedHosts`: registry.npmjs.org, github.com, codeload.github.com, api.anthropic.com, plus `host.docker.internal` when local;
  - `outboundByHost` delegates to the egress functions (3c and 3d own their bodies);
  - `onStart` / `onStop` add to `container_seconds`.
- `services/sessions/sandbox/cloudflare-sandbox.ts`: the `SandboxPort` adapter.
- `services/sessions/db/{neon-session-db,local-session-db}.ts`.
- `services/sessions/rocketflare-dev.ts`: `sessionBootstrap(ctx)` for kit 0.15:
  1. `pnpm install --frozen-lockfile --prefer-offline`;
  2. `node scripts/bootstrap.mjs --db-url "$DB" --driver neon --offline --no-dev --no-open --yes`, with `DEV_UI_PORT=5173`, `DEV_API_PORT=8787`, `DEV_ALLOWED_HOSTS=.<preview suffix>`, `APP_URL=<preview origin>`, and `NEON_LOCAL_PROXY` when local;
  3. `startProcess('pnpm dev')`;
  4. `waitForPort(5173)` plus `:8787/api/health`.
- `services/sessions/lifecycle.ts`: each function is a compare-and-set on the session status.
  - `createSession`: policy and concurrency checks, the row, audit `session.created`, then `SESSION_WORKFLOW.create({id})`.
  - `requestTurn`, `requestAction`, `cancelTurn`, `drainSessions`.
- `services/sessions/steps.ts`.
- `workflows/session.ts` (`withStepDatabase` and `createStepRealtime`, as in `agent-run.ts`; every step name distinct):
  - **Boot:**
    1. `claim`;
    2. `db`: ensureDev (prepare inline if needed), then create the branch;
    3. `sandbox.start`;
    4. `repo`: clone `https://github.com/<o>/<r>.git` at depth 50, and check out or create `session/<short>`;
    5. `bootstrap`;
    6. `dev`: emits `preview.ready`.
  - **Loop:**
    1. `wait#N`: `waitForEvent(SESSION_WAKE_EVENT, idle timeout)`;
    2. dispatch on the row to one of: `turn#N` (3c), `checkpoint#N`, `suspend#N`, `resume#N` (boot again with `#K` suffixes), `ship` (3d) or `end`.
  - **`cleanup`** always runs: destroy the sandbox and delete the branch.
- `routes/sessions.ts` (the lifecycle part), `routes/app-sessions.ts`, `routes/admin-sessions.ts`.
- Cron task `sessions.expire` on `*/5`: a suspended session past its expiry is ended.
- `docs/SESSIONS-LOCAL.md` and the local scripts:
  - `scripts/sessions-local-git.mjs`: git smart-HTTP on :9420;
  - `sessions:local-app`;
  - `scripts/sessions-smoke.mjs`.

**Reuses:** `NeonClient`, `installationToken` + `loadImportGitHub` (`import.ts`), `recordAudit`, `encryptToken`, `createFakeWorkflowStep`, `getAppRow`, and the owner check in `mayDeployApp` (`services/launch/apps.ts`).

**Tests:**
- `session-workflow.test.ts` (isolated; FakeSandbox + FakeCloud):
  - the boot order and step names;
  - no secret in any step result or event;
  - a failure at `bootstrap` destroys the sandbox and deletes the branch;
  - idle → suspend → resume clones again and restores the transcript;
  - `interruptNext` → `turn.interrupted` → suspended.
- `sessions-routes.test.ts`: 401 and 403, tenant isolation, 409 for concurrency, 409 when paused, 503 without `SESSION_WORKFLOW`.
- `session-db.test.ts`.
- `tests/config/session-bootstrap.test.ts`: never port 3000.

**First task: verify** that `wrangler dev` honours `outboundByHost`, `interceptHttps` and `allowedHosts` for local containers. If it doesn't, the local-only fallback is:
- `ANTHROPIC_BASE_URL=http://host.docker.internal:3001/__sessions/model/<sandboxId>`, a dev-only route calling the same `handleAnthropic`;
- a git `insteadOf` pointing at the local git server.

### 3c: chat streaming, model proxy, metering and budgets

**Owns:**
- `services/sessions/claude-stream.ts`: the pure `mapClaudeLine(line) → SessionEventInput[]`, plus the command builder.
  - system init → `claude_session_id`;
  - assistant text / tool_use → `text` / `tool.start`;
  - a user tool_result → `tool.end`;
  - `result` → `turn.end` with usage.
- `services/sessions/turn.ts`: `runTurn(db, ports, session)`, with step config `retries: 0` and `timeout: maxTurnMinutes`:
  1. check the budget;
  2. write `user.message` and `turn.start`;
  3. start the process and stream it, batching inserts every 250 ms or 20 events;
  4. poll `cancel_requested_at` every 2 s and `kill` if set;
  5. enforce the timeout;
  6. end with `turn.end`, `turn.failed` or `turn.interrupted`.
- `services/sessions/egress/anthropic.ts`: `handleAnthropic(req, env, ctx, {upstream, openDb, now})`.
- `services/sessions/budget.ts`: `sessionSpend`, `appMonthSpend`, `checkBudget`, `extendBudget`.
- `services/sessions/model-key.ts`.
- `services/sessions/session-stream.ts` and `agui-projection.ts`: these copy the four rules of `services/agents/run-stream.ts`, reusing:
  - `runStreamTickMs` and `RUN_STREAM_*`;
  - `createAguiEncoder` / `kitCustom` (`services/ai/agui.ts`);
  - `streamDatabase`;
  - id-on-last-frame and `?afterSeq`.
- `routes/session-chat.ts` (mounted by 3a):
  - `POST /:id/turns`: 202, or 409 `turn_in_progress`;
  - `POST /:id/cancel`;
  - `GET /:id/agui/stream`;
  - `GET /:id/events`;
  - `POST /:id/budget`.

**Tests:**
- `claude-stream.test.ts`, with fixtures from the S7 output.
- `session-model-proxy.test.ts`:
  - the key is swapped, and the placeholder never reaches upstream;
  - an unknown `containerId` → 403;
  - a path or model outside the allowlist → 403;
  - usage rows and totals are written;
  - over budget → 403 with no upstream call.
- `session-turn.test.ts`: cancel kills the process, timeout, event order.
- `session-stream.test.ts`: `afterSeq`, no `RUN_ERROR` on its own failure, 404 for another tenant.

### 3d: preview gateway, ship and PR

**Owns:**
- `api/preview/gateway.ts`: grant, cookie, proxy and HMR upgrade.
- `services/sessions/preview.ts`: HMAC via WebCrypto, with the key derived by HKDF from `OAUTH_ENCRYPTION_KEY` (info `launch-preview`); `mintGrant`, `verifyCookie`.
- `services/sessions/egress/github.ts`.
- `services/sessions/repo/{github-repo-host,local-repo-host}.ts`.
  - `LocalRepoHost` rewrites `github.com/<o>/<r>.git` to `SESSION_LOCAL_GIT_URL` inside the handler.
  - `openPullRequest` writes the PR fields on the row (`local://…`).
  - `getChecks` reports the ship gate's result.
- `services/sessions/ship.ts`:
  1. run the ship turn and parse `{title, body}`;
  2. checkpoint;
  3. open the PR;
  4. mark `shipped` and audit `session.shipped`;
  5. `refreshChecks`.
- `services/sessions/checkpoint.ts`: commit, push, and the transcript → R2 (`createR2Storage(env.FILES)`).
- `routes/session-ship.ts`: `POST /:id/ship`, `POST /:id/end`, `POST /:id/preview-grant`, `GET /:id/pr`.
- Cron task `sessions.checks`.

**Tests:**
- `preview-gateway.test.ts`:
  - no cookie → 401;
  - a forged cookie, or another session's, → 401;
  - a grant replayed on another host → 401;
  - a valid grant → 302 + cookie, then proxied;
  - an ended session → 410;
  - no `X-Frame-Options`.
- `session-github-egress.test.ts`: another repo is refused; the token is re-minted near expiry.
- `session-ship.test.ts`: a red gate → no PR and a `ship.gate` event; a green gate → a PR with head `session/<short>`; pending checks → success.
- `session-checkpoint.test.ts`.

### 3e: UI and CLI

**Owns:**
- `ui/pages/sessions/SessionPage.tsx` at `/apps/:slug/sessions/:id`: a split pane, chat on the left and preview on the right.
- `ui/pages/sessions/components/`:
  - `SessionChat.tsx`: reuses `ChatBubble` / `Markdown` (`components/ai`) and `ToolCallRow` + `buildTimeline` (`pages/agents/run/timeline/*`);
  - `PreviewFrame.tsx`: reloads on `turn.end`;
  - `SessionHeader.tsx`: status, cost against the cap, Ship / End / Resume;
  - `ShipPanel.tsx`;
  - `BootProgress.tsx`.
- `ui/hooks/useSessionStream.ts` and `ui/lib/sessionAguiStream.ts`, modelled on `useRunStream.ts` / `runAguiStream.ts`.
- `pages/apps/components/SessionsCard.tsx`, with "Start session", added to `AppDetailPage.tsx`.
- `pages/admin/SessionsAdmin.tsx`: live sessions and Drain.
- `apps/cli/src/commands/sessions.ts`: `start | say --follow | ship --wait | end | ls | preview-url`.

**Tests:** `tests/ui/session-page.test.tsx`, using `tests/ui/helpers/sse.ts`, and the CLI tests.

### 3f (optional): `SandboxScaffoldRunner`

This implements `ScaffoldRunnerPort` (`services/launch/scaffold/runner.ts`) and is swapped in through `defaultPorts()`.
- A `SessionSandbox` named `scaffold-<ticketId>`, with only github.com and npm allowed, runs `SCAFFOLD_SCRIPT --token-from-env`.
- `poll` reads the process's exit.

## 4. Local end-to-end

**Automated:** `tests/api/session-e2e.test.ts` (`// @vitest-isolate`), with FakeCloud as the global fetch, FakeSandbox and fake Anthropic.
1. `POST /api/apps/:id/sessions`, then drive `SessionWorkflow.run` with `createFakeWorkflowStep({onWait})`.
2. `onWait` posts a turn. FakeSandbox's `claude` emits stream-json, and the test calls `handleAnthropic` with the sandbox's `containerId`, so usage is recorded.
3. Preview: grant → gateway → 200.
4. Ship: the gate passes, a PR appears, checks succeed.
5. End.

**Assertions:**
- the audit chain runs `session.created` → `session.shipped` → `session.ended`;
- the `ai_usage` rows for the session add up to the session's totals;
- no key appears in any event;
- the branch is deleted and the sandbox destroyed.

**Variants:** over budget, cancel, a rollout interrupt, idle suspend then resume.

**A real container, locally** (the full procedure goes in `docs/SESSIONS-LOCAL.md`):

```bash
pnpm dev:db:up --neon && pnpm db:migrate
# .dev.vars: SESSION_BACKEND=local, SESSION_PREVIEW_URL=http://{label}.localhost:3001, SESSION_LOCAL_DB_URL,
#            SESSION_LOCAL_NEON_PROXY=http://host.docker.internal:<port>, SESSION_LOCAL_GIT_URL=http://localhost:9420, ANTHROPIC_API_KEY
pnpm sessions:local-git serve &
pnpm sessions:local-app --slug demo --from /Users/clifton/work/rocketflare --ref 0.15.0
pnpm dev     # wrangler dev builds the session image the first time
pnpm sessions:smoke --app demo --message "Change the Home page heading to 'Hello from Launch'"
```

Then check:
- the pushed `session/<short>` branch;
- the `ai_usage` rows;
- the container is gone after End;
- no `sk-ant-api` in the container's env;
- the `launch_sess_*` database is gone.

## 5. What is left for real infrastructure

1. **Cloudflare:**
   - image build and push (amd64), first-start latency, and `max_instances`;
   - whether `ctx.containerId` equals the recorded id;
   - git smart-HTTP through `interceptHttps`;
   - `wss://` to the Neon branch;
   - Vite HMR through `containerFetch`;
   - `run_worker_first = true` and the preview catch-all route;
   - `SameSite=None` cookies inside the iframe;
   - whether a deploy stops running sandboxes.
2. **Neon:**
   - `init_source: schema-only`;
   - `session_owner` inheritance and the per-branch password reset;
   - branch caps (10/25, against `maxConcurrentPerApp` 3).
3. **GitHub:**
   - `checks: read` and `statuses: read`;
   - rulesets that limit pushes to `session/*`;
   - PRs opened by the App triggering `ci.yml`.
4. **Anthropic:** the real key, the model allowlist and pricing, and the handler's streaming overhead.
5. **The exit run on staging**, then a drain → deploy → resume rehearsal.
