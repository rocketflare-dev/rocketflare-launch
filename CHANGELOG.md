# Changelog

## Unreleased

- **The pipeline strip follows a release's tag run on GitHub before staging.** While the newest
  release is `tagged` (or deploying to staging) the strip says "v0.15.7 is tagged — GitHub is
  checking it before it deploys to staging" with the job it is on, then "Deploying v0.15.7 to
  staging…", each with **View on GitHub**. A tag run that fails before its staging job (a red gate)
  now marks the release `failed` (audited `release.failed`) — the strip says "v0.15.7 did not
  deploy: ci / Gate failed", and a session's landing stalls `deploy_failed` at once instead of
  timing out after 45 minutes. `GET /api/apps/:id/promotion` gains `candidateRun` (nullable,
  defaulted); migration 0033 adds `app_releases.tag_run` / `tag_run_polled_at` (the per-release
  read throttle).
- **The app page's pipeline strip and Shipping card are compact.** The strip is one row (staging →
  Promote → production) with its reason underneath and what it ships folded away; a release stuck
  in `tagged` for more than 45 minutes reads "vX never reached staging" instead of "still
  deploying", and a non-release build shows as `main-64a36e6`, not `vmain-64a36e6`. The Shipping
  card is a two-line summary below the sessions card; **Change** opens its form in a modal.

- **Ship means "live on staging"** (rocketflare-launch#5; `docs/plans/i5-ship-to-staging.md`,
  `docs/CONCEPTS.md` §18.13, spec/08 § Shipping). A session's Ship no longer ends at an open pull
  request: after Launch's gate opens the PR, the session waits for the PR's CI (the repo's `Gate`
  check, on the SHA Launch gated), then — when the app asks for one — a review in Launch, then
  Launch squash-merges the PR as its GitHub App (once, with the ship summary as the commit message),
  cuts a patch release, follows it to staging and ends on "Live on staging: <link>, vX.Y.Z". The
  person who made the change never visits GitHub. Before the merge a red CI (its failing check and
  a redacted log tail, so "Ask Claude to fix it" works in a normal turn), a CI that never reports,
  a branch that moved, a closed PR, a refused merge or a rejected or expired review gives the
  session back (`ready`, or `suspended` once its container was released) with the reason; after
  the merge a failure never reopens — the session shows "merged, not live yet" with the reason and
  a link to the app page. A lost Workflow is woken or restarted by the `sessions.checks` cron. No new
  session status: `shipping` now spans the gate, CI, review and merge, and `sessions.landing`
  holds the stage; `sessions.ship_summary` keeps the PR's summary. Migration
  `0032_launch-i5-ship-to-staging`.
- **Launch releases on merge** (rocketflare-launch#5; `docs/CONCEPTS.md` §18.17). The merge of a
  session's PR cuts a patch release with no person behind it (`release.created {trigger:
  'session.merge'}`), one at a time per app under a release claim on the app (PRs merged close
  together share one release and one tag; a double tag is impossible), and follows it to staging
  active and healthy on its version. Release by hand still works: while a release is being cut it
  answers 409 `release_in_progress`. A release's chain now reads PR → review → merge → release →
  staging → production.
- **Review a session's change in Launch: the `session.merge` approval** (rocketflare-launch#5;
  `docs/CONCEPTS.md` §18.15). A sixth approval kind: the PR's title, summary and diff stat with
  links to the PR and the session's preview; one approval, two days, never by the session's
  creator or anyone who wrote in it (403 `self_approval`). An eligible reviewer may read the
  session (its page, preview and PR), never drive it. Ending a session while its review waits
  cancels the request.
- **Shipping settings and branch protection on the app page** (rocketflare-launch#5;
  `docs/CONCEPTS.md` §18.4, §18.5, `SETUP.md`, `docs/DEPLOY.md`). A Shipping card lets an app's
  owners and admins choose where Ship ends — "go live on staging" (every app's default, imported
  ones included) or "open a pull request for review on GitHub" (the old behaviour) — and who
  reviews a merge (nobody, the app's owners, or named teams), via `PUT
  /api/apps/:id/ship-settings`, audited. An admin `session.merge` approval policy overrides the
  app's review and shows read-only there. Launch protects an app's default branch with a
  repository ruleset named `launch` (pull request and the `Gate` check required, Launch's App may
  bypass — so it can merge and push the release bump): new apps get it at launch, and `GET|POST
  /api/apps/:id/branch-protection` diagnoses an existing repo and lets an admin apply it (classic
  protection must be removed by hand). No new GitHub App permission.
- **Promote to production is the app page's primary action** (rocketflare-launch#5, part 8;
  `docs/CONCEPTS.md` §18.17, §18.19). A pipeline strip leads the page — `Staging: v1.4.2 (healthy,
  deployed 10 minutes ago)` → **Promote to production** → `Production: v1.4.1` — with what the
  promotion ships in plain words: each session's title and the one-line summary of its change,
  then its pull request's title. The button is disabled with the reason when there is nothing to
  promote ("Staging is still deploying", "Staging is unhealthy", "Production already runs v1.4.2",
  "Nothing on staging yet"); after the click the strip shows "Waiting for approval from <names>"
  with the request's link to share, then "Deploying to production…", then "Live in production"
  with its link. Owners and admins promote; everyone else reads the strip with who can. Same route
  and `deploy.production` approval as before, plus a read model, `GET /api/apps/:id/promotion`
  (`@launch/shared/launch-promotion`).
- **`launch sessions ship` waits through to staging** (rocketflare-launch#5; `.claude/rules/cli.md`).
  It prints each stage (CI, the review, the merge, the release, staging) and exits 0 when the
  change is live on staging, 1 on a reopen, a stall or a session ended while it waited; `--no-wait`
  returns once the ship has started (`--wait` is still accepted). In an app's `pr` mode it ends as
  before, at the PR and its CI. The session page's ship panel walks the same steps.

- **A launching app's host shows browsers an animated "launching" page** (rocketflare-launch#4;
  `docs/CONCEPTS.md` §18.5). The placeholder Worker answers a `GET`/`HEAD` that accepts
  `text/html` outside `/api/` with a self-contained page (inline CSS/SVG/script, its own CSP, under
  30 KB): the app's display name on the tower (HTML-escaped), a rocket idling on the pad, a
  mission-control checklist, light/dark from `prefers-color-scheme` and a still scene under
  `prefers-reduced-motion`. It polls the same host's `/api/health` every 12 s and, on the first
  200, plays the lift-off and reloads into the app. It is still a `503` with `Retry-After: 60` and
  `Cache-Control: no-store`; every other request — Launch's health probe, `curl`, API clients —
  gets today's plain-text body unchanged. `pnpm web preview:placeholder` serves the generated
  module locally (`/__preview/live` simulates the first deploy).

- **The ship gate runs the kit's `pnpm gate` steps — the same checks as the app's CI**
  (rocketflare-launch#2, kit 0.16.0; `docs/CONCEPTS.md` §18.13). On a kit with `pnpm gate` the
  gate is `pnpm gate lint` → `pnpm gate typecheck` → `pnpm gate test`, the copy's one CI job minus
  `build`, the one declared exception (`SHIP_GATE_SKIPPED`; container memory, and the PR's CI runs
  it). A new `ship.kit#N` step probes the checkout first: a root `gate` script → the kit's own
  `pnpm gate --list --json` (schema 1, mirrored as `kitGateListSchema`), planned in its order and
  REFUSED — a red Tests row, no fix turn — when it lacks one of Launch's steps or names one Launch
  does not know; only `test:ephemeral` (kit 0.15.7 up to 0.16.0) → the legacy `pnpm lint`,
  `pnpm typecheck`, `pnpm test:ephemeral`; neither → the "upgrade the kit" message. The test step's
  three-variable Neon contract is unchanged; its `ship.gate` event gains `target`, the line the
  kit's `pnpm test` prints first, shown on the ship panel. The PR body names the commands that ran.
  A contract test proves the steps against a fixture of kit 0.16.0's own step list.
- New apps are cut from Rocketflare 0.16.0 (`DEFAULT_TEMPLATE_PIN`, commit `bc89e0e`): `pnpm gate`,
  `pnpm test` as the one full run (on a Neon gate branch when `TEST_DATABASE_BRANCH` is set, time
  limits scaled for it), and `kit.yml`, `plugin-ci.yml` and `notify-plugins.yml` stripped by the
  rename, so a new app's first PR has a single Gate job. The scaffold's own gate is
  `pnpm gate lint typecheck` + `pnpm web test:config` on such a kit (its kit-only deletions are
  no-ops there, kept for older pins). The session image's warm pnpm store follows it
  (`ARG KIT_TAG` / `SESSION_KIT_TAG` 0.16.0, image `session-5`, so no workspace backup from the old
  image is restored into the new one) — it builds on the next deploy; drain sessions first.
- **A new app on kit 0.16.0 scaffolds.** The scaffold added the analytics plugin's
  `dashboard-visibility.test.ts` to the kit's unscoped allow-list (a 3.4.1 workaround) even though
  0.16.0 installs analytics 3.4.2, whose delete names the tenant (plugins#8) — and the kit's scan
  fails a stale entry, so the scaffold's own `test:config` failed. The patch now applies only while
  the plugin's test still holds the unscoped delete (`requiresText`).
- **A session's preview shows its work after a resume.** The preview gateway passed the dev
  server's cache headers through, and Cloudflare's zone default gave `/index.css` four hours in the
  browser: hot reload hid it (fresh `?t=` URLs), but the full reload after a resume served the
  stylesheet from before the session's edits, so the preview looked as if the work was gone. Every
  proxied response is now `Cache-Control: no-store, private` and `CDN-Cache-Control: no-store`.
- **A coding session's agent gets its system note, and never runs the full gate.** The
  `session-system-note` prompt was registered (and editable in Settings) but never sent; every
  turn now appends it with `--append-system-prompt`, resumed turns included. It gains one rule:
  never run `pnpm gate` or a workspace-wide lint, typecheck, test or build — slow and costly in the
  sandbox, and Launch's ship gate and the PR's CI run it — only targeted checks on the files being
  changed. The ship fix turn's `session-ship-fix` no longer invites a workspace-wide
  `pnpm lint` / `pnpm typecheck`.
- **A coding session's dev setup no longer leaks into its PR.** The kit's `bootstrap --offline`
  commented `[ai]` out of both wrangler tomls in place and the checkpoint committed it (with a
  `worker-configuration.d.ts` without `AI`) — hola-world PR #2 would have removed Workers AI from
  the app's production. The bootstrap preload now keeps the kit off the two tomls and the types;
  the dev server runs from a git-ignored `apps/web/wrangler.session.toml` (`[ai]` off) that
  wrangler's own `.wrangler/deploy/config.json` redirect points `wrangler dev` at (`wrangler types`
  ignores it, so the typecheck keeps `AI`). A resume heals a branch an earlier Launch checkpointed
  (against the session's base), and a checkpoint refuses to commit the toggle (`CheckpointError`
  `guard`). No kit change. `docs/CONCEPTS.md` §18.9.
- A session's pull request opens: the token that opens it now carries `contents: read` beside
  `pull_requests: write`. Without it GitHub refuses with 422 "not all refs are readable". A failed
  GitHub call also keeps GitHub's `errors[]` in its message, so a 422 says why.
- **Launch runs the ship gate itself** (slices 2c–2f of rocketflare-launch#1; `docs/CONCEPTS.md`
  §18.13). A ship is Workflow steps, not a Claude turn: `ship.claim` → `ship.save` → per attempt
  `ship.gate` lint → typecheck → `ship.db` → `ship.gate` test → `ship.db-clean`, then on red ONE
  focused fix turn (`session-ship-fix`: the failing command and its redacted output tail) and the
  gate again, up to 3 attempts; green → `ship.commit` → `ship.summary` → `ship.pr`. Only the
  commands' exit codes decide; a green gate makes ONE model call — the PR's title and body from the
  person's messages and the diff stat (`session-ship-summary`, no tools, a small model, billed to
  the session) — and falls back to the session's title when there is no model. The test step runs
  the kit's `pnpm test:ephemeral` (0.15.7) on a throwaway Neon branch per attempt,
  `gate-<short>-<attempt>`, a child of the session's branch, with exactly `DATABASE_URL`,
  `TEST_DATABASE_BRANCH` and `TEST_DATABASE_ENDPOINT` (never logged; outputs are tailed and
  redacted) and the allow-list widened to exactly that endpoint for the step. Not `pnpm build`
  (memory; the PR's CI runs it). One `ship.gate` event per step (`step`, `command`, `durationMs`
  in the shared contract); the ship panel, the chat and `launch sessions ship --wait` show each
  step. The `session-ship` prompt is replaced by `session-ship-fix` and `session-ship-summary`.
- A ship whose container is lost (at its save, mid-gate or mid-fix) suspends the session and
  resumes it from the last save instead of going back to `ready`; the checkpoints inside a ship
  check the boot marker. `POST /api/sessions/:id/end` now works while `shipping`: the gate command
  is killed within seconds and a fix turn is cancelled.
- No orphan gate branches: `ship.db-clean` runs after every `ship.db`, session cleanup and the
  expiry's inline cleanup delete a session's gate branches before its own branch, and a new
  `sessions.gate-sweep` task on the existing `*/5` cron deletes `gate-*` branches older than three
  hours.
- New apps are cut from Rocketflare 0.15.8 (`DEFAULT_TEMPLATE_PIN`, commit `d5accd3`), whose own
  tests live in `apps/web/tests/kit-only/`, which the rename deletes, so an app's gate no longer
  fails on the kit's version chain once the app releases a version of its own. The session image's
  warm pnpm store follows it (`ARG KIT_TAG` / `SESSION_KIT_TAG` 0.15.8, image `session-4`, so no
  workspace backup from the old image is restored into the new one). The ship gate's contract is
  unchanged (`SHIP_GATE_KIT_VERSION` stays 0.15.7; the pin must be at least that).
- New apps are cut from Rocketflare 0.15.7 (`DEFAULT_TEMPLATE_PIN`, commit `ab09a3f`), which adds
  `pnpm test:ephemeral` — the test suite on a throwaway Neon gate branch, no Docker — for a
  session's ship gate (rocketflare-launch#1). The session image's warm pnpm store follows it
  (`ARG KIT_TAG` / `SESSION_KIT_TAG` 0.15.7, image `session-3`, so no workspace backup from the
  old image is restored into the new one).
- Faster Neon branches (slice 2a of rocketflare-launch#1): `NeonClient.waitForOperations` polls
  from 200 ms with a ×1.5 backoff capped at 1 s (it slept a flat 1 s before every poll), reads all
  pending operations at once, and takes `actions` to wait only for the ones a caller needs. A new
  branch — a session's, `dev`, the pipeline's `staging` — now waits for `create_branch` alone
  (`waitForBranch`), not the compute's `start_compute`. 423 Locked retries back off the same way
  (33 retries, ~30 s, as before). Deadlines are unchanged: 120 s slept per wait.
- The TanStack Query devtools are opt-in in development: set `VITE_QUERY_DEVTOOLS=on` in
  `apps/web/.env.local` to show the toggle (it was on unless `off`). Kit issue
  rocketflare-dev/rocketflare#46.
- A coding session notices a container that died under it (out of memory in a `pnpm build`, most
  often) instead of waiting out the 90-minute turn timeout and then working on an empty container.
  A running turn reads the container's boot marker every 45 s (bounded at 20 s; four unanswered
  reads in a row count as lost): a dead container's log stream goes quiet rather than ending, and
  the read reaches a fresh, empty container with no marker. The turn ends `turn.interrupted {
  container_lost }` (a new reason in the shared contract, with a `message`), the session goes
  `suspended`, and the next message resumes it from the last save. A turn whose container is
  already empty never runs: its message stays pending and the session resumes and runs it there. A
  checkpoint on an empty container says the container was lost (and a debounced one suspends the
  session) instead of "Checkpoint failed at scan: Failed to change directory".
- `SESSION_EGRESS = open | allowlist` (missing = `allowlist`) picks how a session container reaches
  the internet, and the three tomls say `open` for now: internet on, no allow-list, and only
  `api.anthropic.com` and `github.com` intercepted, so the container still holds no model key or
  GitHub token. On real Cloudflare containers the egress interception never ends the container's
  stream after a WebSocket closes, so the kit's `migrate` / `db-roles` / `seed` never exited and a
  remote session could not boot (`docs/plans/sandbox-websocket-close.md`). Under `open` the session
  Durable Object turns `setAllowedHosts` into a no-op and deletes the SDK's persisted outbound
  configuration, so a reused object does not bring the allow-list back. The egress allow-list of
  spec/03 is off until the switch goes back. `*.neon.tech` is no longer an outbound handler host
  in either mode, and the database relay (kept for the next probe) accepts both sockets half-open
  and passes a close on to the other side only, instead of answering it twice.
- A session container's database WebSocket is now relayed through a `WebSocketPair` of the egress
  handler's own, which answers every close on both sides. Passed straight through, a close never
  completed on real Cloudflare containers: the container's socket stayed open, so the kit's
  `migrate`, `db-roles` and `seed` did their work and then never exited — the remote bootstrap
  "hang" at step 5.
- A coding session's bootstrap opens at most two database connections (was five), and usually
  none: Launch makes the kit's RLS role `rocketflare_app` on the app's `dev` branch itself
  (NOLOGIN, held by `session_owner` WITH ADMIN, inherited by every session branch); the sandbox
  skips the kit's `db:check` and runs `db:migrate` as its migrator alone, without `db-roles`; and
  a session branched from a prepared `dev` starts from the prepare's migrations hash
  (`apps.session_db.migrationsHash`), so it no longer re-seeds a seeded copy and migrates only
  when its migrations are newer. Each of those
  scripts opened its own database WebSocket through the container's egress interception, and on
  real Cloudflare containers a later one hung until the bootstrap's 15-minute deadline.
- A session container's database WebSocket upgrade that Neon does not answer within 20 s is
  answered 504 (and logged) instead of hanging: the kit's `db-roles` once waited out the whole
  15-minute bootstrap on one such upgrade, with nothing reaching Postgres.
- A coding session's install and kit bootstrap run as polled BACKGROUND commands
  (`services/sessions/background-command.ts`), not one blocking `exec` each: the Sandbox SDK queued
  every other call behind a running exec and the remote binding dropped a long one after ~7 min.
  A step retry attaches to the run still going instead of starting a second, the deadline kills
  the process group with the log's tail in the error, and the running boot step now shows where it
  is ("Installing and seeding — ✔ 4/10 database"), one event per change.
- Launch's test Postgres moves from host port 5433 to 5499 (`docker-compose.test.yml`, `.env.test`,
  CI, evals), so it no longer collides with the Rocketflare kit's and kit-scaffolded apps' test
  database on 5433; recreate it with `pnpm test:db:up`. The dev-database scan skips both ports.
- A session container on real Cloudflare can open its database's WebSocket pool: the egress
  proxy answered the `wss://` upgrade with `Upgrade` and `Connection` twice, which Node's clients
  reject ("Invalid Upgrade header"), so every remote session failed at the kit's `db:check`. Both
  sandbox classes now pass `*.neon.tech` through a handler that drops the origin's copies.
- Under `DATABASE_DRIVER=neon` the database's HTTP queries use the platform `fetch` captured when
  `db/client.ts` loads, never whatever `globalThis.fetch` is at query time: anything that replaces
  or wraps the global (a vendor fake, a test stub, an instrumentation shim) no longer carries — or
  breaks — the database's own traffic. It turned Setup, the health poll, `POST /api/apps` and the
  OIDC loopback into 500s in the `test-neon` job.
- A coding session no longer commits and pushes after every message. A turn that changed nothing is
  not checkpointed at all; one that changed files is saved 30 s after the latest turn (a message
  inside those 30 s runs first and the wait starts again), and never more than 5 minutes after the
  first unsaved change however busy the conversation. A suspend, an end and a ship still save
  first.
- Coding sessions recover a lost turn without throwing its work away. When a turn's Workflow dies
  under it (a `wrangler dev` reload, a deploy), the fresh instance first SALVAGES the container
  that outlived it: it stops the orphaned Claude Code process (SIGTERM, then SIGKILL), checkpoints
  (commit, push, transcript) and keeps the container for a warm resume, and the turn's
  `turn.failed` says whether the work was saved. Stop now works when the turn step is gone: a
  cancel on a turn with a stale heartbeat (30 s, the turn now beats every 10 s) is acted on at once
  — the same salvage, closing the turn as cancelled — instead of 3 minutes later with the work
  lost. A conversation that cannot be resumed (no transcript was ever checkpointed) is forgotten
  with an event instead of failing every later turn, and a turn whose `--resume` is refused
  retries once as a new conversation.
- `.dev.vars.example` sets `SANDBOX_LOG_LEVEL=warn` and `SANDBOX_LOG_FORMAT=pretty`: the Sandbox SDK's
  Durable Object no longer prints a multi-line object for every exec and destroy under `pnpm dev`.
- A remote-sandbox session (`SESSION_SANDBOX_HOST=remote`) gets its credentials the way Launch's
  own sandboxes do: Launch sends the sandbox host an egress grant (the repo, the session branch,
  the GitHub token, the Anthropic key and model) and `HostedSessionSandbox`'s own outbound handlers
  inject them under the proxies' rules — one repo, a push only to `session/<short>`, the model
  allow-list. Nothing credential-related is in the container any more: no key in the turn's
  environment (only the placeholder), no git credential file or helper. The `direct` egress mode is
  gone. Turns are still metered per turn and killed at the budget. Redeploy the host
  (`pnpm --filter @launch/web deploy:sandbox-host`).
- A coding session's turn runs Claude Code with `--permission-mode bypassPermissions`,
  `IS_SANDBOX=1` and `HOME=/root` (`acceptEdits` silently denied every shell command in `-p` mode);
  `.claude/settings.local.json` keeps only its deny rules (`git push`, `git remote`, `git config`).
- A session's checkout sets `GIT_TERMINAL_PROMPT=0`, runs under a lock
  (`/workspace/.launch/repo.lock`) so overlapping attempts queue instead of racing, and a failed
  checkout reports git's last 15 stderr lines. A git server the egress handler cannot reach (the
  local git server not running under `SESSION_BACKEND=local`) is a 502 naming it, not "Empty reply
  from server".
- Local coding sessions on Apple Silicon should run Docker in colima with Rosetta rather than QEMU
  (docs/SESSIONS-LOCAL.md).
- Coding sessions can run on REAL Cloudflare containers from a laptop instead of local Docker under
  amd64 emulation: set `SESSION_SANDBOX_HOST=remote` (with `SESSION_BACKEND=cloud`) in
  `apps/web/.dev.vars` and `pnpm dev` binds Launch to a new small Worker, `launch-sandbox-dev`
  (`apps/web/wrangler.sandbox-host.toml`), through a remote service binding declared only in a
  generated, git-ignored `wrangler.dev-remote.toml`, and skips the local image build. Development
  only (`loadConfig` refuses it elsewhere); deployed Launch is unchanged. In this mode each turn
  meters itself from Claude Code's own usage and is stopped when it reaches the budget. The host
  must be deployed
  once by hand (`pnpm --filter @launch/web deploy:sandbox-host`, docs/DEPLOY.md § The sandbox host).
  Session transcripts now also scrub GitHub token shapes.
- A coding session's turn whose log stream Launch loses (or that is cancelled or times out) no
  longer leaves its `claude -p` process running in the sandbox: Launch kills it, SIGTERM then
  SIGKILL after 5 s, by the pid the turn records (`/workspace/.launch/turn.pid`).
- Session containers run every command with core dumps off (`ulimit -c 0`), and a checkpoint never
  stages a core dump (`core`, `core.<pid>`, `*.core`, `qemu_*.core`, written to the checkout's
  `.git/info/exclude`) or any single file over 50 MB: it leaves the file out, says so in an `error`
  event naming it, and saves the rest. A git command that times out now says which step and after
  how long, and a stale `.git/index.lock` left by one is removed.
- A coding session's turn no longer fails at once with "Launch lost the connection to Claude Code":
  reading the process's logs passed an `AbortSignal` into the Sandbox SDK's RPC stub, which
  workerd cannot serialise. The signal now cancels the log reader on Launch's side.
- When a coding session's container is destroyed after its warm window (or by a drain), its
  workspace — checkout, `node_modules` and `.dev.vars` — is backed up with the Sandbox SDK's
  `createBackup`, and a later cold resume restores it instead of cloning and installing when the
  branch head is still the backup's commit (a new "Restoring the saved workspace" step; "Cloning
  instead" when it cannot). On by default under `wrangler dev` (`SESSION_WORKSPACE_BACKUP=binding`),
  off deployed until `presigned` and its R2 credentials are set (docs/DEPLOY.md). A new
  `BACKUP_BUCKET` binding on the `FILES` bucket in both tomls. Migration 0031 adds
  `sessions.workspace_backup`: run `pnpm db:migrate`.
- A coding session resumed COLD (its container was destroyed) no longer re-seeds its database or
  re-runs the database check, and migrates only when the checkout's `apps/web/migrations` changed
  since its last successful bootstrap (hashed, `sessions.migrations_hash`). A first boot is
  unchanged. Migration 0030 adds the column: run `pnpm db:migrate`.
- Resuming a coding session that went idle is fast again. An idle suspend (after
  `idleSuspendMinutes`) still checkpoints, but now KEEPS the container, dependencies and running
  dev server for 45 minutes (`SESSION_WARM_KEEP_MINUTES`); a resume inside that window restarts
  only the dev server, and only when it stopped answering — no clone, install or bootstrap (under
  local amd64 emulation that was ~3 minutes). After the window, on a drain, or when the container
  went away, the container is destroyed and the next resume is a full boot as before. Starting a
  session container is now bounded per attempt (100 s) and retried once after a reset, booting
  before the allow-list is applied, and the sandbox's `onStop` database write is bounded — two
  resumes right after an idle destroy had hung at "Starting sandbox" under `wrangler dev`.
  Migration 0029 adds `sessions.container_kept_at`: run `pnpm db:migrate`.
- The coding-session image's warm pnpm store is fetched for kit 0.15.5 (was 0.15.0), the kit
  a new app is cut from (`DEFAULT_TEMPLATE_PIN`), so a session's `pnpm install --prefer-offline`
  stops falling back to the registry for what changed since 0.15.0; a config test fails when the
  two drift apart. The image is `session-2`: deploying it replaces running session containers, so
  drain sessions first (docs/DEPLOY.md § Coding sessions).
- A coding session's checkpoint push no longer fails with "Repository not found" right after its
  GitHub token is re-minted (a session idle past the token's hour). GitHub does not always accept
  a just-issued installation token for a second or so and answers a private repo's anonymous-looking
  request with a 404; the git proxy now retries a fresh token's 401/404 after 0.5 s, 1 s and 2 s
  (a token that has been valid for a while is never retried). Two requests re-minting at once now
  converge on one token instead of overwriting each other, and the checkpoint retries a push that
  failed transiently once, after 3 s.
- Using a coding session's live preview now counts as activity: the session is no longer suspended
  as idle while the person is clicking around the preview with no chat turn. A preview request moves
  the session's `last_activity_at` (at most one write a minute), and the idle timeout re-checks it
  before suspending, waiting out the rest of the window instead. An open session page alone still
  does not keep the container up.
- A coding session whose turn's Workflow died (a `wrangler dev` reload, a lost or errored instance)
  no longer stays "working" for ever. A running turn now writes a heartbeat every 30 seconds; the
  session page's read, End and the five-minute cron settle a turn quiet for 3 minutes whose
  instance is gone, errored or stuck: the turn ends failed with a sentence saying so ("send your
  message again"), the session goes back to ready and is booted again from its branch (the
  previous turn's checkpoint), and an End asked meanwhile ends it. A fresh instance that finds a
  turn still `working` closes it the same way instead of leaving it open.
- The nightly `ai_spans` prune is one DELETE across every tenant instead of one per tenant (ported
  from Rocketflare 0.15.3): Postgres answers the cutoff from the `(tenant_id, started_at)` index,
  and under the `neon` driver the per-tenant loop cost a round trip per ten tenants. The web tests'
  timeout is 20 s under `DATABASE_DRIVER=neon` (every query an HTTP request through the local
  proxy) and stays 5 s for the `postgres` gate.
- Deploys show while they run. The app overview has a "Deploying" panel with each environment's
  latest deploy and its steps — dispatched → approved → uploaded → migrating → activating → live, or
  failed with the reason — plus who started it and a link to the GitHub run; the catalogue's cards
  and table show an app's deploy in progress (or its last one). Both poll every 5 s while a deploy
  runs (`GET /api/apps/:id/deploys/latest`, and `latestDeploy` on `GET /api/apps`). A deploy whose
  GitHub run died (cancelled, runner lost mid-migration) is now marked failed when the page reads
  it, its migration credential revoked, instead of staying "deploying" for ever. Migration 0028
  adds `deploy_tickets.activation_started_at` and `run_polled_at`: run `pnpm db:migrate`.
- A session preview's Vite HMR WebSocket now connects: an upgrade goes through the Sandbox SDK's
  `wsConnect` instead of `containerFetch`, which is an RPC and cannot carry a socket.
- Coding sessions no longer stall silently. Every sandbox call a boot step makes has a deadline
  and a readable error ("Installing and seeding: the sandbox (setAllowedHosts) did not answer within
  90 s"), and so does every Neon call; a failed install, bootstrap or dev server shows its last 40
  lines of output (database URI scrubbed) on the checklist and the failed session's page, which now
  offers "Start a new session". A container that died and came back empty (Docker's OOM killer on a
  laptop) fails the step with a sentence that says so instead of a bare "HTTP error 500" and minutes of
  waiting on nothing; the dev server's wait fails at once when its process exits. End during a boot
  step takes effect within 10 seconds ("Ending…"). A boot whose Workflow died — a `wrangler dev`
  reload, which a build rewriting `dist/ui` in the same checkout also triggers — is settled on the
  session page's read, on End and by the five-minute cron, and a settled session whose cleanup never
  ran has its container destroyed and its Neon branch deleted. An app's `dev` database left
  `preparing` by a session that died is prepared again by the next one. `docs/SESSIONS-LOCAL.md`
  § Memory: one session wants ~4 GB under emulation; give Docker 12 GB.
- Coding sessions boot their app's database under `wrangler dev`. The first real session
  (hola-world) failed at the kit bootstrap's `4/10 database` with "The service was stopped": Launch
  ran on a laptop with `SESSION_BACKEND` unset, so the amd64 container ran under emulation WITHOUT
  `GOGC=off` and `tsx`'s esbuild crashed in its garbage collector on every `db:check` attempt.
  `GOGC=off GOMEMLIMIT=1536MiB` now follows `APP_ENV=development` (every `wrangler dev` container)
  rather than `SESSION_BACKEND=local`. Behind it, the database was unreachable anyway: the
  sandbox's allow-list had no Neon host. Before the bootstrap runs, the allow-list now gains EXACTLY
  the Neon endpoint of the database it is handed (plus that region's `api.` host for the driver's
  HTTP queries), replacing any earlier one, and never a wildcard; the app runs `DATABASE_DRIVER=neon`
  with no proxy. A session's database is ALWAYS a real Neon branch, `SESSION_BACKEND=local`
  included: the local-Postgres `LocalSessionDb`, `SESSION_LOCAL_DB_URL`, `SESSION_LOCAL_NEON_PROXY`
  and `host.docker.internal` on the sandbox's allow-list are gone (`pnpm sessions:local-app` takes
  `--neon-project`). `session_owner` is now created IN SQL by `neondb_owner` (`LOGIN CREATEROLE`,
  `vector` made as the owner), no longer through Neon's role API as a `neon_superuser` member; an
  app `dev` branch made the old way is repaired on the next session and prepared again.
- The launch step list no longer shows an attempt counter ("×8") or "failed after N attempts":
  the count summed every Retry and Re-scaffold and never reset. The API still reports `attempt`.
- Re-scaffold no longer refuses an app just because a deploy job was handed the migrator
  credential: when nothing was activated, Launch asks that environment's database (as
  `neondb_owner` over Neon's HTTP SQL) and allows it when `drizzle.__drizzle_migrations` and
  `public` are empty — a `db:migrate:ci` that failed in its role phase — else refuses with the count
  ("staging has 12 applied migrations"), and refuses conservatively when Neon cannot answer. The
  page offers the button with a note that the database is checked first; only the POST calls Neon.
- New apps are scaffolded from Rocketflare kit 0.15.5, whose `db:migrate:ci` works as the app's
  `migrator` (no CREATEDB).
- A staging deploy whose job stopped after upload (its `db:migrate:ci` failed, then `finish` ran)
  is now a FAILED deploy: the launch's deploy wait fails with "The staging deploy job ended without
  activating the new version (it stopped after upload — see the run)" and offers Retry, instead of
  marking the deploy done and probing `health` against the placeholder. "Deployed" is the new
  `deploy_tickets.activated_at`, set only by `activate` (migration 0027 backfills it from the
  `deploy.activated` audit events); `finish` records `error: 'finished before activate'` on a
  deploy ticket it closes unactivated, the app's deploys list badges it "not activated", and
  re-scaffold no longer counts an unactivated upload as a deploy (a job handed the migrator
  credential still blocks it, now with its own reason). A Retry's deploy wait no longer re-reads the
  ticket it is retrying.
- Setup has a Kit version card: pin new apps to a kit release tag or, for testing a kit fix before
  it is released, a commit on any branch (a pasted SHA or "latest main"). Launch resolves either
  through the GitHub App and refuses one the kit repo lacks; "Reset to default" returns to Launch's
  pin; changes are audited `setting.changed`. The scaffold job fetches a commit pin by its SHA,
  `scaffold.verify` checks the commit, and the app records the SHA as its template ref.
- Launch's commits of the scaffold job's own files carry `[skip ci]`, so they no longer start a
  red CI run on a new app's `main` (the app's Biome linted `.launch/scaffold.mjs`).
- New apps are scaffolded from Rocketflare kit 0.15.4, whose deploy job checks wrangler parity with
  the parity test alone (the whole config project failed on the job's shallow checkout).
- New apps are scaffolded from Rocketflare kit 0.15.3: an app's deploy no longer fails on the
  kit-only "Gate with default plugins" job ("analytics is already installed"), a commit already
  green in CI is not gated again on deploy, and the neon test run no longer times out.
- New apps are scaffolded from Rocketflare kit 0.15.2 (the default template pin): a hyphenated
  slug now gets the `<snake>_` API-key prefix its tests expect, so the app's first CI gate is green.
- The scaffold job skips its rocketflare#37 patch when the kit already carries `KIT.preservedPattern`
  (kit 0.15.2+, where the rename keeps `rocketflare-dev/` references itself); older pins are still
  patched.
- "Re-scaffold from kit <tag>" (`POST /api/apps/:id/pipeline/rescaffold`, `manage App`): a launch
  that failed after its scaffold — the app's CI red on a kit bug a newer kit release fixes — can
  be scaffolded again from the CURRENT kit pin, which a Retry never picked up (it skips the
  succeeded scaffold). Offered beside "Retry from failed step", behind a confirmation, only while
  the create run is failed, the app is neither live nor archived and it has never deployed (409
  `app_already_deployed` / `app_live` / `app_archived` / `run_not_failed` otherwise — a deployed
  app takes a kit upgrade). The scaffold, its check, the config commit, the placeholder Workers
  and the staging deploy run again on a new instance; the repository, database, storage, Workers,
  sign-in client and secrets are kept. `GET …/pipeline` answers `canRescaffold` and `templateTag`;
  audited `app.pipeline.rescaffolded` with the old and new kit tag. The placeholder upload now
  keeps the Worker's secrets (`keep_bindings: ['secret_text']`), as a PUT over a Worker that has
  them would otherwise drop them.
- Reading a launch's pipeline polls the job its open wait is on (at most once per 20 s per wait):
  the GitHub run link appears as soon as GitHub lists the run, and a scaffold or staging deploy
  job that died on GitHub (a red gate never reaches `/ci/deploy`) fails its step with the run URL
  and a readable error at the next page read, fails the app and offers Retry — instead of "Deploy
  staging" showing running until the Workflow's next round, which under local wrangler never came.
  The Workflow is nudged with the wait's event; `app.launch_failed` is now audited once per failure.
- A launch whose Resend key or notifications domain is not ready records "email" as SKIPPED with
  the reason ("notifications.example.com is not a verified Resend domain yet…") and carries on,
  instead of throwing: a precondition cannot be fixed by the Workflow's retries.
- "Set up GitHub environments" asks for an installation token with `administration: write` (and
  `actions_variables: write`): GitHub lists creating an environment under Administration, not
  Environments, so the narrower token was refused ("Resource not accessible by integration") on a
  real repository. FakeCloud now enforces the same rule.
- The placeholder Worker a launch uploads exports a `queue` handler (retrying every message) and a
  no-op `scheduled`: Cloudflare refused to attach the app's queue consumer to a script without one
  ("11001: Queue handler is missing"), which failed "Create the Workers" on a real account.
- The launch's `neon` step creates `migrator` and `app` in SQL as `neondb_owner` instead of through
  Neon's role API. On real Neon an API-created role is a `neon_superuser` member that
  `neondb_owner` cannot grant, so `GRANT migrator TO app` failed ("permission denied to grant role
  "migrator"") — and `app` was far too privileged. The step also creates `vector` in database
  `app` itself, and checks each role and the membership before writing, so a retry repeats
  nothing. A project an earlier launch left with API roles is repaired on retry — its database
  `app` and those roles are deleted and recreated — but only while `app` has no tables; otherwise
  the step fails and says so.
- A launch or teardown whose Workflow died mid-step no longer shows that step running for ever:
  reading the app's pipeline (or retrying it) asks the Workflow about a run that has written
  nothing for 3 minutes, and if the instance errored, was terminated, finished or is gone — or,
  under `pnpm dev`, a reload left a step stalled for over 7 minutes — the step is marked failed
  ("The launch's Workflow stopped (…) while this step ran — Retry resumes from here"), the app is
  failed, `app.pipeline.reconciled` is audited, and "Retry from failed step" resumes from it.
  Waits parked on their job are left alone.
- The launch's step list is shorter: each CI job is one row — "Scaffold from the template" covers
  starting, waiting on and checking the scaffold job, "Deploy staging" the same for the staging
  deploy — so a launch shows 15 rows instead of 19. The Workflow still runs (and retries) the
  parts as separate steps; `GET /api/apps/:id/pipeline` returns the merged rows (`scaffold`,
  `deploy_staging`), with the failed part's error, the job's run link and the highest attempt.
- New apps are scaffolded from Rocketflare kit 0.15.1 (the default template pin), whose rename
  leaves a hyphenated slug's evals script parseable — 0.15.0 failed the scaffold's lint gate on it.
- The scaffold job installs with `pnpm install --no-frozen-lockfile` after the kit's rename
  (`--skip-install`): on GitHub's runners the rename's own install was frozen and failed on the
  workspace names it had just changed. A retried scaffold first updates the job files in the app's
  repo, so a fixed job is the one that runs, and every retry starts a new Workflow instance — under
  `pnpm dev` a second retry used to reuse the first's id and silently do nothing. The app page now
  uses the full width, and a step's "View run" link and attempt count sit under its name.
- One admin in single mode: under `TENANCY_MODE=single` the organisation's owners and admins now
  run the platform — the setup wizard (credentials, apps domain, GitHub App, Neon, Resend, public
  URL, template pin), Launch's OIDC signing keys and the access-request queue — without the global
  flag. They moved from `/admin` to **Settings → Platform** (`/settings/platform/setup`,
  `/identity`, `/access-requests`; sidebar "Setup"), and their API from `/api/admin/{setup,oidc,
  access-requests}` to `/api/platform/*`; old `/admin/setup` links redirect with their step anchor.
  One predicate decides both sides (`canAdministerPlatform`). Multi mode is unchanged (global admins
  only), `/admin` (organisations, users, feature flags, sessions) stays global-admin only, and a
  single-mode reviewer approves only into their own organisation (and `owner` only as an owner). A
  `BOOTSTRAP_ADMIN_EMAILS` address is now the organisation's owner in single mode (created, joined
  or promoted on its verified login), and the seed makes its platform admin an owner too.
- Creating an app no longer hides a scaffold job that died on GitHub: the step list shows the job
  RUNNING (not a tick on "Start the scaffold job") with a "View run" link to its GitHub Actions run,
  and a run that fails, is cancelled or never starts fails the step within a minute with a readable
  reason — including "Launch is not reachable at http://localhost:3000" when that is why — so
  "Retry from failed step" appears; a retry dispatches a fresh job on a new ticket. A launch stuck
  in a wait can be stopped ("Stop", `POST /api/apps/:id/pipeline/cancel`, `manage App`), which
  makes it retryable.
- Setup gains step 7, Public URL: Launch checks that its `APP_URL` is public HTTPS and fetches its
  own `/ci/ping` through it to prove it routes back. Creating an app, retrying a create and "Deploy
  to production" are refused with 409 `launch_not_reachable` while that check fails, and the Create
  modal says why and links to the step. Under `pnpm dev` the Vite server now proxies `/ci`, so the
  CI jobs can reach Launch through the tunnel.
- Shared config (P5): admins create a shared resource — a named bundle of vars and secrets, such
  as the company's M365 app registration, owned by a team — and that team sets its values per
  environment. Values are write-only: no page, command or API answer ever shows a secret, a blank
  field keeps what is set, and every change is a new version. The Shared config list and a page
  per resource show what is set (never a value), who holds it (to the owner team and admins), the
  approval policy per environment and the push history. A team that owns shared config can no
  longer be deleted (409 `group_owns_shared_config`); one migration adds the tables (0025) and a
  second the record of vars a push replaced (0026).
- Grants (P5): an app asks for a shared resource per environment from its Config page (or `launch
  grants request`); the resource's owner team approves it in the approvals inbox — not the admins
  unless a policy says so, and never the requester — with production able to need two approvals.
  Approval pushes the values onto the app's Worker as secrets, replacing the plain vars a plugin
  install left in the live version; the next deploy drops those vars from the upload and keeps the
  secrets, and a deploy that activates after a newer push re-pushes it. Revoking removes the
  secrets from that app's Worker only; a grant may expire, with a reminder a week before.
- Rotation (P5): setting new values where apps hold them pushes them to every holder in one push,
  with live progress; the old version is retired only when every app has the new one, and the
  owner team is then told to revoke the old credential at the vendor. A push that misses some apps
  lists them and offers Retry, which writes only those. Secrets past their rotation age remind the
  owner team.
- Detecting needs (P5): on import, on each Release and on "Re-scan", Launch reads the plugins an
  app's repo installs, matches their declared config to shared resources by name and tells the
  app's owners once what to request; a session's ship panel says when its PR needs shared config.
  CLI: `launch shared ls|show|set|rotate|pushes` (values from a hidden prompt or stdin, never the
  command line) and `launch grants needs|ls|request|revoke`. `GRANT_BACKEND=local` (development
  only) records pushes without calling Cloudflare.
- Setup against real accounts: the Neon step no longer fails with "not allowed for organization
  API keys" — the region is checked against Launch's list of Neon regions (and chosen from a
  select in the wizard), or pinned from where the org's projects already are, else
  `aws-us-east-2`, with a warning to change it before the first app. The Cloudflare step now
  creates the apps domain's proxied `AAAA * → 100::` wildcard record itself when the zone has none
  (audited `dns.wildcard.created`); an existing DNS-only record is left alone, with what to do.
- Approvals (P4): one engine decides everything a second person must approve — who may decide
  each kind (the app's owners, the organisation's admins, named teams or people), how many
  approvals it needs (one rejection is final), whether it expires, and whether a senior enough
  requester is approved at once. The author of a request can never approve it. Approvers are told
  in the app and by email, and the requester when it is decided; what an approval does after it
  is granted (publish a release, start a launch, wake a session) is retried every five minutes if
  it fails. Admins edit the policies under Settings → Approvals, for the organisation or one team
  or app. One migration adds the tables and moves every pending app-access request across with
  its id.
- The stand-ins on the engine (P4): members who could not create an app now ASK — the app waits
  as `requested` until an admin approves (admins and above, or whoever `app_create_role` names,
  are approved at once, as before); an access request is decided in the approvals inbox, by the
  app's owners or the organisation's admins, rather than on the app's Access page; and "extend
  budget" on a session opens a request in its creator's name that an owner or admin approves in
  one click — the creator extending their own session now waits for someone else.
- Releases and the production gate (P4): "Release" on an app bumps its version, tags it (starting
  staging) and lists the merged pull requests since the last release; "Promote" asks for a
  production deploy once staging runs the release, and a second person — never its author —
  approves it, which publishes the GitHub Release and lets exactly that tag's production run
  through. A production run started by hand in GitHub waits for an approval too, and "Deploy to
  production" now asks a second person. Merged session PRs are recorded, and each release shows
  its whole chain from pull request to production.
- A hash-chained audit log (P4): every five minutes the audit log is sealed into a per-organisation
  SHA-256 chain. Admins can verify it (`GET /api/audit/verify`, the audit page, `launch audit
  verify`) and export it as CSV or JSON Lines (`launch audit export`, streamed to a `0600` file);
  every exported row carries its `seq`, `prevHash` and `hash`, and `scripts/verify-audit-export.mjs`
  checks an export offline — the whole chain, or a filtered export row by row with `--filtered`.
- Approvals inbox (P4): `/approvals` lists what is waiting on you, what you asked for and (for
  admins) everything, with a badge in the navigation; each request has its own page with what is
  being approved in plain words, who asked and why, who it is waiting on by name, N-of-M progress,
  the expiry, and Approve / Reject with a comment. The app page gains Releases (cut a release,
  promote it to production through an approval, see its whole history); a session's creator can
  ask for more budget; the audit page can verify the chain and export the log. CLI: `launch
  approvals ls|show|approve|reject`, `launch releases ls|create|promote [--wait]` and `launch
  audit verify|export`.
- Coding sessions (P3): "Start session" on an app boots a sandbox container with the app's repo on
  a `session/<short>` branch and its own database (a Neon branch of the app's `dev`, prepared by
  the first session), runs the kit's bootstrap and dev server, and then runs each message as a
  headless Claude Code turn whose text and tool calls stream into the chat. Every turn is
  committed and pushed; an idle session suspends after 30 minutes (checkpointed, container
  destroyed) and resumes where it left off; a suspended one ends after 24 hours; a turn can be
  cancelled; a session can be ended at any time, which deletes its container and database.
- Session preview: the app running in the session is shown beside the chat through Launch itself,
  on a per-session host that needs a short-lived grant from the session page (no public tunnel);
  it reloads after every turn and only the creator, the app's owners and admins can open it.
- Model proxy and budgets: the sandbox never holds the Anthropic key — Launch adds it on the way
  out, allows only the policy's model, and meters every call into `ai_usage` against the session.
  Sessions have a per-session cap ($10) and a per-app monthly cap ($200, overridable per app); a
  session over its cap is blocked until an app owner or admin extends it, and a call over budget
  is refused before it reaches Anthropic.
- Ship: "Ship" runs the app's gate (`pnpm lint && pnpm typecheck && pnpm test`) in the session,
  lets Claude fix failures, re-runs the gate itself, and only when it is green opens a pull
  request from `session/<short>` with the title and description Claude wrote; the PR's CI is
  shown on the session and refreshed every 5 minutes until it settles. Shipping ends the session.
- Drain: Admin → Sessions → Drain pauses new sessions and suspends every live one (checkpointed)
  before a deploy that changes the session image; Undrain lets people start and resume again.
- CLI: `launch sessions start|say --follow|ship --wait|end|ls|preview-url` — start a session,
  send a message and follow the turn, ship and wait for CI, end, list an app's sessions, and print
  a preview link.
- P3 coding-session UI (slice 3e): the session page (`/apps/:slug/sessions/:id` — chat
  with one-line tool rows and a keyboard-first composer beside a live, grant-gated preview that
  reloads after every turn; header with status, cost against the cap, Ship / End / Resume and
  Extend budget; the ship panel with gate attempts, the PR and its CI; boot progress), a
  "Coding sessions" card with Start session on the app page, and Admin → Sessions with Drain /
  Undrain.
- P3 foundations (slice 3a) for coding sessions: the `sessions` and `session_events` tables,
  `ai_usage.session_id`, the app's session database and monthly budget columns (one migration);
  the `SESSION_SANDBOX` container (`@cloudflare/sandbox` 0.12.10, a placeholder image) and
  `SESSION_WORKFLOW` bindings; `run_worker_first = true` so session previews reach the Worker; the
  session contracts, policy defaults and preview-host grammar; an `anthropic_api_key` credential
  with its Setup check, and the GitHub App now needs `checks` and `statuses` read; PR and CI calls
  to GitHub, branch delete and `schema-only` branches on Neon. No screen changes yet.
- Create an app: "Create app" on the catalogue starts a pipeline that creates the GitHub repo,
  scaffolds it from Rocketflare 0.15.0, creates its Neon project (a `staging` branch, `migrator`
  and `app` roles), KV, queue and R2 per environment, its sign-in client, placeholder Workers
  with their routes, workflows and queue consumers, Worker secrets and a Resend sending key, then
  deploys staging and waits for it to answer healthy. Every step is recorded; a failed run is
  retried from the step that failed, without creating anything twice.
- Deploy gateway (`/ci/deploy`): an app's own `deploy.yml` deploys through Launch with a GitHub
  Actions OIDC token and no Cloudflare or Neon credential. Launch checks every binding against the
  app's recorded resources (another app's KV, bucket, queue or workflow is refused with 403),
  uploads the version, hands out a migration credential for that deploy only and revokes it after.
  Staging deploys are approved automatically; production waits for an app owner or admin.
- Scaffold job: a one-shot GitHub Actions job in the new repo clones the pinned kit, renames it,
  installs the default plugins, runs its gate and pushes `main`, with a one-hour token scoped to
  that repo (`/ci/scaffold`).
- App page: follow a launch step by step, retry it from the failed step, approve or reject a
  production deploy (owners and admins), "Deploy to production", and archive the app, which
  deletes its resources and archives the repo. The create form previews the staging host.
- P2 foundations (slice 2a) for creating apps: `deploy_tickets` and the app columns a launch
  records (GitHub repo id, template ref/commit, run id, archive time, the sealed encryption key)
  in one migration; the `APP_LAUNCH_WORKFLOW` and `APP_TEARDOWN_WORKFLOW` bindings; a public
  `/ci` surface for GitHub Actions (verified GitHub OIDC tokens, mapped to an app, its
  environment, workflow file and branch); the Cloudflare, Neon, Resend and GitHub calls creating
  an app needs; `template_pin` (kit 0.15.0) and `app_create_role` (admin) settings. No screen
  changes yet.
- App registry: import an existing Rocketflare app from GitHub (its manifest and both wrangler
  tomls, read with a token narrowed to that repo), a catalogue with a health dot per environment,
  and an app page with resources, health history, the operations log and its OIDC client. Health
  is checked every 5 minutes (`/api/health` + `/api/ready`: up, degraded or down; changes are
  audited) and on demand. Registering an app's OIDC client shows its secret once, with the config
  to paste.
- OIDC logout asks before signing you out of Launch unless the app proves the request with an
  `id_token_hint` Launch issued; `prompt=login` and `max_age` now make you sign in again.
- Launch is an OIDC issuer for the company's apps: discovery, JWKS with key rotation,
  authorize (PKCE S256 only), token (single-use codes; a replay revokes the first token),
  userinfo and logout. Each app has an access policy (everyone, or named groups and people),
  and a request-access page for anyone it leaves out. Every sign-in and decision is audited.
- Setup wizard (`/admin/setup`): the apps domain and zone, and the Cloudflare, Neon, Resend and
  GitHub App credentials, each sealed at rest, checked against the vendor, shown only as set /
  when / by whom, and audited.
- Seeded from Rocketflare 0.15.0.
- Branded as Launch by Rocketflare: the Rocketflare icon (tuned 16px favicon, PNG and
  apple-touch icons, a web manifest), a "by Rocketflare" line under the name, and the
  "Afterburner" light/dark theme (flame primary, violet accent, flame-gradient sign-in button,
  per-scheme `theme-color`) with a contrast test over every token pair.
- P1 foundation (slice 1a): the registry, OIDC, credential and audit tables in one migration;
  an append-only audit log (`GET /api/audit`, the Audit page); the sealed credential store and a
  GitHub App client; and the wiring the issuer, setup, import and catalogue slices build on —
  `/oidc` and `/.well-known` mounts, `/api/apps`, `/api/app-access`, `/api/admin/{setup,oidc}`,
  a five-minute health cron, and the Apps, Audit, Setup and Identity pages as placeholders.
