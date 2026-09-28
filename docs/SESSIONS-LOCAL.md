# Coding sessions on a laptop

How to run a Launch P3 coding session end to end on your own machine: a real session container
under `wrangler dev`, a real Neon branch per session, a real git server, and the gated preview.
The design is `docs/plans/p3-sessions.md`; this is the procedure, and what it measured.

Under `wrangler dev` the container is always a local Docker container, whichever backend you pick.
`SESSION_BACKEND=local` changes only where the REPOSITORY lives. The Workflow, the steps, the
container image, the database and the egress handlers are the deployed ones:

| | Deployed (`cloud`) | Laptop (`local`) |
|---|---|---|
| Container | Cloudflare Containers | `wrangler dev`'s Docker containers, same image, same egress rules |
| Database | a Neon branch of the app's `dev` branch | **the same**: a real Neon branch of the app's project, reached directly from the container |
| Repository | GitHub, through the git egress handler | `scripts/sessions-local-git.mjs` (git smart-HTTP), through the same handler |
| Model | Anthropic, through the model proxy | the same, with `ANTHROPIC_API_KEY` from `.dev.vars` |

`loadConfig` refuses `SESSION_BACKEND=local` outside `APP_ENV=development`. There is no local
database for sessions: neither your Docker Postgres nor the kit's local Neon proxy is involved. So
a session needs the Neon credential connected in Setup and an app with a Neon project (a launched
app has one; `sessions:local-app` takes `--neon-project`).

## What `wrangler dev` does with the sandbox's egress

Checked against `@cloudflare/sandbox` 0.12.10 / wrangler 4.127 (slice 3b): local containers get
the deployed egress behaviour — wrangler runs a `cloudflare/proxy-everything` sidecar per
container.

- `outboundByHost` handlers run in the Worker for HTTP **and** HTTPS (with `interceptHttps = true`;
  the container trusts the interception CA — curl and Node both accepted it).
- `ctx.containerId` is `SESSION_SANDBOX.idFromName(name).toString()` — what `sessions.sandbox_id`
  records.
- `enableInternet = false` + `allowedHosts`: a host off the list answers **520**; one on it goes
  out; `setAllowedHosts` applies at runtime.
- An outbound `wss://` to an allow-listed host with no handler passes through the interception
  (checked 2026-09-28 against a public echo host: `101`, frames both ways, the certificate issued by
  the interception CA; Node trusts it through the image's `NODE_USE_SYSTEM_CA=1`). That is the path
  the neon driver's `Pool` takes to a branch.
- One difference: **`host.docker.internal` is reachable even when it is not on the list.** Nothing
  in a session uses it, and it is not on the list.

So there is no local-only fallback: the git clone goes to `https://github.com/<o>/<r>.git` and the
GitHub egress handler (in the Worker) forwards it to `SESSION_LOCAL_GIT_URL`, exactly as it
forwards to GitHub deployed; the database is the Neon branch's endpoint, allow-listed exactly
(`sessionDbEgressHosts`: `ep-….neon.tech` for the WebSocket, `api.<region>.neon.tech` for HTTP
queries), exactly as deployed.

## Setup

You need Docker (for Launch's own Postgres and the session containers), the **Neon credential
connected in Setup** (sessions branch real Neon projects), and about **4 GB of Docker memory per
running session** on an ARM Mac (see "Emulation" below).

```bash
# 1. Launch's own database.
pnpm dev:db:up && pnpm db:migrate && pnpm seed        # note the API key the seed prints

# 2. apps/web/.dev.vars (see .dev.vars.example):
#    SESSION_BACKEND=local                                        # the repo: the local git server
#    SESSION_PREVIEW_URL=http://{label}.localhost:3001            # the Worker's port
#    SESSION_LOCAL_GIT_URL=http://localhost:9420
#    ANTHROPIC_API_KEY=<only if you want real turns>

# 3. The git server, and an app whose repo lives in it (here: the kit itself at a tag), on a Neon
#    project of your own (throwaway: its `dev` and `session-*` branches are made here).
pnpm sessions:local-git serve &                              # ~/.launch/sessions-git, :9420
pnpm sessions:local-app --slug demo --from /path/to/rocketflare --ref 0.15.0 \
  --neon-project <a Neon project id>                         # an ABSOLUTE --from

# 4. Launch. The first start builds the session image with Docker (below).
pnpm dev

# 5. One session, as a person would drive it: boot, a message, the gated preview, end.
pnpm sessions:smoke --app demo --key <api key> \
  [--message "Change the Home page heading to 'Hello from Launch'"] [--ship] [--keep]
```

Without `--message` no turn runs (no Anthropic key needed): the boot, the preview and the end are
still exercised. `--keep` leaves the session up and prints its URL.

Then check what the plan asks for:

- the pushed branch: `pnpm sessions:local-git log local/demo session/<short>`;
- the `ai_usage` rows of a session with a turn (`session_id`);
- the container is gone after End: `docker ps | grep workerd`;
- no key in the container: `docker exec <container> env | grep -c sk-ant` → 0;
- the `session-<short>` branch is gone from the Neon project (the console, or its API).

## What happens during a boot

The Workflow's steps, as the session page's checklist shows them (`step` events):

1. **Creating database branch** — the app's `dev` branch is ensured (`session_owner` made in SQL
   by `neondb_owner`); when it is prepared, the session's database is a Neon branch of it.
2. **Starting sandbox** — the container, with the base allow-list (npm, GitHub, Anthropic).
3. **Cloning repo** — `git fetch --depth 50` of the base, then `session/<short>` (from the remote
   when a checkpoint pushed it — a resume).
4. **Preparing the app's database (first session only)** — the allow-list gains `dev`'s endpoint,
   then the kit bootstrap into its `session_app` (migrate + seed), then `apps.session_db` → ready.
   The app's `dev` is CLAIMED for this (`preparing`, with the claiming session and the time); a
   claim whose session is no longer active, or older than 30 minutes, is taken over by the next
   session, and a session that fails holding it gives it back (`failed`).
5. **Installing and seeding** — the allow-list swaps to the session branch's endpoint, then
   `pnpm install --prefer-offline` (the image's warm store) and the kit's
   `scripts/bootstrap.mjs --db-url … --driver neon --offline --no-dev --no-plugins`
   (`DATABASE_DRIVER=neon` in the environment and `.dev.vars`, no `NEON_LOCAL_PROXY`). The two run
   one at a time per container (`flock` on `/workspace/.launch/bootstrap.lock`), so a re-run step
   attempt never races an earlier one's `pnpm install`. On a COLD resume (the database is already
   prepared: `sessions.migrations_hash` is set) the kit's seed and `db:check` are skipped, and its
   migrate too unless `apps/web/migrations` hashes differently from the last bootstrap — the
   preload answers those `pnpm` children (`LAUNCH_BOOTSTRAP_SKIP`).
6. **Starting dev server** — `pnpm dev` with Vite on **:5173** and `wrangler dev` on **:8787**
   (never :3000, the Sandbox SDK's own port), until `:8787/api/health` answers. Its pid and output
   go to `/workspace/.launch/dev.{pid,log}`; the wait gives up at once when the process is gone,
   with the log's tail as the reason.

Every step is bounded and says what it was waiting for: each sandbox call has a deadline
(`services/sessions/deadline.ts` — 90 s for a control call, a command's own timeout plus a minute),
each Neon call 5 minutes, and a failure puts the step's error (a failed command's last 40 lines,
the database URI scrubbed) on the checklist and in `sessions.error`. `sandbox.start` writes a boot
id to `/workspace/.launch/boot-id`; every later step checks it, so a container that died and came
back EMPTY fails the step with "The session container stopped while … and came back empty" instead
of cloning into nothing or curling a dev server that is not there. Pressing **End** while a step
runs stops it within ten seconds (each boot step polls the row) and ends the session.

## Suspend and resume

A session quiet for `idleSuspendMinutes` (30 by default) is **suspended warm**: checkpointed
(commit, push, transcript to R2), the preview answers 503, and the container is KEPT — workspace,
`node_modules` and the running dev server (`sessions.container_kept_at`,
`services/sessions/warm.ts`). A resume within `SESSION_WARM_KEEP_MINUTES` (45) after that is
**warm**: "Starting sandbox" finds the boot marker it wrote on the first boot and "Starting dev
server" reuses the dev server if both ports still answer (else `pnpm dev:stop`, then `pnpm dev`) —
no clone, install or bootstrap. After the 45 minutes the Workflow's `cool#N` destroys the container
and the next resume is **cold**. A drain cools at once; a container Docker killed meanwhile (no
marker) resumes cold.

Before a cool (or a drain) destroys the container, the workspace is **backed up** — `/workspace/app`
with `node_modules` and `.dev.vars`, through the Durable Object into the local `BACKUP_BUCKET`
(`SESSION_WORKSPACE_BACKUP=binding`, the development default; `.wrangler/` holds it). A cold resume
whose branch head is still the backup's commit then shows **Restoring the saved workspace** instead
of **Cloning repo**, and its **Installing and seeding** step only re-applies the allow-list and the
dev-server keys (when the migrations did not change). A restore that fails says "Cloning instead: …"
on that line and the boot goes on the old way. Unmeasured: on the SDK's default HTTP transport the
restore carries the whole archive through the Durable Object as base64, which for a checkout with
`node_modules` may be slower than the clone and install it replaces — set
`SESSION_WORKSPACE_BACKUP=off` in `.dev.vars` if it is.

To see both locally without waiting: give a NEW session a short idle window — the policy is
frozen onto the row at create, from `launch_settings.session_policy` (e.g. `{"idleSuspendMinutes":
2}` in Launch's database; there is no UI for it) — and for a cold resume, `docker rm -f` the session's container while it is
suspended (it comes back empty, so the resume boots cold).

## A start that never answers

Seen twice under `wrangler dev` (2026-09-28): an idle suspend DESTROYED the container, a resume
~10 s later started the same Durable Object, and "Starting sandbox" never answered within its 4
minutes although Docker showed the new container up. Not reproduced since. What the SDK's code
(`@cloudflare/sandbox` 0.12.10 over `@cloudflare/containers` 0.3.7) makes plausible:

- `Sandbox.destroy()` SIGKILLs the container but runs no `onStop`. The Containers base class runs
  a pending `onStop` at the HEAD of the next start (`startAndWaitForPorts` →
  `syncPendingStoppedEvents`), and Launch's `onStop` wrote to Postgres with no deadline — a write
  that hangs would hang the start with it. It is now bounded at 10 s (`ON_STOP_DB_MS`).
- Right after a destroy, `container.running` may still read true, so the next start takes the
  "already running" fast path and talks to a container that is going away; the old start ALSO
  called `setAllowedHosts` first, which re-registers the egress interception on that container.
  `CloudflareSandbox.start` now boots first (`exec('true')`), applies the allow-list after, bounds
  each attempt at 100 s, and on a timeout destroys again (a reset) and tries once more.

Warm suspends avoid the destroy → start sequence for any resume inside the warm window. If it
happens again, the Worker's log (`sandbox.destroy`, `version.check` and the `Container error`
lines) and `docker ps -a` around the resume are what to capture.

## Measured (slice 3b, an M-series Mac, colima 8 GB, amd64 emulation)

These were measured when a local session's database was a TEMPLATE copy on the laptop's Postgres
behind the Neon proxy (since removed). A Neon branch takes a few seconds to create, and migrate +
seed over the network to a Neon endpoint will differ; not re-measured.

| | Time |
|---|---|
| Session image, cold `docker build` (network) | 99 s; 54 s with the base cached |
| `pnpm dev` start including the image build (layers cached) | ~100 s |
| First container start after `pnpm dev` | 6.2 s; later ones 1.5 s |
| Database branch (TEMPLATE copy) | < 1.6 s (below the event granularity) |
| Clone (local git server) | 1.6 s |
| Prepare `dev` (first session: install + migrate + seed) | 105 s |
| Install + bootstrap on the session's database | 85–108 s |
| Dev server up (both ports) | 20 s |
| **Boot, first session (prepares `dev`)** | **214 s** |
| **Boot, prepared app** | **133 s** |
| Drain → suspended (checkpoint commit + push through the egress handler, destroy) | 3 s |
| Resume → ready (clone of the pushed branch, bootstrap, dev) | 133 s |

S7 measured 24 s to a live preview on real amd64 Cloudflare hardware; the difference here is
almost entirely **emulation**.

## Emulation (ARM Macs)

The Sandbox base image is **amd64 only**. On an ARM Mac with colima (QEMU user emulation), Go
binaries — esbuild, inside `tsx`, Vite and wrangler — crash in their garbage collector ("The
service was stopped", "found pointer to free object", "concurrent map read and map write", a
garbled `Invalid version: "24.21.0"` mid-transform). Measured: `GOGC=off` fixes it;
`GOMAXPROCS=1` and `GODEBUG=asyncpreemptoff=1` do not. Re-measured 2026-09-28 in the session image
(`docker run --platform linux/amd64`, `tsx` over 300 small zod modules): 0 of 4 runs survive
without it, 4 of 4 with it. So every session under `APP_ENV=development` — ANY `wrangler dev`
container, `SESSION_BACKEND=cloud` included — runs every command with `GOGC=off
GOMEMLIMIT=1536MiB` (`sessionProcessEnv`), which is why a session wants ~4 GB: a second concurrent
session in an 8 GB colima VM was OOM-killed during `pnpm install`. (Keying it on
`SESSION_BACKEND=local` is what failed the first real session: Launch ran `wrangler dev` on the
`cloud` backend, and its prepare's `db:check` died in esbuild on every attempt.) Deployed
containers are native and get neither variable. colima with Rosetta (`--vm-type vz
--vz-rosetta`) is likely faster; not measured.

## Memory

**One session container wants ~4 GB under emulation, and the Docker VM is shared.** Measured
2026-09-28 on an M-series Mac, Docker Desktop's 8 GB VM with Rosetta for amd64 (not QEMU — the
same amd64-only image either way): the Sandbox SDK's control server (`sandbox`) alone holds ~1 GiB
resident in an IDLE container; the app's dev stack under `GOGC=off GOMEMLIMIT=1536MiB` adds ~3 GiB
(two `workerd` at ~0.6 and ~0.36 GiB, two Node processes at ~0.77 and ~0.6 GiB, two esbuild at
~0.35 and ~0.27 GiB) and was up in 14 s. `workerd` itself runs fine under emulation (the kit's
`workerd-linux-64` served a request); what fails is memory. hola-world's second session died at
"Starting dev server" to the VM's **global OOM killer**: `dmesg` in the VM shows `Out of memory:
Killed process … (sandbox)` in the session container's cgroup at 7.7 GB anonymous memory and no
swap, and the SDK's answer to the next call was a bare `HTTP error! status: 500` before the
container was recreated EMPTY.

What to do on a laptop:

- give Docker's VM **12 GB or more** (Docker Desktop → Resources, or `colima start --memory 12`),
  or run one session at a time;
- stop what else lives in the VM while a session runs (`docker stats --no-stream` shows it — other
  Postgres, MinIO or Mongo containers count against the same 8 GB);
- `docker run --rm --privileged alpine dmesg | grep -i "killed process"` says whether the OOM
  killer took a session (the cgroup is `/docker/<container id>`).

**An arm64 image is not an option today**: `cloudflare/sandbox:0.12.10` is published for
`linux/amd64` only, and `wrangler dev` (4.127) builds every `[[containers]]` image with
`--platform linux/amd64` hard-coded. Both are upstream.

## Gotchas

- **Editing `apps/web/src` — or building in the same checkout — while a session boots kills its
  running step.** `wrangler dev` reloads the Worker on a source change AND on a change to
  `apps/web/dist/ui` (the `[assets]` directory it watches), so a `pnpm build` or `pnpm typecheck`
  in the checkout that runs `pnpm dev` reloads it too (hola-world's second session, 2026-09-28: a
  gate run rebuilt `dist/ui` at 12:22:02–04 and the `prepare` step died mid-call). Measured with a
  throwaway Workflow under wrangler 4.127: the killed step never finishes, the local engine keeps
  reporting the instance `running`, and the step is re-run only when something next pokes the
  engine (a later reload, or a request to the instance) — minutes later, or never. The session
  page's read reconciles it (`services/sessions/reconcile.ts`): a boot with no heartbeat for 3
  minutes has its instance terminated, is failed naming the step, and a fresh instance cleans up.
  A TURN killed the same way (no turn heartbeat for 3 minutes) fails as a turn, not a session: the
  session goes back to `ready`, a fresh instance boots it again from its branch, and the message
  has to be sent again. Run the gate in a separate worktree.
- **`pnpm dev:stop` can leave a container's proxy sidecar** for a few seconds; `docker ps | grep
  workerd` and `docker rm -f` if it lingers.
- **The kit's bootstrap refuses to run as root** (kit 0.15). A sandbox runs as root, so the
  bootstrap is started with a preload that answers its one uid check (`NOT_ROOT_PRELOAD`). A kit
  gap to report upstream.
- **A branch is real Neon, even on a laptop.** A session left running after `pnpm dev:stop` (or a
  lost Workflow) leaves its `session-<short>` branch until the session is ended or expires
  (`sessions.expire` cleans up). A session settled `failed` or `ended` whose cleanup never ran (its
  instance died between the two, or somebody settled the row by hand) is found by the same cron and
  by the page's read, and a fresh instance destroys its container and deletes its branch. Check
  the project's branches if you killed things by hand.
- Cron: `sessions.expire` runs on `*/5`; fire it by hand with
  `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*"`.
