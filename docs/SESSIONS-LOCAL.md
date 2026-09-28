# Coding sessions on a laptop

How to run a Launch P3 coding session end to end on your own machine: a real session container
under `wrangler dev`, a real database per session, a real git server, and the gated preview. The
design is `docs/plans/p3-sessions.md`; this is the procedure, and what it measured.

`SESSION_BACKEND=local` changes only WHERE the three outside things live. The Workflow, the steps,
the container image and the egress handlers are the deployed ones:

| | Deployed (`cloud`) | Laptop (`local`) |
|---|---|---|
| Container | Cloudflare Containers | `wrangler dev`'s Docker containers, same image, same egress rules |
| Database | a Neon branch of the app's `dev` branch | `CREATE DATABASE launch_sess_<short> TEMPLATE launch_sessdev_<slug>` on your Postgres, reached through the kit's local Neon proxy |
| Repository | GitHub, through the git egress handler | `scripts/sessions-local-git.mjs` (git smart-HTTP), through the same handler |
| Model | Anthropic, through the model proxy | the same, with `ANTHROPIC_API_KEY` from `.dev.vars` |

`loadConfig` refuses `SESSION_BACKEND=local` outside `APP_ENV=development`.

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
- One difference: **`host.docker.internal` is reachable even when it is not on the list.** It is
  on the list for `local` anyway, so the code states the deployed behaviour.

So there is no local-only fallback: the git clone goes to `https://github.com/<o>/<r>.git` and the
GitHub egress handler forwards it to `SESSION_LOCAL_GIT_URL`, exactly as it forwards to GitHub
deployed.

## Setup

You need Docker (for Postgres, the Neon proxy and the session containers) and about **4 GB of
Docker memory per running session** on an ARM Mac (see "Emulation" below).

```bash
# 1. Postgres and the kit's Neon proxy in front of it (the container has no TCP out, so its app
#    reaches Postgres over the proxy's HTTP/WebSocket, as it reaches Neon deployed).
pnpm dev:db:up --neon && pnpm db:migrate && pnpm seed        # note the API key the seed prints

# 2. apps/web/.dev.vars (see .dev.vars.example):
#    SESSION_BACKEND=local
#    SESSION_PREVIEW_URL=http://{label}.localhost:3001            # the Worker's port
#    SESSION_LOCAL_DB_URL=<an owner URL on the same Postgres: it creates databases>
#    SESSION_LOCAL_NEON_PROXY=http://host.docker.internal:<the NEON_LOCAL_PROXY port>
#    SESSION_LOCAL_GIT_URL=http://localhost:9420
#    ANTHROPIC_API_KEY=<only if you want real turns>

# 3. The git server, and an app whose repo lives in it (here: the kit itself at a tag).
pnpm sessions:local-git serve &                              # ~/.launch/sessions-git, :9420
pnpm sessions:local-app --slug demo --from /path/to/rocketflare --ref 0.15.0   # an ABSOLUTE --from

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
- the `launch_sess_*` database is gone: `psql … -c "select datname from pg_database"`.

## What happens during a boot

The Workflow's steps, as the session page's checklist shows them (`step` events):

1. **Creating database branch** — `launch_sessdev_<slug>` is ensured; when it is prepared, the
   session's database is a TEMPLATE copy of it (well under a second).
2. **Starting sandbox** — the container, with the allow-list (base hosts + `host.docker.internal`).
3. **Cloning repo** — `git fetch --depth 50` of the base, then `session/<short>` (from the remote
   when a checkpoint pushed it — a resume).
4. **Preparing the app's database (first session only)** — the kit bootstrap into
   `launch_sessdev_<slug>` (migrate + seed), then `apps.session_db` → ready.
5. **Installing and seeding** — `pnpm install --prefer-offline` (the image's warm store), then the
   kit's `scripts/bootstrap.mjs --db-url … --driver neon --offline --no-dev --no-plugins`.
6. **Starting dev server** — `pnpm dev` with Vite on **:5173** and `wrangler dev` on **:8787**
   (never :3000, the Sandbox SDK's own port), until `:8787/api/health` answers.

## Measured (slice 3b, an M-series Mac, colima 8 GB, amd64 emulation)

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
service was stopped", a nil-pointer panic mid-transform). Measured: `GOGC=off` fixes it;
`GOMAXPROCS=1` and `GODEBUG=asyncpreemptoff=1` do not. So `SESSION_BACKEND=local` runs every
command with `GOGC=off GOMEMLIMIT=1536MiB` (`sessionProcessEnv`), which is why a session wants
~4 GB: a second concurrent session in an 8 GB colima VM was OOM-killed during `pnpm install`.
Deployed containers are native and get neither variable. colima with Rosetta (`--vm-type vz
--vz-rosetta`) is likely faster; not measured.

## Gotchas

- **Editing `apps/web/src` while a session boots loses it.** `wrangler dev` reloads the Worker, and
  a reload drops every Workflow instance mid-step; the row stays `booting`. End it (or send a
  message, or resume): every route that wakes a session restarts a lost instance from the row
  (`wakeOrRestart`), and the new instance's `claim` starts the session over from its branch. If
  its `workerd-*` containers linger, `docker rm -f` them.
- **`pnpm dev:stop` can leave a container's proxy sidecar** for a few seconds; `docker ps | grep
  workerd` and `docker rm -f` if it lingers.
- **The kit's bootstrap refuses to run as root, and wants `--driver neon` URLs on `*.neon.tech`**
  (kit 0.15). A sandbox runs as root, so the bootstrap is started with a preload that answers its
  one uid check (`NOT_ROOT_PRELOAD`), and a local session's URI carries the host
  `launch-local.neon.tech`, which is never resolved: `NEON_LOCAL_PROXY` sends every query to the
  proxy, which routes by database. Both are kit gaps to report upstream.
- **`CREATE DATABASE … TEMPLATE` needs the template idle**, and the Neon proxy pools connections to
  it, so `LocalSessionDb` terminates the template's other backends first.
- Cron: `sessions.expire` runs on `*/5`; fire it by hand with
  `curl "http://localhost:3001/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*"`.
