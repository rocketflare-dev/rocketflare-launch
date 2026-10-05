# Sandbox session issues

## Status

Updated 2026-09-29.

- **Local Docker works.** Checks 1–5 pass (see Results); ship (6) waits on issue #1.
- **Remote is blocked by an open platform-level hang.** A remote session's kit bootstrap stalls
  every time at step 5 (`db:migrate`): a database WebSocket that never reaches the Worker. See
  "Open: the remote bootstrap hangs" below. **Workaround pending a check (2026-09-29):**
  `SESSION_EGRESS=open` takes the database out of the egress interception; the next step is a
  fresh remote session (`sandbox-websocket-close.md`, "Research" and "Rollout"). Everything before it now works remotely: the Neon
  branch, the sandbox start, the clone (the host's grant handlers), install, and bootstrap steps 1–4.
- **Deployed Launch uses the same real containers**, so the open hang would stop sessions in
  production too. It must be solved before Launch is deployed (README "Next" item 7).
- `apps/web/.dev.vars` is left on `SESSION_SANDBOX_HOST=remote`. Unset it for local Docker.

| Mode | Set in `apps/web/.dev.vars` | Where the container runs | How it reaches GitHub and Anthropic |
|---|---|---|---|
| Local Docker | `SESSION_SANDBOX_HOST` unset | `wrangler dev`'s Docker (colima on this Mac), amd64 | Launch's outbound handlers (`egress/github.ts`, `egress/anthropic.ts`) inject the token and key |
| Remote (dev only) | `SESSION_SANDBOX_HOST=remote`, `SESSION_BACKEND=cloud` | The deployed Worker `launch-sandbox-dev` on real Cloudflare containers, through the remote service binding `SANDBOX_HOST` | `host` egress (`egress/host.ts`): Launch sends an egress grant; the host's own outbound handlers (`src/sandbox-host/egress.ts`) inject the token and key |

The container holds no credential in either mode: only the placeholder key, no git credential file
or helper.

## Root causes found

1. **Remote clone got no credential.** The old `direct` mode wrote the token to a file read by
   git's `store` helper. `store` **erases** a credential GitHub rejects, and GitHub rejects a freshly
   minted installation token for about a second (the git proxy had already seen a 404 one second
   after a mint). Overlapping checkout attempts in the same container made it worse: one attempt's
   rejection emptied the file under the next. Every later git call then had nothing:
   "could not read Username".
2. **Local Docker ran amd64 under QEMU, not Rosetta.** The Go GC crashes, the esbuild segfault and
   Claude Code's core dumps (11.5 GB in `/workspace/app`) are QEMU user-mode failures.
3. **`--permission-mode acceptEdits` denied Bash.** In `-p` mode it silently denies every shell
   command outside the `settings.local.json` allow-list, so a turn could not run commands.
4. **`HOME` was unset** in the SDK's shells, so the transcript path (derived from `HOME`) and git's
   global config were not where Launch expected them.

## What changed

1. **`host` egress replaces `direct`** (`a7ff9c1`). `HostEgress` sends a per-sandbox `EgressGrant`
   (repo, branch, upstream, the sealed installation token and its expiry; the key and the policy's
   model) over the binding; `HostedSessionSandbox` keeps it in its Durable Object storage (cleared
   on `destroy()` and `onStop`), and its own `outboundByHost` injects it through the proxies' pure
   cores (`forward-git.ts`, `forward-model.ts`): one repo, a push only to `session/<short>`, the
   model allow-list, a fresh token's 401/404 retried. Remote turns are still metered per turn
   (`turn-meter.ts`) and killed at the budget.
2. **Permissions** (`810356f`). Turns run `--permission-mode bypassPermissions` with `IS_SANDBOX=1`
   and `HOME=/root` (the checkpoint's git too); `settings.local.json` is deny-only.
3. **Checkout hardening** (both modes). `GIT_TERMINAL_PROMPT=0`, the whole checkout under `flock` on
   `/workspace/.launch/repo.lock` (120 s), and a failure reports git's last 15 stderr lines.
4. **Local Docker on Rosetta.** colima restarted with `--vm-type vz --vz-rosetta --cpu 6 --memory 12`
   (`docs/SESSIONS-LOCAL.md`).

## Found 2026-09-29 (remote)

1. **The database WebSocket never opened** from a real container: a passed-through 101 carried
   `Upgrade`/`Connection` twice, which Node's clients reject. Fixed in `8de9d75` (the neon handler
   re-wraps the 101 without the origin's copies).
2. **The remote binding drops a long blocking exec RPC** after ~7 min ("Peer closed WebSocket:
   1006"): the result is lost while the command keeps running in the container.
3. **The Sandbox SDK serialises every call behind a running `exec`**: during a 25 s exec,
   `readFile`, `startProcess` and another `exec` all waited. A step retry's short exec ("did not
   answer within 2 min") queued behind the orphaned first run. A BACKGROUND process blocks nothing
   (`startProcess` answers in 0.3 s; its log file reads live).
4. **So the install and the kit bootstrap now run in the background and are polled**
   (`services/sessions/background-command.ts`, branch `observable-bootstrap`): files
   `<name>.log|.pid|.exit` under `/workspace/.launch`, a step retry attaches to the live run, the
   deadline kills the process group, and the running boot step shows the kit's latest `✔ n/10`
   line — which is how the next remote run will show WHERE the bootstrap stalls. Still one
   blocking exec: the ship gate. Merged (`83a6d00`); the progress detail works remotely.
5. **An upgrade Neon does not answer in 20 s is now a 504**, logged by the handler
   (`12ecb66`), not a hang. It did NOT fire for the open hang below: that request never reaches
   the handler.
6. **The kit's bootstrap puts the database URL (with its password) on its command line**
   (`--db-url "$LAUNCH_DB_URL"` expands before `node` runs), so `ps` inside the container shows it.
   It is the session's own throwaway branch, but the rule is "env var only". Fix: the kit reads
   the URL from an env var (a kit change), or Launch writes `.dev.vars` before the bootstrap.
7. **Tools missing from the image:** `pgrep` resolves but lists nothing useful (Node processes show
   as `MainThread` in `ps -o comm`); `ss`, `strace` and SSH are absent (SSH needs `[containers]`
   config and a redeploy). `lsof` works.

## Open: the remote bootstrap hangs

> **Root cause found (2026-09-29): see `sandbox-websocket-close.md`.** The interceptor never ends
> the container's stream after a WebSocket closes, so the kit's scripts finish their work and then
> can't exit. That doc has the evidence, the options, the decision (`SESSION_EGRESS=open` for
> now) and the Cloudflare issue draft. The notes below are the investigation that led there.

**What happens.** Every remote session (`b2b1cd0c`, `c028c2a0`, `9e467448`) hangs in the kit
bootstrap's step 5, `pnpm db:migrate`, until the 15-minute deadline kills it. The step retry then
hangs the same way.

**What is known:**

- Each kit script opens its OWN Neon WebSocket pool and exits. In the bootstrap, `db:check`
  connects, then `db-roles --phase=role` hangs. Run by hand in the same container, `db:check` and
  `db-roles` succeed and `migrate.ts` hangs next. So it is not one script; after one or two
  connections, the NEXT one stalls.
- The stuck process holds ONE established TCP connection to the Neon endpoint's intercept address
  (`[fd00::119:1]:443`), idle (`lsof`; `/proc/net/tcp6` queues 0). `pg_stat_activity` shows NO
  backend from it: nothing reached Postgres.
- The host Worker never sees it. During a reproduction, `wrangler tail launch-sandbox-dev` logged
  exactly one `ContainerProxy` fetch for the Neon host (the connection that worked, ending
  `responseStreamDisconnected` when its script exited). The 20 s upgrade timeout never fired. So
  the stall is **inside the container's egress interception, before the outbound handler**.
- **Not reproduced in a fresh scratch sandbox** with handshake-only traffic (a raw Postgres
  startup message, answered by `R`/3): 10 WebSockets held open at once, 12 opened and closed in
  turn, and 8 separate processes each exiting without a close all worked (~100–200 ms each).
  The difference left: real authenticated traffic (password, queries, `pool.end()`), and a
  container that already holds stuck connections.
- The local Docker path (`wrangler dev`) runs the same bootstrap in about 40 s.
- Already on the latest stable packages (`@cloudflare/containers` 0.3.7, `@cloudflare/sandbox`
  0.12.10).

**Research (2026-09-29, Cloudflare docs, the SDK source, GitHub issues, similar projects):**

- **Our credential injection is the intended pattern.** `outboundByHost` for `api.anthropic.com`
  and `github.com` is Cloudflare's own `sandbox-sdk/examples/authentication`.
- **The database path is the part nobody else does.** Interception is documented only as
  HTTP/HTTPS request/response on ports 80/443 (developers.cloudflare.com/containers/platform-details/outbound-traffic,
  /sandbox/guides/outbound-traffic, blog.cloudflare.com/sandbox-auth). WebSockets and databases
  are never mentioned. There is no official example of a container reaching a database, and no
  project was found that runs pooled DB WebSockets through `interceptHttps`. Hyperdrive from a
  container is "on the roadmap" (cloudflare/containers#97).
- **The interceptor has open bugs that fit.**
  - Accepted but never dispatched: sandbox-sdk#844 (0.12.9 and @next, handler never called,
    `wrangler tail` silent) and #930.
  - It rewrites HTTP framing: containers#220, #195, sandbox-sdk#814; our duplicated `Upgrade`
    headers are one of these.
  - Its fixes ship only when the container APPLICATION is rolled out again, not with an npm bump
    (sandbox-sdk#747).
- **Ruled out.**
  - `placement` (sandbox-sdk#661, containers#226): we have none.
  - Class-field `outboundByHost` (containers#247): ours is assigned after the class.
  - A mid-flight `setAllowedHosts` re-registration: it is called once, before the install.
  - A pooler/direct host mismatch: the session URI is unpooled.
  - `ContainerProxy` (containers 0.3.7) has no queueing or limits in JS, so the stall is below it.

**What changed (not yet run remotely):** fewer database connections from the sandbox.

- Launch makes the app's RLS role (`<snake>_app`, the kit's `rocketflare_app` renamed) on `dev`
  itself (NOLOGIN, held by `session_owner` WITH ADMIN OPTION, so a turn's `pnpm db:migrate` can
  still alter it).
- The bootstrap preload always skips `db:check`, and runs `db:migrate` as the migrator alone,
  without `db-roles`.
- A new session used to re-run the WHOLE bootstrap, seed included, on a branch of an
  already-seeded `dev`: its own `migrations_hash` was null, and that is what counted as
  "prepared". That was the five-connection path every hung run took. Now the prepare records its
  migrations hash on `apps.session_db`, and a session branched from a `ready` `dev` starts from
  it.

| Case | Connections before | Connections now |
|---|---|---|
| A prepare | 5 | 2 (migrate, seed) |
| A new session on a ready `dev`, same migrations | 5 | 0 |
| The same, newer migrations, or a `dev` prepared before the hash was recorded | 5 | 1 |
| A new session branched while `dev` is being prepared elsewhere | 5 | 2 |
| A resume with changed migrations | 3 | 1 |
| A plain resume | 0 | 0 |

If the prepare's seed still hangs, the interceptor fails on its own, not on our connection count.
The next steps are then: the diagnostic below (HTTPS, Neon's HTTP `/sql`, and a new WebSocket from
the stuck container); moving the kit's scripts onto neon-http (a kit change); or rolling out a new
container version (a redeploy). Ask before either of the last two.

**Found (2026-09-29, session `d0d0cbc5`, after the change above): it is not a hang, it is an exit
that never happens.** With a single `migrate.ts` process stuck, the host's tail showed all three
of its `/v2` upgrades reach the handler and end (`responseStreamDisconnected`) within 3 s, while
the process still held three ESTABLISHED sockets to the intercept address and Postgres had no
backend left. The session's branch already had all 18 migrations. In the same container:
- a `Pool` query plus `pool.end()` finished in 190 ms, and the process could still not exit 20 s
  later (`timeout` killed it);
- a bare WebSocket's `close(1000)` never got its close frame back: `onclose` never fired and the
  socket sat in CLOSING (readyState 2).

So a passed-through socket's close is forwarded to Neon but never completed back to the
container, and Node does not exit while a socket is open. `db:check` calls `process.exit(0)`, and
so did every earlier probe, which is why neither ever "hung"; `migrate.ts`, `db-roles.ts` and
`seed.ts` end their pools and wait for Node to exit. **The fix**: `forwardDatabase` terminates the
WebSocket in the Worker (a `WebSocketPair` towards the container, Neon's socket accepted, messages
relayed, every close answered on both sides). Belt and braces for the kit: its three scripts
should `process.exit(0)` once done (an upstream kit change).

The `configure` RPC the tail shows every ~2.5 s is Launch's own polling: each host call goes
through `getSandbox()`, which sends the SDK's `configure(options)` — a no-op when unchanged.

**Next research (a fresh session):**

1. Reproduce with REAL authenticated traffic in a scratch sandbox: a loop of separate processes,
   each `openScriptSql` → a query → `end()`, against a test branch. This needs a database
   credential inside the probe. **The user allows it (2026-09-29): session branches are
   throwaway**, so a session's sealed URI (`sessions.db_uri_sealed`, `decryptToken` with
   `OAUTH_ENCRYPTION_KEY`) may be decrypted for the probe — kept in a 0600 file, never printed.
2. If it reproduces: find the trigger (the count, the `pool.end()`, the time between connections,
   the TLS session), then report it to Cloudflare with the repro.
3. Workarounds to weigh: keep one connection alive across the kit's scripts (a kit change);
   route the database through the handler differently (a Worker-side WebSocket pair instead of a
   passthrough); `enableInternet` for the Neon host only, if the platform allows it.

**The probe harness** (`/tmp/sbx-probe`, not committed): a `wrangler.toml` with ONLY the remote
service binding (`SANDBOX_HOST` → `launch-sandbox-dev`, `remote = true`), and Node scripts that
call it through `getPlatformProxy()`: `start` → `setAllowedHosts` (the base list plus the endpoint
and `api.<region>.neon.tech`) → `writeFile` + `exec` → `destroy`, on a scratch name
`probe-*`. The same binding can `exec` in a live session's sandbox (by its session id): that is
how the process list and `lsof` above were read. Remember the SDK serialises calls behind a
running `exec`.

## Before retesting

1. The Anthropic key: set as `ANTHROPIC_API_KEY` in `apps/web/.dev.vars` (the env fallback of
   `resolveModelKey`); turns run in local Docker.
2. `launch-sandbox-dev` is redeployed (see Deployed resources).
3. **Local crons do not fire under `wrangler dev`**: a session stuck in `ending` or a dead
   Workflow is settled only by the `*/5` reconcile. Fire it by hand until `dev-server.mjs` does:
   `curl "http://localhost:3001/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"`.
4. Launch's own test Postgres is on :5499 (the kit's is :5433).

## Validation checklist

Run each item in BOTH modes: local Docker (`SESSION_SANDBOX_HOST` unset) and remote
(`SESSION_SANDBOX_HOST=remote`, `SESSION_BACKEND=cloud`). Events: on the dev database (container
`launch-dev-postgres-*`, user `launch`, database `launch_dev`),
`select seq, at, type, data from session_events where session_id = '<id>' order by seq`.

1. **Boot timings** from `session_events`: each `step` (branch, sandbox start, clone, bootstrap,
   dev server) to `ready`.
2. **A turn that runs shell commands** (e.g. "run `ls` and `pnpm -v`") completes, with `tool.start`
   / `tool.end` for Bash.
3. **`id; echo $HOME`** in a turn prints root and `/root`.
4. **Turn 2 resumes** the conversation (`--resume` works; the model remembers turn 1).
5. **Checkpoint** pushes `session/<short>`.
6. **Ship** opens a PR.

Remote only:

7. **No credential file** in the container (`ls -la /workspace/.launch`, no `git-credentials`;
   `git config --system --get-regexp credential` empty).
8. **`env | grep -i anthropic`** shows only the placeholder.
9. **A push to another branch is refused** with a 403 (e.g. `git push origin HEAD:refs/heads/x`
   from a turn, or by hand over `wrangler containers ssh`).

## Results

Local Docker run on 2026-09-29, session `608db49e` on hola-world (idle suspend cut to 1 minute on that row for the warm test; the cold path forced with `docker kill`). Remote runs the same day: `b2b1cd0c`, `c028c2a0`, `9e467448`, all stopped in the bootstrap (see "Open: the remote bootstrap hangs").


| Check | Local Docker | Remote |
|---|---|---|
| 1. Boot timings | ✔ 63 s to ready (db 13 s, sandbox 1 s, clone 2 s, install+seed 40 s, dev 7 s) | ✖ db 14 s, sandbox 2–4 s, clone 3 s, install 7–13 s, then the bootstrap hangs at step 5 |
| 2. Turn with shell commands | ✔ Bash `tool.start`/`tool.end` | blocked (never ready) |
| 3. `id; echo $HOME` | ✔ `uid=0(root)`, `HOME=/root` | blocked (never ready) |
| 4. `--resume` on turn 2 | ✔ same container; warm resume (<1 s to ready); recreated container (clone + bootstrap + transcript restore, but "Starting sandbox" 1 m 44 s) | blocked (never ready) |
| 5. Checkpoint push | ✔ debounced, ~30 s after the edit turn | blocked (never ready) |
| 6. Ship → PR | blocked on issue #1 | blocked |
| 7. No credential file | — | blocked (never ready) |
| 8. Placeholder key only | — | blocked (never ready) |
| 9. Other-branch push refused | — | blocked (never ready) |

### Found in the 2026-09-29 run

- **Local crons never fire.** `wrangler dev` does not run `[triggers] crons`, so the `*/5` reconcile never ran: a session sat in `ending` for 9 hours until the cron was fired by hand (`curl "http://localhost:3001/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"`). Fix: `dev-server.mjs` fires each cron on its schedule.
- **`grep` is broken in Claude's Bash after a recreated container**: every `grep` answered `error: unknown option '-G'`, and Claude fell back to `command grep`. It is likely Claude Code's shell snapshot aliasing `grep` to a tool that is missing or different in the image.
- **"Starting sandbox" took 1 m 44 s** once the killed container had been recreated by workerd (compare 1 s normally). This is the same symptom as the resume hang noted in `README.md`.
- **The preview reloads after every turn.** HMR already shows edits live; the reload is only needed when the dev server restarts (`preview.ready`). **Fixed 2026-10-03:** the frame reloads only on `preview.ready`; the Reload button forces one.

## Deployed resources (created 2026-09-28, with the user's go-ahead)

- **Worker:** `launch-sandbox-dev`, version `c98a0a88` (2026-09-29: the grant handlers, the
  `*.neon.tech` passthrough and its upgrade timeout). No routes, no public URL.
- **Container application:** `launch-sandbox-dev-hostedsessionsandbox` (id
  `a0318e29-600f-4151-a8dd-7490f86e0445`), `standard-3`, `max_instances = 3`.
- **Cost:** about $0.08 an hour per awake container.
- **Deploy command:** `pnpm --filter @launch/web deploy:sandbox-host`. **Check `wrangler containers
  list` afterwards.** The first deploy exited 0 after uploading only the Worker: the push of the
  730 MB layer (the pre-filled pnpm store) stalled, and wrangler didn't report it. The retry
  completed.
- **Removal:** `wrangler delete -c wrangler.sandbox-host.toml`, then
  `wrangler containers delete a0318e29-…`, then `wrangler containers images delete …`.

## Slow, not broken

**`Creating database branch` took 13–16 s** (`neon-session-db.ts` `createBranch`). It waited for
**every** Neon operation in sequence, with a flat 1 s sleep before each poll
(`NeonClient.waitForOperations`, `NEON_LOCKED_DELAY_MS = 1000`). That included `start_compute` (a
cold start the first connection would trigger anyway) and a per-session role password reset.

- **Done (slice 2a of rocketflare-launch#1):** a new branch waits for `create_branch` only
  (`waitForBranch`; also `dev` and the pipeline's `staging`); polls and 423 retries back off from
  200 ms ×1.5 to a 1 s cap, pending operations read in parallel; the deadlines are unchanged (120 s
  slept per wait, ~30 s of 423s). Neon's docs: a create-branch answers `create_branch` +
  `start_compute`, connecting to an idle compute starts it, and a conflicting request is refused
  with 423 rather than misapplied (neon.com/docs/manage/operations). The password reset's own
  operations are still awaited — the password must be live before the container connects.
  Expected: roughly halved (13–16 s → about 6–9 s); **not yet timed against real Neon**.
- **Still open:** run the step in parallel with the sandbox start and clone. The container only
  needs the database host added to its allow-list, which `setAllowedHosts` can do at runtime.
- **Maybe:** skip the per-session password reset (the branch inherits `dev`'s password, but Launch
  does not keep it), which would take the compute start off the critical path entirely.

## Log noise

- `Uncaught Error: Containers have not been enabled for this Durable Object class` came from stale
  local `SessionSandbox` records (`apps/web/.wrangler/state/v3/do/launch-SessionSandbox/`) whose SDK
  timers fired under `--enable-containers=false`. **Cleared**: the state was moved to `/tmp`. If it
  comes back, the alternative is making `SessionSandboxBase` survive construction when containers
  are disabled.
- The `internal error; reference = …` bursts and "Network connection lost" are the remote binding's
  proxy; they appeared while the container application was provisioning or failing to start, and at
  `pnpm dev` reloads. Not yet investigated with a healthy container.
- A failed remote session destroys its container, so anything needed for diagnosis has to come back
  in the step's error. `wrangler containers ssh <instance>` works only while an instance is alive.
