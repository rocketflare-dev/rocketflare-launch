# Build status

Paused on 2026-09-28, at the end of the first day of testing on real infrastructure. P0–P5 are built, and the P6 plan is written.

## Where things are

**Launch.** All work is on the local branch `phase-5-grants`. The phase branches are stacked:

```
main → phase-0-seed → phase-1-foundation → … → phase-5-grants
```

- Nothing is pushed or merged into `main`.
- Launch itself is not deployed. It runs locally with `pnpm dev`, reachable at `https://local.clewro.com` through `pnpm dev:tunnel`.
- The gate is green (in a throwaway worktree): lint, typecheck, tests (web about 3,100, CLI 104, evals 22) and build.

**The kit (`rocketflare-dev/rocketflare`).** Released up to **0.15.5**, with all the fixes this testing found. Nothing is open: no PRs on the kit or the site (`rocketflare-www`). Launch's default pin (`DEFAULT_TEMPLATE_PIN`) is 0.15.5.

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

## Next, in order

1. **Re-test a coding session on hola-world.** The fixes are merged but haven't run against a real session yet.
   - Give Docker Desktop **at least 12 GB** of memory. The last session was killed by the Docker VM's out-of-memory killer at dev-server start.
   - Open the old failed session `a07e371e…` once. Its reconcile deletes the leftover Neon branch (`ep-wild-silence-…`).
   - Start a new session. The `dev` database is already prepared.
   - **Unproven:** Neon over WebSocket through the egress interception, `workerd` inside the container trusting the interception CA, and a real Claude turn (the Anthropic key must be set in Setup).
   - **Local preview routing works.** `*.clewro.com` is a CNAME to the cfld tunnel, which sends it to `localhost:3001`: the Worker, where the preview gateway runs. Vite on :3000 would rewrite the `Host` header. cfld quotes wildcard hostnames in its YAML, a local patch in `~/work/cfld`. The HMR WebSocket goes through `wsConnect`.
   - **Investigate: faster session boot through a persistent dependency cache.** Run `pnpm install` once per lockfile into an R2-backed store, then mount it into every sandbox, keyed by a hash of `pnpm-lock.yaml` ([Sandbox persistent storage](https://developers.cloudflare.com/sandbox/tutorials/persistent-storage/)).
     - **Why:** the image's warm store (`containers/session/Dockerfile`) is fetched for the default pin (`KIT_TAG=0.15.5` since the fast-resume work). Apps drift from it with every dependency change, so `--prefer-offline` falls back to the registry more over time. S7 measured about 5 s warm against about 17 s cold.
     - **Questions:**
       - Mount the pnpm store (content-addressed, so it is shared across lockfiles) or a tarred `node_modules` per lockfile hash (no link step, but one copy per hash)?
       - What is FUSE/s3fs read speed against local disk for pnpm's hard links? Copy-on-first-use may be needed.
       - Who writes the cache (the `prepare` run, or the first session on a new hash) without two writers racing?
       - Does the cache need its own egress allow-list entry for R2?
       - How is the cache evicted?
       - Does it work locally under `wrangler dev`, or only on real containers?
     - **Where:** `services/sessions/rocketflare-dev.ts` (`INSTALL_COMMAND`, step 1 of `sessionBootstrap`).
   - **Found on 2026-09-28:** a checkpoint push failed with "Repository not found" 1 s after a fresh token mint, and a session was suspended as idle while its preview was in use. Fixed, not yet re-tested: the git proxy retries a fresh token's 401/404 (0.5/1/2 s), the checkpoint retries a transient push failure once, and preview traffic counts as activity (the idle wait now runs from `last_activity_at`). A resume's "Starting sandbox" also hung until its 4-minute deadline once, then retried; the likely cause is a destroy followed straight away by a start on the same Durable Object under `wrangler dev`.
   - **Fast resume (decided: do all four).** Today a suspend destroys the container, so a resume is a cold boot. Locally that took about 3 minutes: the clone 3 s, install and seed 2 min 11 s, the dev server 33 s, all under amd64 emulation.
     1. **Keep the container across a short idle:** stop the dev server, or suspend only after a long idle, instead of destroying the container.
     2. **Snapshot the workspace:** SDK `createBackup`/`restoreBackup` of `/workspace/app` (`node_modules` and `.dev.vars` included) to R2 on suspend, restored on resume. This skips the clone, install and bootstrap, and supersedes the dependency-cache idea for resumes.
     3. **A lighter resume:** migrate only when the migrations changed, and no re-seed of a database that is already prepared.
     4. **Refresh the image's warm store** (`KIT_TAG` in `containers/session/Dockerfile`) to the pinned kit, and keep it in step with `DEFAULT_TEMPLATE_PIN`.
   - **Option: real containers for local dev.** `wrangler dev` always runs containers on local Docker, and Durable Objects can't be remote bindings. Instead, deploy a small `launch-sandbox-dev` Worker that holds `SessionSandbox` on Cloudflare, and reach it through a remote **service binding** with a `RemoteSandbox` adapter behind `SandboxPort`. The outbound handlers (git, Anthropic) would run in that Worker and call back into local Launch over the tunnel through a signed internal endpoint. That gives production-speed boots and no emulation, at the cost of a second deploy and billed container time. **Needs your go-ahead** (outward-facing).
2. **Deploys in progress on the app overview and the catalogue.** Built (migration 0028), not yet seen on a real deploy. The next production promote should show its steps live. Known gaps are in CONCEPTS §18.7: a run that dies before `start` stays "dispatched" until its pre-approval expires (15 minutes), and nothing sweeps a ticket that nobody opens.
3. **Small fixes found along the way:**
   - **Kit deploy step names:** "Deploy (…wrangler.staging.toml)" becomes "Deploy with wrangler (no deployer)", and "Activate the uploaded version" becomes "Deploy: activate the uploaded version". Ship them with the next kit change, through a commit pin.
   - **Email:** have Setup verify `notifications.clewro.com` in Resend (create the domain and write its DNS records to the zone). Email is skipped until then.
   - **The site's `check:releases`** accepts a `TODO` summary. Make it refuse one.
   - **Sessions:** a `shipping` session whose Workflow died isn't reconciled yet. (Done: a `working` turn whose Workflow died is now reconciled, and the `ai_spans` prune is a single statement.)
4. **Prove the rest on real infrastructure.** Not yet run for real:
   - archiving and tearing down a real app;
   - P5 grants (push, rotate, revoke onto a live Worker);
   - a commit pin fetched on a real runner ("Pin latest main");
   - the GitHub App reading the kit's tags.
5. **Deploy Launch (P1 step 1e).** This needs your go-ahead.
   - Launch goes to `launch.clewro.com`, with a `launch` database in an existing Neon project and `DATABASE_DRIVER=neon`.
   - Set the secrets before routing traffic to it.
   - The live public-URL probe is only a warning when deployed (unproven whether a Worker can fetch its own hostname).
6. **P6: fleet operations.** Build from [p6-fleet](p6-fleet.md): a foundations slice (6a), then parallel slices in worktrees, an integration pass, and the exit test. Per-PR previews (6f) come last and are off by default.
7. **Housekeeping.**
   - Decide how the stacked phase branches reach `main`: one PR per phase, or a squash.
   - File the remaining unfiled kit issues (`upstream-kit-issues.md`).
   - Replace the kit's example agents once Launch has a real one.

## Working rules learned

- **Never run `pnpm build` or the gate in the checkout that runs `pnpm dev`.** `build:ui` rewrites `apps/web/dist/ui`, which `wrangler dev` watches. The reload kills in-flight Workflow steps, and locally they don't resume until something pokes the engine. Gate in a throwaway worktree: `git worktree add /tmp/launch-gate <sha>`, `pnpm install --frozen-lockfile --prefer-offline`, then the gate.
- **Parallel agents share the :5433 test database.** Concurrent suites cause "tuple concurrently updated", 401s from vanished sessions and deadlocks. Rerun alone before believing a failure.
- **A new migration must be applied to the dev database at once** (`pnpm db:migrate`) if `pnpm dev` loads the schema change. Once applied, it is history.
- **Test a kit fix without a release:** merge it to kit `main`, then Setup → Kit version → **Pin latest main**, then Re-scaffold.
- **A stuck local Workflow instance:** `pnpm --filter @launch/web exec wrangler workflows instances terminate <workflow-name> <instance-id> --local --port 3001`.

## Local dev notes

- `pnpm dev:tunnel` runs only the tunnel (cfld). `pnpm dev` switches to the tunnel URL while that tunnel is up. CI jobs need it: Launch refuses to start CI while its public URL isn't reachable.
- **cfld cert zone.** cfld routed `local.clewro.com` with the `guidemode.dev` cert, which created `local.clewro.com.guidemode.dev`. Fix it with `pnpm web exec cfld login --reauth` for `clewro.com`, then restart the tunnel. Delete the stray record in the `guidemode.dev` zone.
- The kit source is at `~/work/rocketflare`. Run its gate against a throwaway Postgres on another port, not :5433.
