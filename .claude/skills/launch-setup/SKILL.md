---
name: launch-setup
description: First run of this kit on this machine — checks the toolchain, starts Postgres, migrates, seeds demo data, and gets you signed in
argument-hint: "[--offline] [--no-demo] [--no-plugins] [--db-url <postgres-url>] [--driver neon|postgres]"
---

# First run

You are driving `scripts/bootstrap.sh` for someone who may never have run this kit. It does
SETUP.md Part 1 end to end and is **idempotent** — re-running after a fix is always safe.

## Constraints on you (Claude)

- You may reach this skill from a plain "help me set up this project" — the user need not
  have typed `/launch-setup`. Before the first command, say in one sentence what the script will do
  to their machine (start a Postgres container, write `apps/web/.dev.vars`, seed a demo
  database) and that it is idempotent. Then run it; don't wait for permission you already have.
- Your Bash tool has **no TTY** and a **2-minute default timeout**. Always run the bootstrap with a
  10-minute timeout (`timeout: 600000`) — `pnpm install` alone can take minutes on a cold machine.
- Never start or stop the user's dev stack with raw `kill`/`docker` commands; the script and
  `pnpm dev:stop` / `pnpm dev:status` own that.
- Show the user the script's output as you go. Every step prints a `✔` line; the last line is the
  verification line. Do not summarise a failure away — quote it.
- The `plugins` step (6) installs nothing: Launch commits its plugins (today `analytics` —
  dashboards, cubes, the drizzle-cube API), and the step only checks each one's files are on disk.
  `/launch-plugin` is the skill for installing another, where the plan is read before anything is
  written.

## 1. Run it

```
bash scripts/bootstrap.sh --no-dev $ARGUMENTS
```

`--no-dev` means the script does NOT start the servers (you will, in step 3). `--offline` skips
the Cloudflare login / Workers AI probe; `--no-demo` runs plain `pnpm seed` (tenant, users and key,
but no plugin demo data); `--no-plugins` skips the `plugins` check (step 6 below). `--db-url <postgres-url>` uses a database that already
exists (a Neon branch in a sandbox with no Docker) instead of starting one. Docker is then not
checked, the URL goes into `apps/web/.dev.vars`, step 4 only waits for it to answer, and the seed
is allowed to write to it. Use it when `docker` is missing and the user has given you a URL; never
invent one, and never echo the URL back (it holds a password). A Neon URL (`*.neon.tech`) also
selects the `neon` driver locally — HTTPS and WebSocket only, which a sandbox with no TCP out
allows; any other URL gets `postgres`.

`--driver neon|postgres` sets the LOCAL database driver (D35), written to `apps/web/.dev.vars` as
`DATABASE_DRIVER`. The default is `postgres` (TCP to the Docker database, nothing else running),
whatever the tomls say — their `DATABASE_DRIVER` is the DEPLOYED driver, `neon` in a fresh copy.
Don't pass `--driver` unless the user asks to run the deployed Neon driver locally: `neon` with the
Docker database also starts a Neon proxy container in step 4 (a community image, pinned). A re-run
keeps whatever `.dev.vars` already says. Switch later with `pnpm dev:db:up --neon` / `--postgres`.

## 2. Read the exit code

| Exit | Meaning | What you do |
|---|---|---|
| 0 | every step passed | go to step 3 |
| 1 | a step failed | show the tail of the output, fix the cause, re-run the same command (idempotent). A failing `6/10 plugins` is the one worth reading closely: re-run with `--no-plugins` to get a working app, then install the plugin with `/launch-plugin`, where the plan is shown before anything is written |
| 2 | usage error | check `$ARGUMENTS` against the hint above and re-run |
| 3 | a prerequisite is missing | install it, then re-run: Node 24 via `nvm install` (reads `.nvmrc`) or `fnm use`; pnpm via `corepack enable`; Docker via Docker Desktop, or `brew install colima docker && colima start` on macOS, or Docker Engine + the `docker` group on Linux. If Docker can't run here (a sandbox), ask the user for a Postgres URL (a Neon branch) and re-run with `--db-url` |
| 4 | a dev port is held by another checkout | the DATABASE port is chosen automatically (`scripts/dev-db.mjs` takes the next free one), so this is :3000/:3001 (or `DEV_UI_PORT`/`DEV_API_PORT`): run `pnpm dev:status` and `pnpm dev:db:status`, show the user the other path/pid, and let THEM decide — stop it there, or move this checkout with `DEV_UI_PORT`/`DEV_API_PORT` in `apps/web/.dev.vars` plus `APP_URL` on the new UI port (SETUP.md 1.6) — never kill another checkout's processes |
| 5 | Cloudflare login required | see below |

**Exit 5 — Cloudflare login.** Explain in one sentence: *the kit's zero-key chat and agents run on
Workers AI, which `wrangler dev` proxies through a logged-in Cloudflare account (a free one is
enough), and every call is billed to that account (10 000 free neurons a day).* Then ask: log in,
or stay offline?

- Log in: tell the user to run `pnpm web exec wrangler login` **in their own terminal** (the
  browser OAuth callback must outlive a tool call, so you cannot run it), wait for them to confirm,
  then re-run the bootstrap with `--online`.
- Stay offline: re-run with `--offline`. Chat/agents answer 503 until a key or tenant provider
  exists (SETUP.md 2.5); everything else works.

## 3. After success — start the app and sign in

1. Start the dev stack in the background (`run_in_background: true`):
   ```
   pnpm dev
   ```
2. Poll until the API answers, at most 90 seconds (if `apps/web/.dev.vars` sets `DEV_API_PORT` /
   `DEV_UI_PORT`, use those ports instead of 3001 / 3000 here and in step 3):
   ```
   curl -s localhost:3001/api/health
   ```
   You should see `{"status":"ok",…}`. If nothing after 90 s, run `pnpm dev:status` and show it.
3. Open the dev sign-in for the demo owner (macOS `open`, Linux `xdg-open`):
   ```
   open "http://localhost:3000/login?as=owner@example.test"
   ```
4. Report what is true now, in **at most six lines** — where the app is (the two URLs), who they
   are signed in as (**owner@example.test**; also `admin@` and `member@example.test`, and the
   global admin `admin@clewro.com`), the port Postgres landed on if it was not 5432, the
   local database driver if it is not `postgres` (`neon`, through the proxy — step 4 says so), **any
   plugin the `plugins` step installed and the page it adds** (`pnpm plugin list` names them; say
   "no plugins installed" rather than nothing when there are none), and any note the script printed
   (an orphaned volume, `--offline`). Do not restate the ten ✔ lines
   they just watched, and **do not echo the seeded API key** — it was printed once by the seed and
   is in their scrollback; say that `pnpm cli login` mints another whenever they want one.

## 4. Then ask what they want to do next — do not guess

A first run ends with the person looking at a working app and no idea what the next move is, so
**end the turn with `AskUserQuestion`**, not with a paragraph of suggestions and not with an
open "want me to do anything else?". Offer these, in this order, with the first as the default:

| Option | What you do when it is chosen |
|---|---|
| **Show me around** | Walk the seeded app: **Chat** (streams a reply — Workers AI needs the `wrangler login`, else a key), **Agents** (run `summarize-text`, watch the timeline fill), **Knowledge** (upload a document, then search it), **Analytics** (the seeded Organisation Overview). Drive it with them; one screen at a time |
| **Check it really works** | `pnpm test:db:up && pnpm test` (ephemeral Postgres on :5433) — which runs the analytics plugin's own tests too, including the two-tenant cube isolation one — then the SETUP.md 1.6 analytics check, `pnpm cli analytics check-facts` |
| **Add a capability** | `/launch-plugin` — install a plugin (a git repository copied in, with a plan you read first), or audit what is installed with `pnpm plugin list` / `pnpm plugin check` |
| **Deploy it** | `/launch-provision` — **user-invoked only**: tell them to type it, and that it needs the three accounts (Cloudflare on Workers Paid, Neon, Resend) and `pnpm provision tokens` in their own terminal first |

Leave the dev stack running unless they ask you to stop it (`pnpm dev:stop`). If they pick
something not on the list, just do that — the list is a starting point, not a gate.

## What each ✔ line means

Lines read `✔ n/10 <name> <what it verified>` (a failure is `✖ n/10 <name> <message>` plus a
`fix:` hint). `bash scripts/bootstrap.sh` first prints its own `✔ os / git / docker / node / pnpm`
prerequisite lines, then hands over to `scripts/bootstrap.mjs` for the ten steps:

| Step | Name | What it proved |
|---|---|---|
| 1 | `toolchain` | Node 24, pnpm 10, Docker daemon and `docker compose` reachable. With `--db-url` it reads `docker skipped (external database <host>/<db>)` |
| 2 | `install` | `pnpm install` done; `wrangler` resolves in `apps/web` |
| 3 | `secrets` | `apps/web/.dev.vars` exists with `DATABASE_URL`, `OAUTH_ENCRYPTION_KEY` (generated, git-ignored) and `DATABASE_DRIVER` (the LOCAL driver, D35: `postgres` unless `--driver`, a Neon `--db-url`, or a value already there says otherwise — a note names it when it changes). With `--db-url` it notes `DATABASE_URL set from --db-url` |
| 4 | `database` | this checkout's Postgres container is up and healthy on the port it chose (5432 unless taken; the step says so and writes it to `.dev.vars`); the `Connected to … (<driver> driver)` part names the local driver. Under `neon` the Neon proxy container is up too (`local driver neon: Neon proxy at http://localhost:<port>`). With `--db-url` there is no container: the line reads `external <host>/<db> · Connected to …` once `db:check` answers |
| 5 | `migrate` | role → migrations → grants applied; the pgvector extension is installed |
| 6 | `plugins` | every plugin in `launch.plugins.json` has its files on disk (`installed: analytics@3.4.1`). Launch commits its plugins and their migrations, so nothing is installed here. `analytics` is where dashboards, cubes and the fact table live (`docs/CONCEPTS.md` §8). Skipped with `--no-plugins` |
| 7 | `seed` | the tenant (single mode: one, named after `APP_NAME`), owner/admin/member users, one API key (printed once), plus each plugin's demo data (analytics dashboards) unless `--no-demo`. The seed prints `seeding <host>/<db>` first; with `--db-url` it runs with `SEED_ALLOW_REMOTE=1` |
| 8 | `cloudflare` | wrangler is logged in (Workers AI available) — or `--offline` was chosen |
| 9 | `cli` | `pnpm cli whoami` with the seeded key — deferred/skipped with `--no-dev` (needs the server) |
| 10 | `run` | `pnpm dev` started and `/api/health` answered — skipped with `--no-dev` (you do it in step 3) |

**Why `plugins` sits before `seed`:** the seed runs each plugin's demo-data hook, so a plugin whose
files are missing fails here, with its name, rather than halfway through the seed.

With `--no-dev` the script stops after step 8 and prints the three things to run next (`pnpm
dev`, the login URL, `pnpm cli login`). If a line reads `✖`, the exit code table above says what
to do. The script's own output is authoritative; when it and this table disagree, trust the script.
