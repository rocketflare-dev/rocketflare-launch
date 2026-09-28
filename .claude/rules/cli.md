---
paths:
  - apps/cli/src/**
  - apps/cli/tests/**
---

# CLI Patterns (`apps/cli`, `@launch/cli`, bin `launch`)

A commander CLI that talks to the web API with a tenant API key. Dev: `pnpm cli <command>` from the
root (runs `tsx src/cli.ts` inside `apps/cli`); build: `pnpm --filter @launch/cli build` → `dist/cli.js` (the `bin`).
The package is **private**; publishing it is an app decision (docs/DEPLOY.md).

## Shape

- `apps/cli/src/cli.ts` — `program` setup only: name/version from `package-info.ts`, global options
  (`--server <url>`, `--json`), one `.command()` per file, one catch that prints a `CliError` once and
  sets `process.exitCode`. No business logic
- `apps/cli/src/commands/<name>.ts` — one file per command, **thin**: options → `api.ts` → output.
  Each is an exported function taking a `CommandContext` (`context.ts`: config store, `fetch`, `open`,
  output — all injectable) so tests run it in-process without spawning
- `apps/cli/src/api.ts` — the only `fetch` call site (`createApiClient`). Adds `Authorization: Bearer
  <key>`, parses every response with the matching `@launch/shared/<module>` schema (errors with the shared
  envelope), throws `CliApiError` with the exit code for the status. Never hand-write a response type
  here; add the schema to `packages/shared` first
- `apps/cli/src/errors.ts` — `CliError { exitCode, hint }`, `NotLoggedInError`, the `EXIT_*` constants.
  Commands throw; they never print errors or call `process.exit()`
- `apps/cli/src/config.ts` — `~/.launch/config.json` (`LAUNCH_CONFIG_DIR` relocates it; tests use a temp
  dir): directory `0700`, file `0600`, re-tightened on every write. Env overrides win over the file:
  `LAUNCH_API_KEY`, `LAUNCH_URL` (for CI — no browser); `LAUNCH_DEBUG` enables debug lines
- `apps/cli/src/auth.ts` — the browser handoff: loopback `http.Server` on the first free port in
  `127.0.0.1:8765–8770`, `open(<server>/auth/cli?redirect_uri=http://127.0.0.1:<port>/callback)`,
  (plus `&hostname=<os.hostname()>` so the server can name the key `cli:<hostname>`), receive
  `?key=&tenant_id=&tenant_name=` once (an `?error=` query is handled defensively), answer a
  self-closing page, verify the key against `/api/me`, save, shut down. Five-minute timeout. Never
  log the key
- `apps/cli/src/utils/output.ts` — tables (`renderTable`), `formatJson`, pagination footer; `--json`
  switches the whole `Output` to JSON-only
- Never import from `apps/web`; only `@launch/shared`, `commander`, `chalk`, `open`, `zod`, `node:*`

Feature flags (D30) are read-only here: `features list` shows the EFFECTIVE flags for the key's
organisation via `GET /api/features`. Administering one is a global-admin act and
`globalAdminMiddleware` resolves the session cookie only, so a tenant API key cannot reach
`/api/admin/*` — by design; do not widen that middleware to make a CLI command possible.

Evals (D33): `feedback list` reads the thumbs queue (`GET /api/feedback`, admin+) and `evals promote
<id> --dataset <name>` fetches `GET /api/evals/export` (message id first, run id on a 404, `--run`
skips the first try) and APPENDS one `EvalCase` line to `apps/evals/datasets/<name>.jsonl`, found by
walking up from the cwd (`--dir` overrides). It is the one kit command that writes into the
repository, and what it writes is tenant data, so it warns and refuses without `--yes` or a
confirmed TTY prompt (tests inject `confirm`), and refuses a duplicate case id.

Groups (D29) are READ-only here: `groups list` and `groups members <id>`. Creating or deleting a
group is a decision about who sees what, and the confirmation the web UI gives before a delete
narrows access has no honest one-line equivalent in a CLI.

Coding sessions (Launch P3): `sessions start <app>` (slug → `GET /api/apps/:slug` → `POST
/api/apps/:id/sessions`), `say <id> <msg> [--follow]`, `ship <id> [--wait]`, `end`, `ls <app>
[--all]`, `preview-url <id> [--open]`. Following POLLS the durable rows (`GET /events?afterSeq=`)
rather than reading SSE — `api.ts` stays the one JSON fetch site; `sleep`/`pollMs` are injectable.
A failed turn, a ship with no PR, or failing CI exit 1; with `--json` a follow prints ONE document
(`{ session, events[, pr] }`) at the end. The preview URL is a one-minute credential: printed only
when asked for.

Approvals and releases (Launch P4): `approvals ls [--box mine|requested|all] [--status] [--kind]
[--app <slug>]`, `show <id>` (a plain-words summary per kind, the policy, N-of-M, the decisions and
either the approve/reject commands or the `whyNot` sentence, and — while pending — who it waits
on, from `eligible`), `approve|reject <id> [--comment]`
(a 409 `not_pending` / `already_decided` becomes a sentence and exits 1; 403 exits 3). An id may be
an 8-character prefix, looked up in the caller's boxes. `releases ls <app>`, `create <app>
[--bump patch|minor|major]`, `promote <app> <id|X.Y.Z> [--reason] [--wait]` — promote prints the
approval's URL; `--wait` polls the approval to a terminal status, then the release to
`production_active` (exit 1 on reject, expiry or failure; with `--json` ONE `{ release, approval }`
document), with `sleep` / `pollMs` injectable. The CLI never approves its own promote — the
promoter is excluded from deciding.

The audit log (Launch P4, admin+): `audit verify` (exit 1 at the first broken link, printed) and
`audit export --out <file> [--format json|csv] [--app] [--action] [--from] [--to] [--force]`. The
export is the one place the CLI does not read a whole body: `ApiClient.download` hands it back as a
stream (the timeout covers the headers only) and it goes straight into a `0600` file (`wx` unless
`--force`); a download cut off mid-body removes the file rather than leave a shorter chain behind.
It prints the offline check — `node scripts/verify-audit-export.mjs [--filtered] <file>`, with
`--filtered` when a filter was given. A schema passed to `api.ts` is typed
`z.ZodType<T, z.ZodTypeDef, unknown>`, so `T` is the contract's OUTPUT (its `.default()`s and
coercions applied) and no call site casts.

Shared config (Launch P5): `shared ls`, `show <slug>` (var values and holders only when the server
sends them — the owner team and admins), `set <slug> --env <env> [--wait]`, `rotate <slug> --env`
(= `set --wait`) and `pushes <slug> [--env] [--wait]`. A VALUE never travels in argv: `set` reads a
hidden TTY prompt (raw mode, one per item, Enter keeps a set key; tests inject `promptHidden`) or,
when stdin is not a terminal, `KEY=value` lines / one JSON object (`readStdin` injectable), and no
output, log line or error ever repeats one. `--wait` polls the push and exits 1 on `partial` /
`failed`, naming the apps. `grants needs|ls <app>`, `request <app> <resource> --reason [--env
staging,production] [--expires]` (both environments by default; prints each approval's page) and
`revoke <app> <grant>` (id, 8-char prefix, or resource slug with `--env`). `api.ts` accepts `PUT`
for the values write.

## Output

- Human output goes to stdout via `chalk`; diagnostics and progress to stderr. `--json` on **every
  list/read command** prints the parsed response as JSON only (no colour, no extra lines) so it pipes
  into `jq`
- **Never print a full API key.** Show `launch_ab12…` (prefix + 4) in `whoami`/`status`;
  `login` says where the key was stored, not what it is
- Errors: one line `error: <message>` on stderr (+ `code` when the envelope has one). With `--json`,
  the envelope `{ error, statusCode, code? }` goes to stdout

## Exit codes

| Code | Constant | Meaning |
|---|---|---|
| 0 | `EXIT_OK` | success |
| 1 | `EXIT_ERROR` | API non-2xx other than 401/403, network failure, unexpected error. (Commander usage errors are not routed through `CliError`; `cli.ts` sets no `exitOverride`, so they take commander's default exit) |
| 2 | `EXIT_NOT_LOGGED_IN` | no key in config/env, or the server answered 401 (`hint`: run `launch login`) |
| 3 | `EXIT_FORBIDDEN` | 403 — the key's role in the tenant does not allow the action |

`exitCodeForStatus(status)` in `api.ts` is the single mapping; `cli.ts` sets `process.exitCode`
from the thrown error, so tests assert the code without a process exit. `process.env` is legitimate
here (it is Node), but read it in `config.ts` only.

## Tests (`apps/cli/tests`)

Vitest, Node, no database (`.claude/rules/testing.md`). Build a `CommandContext` with a fake `fetch`,
a no-op `open`, a memory `Output` (`createMemoryOutput`) and a config store in a temp dir
(`LAUNCH_CONFIG_DIR`); call the command function; assert the thrown `CliError.exitCode` and the parsed
`--json` output. Never touch the real `~/.launch`.

## Plugins (D31) — `apps/cli/src/plugins/<id>/index.ts`

A plugin that ships commands exports a `CliPlugin` — `{ shared, register(program, action) }` — and
one line in `apps/cli/src/plugins/index.ts` adds it to `CLI_PLUGINS`. `cli.ts` loops over
`cliPlugins` and calls `register` once each, **after** every kit command, so `launch --help`
lists them together and a plugin can never shadow `login`.

- **The top-level command name is the plugin's id** (`launch analytics …`), which is what
  keeps two installed plugins from claiming the same word. Sub-commands below it are the plugin's
  own
- **It registers with the host's `action()` wrapper**, so it inherits one context, one error printer
  and the same exit codes (0 · 1 · 2 · 3). It throws `CliError`; it never prints an error, never
  calls `process.exit`, and never reads `process.env` outside `config.ts`
- **It owns no second copy of the contract**: it calls the plugin's own routes through
  `requireClient(ctx).request(...)` and parses with the same `@launch/shared/plugins/<id>`
  schema the server validated with. A command that starts background work POSTs the route that
  enqueues rather than building an envelope, so producer validation and the `JOBS_QUEUE` binding
  stay on the server
- `--json` on every list, key prefixes only, chalk to stdout and diagnostics to stderr — the rules
  above apply unchanged. The installed example is `apps/cli/src/plugins/analytics/`
