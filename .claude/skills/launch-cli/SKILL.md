---
name: launch-cli
description: Drive and debug a Launch server from the terminal with the `launch` CLI — pick the server (local dev, staging, production) by name, find out why a coding session, ship, release, deploy, app launch, agent run or chat answer failed or is stuck, read logs and timelines, and act (retry, cancel, resume, approve) without the web UI. Also how to discover any command or API route and what JSON it takes. Use whenever someone asks to debug, inspect, check, tail or operate Launch, mentions a session/app/release/run id, says "why did X fail", "what is it doing", "is it stuck", or asks to do something in Launch from the command line.
argument-hint: "[what to look at: a session id, an app slug, a release, a run id, \"production\", …]"
---

# The `launch` CLI — operate and debug Launch from a terminal

Everything a person can do or see in the Launch web app, the CLI can do or see too (issue #6;
`cli-parity.test.ts` keeps it that way). Prefer it over hand-written `fetch` scripts, over
reading the database, and over guessing from code: it reads the same routes and the same
`@launch/shared` schemas as the UI, with the server's own redaction.

**How to run it.** In this repository: `pnpm cli <command>` from the root (tsx, always current).
Elsewhere: the built `launch` binary. Below, `launch` means either.

**Act carefully.** Reads are free. Anything that changes state on a shared server (production
especially) — approve, promote, retry, teardown, drain, rotate, set — needs the user's go-ahead for
that specific action unless they already asked for it. Destructive commands ask first and refuse
without a terminal; pass `-y` / `--yes` only when the user has said yes.

## 1. Which server

```
launch servers ls                        # every stored server: * default, the active one, key prefixes only
launch --server prod <command>           # one command against a named server (or --profile prod)
LAUNCH_PROFILE=prod launch <command>     # the same for a whole shell
launch login --server https://launch.example.com --name prod   # add one (browser sign-in)
launch status [--all]                    # health + readiness + who you are, per server
launch whoami
```

- Not signed in (exit 2) → the user must run `launch login …` themselves (it opens a browser);
  suggest `! pnpm cli login --server <url> --name <name>`.
- `--server <url>` uses the key stored for that URL, if any — a key never goes to another server.
- Deployment-wide controls (`launch admin …`, `launch platform …`) need an **admin key**:
  `launch login --admin` (platform administrators; stored as `<server>-admin`, 30 days). A 403 with
  "needs an admin key" means that, not a bug. Use `--server prod-admin` only for those commands.

## 2. Discover anything

```
launch commands [--json]                 # every command, argument and option — generated, never stale
launch <group> --help                    # one group's commands
launch api ls [word]                     # every API route: summary, and the command that covers it
launch api show <METHOD> <path>          # what a route takes and returns: fields, an example
launch api schema <METHOD> <path>        # the full JSON Schema: params, query, body, response
launch api call <METHOD> <path> [--data <json|@file|->] [--query k=v]   # anything, raw
```

`api show` accepts a concrete path (`/api/sessions/1a2b…/end`). Use `api call` only when no command
fits — it validates params, `--query` and `--data` with the route's own `@launch/shared` zod schema
first (exit 1 listing `path: message`, nothing sent; `--no-validate` skips it), then prints the raw
JSON and the server's error envelope (`details` lists zod issues).
`--json` on any read gives the parsed body for `jq`; it is what to use when you need a field.
The Rocketflare header (the line naming the server) is on stderr and only on a TTY, so it never
pollutes what you parse.

## 3. Debug playbooks

Start from what the user gave you; `ls` commands find ids. Each command's output names the next
command to run — follow it.

**A coding session failed, or its ship did** (a session id, often an 8-char prefix):
```
launch sessions show <id>                # status, PR, ship stage, budget, last error, failing gate step + output tail
launch sessions logs <id> [--type ship.] [--since <seq>] [--follow]   # every durable row; the debugging view
launch traces show <traceId>             # a boot or turn's span tree (ids come from show/logs)
```
Then act: `sessions resume|cancel|landing-retry|budget`, or `sessions say <id> "<fix>" --follow`.
`sessions ls <app> --all` lists an app's sessions.

**An app's launch (create) or teardown is stuck or failed:**
```
launch apps show <app>  ·  launch apps pipeline <app> [--kind teardown]  ·  launch apps operations <app>
```
`apps pipeline retry|cancel <app>` once the cause is fixed (a missing platform credential? → section
"Platform").

**A release, deploy or promotion is stuck:**
```
launch releases ls <app>  ·  releases show <app> <ver>  ·  releases chain <app> <ver>  ·  releases promotion <app>
launch deploys latest <app>  ·  deploys ls <app>  ·  apps health <app> [--hours 24]
launch approvals ls --box all  ·  approvals show <id>
```
`releases retry <app> <ver>` re-runs exactly the failed stage; `releases cancel` stops the run.

**An agent run failed, or waits:** `agents runs --status failed` → `agents run <id>` →
`agents logs <id>` → `traces show <runId>`. A run waiting on a person: `agents interrupts`,
`agents answer <run>` (no flags prints the question and how to answer).

**A chat answer was wrong:** `chat ls` → `chat show <id>` → `traces list --conversation <id>` →
`traces show <messageId>`; `chat stats <id>` for context size and cost; `docs search "<q>"` to see
what retrieval returned (rank, score, which signal). To reproduce, `chat send --new "<question>"`
(or `chat send <id> "<msg>"`) streams a fresh turn; `--json` gives one AG-UI event per line. See
the `launch-traces` skill for reading spans.

**Secrets didn't reach an app:** `grants needs <app>` → `grants ls <app>` → `shared pushes <slug>` →
`shared retry <slug> <push>` / `grants repush <app> <grant>`.

**Platform (admin key):** `platform setup` (each step and credential with its last check — only
the warnings to act on), `admin sessions` (live sessions everywhere, drained or not),
`platform credentials check <kind>`, `platform public-url check`.

**Who did what:** `audit ls [--app] [--action] [--from]`, `activity ls`, `notifications ls`.

## 4. Reading the results

| Exit | Meaning | What to do |
|---|---|---|
| 0 | ok | — |
| 1 | the server refused (4xx/5xx), a network error, a failed follow | read the one-line error; `--json` puts the envelope on stderr |
| 2 | not logged in / key rejected | the user logs in (`! pnpm cli login …`) |
| 3 | forbidden — the key's role is too low | say which role is needed; for admin/platform, `login --admin` |

- A `--follow` exits 1 when what it follows fails (a turn, a ship, a run, a pipeline step).
- Keys and secret values are never printed (prefix only), except a NEW key or client secret,
  printed once at creation. Don't paste either into chat or a file.
- The command catalogue by area, with the routes behind each: `reference.md`.

## 5. When the CLI can't do it

Rare by design. Check `launch api ls <word>` first. A route the CLI deliberately leaves out is
listed with its reason in `apps/web/tests/config/cli-parity-exclusions.ts` (browser-only flows,
webhooks, irreversible org deletion). If you find a real gap while working in this repo, add the
command (`.claude/rules/cli.md`) rather than a one-off script — that's the rule, and the
PostToolUse hook will remind you when you add a route.
