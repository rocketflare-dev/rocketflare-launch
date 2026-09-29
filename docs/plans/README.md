# Build status

Updated 2026-09-29. P0–P5 are built and the P6 plan is written. The next piece of work is making sessions ship (issue #1); see "Next, in order".

## Where things are

**Launch.** All work is on the local branch `phase-5-grants`. The phase branches are stacked:

```
main → phase-0-seed → phase-1-foundation → … → phase-5-grants
```

- Nothing is pushed or merged into `main`.
- Launch itself is not deployed. It runs locally with `pnpm dev`, reachable at `https://local.clewro.com` through `pnpm dev:tunnel`.
- The gate is green (in a throwaway worktree): lint, typecheck, tests (web about 3,100, CLI 104, evals 22) and build.

**The kit (`rocketflare-dev/rocketflare`).** Released up to **0.15.6**. Nothing is open: no PRs on the kit or the site (`rocketflare-www`). Launch's default pin (`DEFAULT_TEMPLATE_PIN`) is still 0.15.5.

**The real app.** `hola-world` (`guidemode/hola-world`, Neon project `mute-star-58262276`) is **live** on staging (`https://hola-world-staging.clewro.com`) and was promoted to production through the approval gate.

## Phases

| Phase | Plan | State |
|---|---|---|
| P0 | seed, cut the cord, brand | Done. Seeded from Rocketflare 0.15.0 with the Afterburner theme; analytics kept. |
| P1 | [p1-foundation](p1-foundation.md) | Built. Covers the audit log, setup (now Settings → Platform, for the owner/admin in single mode), OIDC issuer, registry/import and health. |
| P2 | [p2-create-app](p2-create-app.md) | Built, and **proven on real accounts**: scaffold → Neon → Cloudflare → config → placeholders → GitHub env → secrets → staging deploy through the gateway → health → live. Adds Re-scaffold and commit pins. |
| P3 | [p3-sessions](p3-sessions.md) | Built. The first real sessions failed; the fixes are merged but **not re-tested** (see "Next" below). No real Claude turn has run yet. |
| P4 | [p4-approvals](p4-approvals.md) | Built. Production promote through an approval is **proven** on hola-world. |
| P5 | [p5-grants](p5-grants.md) | Built. The exit test passes against fakes; not yet run on real accounts. |
| P6 | [p6-fleet](p6-fleet.md) | Planned. The open questions are decided (see its §7). The admin collapse it depends on is done. Not started. |

Known gaps for each subsystem are in [docs/CONCEPTS.md](../CONCEPTS.md) §18. Kit issues are in [upstream-kit-issues.md](upstream-kit-issues.md).

## What real testing proved and fixed (2026-09-28)

**Proven on real accounts:**
- The GitHub scaffold job, including Re-scaffold and `[skip ci]` on Launch's own commits.
- Neon: roles created in SQL (`migrator`/`app`, with the `GRANT`), and the migration-evidence check before Re-scaffold.
- Cloudflare: storage, queue and KV; the placeholder Workers (with a `queue` handler and `keep_bindings`); Worker secrets.
- GitHub environments, created with an `administration` token.
- The deploy gateway: ticket → upload with the binding check → `db:migrate:ci` as `migrator` → activate → finish.
- Health, go-live, and the production approval and promote.

**Launch fixes merged during testing:**
- **Pipeline visibility:** scaffold and deploy waits fail fast, and the page polls the CI job on read. Retry and Stop were added, and a dead-instance check fails a launch or teardown whose Workflow died.
- **Public URL:** a setup check refuses to start CI while Launch can't be reached from outside.
- **Neon:** roles are created in SQL, not through the role API.
- **Email:** the step is skipped, with its reason, while Resend isn't ready.
- **"Deployed" means activated** (a new `deploy_tickets.activated_at`, migration 0027).
- **Re-scaffold:** replaces the scaffold of an app that has never gone live, after checking its database for applied migrations.
- **Kit version card** in Setup: pin a release tag, or a `main` commit for development.
- **Admin collapse:** in single mode, the organisation's owner/admin is the platform admin.
- **UI:** a simpler step list (15 rows), the page at full width, and no attempt counter.
- **Sessions:**
  - a session's database is always a real Neon branch, reached through an allow-list of exactly its own hosts;
  - session roles are created in SQL;
  - `GOGC=off` under emulation;
  - every sandbox and Neon call has a time limit;
  - failures carry the output tail;
  - a recreated container is detected;
  - End works mid-step;
  - a stalled-session check.

**Kit releases, each a PR, CI and a release:**

| Release | Fix |
|---|---|
| 0.15.1 | The evals script: a hyphenated slug is no longer used as an identifier. |
| 0.15.2 | Hyphenated slugs: the API-key prefix, the `rocketflare-dev/` references (#37), the test Compose project (#38), a stale `plugin-api.md`, and a CI job that gates a renamed copy. |
| 0.15.3 | The default-plugins gate is kit-only (it failed every app with "already installed"); each commit is gated once; a single-statement `ai_spans` prune for the neon test timeouts. |
| 0.15.4 | The deploy job runs only the parity test (its checkout is shallow). |
| 0.15.5 | `db-roles` works as a role without CREATEDB. |

## Landed since the first real day (2026-09-28, evening)

Built and tested against fakes; **none of it yet seen in a real session**:

- **Fast resume** (migrations 0029–0031): a short idle keeps the container, a destroyed container's workspace is backed up to R2 and restored on a cold resume, a cold resume never re-seeds and migrates only when the migrations changed, and the image's warm store is kit 0.15.5.
- **Deploys in progress** on the app overview and the catalogue (migration 0028).
- **Push and idle:** git retries a fresh token's 401/404 for about 7.5 s, a checkpoint retries a transient push once, and preview traffic counts as activity.
- **Preview HMR** WebSocket through `wsConnect`.
- **Remote sandbox (`SESSION_SANDBOX_HOST=remote`)** with `host` egress: the host injects the token and key, and the container holds no credential ([sandbox-session-issues](sandbox-session-issues.md)).
- **Turns** run with `bypassPermissions`, `IS_SANDBOX=1` and `HOME=/root`; local Docker runs under Rosetta.
- **Debounced checkpoints** (30 s after the latest changed turn, 5-minute cap), and a lost turn's container is salvaged before recovery.
- **The neon driver** never queries through a replaced global `fetch`.

The kit is at **0.15.6** (magic link: opening the link no longer spends the token). Launch's `DEFAULT_TEMPLATE_PIN` and the image's `KIT_TAG` are still 0.15.5.

## Next, in order (agreed 2026-09-29)

1. **Validate sessions, checks 1–5** of [sandbox-session-issues](sandbox-session-issues.md): boot timings, a turn with shell commands, `HOME`, `--resume`, checkpoint.
   - Local Docker first. **Needs the Anthropic key in Settings → Platform** (the user).
   - Then remote, after redeploying `launch-sandbox-dev` (needs the go-ahead).
   - Ship (check 6) can't pass until item 2 is done.
2. **Issue #1: Launch runs the ship gate itself, on a throwaway Neon branch** ([rocketflare-launch#1](https://github.com/rocketflare-dev/rocketflare-launch/issues/1)). Today the gate runs inside a Claude turn, and the kit's `pnpm test` needs Postgres on :5433 plus Docker, which the sandbox lacks. So no kit app can ship from a session. Slices:
   - **2a. Faster Neon branches.** Wait only for `create_branch`, and poll from about 200 ms with backoff instead of a flat 1 s (`NeonClient.waitForOperations`). Today a branch takes 13–16 s.
   - **2b. Kit: an opt-in for an ephemeral test database** (a kit PR, tested through "Pin latest main", then release 0.15.7):
     - `safetyCheck()` accepts a non-local `DATABASE_URL` only with `TEST_DATABASE_EPHEMERAL=1` and a gate-branch pattern.
     - The driver test accepts real Neon when no proxy is set.
     - `db-roles.test` is skipped without TCP.
     - A `test:ephemeral` script: no compose, the neon driver, longer timeouts, fewer forks.
   - **2c. Workflow steps.** `ship.claim`, then for each attempt: `ship.db` (a child branch of the session's branch, `gate-<short>-<attempt>`), `ship.gate` (each kit command exec'd by Launch, a `ship.gate {step, passed, attempt, output}` event per step), and on red `ship.fix` (a focused turn with the failing command and its tail). Up to N attempts, then `ship.db-clean`, then `ship.pr`.
     - A green gate makes no model call to decide pass or fail.
     - The PR title and body come from one cheap summary call (a small model with no tools) over the diff stat and the user's messages. The ship turn goes.
   - **2d. The gate steps are the kit's commands, fixed in Launch.** There is no per-app config; a config test keeps them in step with the pinned kit.
   - **2e. No orphan gate branches.** Cleanup and `end` delete them before the session branch, and a cron sweeps by name prefix.
   - **2f. Docs and pins.** CONCEPTS §18.13, CHANGELOG. Bump `DEFAULT_TEMPLATE_PIN` and the image's `KIT_TAG`.
3. **Validate ship end to end on hola-world** (check 6): a green gate opens a PR, the PR's `ci.yml` runs, and a forced test failure gets one fix turn.
4. **Deploys in progress:** watch the steps live on the next real production promote. Known gaps are in CONCEPTS §18.7.
5. **Small fixes found along the way:**
   - **Kit deploy step names:** "Deploy (…wrangler.staging.toml)" becomes "Deploy with wrangler (no deployer)", and "Activate the uploaded version" becomes "Deploy: activate the uploaded version". Ship them with the kit change in 2b.
   - **Email:** have Setup verify `notifications.clewro.com` in Resend.
   - **The site's `check:releases`:** refuse a `TODO` summary.
   - **Sessions:** a `shipping` session whose Workflow died isn't reconciled yet.
   - **Faster boot:** a persistent dependency cache. Largely superseded by the workspace backup for resumes; revisit only if first boots stay slow.
6. **Prove the rest on real infrastructure:**
   - archiving and tearing down a real app;
   - P5 grants (push, rotate, revoke onto a live Worker);
   - a commit pin fetched on a real runner;
   - the GitHub App reading the kit's tags.
7. **Deploy Launch (P1 step 1e).** Needs the go-ahead.
   - `launch.clewro.com`, with a `launch` database in an existing Neon project and `DATABASE_DRIVER=neon`.
   - Set the secrets before routing traffic.
8. **P6: fleet operations** ([p6-fleet](p6-fleet.md)).
9. **Housekeeping:**
   - how the stacked phase branches reach `main`;
   - file the remaining kit issues ([upstream-kit-issues](upstream-kit-issues.md));
   - replace the kit's example agents.

## Working rules learned

- **Never run `pnpm build` or the gate in the checkout that runs `pnpm dev`.** `build:ui` rewrites `apps/web/dist/ui`, which `wrangler dev` watches. The reload kills in-flight Workflow steps, and locally they don't resume until something pokes the engine. Gate in a throwaway worktree: `git worktree add /tmp/launch-gate <sha>`, `pnpm install --frozen-lockfile --prefer-offline`, then the gate.
- **Parallel agents share the :5499 test database.** Concurrent suites cause "tuple concurrently updated", 401s from vanished sessions and deadlocks. Rerun alone before believing a failure.
- **A new migration must be applied to the dev database at once** (`pnpm db:migrate`) if `pnpm dev` loads the schema change. Once applied, it is history.
- **Test a kit fix without a release:** merge it to kit `main`, then Setup → Kit version → **Pin latest main**, then Re-scaffold.
- **A stuck local Workflow instance:** `pnpm --filter @launch/web exec wrangler workflows instances terminate <workflow-name> <instance-id> --local --port 3001`.

## Local dev notes

- `pnpm dev:tunnel` runs only the tunnel (cfld). `pnpm dev` switches to the tunnel URL while that tunnel is up. CI jobs need it: Launch refuses to start CI while its public URL isn't reachable.
- **cfld cert zone.** cfld routed `local.clewro.com` with the `guidemode.dev` cert, which created `local.clewro.com.guidemode.dev`. Fix it with `pnpm web exec cfld login --reauth` for `clewro.com`, then restart the tunnel. Delete the stray record in the `guidemode.dev` zone.
- The kit source is at `~/work/rocketflare`. Run its gate against a throwaway Postgres on another port, not :5433.
