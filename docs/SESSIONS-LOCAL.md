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
5. **Installing and seeding** — the allow-list swaps to the session branch's endpoint, then
   `pnpm install --prefer-offline` (the image's warm store) and the kit's
   `scripts/bootstrap.mjs --db-url … --driver neon --offline --no-dev --no-plugins`
   (`DATABASE_DRIVER=neon` in the environment and `.dev.vars`, no `NEON_LOCAL_PROXY`).
6. **Starting dev server** — `pnpm dev` with Vite on **:5173** and `wrangler dev` on **:8787**
   (never :3000, the Sandbox SDK's own port), until `:8787/api/health` answers.

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

## Gotchas

- **Editing `apps/web/src` while a session boots loses it.** `wrangler dev` reloads the Worker, and
  a reload drops every Workflow instance mid-step; the row stays `booting`. End it (or send a
  message, or resume): every route that wakes a session restarts a lost instance from the row
  (`wakeOrRestart`), and the new instance's `claim` starts the session over from its branch. If
  its `workerd-*` containers linger, `docker rm -f` them.
- **`pnpm dev:stop` can leave a container's proxy sidecar** for a few seconds; `docker ps | grep
  workerd` and `docker rm -f` if it lingers.
- **The kit's bootstrap refuses to run as root** (kit 0.15). A sandbox runs as root, so the
  bootstrap is started with a preload that answers its one uid check (`NOT_ROOT_PRELOAD`). A kit
  gap to report upstream.
- **A branch is real Neon, even on a laptop.** A session left running after `pnpm dev:stop` (or a
  lost Workflow) leaves its `session-<short>` branch until the session is ended or expires
  (`sessions.expire` cleans up); check the project's branches if you killed things by hand.
- Cron: `sessions.expire` runs on `*/5`; fire it by hand with
  `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*"`.
