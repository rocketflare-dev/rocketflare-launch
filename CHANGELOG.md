# Changelog

## Unreleased

- **A session on kit 0.17.4 or later bootstraps through the kit's own flags** (epic #7). The kit
  bootstrap runs with `--no-install`, `ROCKETFLARE_BOOTSTRAP_SKIP` (the database check, plus the
  seed and migrate a resume leaves out) and `ROCKETFLARE_ALLOW_ROOT=1`, and its `--offline` no
  longer runs `wrangler whoami`, so Launch's preload no longer has to stand in for those children.
  The version is the checkout's own (`.rocketflare.json` `kit.version`, else `launch.plugins.json`
  `kitVersion`), read at every bootstrap; an older kit, or one Launch cannot read, keeps the
  stand-ins. The boot's steps and its `boot.timing` phases are unchanged. No migration.
- **A container replaced mid-boot fails fast and the boot starts again from the sandbox** (epic
  #7). A long command (the install, the kit bootstrap) whose container was replaced is noticed at
  the next poll — even one that had printed nothing, which used to be polled to its 10-minute
  deadline — and the boot marker is asked after a poll that fails and with each liveness check. A
  first boot whose `repo`, `bootstrap` or `dev` step finds its container replaced starts again from
  `sandbox.start.r1` (fresh boot marker, clone, install, bootstrap, dev; the database is kept), up
  to twice, instead of failing the session; the checklist says it is starting again. A cold resume
  still fails as before. No migration.
- **A coding session's agent is reached through one turn call, and the CLI process is one kind of
  agent** (rocketflare-launch#13). `AgentRuntime` is now `runTurn(ctx, input, sink)` (with
  `placement`, `workspaceFiles`, `cancel`, a `state` store, `login?`, `userLease?`): the turn hands
  each normalised mapping to a sink `turn.ts` owns and writes the one closing event from the
  outcome, for chat turns and the ship's fix turn alike. Claude Code and Codex are
  `processRuntime(claudeCli)` / `processRuntime(codexCli)` (`runtimes/process/`) — the container
  driver moved out of `turn.ts` unchanged, over a `CliAdapter` that is the old interface renamed;
  the checkpoint, the conversation restore and the salvage's kill go through `runtime.state` and
  `runtime.cancel`. A runtime contract suite runs against both. No behaviour change: every turn,
  checkpoint and login test is untouched. It is the seam a runtime that runs no CLI (Pi on a
  Durable Object, #14) plugs into.

- **The remote sandbox host backs workspaces up to a development bucket of its own.** `wrangler.sandbox-host.toml`
  binds `BACKUP_BUCKET` to `launch-files-dev` (a 14-day lifecycle rule on `backups/`) instead of the
  `launch-files` a deployed Launch uses; the account id is passed at deploy (`--var
  CLOUDFLARE_ACCOUNT_ID:<id>`), never committed (`docs/SESSIONS-LOCAL.md`, issue #3).

- **The sign-in page flies a rocket across a night sky.** `/login` (every state of it, including
  "check your email") and `/magic-link/sent` sit on `RocketBackground`, ported from the hola-world
  app's login: a canvas of bright, twinkling stars with a Rocketflare rocket that follows the
  pointer (and loops on its own over the card), leaving an exhaust trail; a click on the sky fires
  sparks. Unlike the original, the sky is night in BOTH themes (fixed `:root` colours, not theme
  tokens) and the rocket wears the mark's colours inside a dark ink outline. Decorative only
  (`aria-hidden`, no pointer events, nothing focusable); `prefers-reduced-motion` gets a still sky
  with no rocket. The card keeps its theme surface. No new dependency, no migration.

- **Launch signs strangers up by request, not refusal.** Both tomls set `SIGNUP_MODE = "approval"`
  (was `invite_only`): someone with no invitation who signs in lands on `/pending` with an access
  request under Settings → Platform → Access requests, and approving it joins the organisation
  (`member` by default). Before, they were turned away with `not_invited` and nothing was recorded.
  A deployed instance re-renders `wrangler.deploy.toml` (`pnpm provision render`) to pick it up.
- **The ship gate checks its test database before the tests, and says what failed when it cannot
  reach it** (rocketflare-launch#7). Before `pnpm gate test` Launch runs a small probe in the
  container: the app's own `@neondatabase/serverless` asks the gate branch for `select 1` over the
  WebSocket the kit's test setup opens first, retrying for up to 45 s, then checks DNS and HTTPS to
  the endpoint to say which part failed. A probe that gives up stops the ship with that verdict on
  the Tests row (no fix turn: the code is not what failed) instead of a vitest "No test files
  found" under an empty `ErrorEvent`. A test run that failed only because the kit's test setup lost
  its database connection is run once more, and the row says so; a real test failure is never
  retried. The 2026-10-06 failure (hola-world, a local sandbox) was the container itself: a reload
  of Launch's `wrangler dev` while a session's container runs leaves that container without
  internet (Launch's own hosts still work) — suspend and resume the session, or start a new one.
  Every Neon WebSocket pool (`createNeonPool`, `src/db/client.ts`, and the scripts) now listens for
  `error`, so a dropped connection rejects its query instead of crashing the process. No migration.

- **A session that is still shipping stays on the app page.** After the merge a session is
  `shipped` while its landing still cuts the release and deploys it to staging, and a stall before
  the release (CI failed on main, the release failed) waits on a person; until now none of that
  appeared under Active sessions or Needs you, only on the session page under "show finished".
  Session summaries now carry a derived `shipping` (`{ stage, waitingOn, stalledReason,
  approvalId, prNumber, version, since }`, null when nothing is in flight) — the session status
  enum is unchanged — and the `active` scope of `GET /api/apps/:id/sessions` and
  `GET /api/admin/sessions` includes such sessions whatever their status. The Overview's Active
  sessions and the Sessions tab say "Shipping" with where it stands ("Waiting for a review",
  "Deploying v1.4.2 to staging", "Merged, but CI failed on main"); Needs you lists a merge review
  waiting on you (once, linking the request), a review waiting on someone else (read-only), and a
  stall before the release (linking the session, where Re-run CI / Release anyway / Retry live);
  `launch sessions ls` prints the stage. No migration.

- **A session boots faster: the kit bootstrap skips two redundant children, the dev server starts
  directly, and finished commands are noticed sooner** (epic #7, track B). The bootstrap preload
  now also answers the kit's own second `pnpm install --prefer-offline` (Launch's install has just
  run) and its `pnpm web exec wrangler whoami` (a sandbox never has a Cloudflare login; the
  stand-in says "not authenticated", so `--offline` behaves exactly as before) — together 8-12 s of
  a local boot. The `dev` step runs `node apps/web/scripts/dev-server.mjs --start`, what `pnpm dev`
  runs, without pnpm's two startups (`pnpm dev` when the script is missing). A background command
  (the install, the bootstrap, the ship gate's commands) is read every 0.5 s for its first 30 s
  and every 1 s to 2 minutes before settling to 2.5 s. No migration, no image change.
- **A session started from the app page boots while you write, and one nobody writes to goes
  away** (issue #17). Start session and Change it now start the session WARM (`warm: true` on
  `POST /api/apps/:id/sessions`), once per press; opening it again while it waits for its first
  message returns the same session instead of booting a second one. Each person may hold
  `maxWarmPerUser` (a new session-policy limit, default 2) such sessions — beyond that the start is
  refused with `warm_session_limit`, explained on the card — and they count against the app's
  concurrency as before. One nobody writes to ends after `SESSION_WARM_START_MINUTES` (15) quiet,
  the preview's use counting as activity: no checkpoint, the container destroyed and the branch
  deleted, no turn counted, and the chat says why. A first message that arrives as it ends still
  runs. Sessions started from the CLI, Fix in a session and kit upgrades are unchanged. **Deploy:**
  run migrations (`0045`, `sessions.warm_start`).
- **Workspace backups can run on the remote sandbox host, and a failed backup says why** (issue
  #3). The host reads its own `SESSION_WORKSPACE_BACKUP` (`off` or `presigned`; `binding` and
  anything else are refused by name) and gains a `BACKUP_BUCKET` binding on `launch-files`, with
  `SESSION_WORKSPACE_BACKUP = "presigned"`, `BACKUP_BUCKET_NAME` and an empty `CLOUDFLARE_ACCOUNT_ID`
  to fill in. Local Launch backs a remote session up `presigned` whenever `.dev.vars` has
  `CLOUDFLARE_ACCOUNT_ID` (or `BACKUP_BUCKET_ENDPOINT`), while its own Docker sessions keep
  `binding`; the R2 host is on the allow-list only during a backup or restore. `loadConfig` now
  refuses `SESSION_WORKSPACE_BACKUP=presigned` with no account id or endpoint. Every backup attempt
  is a new `workspace.backup` session event (`saved` with its duration, or `failed` with the
  reason), and a failure is a quiet chat notice. To turn it on: an R2 token, the host's
  `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` secrets and account id, `pnpm deploy:sandbox-host`,
  then `CLOUDFLARE_ACCOUNT_ID` in `.dev.vars` (`docs/SESSIONS-LOCAL.md`). Until then nothing
  changes: a remote cold resume clones and installs. No migration.
- **Shipping updates in real time, with much less polling.** Every landing move (`casLanding`),
  every changed PR verdict (`refreshChecks`, from the panel or the cron), every changed reading of
  a release's tag run, every write a deploy run makes on `/ci/deploy`, and an approval's apply
  landing on a sweep retry now nudge the tenant's realtime hub (`entity.changed`, ids only). The
  UI refreshes just the named session or app — a session nudge no longer refetches every other
  session's page — and, while the socket is open, the ship card, the PR panel, the releases card,
  the pipeline strip and an approval's apply poll only as a fallback: 15–30 s instead of 3–15 s.
  With the socket down they poll as before, and a reconnect re-reads them once. No migration.
- **A session boots faster (issue #15).** The database step runs alongside the container's start
  and the clone instead of before them, and the bootstrap waits for both; a failure on either
  side still fails the boot cleanly once the other has finished. A session on a prepared `dev`
  that this Launch has already checked skips `ensureDev` (no owner password reset, no role or
  extension SQL) and only branches: `apps.session_db` now records `roleVersion` and `appRole`
  (jsonb, no migration; the first session after the deploy checks `dev` once and records them).
  Background commands (install, bootstrap, gate) are polled every 0.5 s for their first 10 s,
  then every 2.5 s as before. Compare the boot's `boot.timing` before and after.
- **A session's boot is measured, phase by phase (issue #8).** When a boot is done (a first
  boot, a warm resume or a cold one) the session writes ONE `boot.timing` event: what `db`,
  `sandbox.start`, `repo`, `restore`, `install`, `bootstrap`, `dev` and the other phases it ran each
  took, by the clock of the step that ran them, with the boot's total. The same phases are a
  `session.boot` trace in `ai_spans`, so `launch traces show` draws a boot. Every `turn.end` now
  carries `firstTokenMs` (how long the agent took to answer). The session page shows the boot as
  one line and the first turn after it with "first reply after Ns"; the new `launch sessions show
  <id> [--json]` lists every boot with its phases. No migration.
- **GitHub App webhooks wake the landing; polling stays the fallback** (#19). A new public route,
  `POST /api/github/webhook`, verifies `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET` in
  constant time (401 otherwise), claims each `X-GitHub-Delivery` once (a redelivery enqueues
  nothing), and enqueues a `github.event` job (202). The job maps the delivery's repository to its
  app, takes the tenant from that row, and wakes the landings the event concerns (their PR, gate
  SHA, merge commit, release tag, or the default branch while releasing) with `SESSION_WAKE_EVENT`;
  a followed release's tag-run reading is refreshed. Phase B's GitHub-facing waits are now
  `waitForEvent` rounds (`land.main-ci-wake`, `land.release-wake`, `land.staging-wake`) with the old
  round as the timeout; health keeps its counted sleep. A missed delivery changes nothing: the round
  times out and polls, and the cron stays the safety net. New instances' Apps get the webhook URL,
  the five events (`check_run`, `workflow_run`, `pull_request`, `push`, `release`) and the secret from
  `pnpm provision github-app`; no new permission. **Deploy:** run migrations (`0044`,
  `github_webhook_deliveries`), put `GITHUB_WEBHOOK_SECRET` on the Worker, then turn the webhook on
  in the App — `docs/DEPLOYMENT.md` § 12. Without the secret the route answers 503 and Launch polls
  as before.
- **Tests an agent runs by hand in a session no longer time out on the container's slow CPU.**
  Every turn (Claude Code and Codex) and every dev step gets `TEST_LATENCY_FACTOR=4`, which the
  kit (rocketflare-dev/rocketflare#62) uses to raise its vitest limits — 20 s per test instead of
  5 s. The ship gate keeps its own factor of 12; a kit older than the variable ignores it.
- **Coding sessions default to the agent's own model.** With nothing pinned, Claude Code runs with
  no `--model` (and no background-model override) and Codex with no `-m`, so each picks its model
  as it does on a laptop — Opus 5.5 for Claude Code today, not Sonnet. Platform → Coding agents
  and the composer's picker offer "Default" first; a pinned model works as before, and a policy
  that already pins one (such as an older `claude-sonnet-4-5`) keeps it until an admin picks
  Default. With no pin the model proxy lets through any model of the agent's provider that Launch
  can price. No migration. Deploy the sandbox host with Launch: an older host refuses unpinned
  sessions' model calls.
- **A failed gate step keeps vitest's failed tests and their messages.** The stored output was the
  last 60 lines, and a failure whose stack ran long (an error object's frames) lost the test's name
  and its message. The output now leads with each `FAIL … > test` header and the message under it,
  and clipping only ever shortens the tail.
- **A landing no longer waits ten minutes on its own release claim.** A `land.release` step killed
  mid-release (a `wrangler dev` reload, a deploy) never ran its `finally`, so the claim stayed held
  by the session itself and the retried step waited for it to go stale, showing "Cutting a
  release" the whole time. A session's landing now takes back its own claim at once; a person's
  second press of Release is still refused.
- **`pnpm plugin upgrade` no longer removes a package Launch itself declares** (ported from kit
  rocketflare-dev/rocketflare#61). `add --apply` records on the plugin's surface which packages it
  brought into the host (`addedDependencies`), `upgrade --apply` keeps that record current, and a
  package a release drops is removed only when some plugin's record holds it — equal ranges alone
  no longer count. A plugin installed before the record (`analytics`) keeps every package until
  its next upgrade starts one. `translateBlock(block, null)` now translates nothing (the kit's
  no-app fix; Launch always has an app, so it changes nothing here).

- **Track A follow-ups for shipping and promote (issue #21).** Migration `0043` adds
  `apps.gate_variable_set_at` / `gate_variable_tried_at`; run `pnpm db:migrate`.
  - **A landing stalled before its release can be retried from the session.** `main_ci_failed`
    shows **Re-run CI** (GitHub's "Re-run failed jobs" on the merge commit's failed runs; then
    `land.main-ci` waits for them again) and **Release anyway** (the release is cut past the red
    `Gate`, recorded as the `override` verdict; the tag's deploy runs the full gate itself);
    `release_failed` shows **Retry the release**. `POST /api/sessions/:id/landing/retry
    {action}`, audited `session.land_retried`; a double press retries once.
  - **A Gate GitHub never ran says so.** A job no runner picked up ("not acquired by Runner",
    `startup_failure`, `cancelled`) stalls with "GitHub did not run the default branch's CI … Retry
    re-runs it" rather than "CI failed".
  - **Imported apps get `LAUNCH_GATE_APP_ID`.** The import sets it when the installation may write
    Actions variables, and the five-minute cron (`apps.gateVariable`) sets it on any live app
    Launch has not seen it on, retrying a refused repo hourly. Apply records it too.
  - **Promote waits for the bundle draft.** On a build-once kit (its staging upload sent `source`),
    a draft not attached yet is waited for — the publish attempt fails and the approvals sweep
    retries it — until 20 minutes after staging went live or the engine's last attempt. A draft
    gone by then (a kit pruning old drafts) is POSTed at once; the notes and `release.published`
    say why production rebuilds (`rebuildReason`).
  - **Promote checks the bundle before publishing it.** The draft's `manifest.json` must name the
    tag and carry the staging deploy's artifact digest as `bundleSha256`; a bundle that is not
    staging's build is never published.
  - **A rollback no longer rewrites the old release's `Live Worker version` line.** Only a pending
    line is filled; notes Launch did not write are left alone.
  - **A merge after the green main `Gate` no longer leaves the bump on an untested parent.** When
    the default branch moved past the merge `land.main-ci` saw green, `land.release` waits for the
    new head's `Gate` (up to 30 minutes from that verdict) before cutting the release;
    `release.created` records `parentGate`.

- **Track A follow-ups for sessions (issue #21).**
  - **The PR panel no longer counts `launch/gate` as CI.** Launch's own attestation is left out of
    the checks fold (`foldChecks`), so a repo with no CI reads "no checks" rather than "1 passed".
  - **No attestation for a tree the earlier gate steps did not see.** Each attempt now reads its
    starting tree in a new step, `ship.tree#N.A`. When a step rewrites files (e.g. typecheck
    regenerating `worker-configuration.d.ts`), the last step's tree differs. `ship.attest` then
    posts no `launch/gate` and an `error` event names the files, so the PR's CI runs the whole gate.
    The ship carries on.
  - **Kit upgrade sessions have Stop again**, in the session header while a turn runs. They have no
    composer, which is where Stop lived.
  - **A workflow edit the agent made and then undid no longer blocks saving.** The checkpoint
    judges the net change under `.github/workflows/` against the pushed tip. Unpushed commits that
    touched a workflow on the way are folded into the save's one commit (`git reset --soft`),
    because GitHub refuses a push if any of its commits touches a workflow.

- **A kit upgrade session no longer ends its turn without running the upgrade.** Told to "run
  `/rf-upgrade`", headless Claude Code invoked the Skill tool, read its "Launching skill" as a
  background job, said it would wait, and ended the turn: nothing changed, no `LAUNCH-UPGRADE:`
  line, and the upgrade went to Needs attention with nobody able to nudge it. The prompt now has
  the agent read `.claude/skills/rf-upgrade/SKILL.md` and follow it itself, running
  `pnpm kit:upgrade --to <tag> --apply` with Bash and working through the plan, rejects and
  porting notes in the same turn (every unattended rule unchanged). And when a first turn still
  ends cleanly with no result line and an untouched checkout, Launch sends ONE follow-up turn of
  its own ("You ended the turn without running the upgrade…"), recorded on the upgrade
  (`app_upgrades.follow_up_sent_at`, migration 0042, `followUpSentAt` on the wire) so it happens
  at most once; the next turn is decided as before. An explicit `STOPPED`, or a turn that changed
  files and stopped, still goes straight to Needs attention.

- **The kit version has its own tab, and can follow the latest release.** Platform → Kit
  (`/settings/platform/kit`) now holds the Kit version card; Setup no longer shows it. A third
  mode, **Follow latest**, pins new apps to the kit's newest release — the highest `X.Y.Z` tag,
  pre-releases never — and the five-minute cron re-checks it at most hourly (a failed lookup is
  retried on the next tick), moving the pin when a newer release appears: compare-and-set,
  audited `setting.changed` with `after.by: 'cron'`. Apps are not upgraded; they show as behind and
  the usual upgrade is offered. The card shows "Checked …" and "Latest: X" and a **Check now**
  button (`POST /api/platform/setup/template-pin/check`, 502 `github_lookup_failed` when GitHub
  cannot answer). Contracts: `templatePinSchema` gains `follow: 'latest' | null` (absent on old
  rows, which parse unchanged; no migration — `launch_settings.value` is jsonb),
  `templatePinRequestSchema` gains `{ kind: 'latest' }`, `templatePinStatus.latestCheck` and the
  tags response's `latest` are new, and the last lookup is stored as
  `launch_settings.template_pin_check`. The release-tag field is now a real combobox
  (`components/Combobox.tsx`: type to filter the repo's tags, newest first, arrow keys / Enter /
  Escape / Home / End, ARIA combobox semantics); a tag not in the list can still be typed and the
  server looks it up.

- **`pnpm plugin` keeps the host's dependencies in step with what a plugin declares** (kit 0.17.1,
  ported). `plugin add` writes the DECLARED range into `package.json` (not pnpm's `^<resolved>`)
  and re-keys the lockfile, and skips a dependency the host already holds inside that range;
  `plugin check` accepts a host range inside the declared one (`^2.3.0` for `^2.2.4`, an operator's
  `2.2.5`) and still fails a wider or disjoint one. `plugin upgrade` now ends its plan with a
  **Dependencies** block and, on `--apply`, installs what the release adds or re-ranges and removes
  what it drops (kept when another plugin declares it or the host pins a range of its own); a
  range another installed plugin cannot use is refused, exit 6, nothing written.
  `plugin upgrade --json` prints the plan as one document.

- **Kit upgrade sessions can push CI workflow changes; ordinary sessions say why they can't.** A
  kit upgrade (0.17.0 edits `.github/workflows/ci.yml` and `deploy.yml`) failed at its save with
  GitHub's raw "refusing to allow a GitHub App to create or update workflow … without workflows
  permission": the session's push token was narrowed to `contents` and `pull_requests`. A session
  of kind `upgrade` now gets `workflows: write` on its token too (the sealed token records its
  scope, so one minted before this is re-minted, not reused). An ordinary session still does not:
  a change under `.github/workflows/` is refused at the checkpoint before anything is committed or
  pushed, with "This change edits the app's CI workflows (…). Coding sessions can't push workflow
  changes — an owner has to make that change, or run a kit upgrade." No new GitHub App permission
  (Workflows: write was already required).

- **Nobody can steer a kit upgrade session.** Because its token can change the app's CI
  workflows, every route that adds a person's input to an upgrade session — a message (queued or
  interrupting), withdrawing the waiting prompt, an image, a preview screenshot — answers 403
  `upgrade_session_read_only`. The session page shows no message box: it says Launch is running
  the upgrade on its own and, if it stops, to read its last answer and ship it as it stands or end
  it and finish the upgrade on its branch outside Launch (the app page and the stop event say the
  same). `launch sessions say` prints the refusal with that hint. Launch's own turns (the upgrade
  prompt, a ship's fix turns) and Ship / End / Stop are unchanged. The upgrade prompt also names
  where the porting notes are before the apply (`.upgrade/work/<to>/notes/X.Y.Z.md`, `plan.md`).

- **Launch tells an app's CI which GitHub App's gate to trust.** Launch now sets the repository
  Actions variable `LAUNCH_GATE_APP_ID` to its GitHub App id — when an app is launched
  (`github_env`), when an admin presses Apply on the Shipping card's branch protection (how an
  imported app gets it), and when a kit upgrade starts — writing only when the value differs. The
  kit's `verified` CI job runs only with it set, and then skips the full gate for a tree Launch's
  `launch/gate` check run already attested; a kit without that job ignores it. The
  branch-protection diagnosis reports it (`gateVariable`: `ok`, `missing`, `wrong`, `unknown`)
  and the card offers Apply when it is missing or wrong. No new GitHub App permission (Variables:
  write was already required). To detach an app, delete the variable: CI runs the full gate again.

- **A landing waits for the merge commit's `Gate` before it releases.** After Launch squash-merges
  a session's PR, Phase B now reads the squash commit's own checks on the default branch
  (`land.main-ci`, decided on `Gate` like `land.ci`) before it cuts the `release: X.Y.Z` bump and
  tag, so the kit's `deploy.yml` finds a completed green `CI` run on the bump's parent and skips
  the tag's gate. Green → release; red → the landing stalls `main_ci_failed` (the change is
  merged, nothing is released — release it from the app page once main is green); still running
  after 30 minutes (`SHIP_MAIN_CI_MAX_MINUTES`), or no check at all within 3
  (`SHIP_MAIN_CI_NONE_GRACE_MINUTES`, a repo whose CI does not run on main) → release anyway, the
  deploy re-gating as before. No `[skip ci]` on the bump. A release cut by a person (the app page,
  `launch releases`) does not wait.

- **Promote ships the build Staging ran (build once).** On an app whose kit attaches a
  `launch-bundle-<tag>.tgz` to a draft GitHub Release from its staging run, approving a
  production deploy now publishes that draft (`PATCH draft: false`) instead of creating a second
  release, so production deploys the staging bytes; an already-published release is left alone and
  an older kit (no draft) gets a new release as before (production rebuilds). The release notes
  now carry the release's git tree, each session PR's `launch/gate` check, Staging's Worker
  version id and artifact digest, and Live's Worker version id once production is live. Every
  deploy upload records an artifact digest (migration `0041_launch-deploy-artifact-digest`); a
  production upload that differs from Staging's for the same version is warned about and shown on
  the release page ("Live does not run the build Staging ran") — refused only when the job says it
  deployed the bundle (`source: "bundle"`, an optional upload field beside `digest`; nothing changes
  for kits that send neither).

- **A green ship attests its gate on GitHub, and a landing decides on `Gate`.** After the sandbox
  gate passes and the ship's commit is pushed, Launch's GitHub App posts a `launch/gate` check run
  on that commit (`success`, `external_id` `tree:<git tree sha>`, the steps, commands and durations
  in its output) so the kit's CI can skip the gate it would only run again; a failure to post is a
  note in the session, never a failed ship. `ship.commit` now refuses to commit when the workspace
  is no longer the tree the gate ran on, and records that tree (`gateTree`) beside the gate SHA.
  `land.ci` and `land.merge` follow the required `Gate` check when the repo has one: a red optional
  check (an evals run) no longer stops a landing; a repo with no `Gate` check keeps the old rule
  (every check). **Action needed:** the GitHub App now requires **Checks: read and
  write** (was read) — an organisation owner must accept the new permission on the installation
  (Setup's GitHub check reports it missing until then; ships still work, without the attestation).

- **Coding sessions grant the app's REAL RLS role.** A session's database gave `session_owner`
  ADMIN on the kit's pre-rename role `rocketflare_app`, which no Launch-made app has — the kit's
  rename makes it `<snake>_app` (`hello-world` → `hello_world_app`) — so the ship gate's test
  setup (`db-roles`) failed "permission denied to alter role" on any app whose `dev` came from
  staging. Launch now derives the app's role, and when staging's copy (made by `migrator`) is not
  yet held, `neondb_owner` grants it by borrowing `migrator`'s ADMIN for one statement. A `dev`
  prepared before is repaired at the next session's start (still prepared), and an older session's
  own branch before its next gate branch is cut.

- **Kit upgrades for one app.** Moving the template pin (Setup → Kit version) now flags every app
  below it: the catalogue, Settings and the app's Overview say "Requires upgrade → X.Y.Z". The
  Overview's Kit section (and `launch apps upgrade <app>`) starts a coding session that runs the
  kit's `/rf-upgrade` to the pinned tag in one apply — the session may fetch the public kit,
  read-only, and commits nothing: Launch's ship gates, commits and pushes the result; it formats
  `.rocketflare.json` last, so the gate's lint no longer fails on it — and
  ships it on its own when the first turn ends cleanly (`LAUNCH-UPGRADE: DONE`, no question, the
  checkout's `.rocketflare.json` at the target); anything else waits for the owner in the session.
  Every Release now re-reads `.rocketflare.json` at its tag, so the app's recorded kit version
  follows upgrades — Launch's or anyone's — and `app_upgrades` keeps the history.
- **A ship or landing whose Workflow died is restarted.** A `wrangler dev` reload during a
  landing's CI wait left a session `shipping` at stage `ci` for ever, its PR green and never
  merged. Ship, landing and Phase B steps now beat `last_activity_at` while they run, and the
  reconcile (on `GET /api/sessions/:id`, `GET /:id/pr` and the `*/5` cron) terminates an instance
  quiet past a window computed from the longest healthy gap (4.5 min in `ci`/`merging`, 32.5 in
  `approval`, 5 min 10 s for the gate and Phase B) and starts a fresh one that resumes the landing
  where it stood; a gate is salvaged and the person ships again. A squash refused because an
  earlier one just landed is recorded, not reopened.
- **Coding sessions default to Opus 5.5.** A new Claude Code session starts on `claude-opus-5-5`
  (it heads the Setup page's model list too); a deployment whose stored session policy names a model
  keeps it until changed on Setup → Coding agents. The composer's picker still switches per message.
- **The sessions list names each session's agent and model.** An app's Sessions tab has an Agent
  column (Claude Code or Codex, with the model it runs now), since the agent is fixed when the
  session starts; `sessionSummarySchema` (and `launch sessions ls --json`) carry `runtime`,
  `credentialSource` and `model`.
- **Codex sessions offer GPT-6 Astra and GPT-6 Luna beside GPT-6.1 Sol.** The current models Codex
  0.160 lists, priced from OpenAI's published Standard-tier rates, so the composer's model picker
  now shows for Codex sessions too; a switch passes `-m` on the resumed turn and the
  `api.openai.com` egress allows only the new model. A Codex session's composer and queued message
  now say "Codex" where they said "Claude".
- **Show a coding session what its preview looks like.** A camera button in the preview's toolbar
  captures the page you are on, at the pane's size, into the next message as an image chip
  (`POST /api/sessions/:id/preview-screenshot`, a queued `session.preview_screenshot` job through
  Browser Rendering, as PNG). The chip spins until the picture lands, or says why it could not be
  taken. The button shows only where the deployment has Browser Rendering (`BROWSER`); the preview
  grant now says so (`screenshots`) (`docs/CONCEPTS.md` §18.12).
- **The composer names models in words.** The model picker and the transcript's "Switched to …"
  read "Opus 5.5", "Sonnet 5", "Fable 5.1", "Haiku 4.5" (`agentModelLabel`); any other model reads
  as its id.
- **Show a coding session a picture.** Paste an image into the composer, drop one on it, or pick
  one with the paperclip: it uploads at once (shrunk to 1568 px on its long edge first) and shows
  as a chip with a spinner and ×; Send carries up to five, with or without words. Claude Code reads
  them as images (the message goes in on stdin as stream-json); Codex gets them with `-i`. The
  transcript shows each message's images as thumbnails that open full size. Images live in R2
  under the session (`POST /api/sessions/:id/attachments`, `GET …/attachments/:aid`), checked by
  their bytes, 5 MB each (`docs/CONCEPTS.md` §18.11).
- **A coding session no longer sits "Ending…" for ever after a dev-server reload.** An idle session
  (ready, suspended or blocked) whose End, message, ship or resume never reached a running Workflow
  — its wake went to an instance a `wrangler dev` reload had killed while it still reported
  `running` — is now noticed 75 s after the request, on the next read of the session or by the
  `*/5` cron: the dead instance is terminated and a fresh one carries out the request, without
  failing the session. An owed ship is dropped on the way (the session resumes; ship again)
  (`docs/CONCEPTS.md` §18).
- **Write to a coding session while it works: queue the message, or send it now.** The composer
  stays open during a turn. Enter (or Queue) runs the message when the turn ends; Send now stops
  the turn and runs the message next, resuming the conversation, with one line telling Claude its
  last turn was cut off (the `session-interrupted` prompt, editable in Settings). One message
  waits at most; it shows as a muted bubble with Withdraw (`POST /api/sessions/:id/queued/withdraw`)
  and survives a reload (the session's new `queuedMessage`). A stop takes up to about 7 s: the
  turn checks for it every 2 s, then gives Claude Code 5 s to exit (`docs/CONCEPTS.md` §18.11).
- **Coding sessions offer the current Claude models, and the model can change per message.**
  Claude Code sessions now pick from Sonnet 5 (the new default), Opus 5.5, Fable 5.1 and Haiku 4.5,
  all priced from Anthropic's published rates (the 4.x prices stay, so older usage rows and
  sessions on an older model keep their cost). A picker in the composer's footer chooses the model
  for the next message; the switch lands when that turn starts (`sessions.pending_model` →
  `policy.model`, so the model proxy allows the new model and refuses the old one), the turn's
  `turn.start` names it, and the transcript says "Switched to …". A model the runtime does not
  offer is 400 `model_not_offered` (`docs/CONCEPTS.md` §18.11).
- **A session's preview remembers which page you are on.** Launch injects a small script into the
  preview's HTML pages that reports the page's path to the session screen (and only to it). The
  address bar shows it, and Reload, a dev-server restart and "Open in new tab" all land on that page
  instead of the app's home page. An app whose Content-Security-Policy does not allow its own
  origin's scripts (`'self'`) blocks the script and falls back to the old behaviour
  (`docs/CONCEPTS.md` §18.12).

- **`pnpm provision deploy` refuses while a coding session is mid-turn.** Any deploy replaces
  Launch's Worker and cuts the turn's stream to Claude Code (the session survives). Wait for the
  turns, or pass `--interrupt-turns`.
- **The session preview shows on a deployed Launch.** Launch's CSP had no `frame-src`, so the
  browser refused to frame `<port>-<id>-<token>.<domain>` (the "sad page" in the preview pane);
  local dev never saw it because Vite serves the UI without these headers. `frame-src` is now
  `'self'` plus the hosts of `SESSION_PREVIEW_URL` (`https://*.<domain>`), nothing wider.
- **App health checks work when Launch and its apps share a zone.** Launch's Worker now has
  `global_fetch_strictly_public`. Without it, a fetch to `<slug>.<domain>` from a Worker on the same
  zone went to the origin, not the app's Worker, so every probe failed while the app was up.
- **`pnpm provision setup` runs each Setup credential's check**, as the Setup page does on save.
  Before, it only sealed the values, so the Cloudflare zone id was never recorded and creating an
  app failed at "Create the Workers" until someone pressed Check.
- **A subdomain nothing is launched at no longer opens Launch.** The `*.<domain>/*` route that
  brings session previews to Launch brought every other host too, so `bob.<domain>` showed the
  Launch app. Now any host under the preview domain that is not a preview, not Launch's own and not
  an app answers 404: a browser sees the rocket on its pad saying nothing has launched there, with
  a link to Launch; anything else gets one line of text. Never cached, by the browser or
  Cloudflare's edge, so an app or preview deployed at that host answers at once; `noindex`, no script
  (`docs/CONCEPTS.md` §18.12, `docs/DEPLOY.md` § Coding sessions).
- **Deploy your own Launch from one file: `launch.deploy.env` → `/launch-deploy` (or
  `pnpm provision all`).** A fresh clone fills one git-ignored file at the repo root (copy
  `launch.deploy.env.example`: the domain, the admin, the GitHub org, three account tokens), and the
  scripts do the rest: the GitHub App from a manifest (you click Create, then Install), Neon, the
  Cloudflare resources, migrations, the apps wildcard, the deploy, every Worker secret (the
  generated `OAUTH_ENCRYPTION_KEY` is written back to the file, so **back it up**), the Setup page's
  credentials sealed into the instance, and email. The committed tomls stay templates; an instance's
  ids live in `.launch/` and every wrangler call uses the rendered `apps/web/wrangler.deploy.toml`.
  Rerun it to update; a second instance is a second file (`LAUNCH_DEPLOY_FILE`). The runbook is the
  new `docs/DEPLOYMENT.md`. **`/launch-provision` is gone**, replaced by `/launch-deploy`;
  `apps/web/.provision.env` is no longer read (`pnpm provision check` says to move it), the
  `--driver`, `--deploy` and per-environment arguments are gone, and CI deploy of an instance is not
  wired yet.
- **A ChatGPT plan is no longer stuck "in use" after a turn dies.** A claim only blocks while its
  session is mid-turn; a turn killed before it could release (a deploy, a crash, a dev reload) no
  longer makes the next session wait out the two-hour expiry.
- **Codex on a ChatGPT plan works again: `chatgpt.com` is no longer proxied** (`docs/CONCEPTS.md`
  §18.22-B). ChatGPT answers requests sent from the Workers runtime with a 403 block page, so every
  turn failed at model discovery ("workspace routing discovery failed"). The container now reaches
  `chatgpt.com` directly with Codex's own client — it already holds the person's `auth.json` for the
  turn — and the turn is metered from Codex's own `turn.completed` usage (`subscription`, no cost),
  as on the sandbox host. Lost: the path and model allow-list on `chatgpt.com` (Codex's
  `config.toml` keeps analytics, feedback and OTEL off). Needs `SESSION_EGRESS=open` (the tomls).
  The token refresh on `auth.openai.com` is still proxied and resealed at once. **Redeploy the
  sandbox host** (`pnpm --filter @launch/web deploy:sandbox-host`): its egress grant's `chatgpt`
  part is now `chatgptRefresh`, and an old host refuses a ChatGPT plan's turn.
- **Connecting your Claude subscription or ChatGPT plan moved from Profile to Home.** While nothing
  is connected it leads the page ("Connect your coding agent", one row per account your
  organisation allows, with Claude's and Codex's own marks); once one is connected it shrinks to
  one quiet line, still first.
- **A session's preview no longer reloads at the end of every turn.** Edits reach it through Vite's
  HMR as they are saved; it reloads by itself only when the dev server comes (back) up, and the
  Reload button forces a fresh load.
- **The remote sandbox host runs everything Launch's own sandboxes run** (`docs/CONCEPTS.md`
  §18.10, §18.22). Codex (on Launch's OpenAI key or a person's ChatGPT plan), sessions on a
  person's Claude subscription and personal sign-ins now work on the sandbox host, not only Claude
  Code on Launch's key: Launch grants each turn the credential for its runtime and account, and the
  host's handlers forward through the SAME functions as Launch's (`egress/forward-model.ts`, the new
  `egress/forward-openai.ts`, `egress/forward-git.ts`). Usage on the host is metered per turn from
  the CLI's own output, OpenAI-priced for Codex and recorded as `subscription` for personal
  accounts. Fixes a host-mode Claude subscription turn that would have run on a placeholder API key
  instead of its OAuth token. **Redeploy the host** (`pnpm --filter @launch/web
  deploy:sandbox-host`, `docs/DEPLOY.md` § The sandbox host) — it also moves it to the `session-6`
  image and replaces its running containers; an older host answers only Claude Code on Launch's
  key. The Coding agents card's "not available with the remote sandbox host" lines are gone.
- **Where a session's container runs is a platform setting** (`docs/CONCEPTS.md` §18.10):
  Settings → Platform → Coding agents → **Session sandbox** — this Worker's containers (local
  Docker under `pnpm dev`, Cloudflare deployed) or the remote sandbox host (development only),
  `PUT /api/platform/setup/session-sandbox` (audited; 409 `session_sandbox_unavailable` for a host
  this Worker cannot use now). It applies to new sessions with no restart; each session keeps the
  host it started on (`sessions.sandbox_host`, migration 0037). `pnpm dev` now offers both whenever
  it can — local containers unless Docker is down, the remote binding when you are logged in to
  wrangler and the host is deployed — and says which it could not. The `SESSION_SANDBOX_HOST` var is
  retired: a `.dev.vars` still saying `remote` is read once as the setting's starting value.

- **Sessions: agent runtimes and personal AI accounts — the foundation** (`docs/CONCEPTS.md`
  §18.22). A session now records which coding agent it runs and whose account it bills, fixed at
  start; nothing changes on a default deployment (Claude Code on Launch's key). New, all off by
  default: the Platform → Coding agents tab (below), the `AGENT_LOGIN_WORKFLOW` Workflow, the
  optional `OPENAI_API_KEY` secret and the
  `openai_api_key` Setup credential; `POST /api/apps/:id/sessions` takes `runtime?` and
  `credential?` (409 `session_runtime_disabled` / `agent_credential_not_allowed` /
  `agent_credential_required`); `/api/me/agent-credentials` and `/api/me/agent-logins` (a relayed
  sign-in in a throwaway sandbox); Profile → AI accounts and the session card's agent / "Bill to"
  picker appear only when a deployment allows a choice; `launch sessions start --runtime`. A session
  billed to a personal account takes turns and ships only from its owner (409
  `session_credential_owner_only`) and has no money budget; its usage is recorded with
  `ai_usage.billing = 'subscription'` and no cost. The sender of every message is now recorded, so
  a landing's "who wrote messages" counts everyone who did. Migration 0036. The two runtimes'
  sign-ins and egress follow in the next two entries.
- **Coding agents are a Setup page setting, not deployment vars** (`docs/CONCEPTS.md` §18.22).
  Settings → Platform → Setup → Coding agents: per agent (Claude Code, Codex) an on/off switch, the
  model (only priced models — a session's budget needs a price) and who pays (Launch, the person's
  own account, or either), with readiness — whether Launch's key is set, how many people have
  connected an account, the image Codex needs. Allowing personal accounts asks the admin to accept
  the vendor's terms first. Stored in the session policy (`PUT /api/platform/setup/session-agents`,
  audited); changes apply to new sessions. Fail-closed: with nothing set, Claude Code on Launch's
  key only. Starting a personal sign-in the setting does not allow is now 409
  `agent_logins_disabled` (was 503). The Setup page also gains an optional Anthropic key card.
- **Sessions on your own Claude subscription** (`docs/CONCEPTS.md` §18.22-A; only where the Coding
  agents card lets Claude Code bill a person's own account). Profile → AI accounts → Connect runs Claude
  Code's own `claude setup-token` in a throwaway sandbox: open Anthropic's sign-in in a new tab,
  paste the `code#state` it shows back into Launch, and the year-long token is stored encrypted. A
  session billed to it runs with a placeholder token; Launch's model proxy swaps the real one in,
  records the usage with no cost and no money budget, answers 404 to Claude Code's requests for
  org-managed settings, and marks the account "Needs reconnecting" when Anthropic refuses the
  token. The sandbox egress gains a `platform.claude.com` handler that only a Claude sign-in may use.
- **Sessions: Codex as a second coding agent** (`docs/CONCEPTS.md` §18.22-B). With Codex turned on
  in the Coding agents card, a session can run OpenAI's Codex CLI (pinned 0.160.0, default model
  `gpt-6.1-sol`) on Launch's OpenAI key — the new Setup card's `openai_api_key`, checked against the
  model, else `OPENAI_API_KEY` — swapped in at the egress and metered as `openai`; with its "Who
  pays" allowing personal accounts, on a person's ChatGPT plan, connected in Profile → AI accounts by
  OpenAI's device-code sign-in (one session at a time per plan; rotated tokens stored as Codex
  refreshes them). The session image is now `session-6`: drain sessions before deploying it
  (`docs/DEPLOY.md`). OpenAI keys and JWTs are redacted from session transcripts like Anthropic
  keys.
- **Pages use the full width.** Audit, Secrets, Approvals, the apps catalogue, Notifications and the
  Settings, Setup and Admin areas no longer stop at a fixed width; forms and prose keep a reading
  width (`docs/DESIGN.md`).
- **Home is bolder and full width.** Each section has a real heading, a count and its actions on
  the right. The apps are large cards in a grid (up to four across), each led by the app's
  screenshot — or a large initial — with its name, what needs a look, and the Live and Staging
  versions; the whole card opens the app. "Waiting on you" lists its requests on one panel;
  nothing waiting stays one quiet line.
- **Audit is the one log.** Every kit activity — inviting, joining, removing or re-roling a member,
  invitations, API keys, groups, organisation settings, support access, and the plugins' own (the
  analytics dashboards) — is now also an audit event, hash-chained and sealed like Launch's own,
  with the activity type as the action (`member.role_changed`) and the metadata as its summary
  (secret-looking keys recorded only as `set`). The sidebar's "Activity" item is gone and
  `/activity` redirects to `/audit` (query and anchor kept), whose filter takes `member`,
  `invitation`, `api_key` …. Forward-only: activity recorded before this release is not in the
  chain. `activity_events` and `GET /api/activity` are unchanged.
- **Sidebar: no gap above Analytics.** A plugin's unlabelled nav group now joins the unlabelled
  group it lands after instead of starting a group of its own, so "Analytics" sits with Home,
  Apps, Secrets and Approvals; a group whose items are all hidden leaves no space behind.
- **App thumbnails.** After a deploy goes live, Launch takes a screenshot of the app's root URL in
  the background (Cloudflare Browser Rendering, 1280×800, WebP) and shows it beside the app on
  Home, in the catalogue and in the app header — Live's, else Staging's, else the app's initial.
  It is taken without signing in, so an app behind sign-in shows its login page. Settings → General
  has "Refresh thumbnail" for admins (once a minute per app). New `[browser] binding = "BROWSER"`
  in both tomls (Workers Paid recommended; without it there are no thumbnails and nothing fails),
  `GET /api/apps/:id/thumbnail`, `POST /api/apps/:id/thumbnail/refresh`, the `app.thumbnail` job,
  and `thumbnail` on the app list and detail; migration `0035` adds the columns.
- **Home is an overview.** The approvals waiting on you (what, which app, who asked, how long ago —
  each a link to the request; one quiet line when there are none) and the apps, one row each: the
  version Live runs with its health, the version on Staging, and one word when something needs a
  look ("Live deploy failed", "awaiting approval", "not live yet"), those first. "New app" for
  whoever may create one; the full lists are one link away. It reads the catalogue and the inbox
  only — no request per app. The old quick links are gone (a plugin's still show, as one line).
- **"Shared config" is now "Secrets"** in the nav, the pages, the approvals (the kind reads "Secret
  access"), an app's Config & secrets, the session ship panel and the CLI's messages. The pages
  moved to `/secrets` and `/secrets/:id`; `/shared-config` links redirect, keeping the id, query and
  hash. The API (`/api/shared-resources`), the tables and `launch shared` keep their names.
- **A coding session starts for an app that has deployed.** The app's session database (`dev`)
  was cut schema-only from production, which Neon refuses once the app's first migration has made
  its RLS role there ("legacy web access role"). `dev` is now copied from the app's staging branch
  and scrubbed before any session can see it — the app's database dropped, every inherited
  password reset — and `apps.session_db.devSource` records which. An app with no staging branch
  keeps the old schema-only copy, and once that is refused says so (503
  `session_dev_needs_staging`). An existing `dev` is reused unchanged.
- **Roll back Live to an earlier release.** "Roll back to here…" on a Releases row's ⋯, on the
  release page, or `launch releases rollback <app> <version>`: Launch asks for the same production
  approval as Ship, then runs the repository's own deploy workflow at the old tag
  (`workflow_dispatch`, `environment=production`) — the app stays detachable, and nothing is rolled
  back on Cloudflare's side. Migrations and secrets don't revert, and the confirm says so. Once it
  is live the Live row reads "v1.4.1 (rolled back from v1.4.2)" and the release rolled back from is
  marked `rolled_back` (`POST /api/apps/:id/releases/:rid/rollback`; audited
  `release.rollback_requested` and `release.rolled_back`; migration `0034` adds the status and
  `app_releases.rolled_back_from`). A tag dispatch's `X.Y.Z-<sha7>` build label is read as `X.Y.Z`.
- **`main  N commits ahead  [Release to staging ▸]`** above Staging on the Overview: the default
  branch against the latest release tag (`GET /api/apps/:id/releases/compare`, cached a minute per
  app), with the release dialog (patch by default) listing the commits. `launch releases ls` says
  how far main is ahead (`mainAhead` with `--json`).
- **A stuck release has one Retry, labelled with what it does.** Every release now says where it is
  stuck (`failedStage`), and `POST /api/apps/:id/releases/:rid/retry` does the one thing for that
  stage: re-runs the failed jobs of that GitHub run (attempts are kept, and a Live re-run keeps its
  approval), pushes a lost tag again, checks health now, or asks for approval again. Needs you, a
  Releases row's ⋯ and the release page offer it ("Retry staging deploy", "Check staging again",
  "Request approval again"), the release page lists each run attempt, and `launch releases retry
  <app> <version>` is the same from a terminal. **Fix in a session** starts a coding session
  seeded with the failure — the stage, the run and the failed job's log tail
  (`POST /api/apps/:id/sessions { fixRelease }`). **Cancel release** (⋯, or `launch releases
  cancel`) cancels a release's deploy run in flight on GitHub; Retry runs it again. The approval
  and agent action panels lose their coloured left edge (`docs/DESIGN.md`).
- **The app page is an Overview and tabs.** `/apps/:slug` answers "use it, change it, is my change
  live?": a Needs-you list only when something needs a person (a failed release or deploy, an
  approval waiting on you, missing config), then Staging and Live as one row each with "N changes
  not live" and **Ship vX live** between them, a release in flight as one line on the row it is
  changing ("→ v1.4.2 · Waiting for approval from Bob · Copy link"), and the active sessions. The
  header carries `vX live`, Open ↗, **Change it** (start a session) and a ⋯ menu. Sessions,
  Releases (one row per version, each with its own page: deploys, PRs, history), Activity (health,
  the app's audit log for admins, operations) and Settings (General, Config & secrets, Access &
  sign-in, Shipping, Danger zone) are tabs. The old `/apps/:slug/config` and `/apps/:slug/access`
  redirect into Settings. The pipeline strip, the deploy stepper panel, the large environment
  cards and the standalone deploys card are gone; "Promote to production" is now **Ship**, and
  the UI calls the environments Staging and Live. Actions a reader cannot use are hidden.
- **`docs/DESIGN.md`**: the visual rules Launch's screens follow (rows over tiles, no card-in-card,
  no accent stripes, one hero action per view, colour for state only). The catalogue's red card
  edge for an unhealthy app is gone — its dots already say so.
- **Chat, Agents, Knowledge and Search are hidden** behind a new environment-gated feature flag,
  `kit-ai`, that no toml lists. Add it to `FEATURES_ENABLED` to bring them back; the APIs still
  answer. Analytics and the AI settings tabs stay.

- **The app page no longer calls a never-deployed environment "Down", nor stale health "healthy".**
  Launch's placeholder Worker marks its answers (`x-launch-placeholder: 1`); the health probe reads
  it as `unknown` with "Not deployed yet", and the environment card says so instead of Down with an
  HTTP 503. The pipeline strip ignores a health check older than the environment's last deploy
  ("not checked since it was deployed", Promote waits), and a deploy's `finish` now probes the app
  so the new version is judged straight away.

- **The pipeline strip follows a release's tag run on GitHub before staging.** While the newest
  release is `tagged` (or deploying to staging) the strip says "v0.15.7 is tagged — GitHub is
  checking it before it deploys to staging" with the job it is on, then "Deploying v0.15.7 to
  staging…", each with **View on GitHub**. A tag run that fails before its staging job (a red gate)
  now marks the release `failed` (audited `release.failed`) — the strip says "v0.15.7 did not
  deploy: ci / Gate failed", and a session's landing stalls `deploy_failed` at once instead of
  timing out after 45 minutes. `GET /api/apps/:id/promotion` gains `candidateRun` (nullable,
  defaulted); migration 0033 adds `app_releases.tag_run` / `tag_run_polled_at` (the per-release
  read throttle).
- **A session PR merged by hand on GitHub releases to staging too.** When `sessions.checks` finds
  a session's PR merged and no landing was moving (a session shipped before #5, or one left at
  stage `pr`), it adopts the merge in a `staging`-mode app: a `releasing` landing, `ship.merged`
  and `session.merged` marked `by: 'github'`, then the session's Workflow restarts into the same
  release → staging → live follow as after Launch's own merge. Only merges under 24 hours old
  (`LAND_ADOPT_MAX_AGE_HOURS`) are adopted, so older merged PRs are not released all at once;
  `pr`-mode apps still release by hand. The ship panel and the CLI say "Merged on GitHub"
  (`docs/CONCEPTS.md` §18.13).

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
