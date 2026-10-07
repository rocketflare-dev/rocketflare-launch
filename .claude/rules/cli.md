---
paths:
  - apps/cli/src/**
  - apps/cli/tests/**
---

# CLI Patterns (`apps/cli`, `@launch/cli`, bin `launch`)

A commander CLI that talks to the web API with an API key. Dev: `pnpm cli <command>` from the root
(runs `tsx src/cli.ts` inside `apps/cli`); build: `pnpm --filter @launch/cli build` → `dist/cli.js`
(the `bin`). The package is **private**; publishing it is an app decision (docs/DEPLOY.md). What it
covers and why: `docs/CONCEPTS.md` §11. The live command tree: `pnpm cli commands`.

## Shape

- `src/cli.ts` — `program` setup only: name/version from `package-info.ts`, global options
  (`--server <name|url>`, `--profile <name>`, `--json`), one registration per command file, the
  `action()` wrapper (builds the context, prints the header, catches) and one catch that prints a
  `CliError` once and sets `process.exitCode`. No business logic
- `src/commands/<name>.ts` — **thin**: options → `api.ts` → output. Each is an exported function
  taking a `CommandContext` (`context.ts`: config store, `fetch`, `open`, output — all injectable)
  so tests run it in-process. Big groups split by concern (`apps.ts` + `apps-manage.ts`,
  `sessions.ts` + `sessions-debug.ts` + `sessions-attach.ts` over `sessions-common.ts`, …)
- `src/api.ts` — the ONLY `fetch` site (`createApiClient`): `request` (JSON, or a `FormData` body
  sent as multipart), `raw` (`api call`), `download` and `stream` (the body handed back unread; the
  timeout covers the headers only). Adds `Authorization: Bearer <key>`, parses success bodies with
  the `@launch/shared/<module>` schema (typed `z.ZodType<T, z.ZodTypeDef, unknown>`, so `T` is the
  contract's OUTPUT and no call site casts), turns the error envelope into `CliApiError`, and maps
  the status to an exit code. Never hand-write a response type; add the schema to `packages/shared`
- `src/errors.ts` — `CliError { exitCode, hint }`, `NotLoggedInError`, the `EXIT_*` constants.
  Commands throw; they never print errors or call `process.exit()`
- `src/config.ts` — the config file and EVERY `process.env` read (below)
- `src/auth.ts` — the browser handoff: a loopback `http.Server` on the first free port in
  `127.0.0.1:8765–8770`, `open(<server>/auth/cli?redirect_uri=…/callback&hostname=<host>)` (plus
  `&scope=admin` for `--admin`), receive `?key=&tenant_id=&tenant_name=` once (an `?error=` is
  handled), answer a self-closing page, verify the key against `/api/me`, save. Five-minute
  timeout. Never log the key
- `src/utils/output.ts` — `renderTable`, `formatJson`, the pagination footer; `--json` switches the
  whole `Output` to JSON (`write` is the one raw stdout path, for a stream). `utils/input.ts` —
  every input (below). `utils/sse.ts` — `readSseData`. `utils/banner.ts` — the header
- Naming: `ls` and `list` are one verb — `aliasListVerbs` (`commands/commands.ts`, called once in
  `cli.ts` after the plugins) gives each the other as an alias unless a sibling owns it; a new group
  registers `ls`. Every `--yes` is `-y, --yes`
- Imports: only `@launch/shared`, `commander`, `chalk`, `open`, `zod`, `node:*` — never `apps/web`

## Servers and admin keys

`~/.launch/config.json` (`LAUNCH_CONFIG_DIR` relocates it; tests use a temp dir): directory
`0700`, file `0600`, re-tightened on every write. Shape `{ defaultProfile, profiles: { <name>: {
serverUrl, apiKey?, tenantId?, tenantName?, user? } } }`; a legacy flat file is migrated IN MEMORY
into the profile `default` and only the new shape is written. Env: `LAUNCH_API_KEY`, `LAUNCH_URL`,
`LAUNCH_PROFILE`, `LAUNCH_CONFIG_DIR`, `LAUNCH_DEBUG`, `LAUNCH_BANNER`.

- `store.resolve()` is the ONE selection function: `--profile <name>` > `--server <value>` (a
  stored name selects it; a URL is used as-is with the key of the server stored AT THAT URL, or
  none — a key only ever goes to the server that issued it) > `LAUNCH_URL` (same rule) >
  `LAUNCH_PROFILE` > `defaultProfile` > `DEFAULT_SERVER_URL` with no key. `LAUNCH_API_KEY`
  replaces whichever key that picked. An unknown name, or `--profile` with `--server`, is exit 1
  with the known names in the hint
- `login` stores into `--name`; else the selected server when its URL is the target; else the
  server already at that URL; else `default` for the first; else a host-derived name
  (`launch.example.com` → `launch-example-com`, `-2` on a clash). The first server becomes the
  default. `logout` clears key, tenant and user, keeping the URL (`--all`: every server).
  `servers rm` asks and moves the default to the first remaining; `status --all` checks every
  server in parallel (5 s each; a down one is a row, not a failure)
- `/api/admin/*` and `/api/platform/*` take the cookie or an ADMIN-scoped key, never an ordinary one
  (403 `admin_key_required`). `login --admin` asks for one (`cli-admin:<host>`, 30 days, platform
  administrators only, re-checked against its creator's CURRENT standing on every request) and
  stores it as `<server>-admin`. **Never widen the middlewares to an ordinary key** to make a command
  possible: a key left on a laptop or in CI must not quietly carry deployment-wide power. Every
  `admin` / `platform` command goes through `withAdminKey` (`commands/admin-key.ts`), which keeps
  the exit code (2/3) and adds the hint "this needs an admin key: launch login --admin"

## Input and confirmation — `src/utils/input.ts`

The ONE input module; a command never reads stdin, prompts or writes a download any other way.

- A body is the flags plus `--data <json|@file|->` (`readDataArg`, `readDataObject`; a flag wins),
  checked with the route's `@launch/shared` schema BEFORE any request (`parseBody`: exit 1 listing
  each `path: message`, nothing sent). Text: `--file <path|->` (`readTextArg`). Parsers:
  `positiveInt`, `oneOf`, `listOption`
- Whatever the web UI puts behind a confirm dialog, the CLI confirms, in the dialog's words —
  `confirmAction` (`--yes`, or `y` at a TTY; with no terminal it refuses, exit 1) and
  `confirmConsequence` (states the consequence on stderr first — who loses what — and "Nothing
  changed." on a no). Tests inject `confirm`. Adding a confirm to an existing command breaks
  scripts that lacked `--yes`: say so in the CHANGELOG
- A secret is never an argument: `readSecret` / `promptHiddenOnTerminal` (hidden prompt, or stdin
  when piped). An inline `--data` carrying a secret is refused. No output, log line or error ever
  repeats one
- Downloads: `downloadToFile` — a `0600` file opened `wx` unless `--force`, removed if the body is
  cut off
- People, groups, invitations, keys, policies and grants are named by id, id prefix, or name/email
  (`pickOne`, `commands/org-common.ts`)

## Output

- Human output to stdout via `chalk`; diagnostics, progress and the header to stderr. `--json` on
  **every read** prints the parsed body only (no colour, no extra lines) so it pipes into `jq`
- Follows: `sessions logs --follow --json` and `chat send --json` are NDJSON (one document per
  event); `sessions say --follow`, `agents logs --follow`, `releases promote --wait` and `apps create
  --follow` print ONE document at the end. A follow exits 1 when what it follows fails. Following
  POLLS durable rows (`sleep` / `pollMs` injectable), never SSE — except `chat send`, which reads
  the turn's SSE through `ApiClient.stream`
- **Never print a full API key or secret.** `whoami`/`status`/`servers ls` show a prefix; `login`
  says where the key was stored. The exceptions are one-time reveals the server returns only once:
  `keys create` (the key) and `apps sign-in register|rotate-secret` (the client secret) — to stdout
  (inside the body with `--json`), with a stderr warning, never in a log line
- Errors: `✗ <message>` on stderr (+ a dim hint). With `--json`, `{ error, exitCode, body? }` (body =
  the server's envelope) also goes to stderr. A refusal the server words (409s) is printed as the
  server's sentence, exit 1. `api call` prints a non-2xx envelope (zod `details` included) to stdout

## Exit codes

| Code | Constant | Meaning |
|---|---|---|
| 0 | `EXIT_OK` | success |
| 1 | `EXIT_ERROR` | API non-2xx other than 401/403, network failure, local validation, a refused confirm, a failed follow. (Commander usage errors take commander's default exit; `cli.ts` sets no `exitOverride`. Bare `launch` is not one: it prints the help to stdout and exits 0 — `isBareInvocation`) |
| 2 | `EXIT_NOT_LOGGED_IN` | no key, or the server answered 401 (`hint`: run `launch login`) |
| 3 | `EXIT_FORBIDDEN` | 403 — the key's role (or scope) does not allow the action |

`exitCodeForStatus(status)` in `api.ts` is the single mapping; `cli.ts` sets `process.exitCode`
from the thrown error, so tests assert the code without a process exit.

## Parity and discovery (issue #6)

What a person can do or see in the app, an agent can do or see with `launch`.

- **A new `/api` route ships with its command** (the path named LITERALLY at the call site, or via
  a one-line path helper — a path built from variables at run time is invisible to the check), or
  with an entry and a one-line reason in `apps/web/tests/config/cli-parity-exclusions.ts`.
  `cli-parity.test.ts` fails the gate otherwise, and on a stale exclusion
- **Every route registration has a one-line `/** … */` summary** directly above it, its
  `validate()` schemas are `@launch/shared` exports, and a route that reads its body validates it,
  takes multipart, or is listed with its reason in `api-catalog-manual-bodies.ts` (which only
  shrinks). `api-catalog.test.ts` enforces all three
- **The catalog is generated**: `pnpm api:catalog` writes `apps/cli/src/generated/api-catalog.json`
  (summaries, auth, params / query / body as JSON Schema, source, covering CLI file) and
  `api-schemas.ts` (`API_SCHEMAS`: per route, the same zod objects `validate()` uses, plus a
  response schema where the handler's type pairs with one). Never edit either; regenerate and
  commit after changing a route, its schema, or which CLI file calls it
- `launch commands [--json]` walks the commander tree at run time; `launch api ls|show|schema|call`
  read the catalog (`commands/api.ts`, `registerApiCommands` registers both). `api call` validates
  params, `--query` and `--data` with `API_SCHEMAS` first (`--no-validate` skips) and goes through
  `ApiClient.raw`
- A PostToolUse hook (`scripts/cli-parity-nudge.mjs`, `.claude/settings.json`) reminds once per
  session when an edit adds a route or a UI call site. Advisory; the tests are the check
- When a command changes how an agent debugs, update `.claude/skills/launch-cli/`

## Header — `src/utils/banner.ts`

The root help shows the rocket and the "Rocketflare Launch — the control plane" wordmark; each command prints one line on stderr
naming the server (orange when not local). Humans on a terminal only: `bannerMode` returns `off`
for `--json`, a non-TTY stdout or stderr, or `NO_COLOR`; `static` in CI or with
`LAUNCH_BANNER=static`; `LAUNCH_BANNER=off` turns it off. The renderers are pure; only
`animateBanner` writes. Nothing a script parses may depend on it.

## Per-area rules

What `launch <group> --help` says is not repeated here; these are the rules that are not obvious.

- **Sessions** — `start` resolves the slug, and refuses an unknown `--runtime` before any request.
  `ship` WAITS by default (`--no-wait` returns once started; `--wait` is accepted and does nothing;
  `shipFollowState` is the pure decision): one line per stage row worded as the session page's
  timeline (`@launch/shared/launch-ship-progress`), plus lines for stages that write no row, until
  `landing.stage` is `live` (exit 0). `ship.reopened`, `stalled`, a ship that opened no PR and a
  session ended while its landing waited exit 1. Past the PR it polls every ten `pollMs`. In the
  app's `pr` mode it ends at the PR and its CI. `show` says "merged" only from `landing.mergeSha`
  (open/closed is not on the row) and adds the newest gate attempt's failing step and output tail;
  `logs` prints EVERY row (`--type` is a prefix match checked before any request; `--limit` keeps
  the last n) and a follow ends at `sessionLogSettled`. `attachments` lists from the `user.message`
  rows (there is no list route). Images are checked against the composer's limits (magic bytes,
  size, count) before any upload, refused, never downscaled. **The preview URL is a one-minute
  credential**: printed only when asked for
- **Approvals** — an id may be an 8-character prefix, looked up in the caller's boxes. `show` names
  who it waits on (`eligible`) or the `whyNot` sentence
- **Releases** — `promote` prints the approval's URL; `--wait` polls the approval, then the release
  to `production_active` (exit 1 on reject, expiry or failure). **The CLI never approves its own
  promote** — the promoter is excluded from deciding. `retry` reads `failedStage`, exits 1 before
  any POST when nothing is failing, and posts that stage (a release that moved on is the server's
  409 `release_stage_changed`). `rollback` says migrations and secrets do not revert. `ls` adds
  "main is N commits ahead" from the compare route; a failed compare never fails the listing
- **Deploys** — shipping a tested version is `releases promote`; `deploys production` is "Deploy
  main to Live" (an approval). A ticket is an id or an 8-character prefix
- **Audit** — `export` is the one place the CLI does not read a whole body: `ApiClient.download`
  streams straight into a `0600` file (`wx` unless `--force`), removed if cut off (never a shorter
  chain), then prints the offline check `node scripts/verify-audit-export.mjs [--filtered] <file>`.
  `ls` filters app and action on the server; `--actor`/`--from`/`--to` in the CLI over at most 20
  pages of 200
- **Apps** — every refusal is the server's sentence (exit 1); a 403 exits 3. `show` and `releases
  ls` read the promotion / compare best-effort: a failed read never fails the command, and `--json`
  adds it as `promotion` / `mainAhead` (or null). `apps upgrade` deliberately suggests no
  `sessions say`: a message queued behind the upgrade's first turn would postpone auto-ship.
  `create` suggests the slug as the dialog does; an `approvalId` is said, never followed.
  `teardown` lists what is deleted on stderr and sends the slug as `confirmSlug`
- **Secrets** — `set` reads a hidden TTY prompt per item (Enter keeps a set key) or `KEY=value`
  lines / one JSON object on stdin. `--wait` exits 1 on `partial` / `failed`, naming the apps.
  `create` / `edit` / `archive` never carry a value; `edit --item` replaces the list
- **Agents** — `run` reads the trace best-effort (a member's 403 just omits it); there is no
  per-run cost (`ai_usage` has no run column). `logs --follow` polls `GET /runs/:id/agui`: exit 1
  on `RUN_ERROR`, 0 on `RUN_FINISHED` (with the `interrupts` hint for an interrupt outcome).
  `start` takes `--data` (`--input` is a hidden, deprecated alias). `answer` reads the ask from `GET
  /runs/:id`, builds the payload for its KIND, and checks it with `interruptPayloadSchema(spec)` /
  `interruptRejectionPayloadSchema` before the POST; no answer flag prints the question, exit 1
- **AI** — a provider key is only ever `set`/`none` (`hasCredential`); it goes in only through
  `--key`, and `--data` with an `apiKey` is refused. `prompts set` prints a line diff (`--dry-run`
  saves nothing)
- **Chat** — `send` checks the message with `sendMessageRequestSchema` before anything is created;
  frames are validated with `kitAguiEventSchema` (an unknown frame is skipped, as the web UI does).
  A `RUN_ERROR`, or a stream ending without `RUN_FINISHED`, exits 1
- **Docs** — `upload` is checked first with the page's `validateDocumentFile`; `search` prints
  rank, RRF score, dense/lexical ranks and passage position per hit
- **The organisation** — every write that takes access away asks, in the page's words
  (`confirmConsequence`). A group delete refused as 409 `group_in_use` prints the page's sentence
  and exits 1 unless `--force`, which asks again and re-sends with `?force=1` (fail-closed).
  `keys revoke` warns louder when it is the CLI's own key. `invites send` with several addresses
  uses the bulk route and prints per-address results. `policies set` starts from the row at that
  scope (or the code default) so one flag edits one field; one that auto-approves members asks
- **Admin and platform** (admin key) — `platform setup` prints presence and probe sentences, never a
  value or `metadata`. A credential comes from `readSecret`, `--private-key-file <path|->` or
  `--data @file|-` (inline `--data` refused); a check that comes back `failed` prints its probes,
  then exits 1. `agents set --runtime` fills the rest of that runtime's entry from `GET
  /api/platform/setup` (the PUT takes each runtime whole). Support enter/leave has no command (it
  pins a browser session; a key gets 400 `support_needs_session`)
- **Agent accounts** — `login` resumes the sign-in in flight or starts one; Claude's `code#state`
  is read hidden or from stdin's first line, checked, then sent once; a bad one or Ctrl-C cancels
  the sign-in. No token is ever in these responses
- **Evals** — `evals promote` is the one command that writes into the repository: it APPENDS a case
  to `apps/evals/datasets/<name>.jsonl` (found by walking up from the cwd; `--dir` overrides),
  refuses a duplicate id, and — the case is tenant data — refuses without `--yes` or a confirmed
  prompt
- **Features** — read-only: `features list` shows the EFFECTIVE flags (`GET /api/features`);
  rollout is `admin flags`

## Tests (`apps/cli/tests`)

Vitest, Node, no database (`.claude/rules/testing.md`). Build a `CommandContext` with a fake `fetch`,
a no-op `open`, a memory `Output` (`createMemoryOutput`) and a config store in a temp dir
(`LAUNCH_CONFIG_DIR`); inject `confirm`, `promptHidden`, `readStdin`, `sleep` / `pollMs` where the
command takes them; call the command function; assert the thrown `CliError.exitCode` and the parsed
`--json` output. Never touch the real `~/.launch`.

## Plugins (D31) — `apps/cli/src/plugins/<id>/index.ts`

A plugin that ships commands exports a `CliPlugin` — `{ shared, register(program, action) }` — and
one line in `apps/cli/src/plugins/index.ts` adds it to `CLI_PLUGINS`. `cli.ts` calls each
`register` once, **after** every kit command, so a plugin can never shadow `login`.

- **The top-level command name is the plugin's id** (`launch analytics …`); sub-commands are its own
- **It registers with the host's `action()` wrapper** — one context, one error printer, the same
  exit codes. It throws `CliError`; never prints an error, calls `process.exit` or reads
  `process.env`
- **It owns no second copy of the contract**: it calls its own routes through
  `requireClient(ctx).request(...)` and parses with `@launch/shared/plugins/<id>`. Background work
  POSTs the route that enqueues
- The rules above apply unchanged. The installed example is `apps/cli/src/plugins/analytics/`
  (reset, rm and recreate confirm with the dashboard pages' words; a template page cannot be
  deleted). It imports only `../api` and its own `@launch/shared/plugins/analytics/index`, so its
  confirm and `--data` reading are its own. Its routes' summary comments live in the copied plugin
  tree: upstream them, or `plugin upgrade` drops them
