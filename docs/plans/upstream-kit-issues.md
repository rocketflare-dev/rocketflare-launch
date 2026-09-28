# Upstream kit issues found while building P2 and P3

Launch was seeded from the Rocketflare starter kit **0.15.0** (commit
`c7fd5dfbf9cfbc197c60f1993f18d524ec28bd66`). These are the kit and plugin problems we hit while
building P2 ("create an app") and P3 (coding sessions, items 10-11). They are collected here to
report upstream.

Every item was checked against the kit source at that commit (`rocketflare-dev/rocketflare`,
tag `0.15.0`) or the plugins repo (`rocketflare-dev/rocketflare-plugins`, tag `3.4.1`). Line
numbers refer to those trees. Where Launch works around an item, the workaround is named.

Repros assume a checkout of the kit at `0.15.0` with `pnpm install` done, run from the repo root.
Config tests run with `pnpm --dir apps/web exec vitest run --project config <file>`.

## Summary

| # | Issue | Repo | Status |
|---|---|---|---|
| 1 | `appendToArray` counts a value quoted in a comment as present | rocketflare | Not filed |
| 2 | `patch-toml.test.ts`: unanchored HYPERDRIVE regex, and a `workers_dev` assumption | rocketflare | Not filed |
| 3 | `update-check-lib.test.ts` assumes the manifest's `app` is `null` | rocketflare | Already filed: rocketflare#37 |
| 4 | `upgrade-lib.test.ts` reads `HEAD~1` (fails with one commit) | rocketflare | Not filed |
| 5 | `plugin-ci.test.ts` fails when `plugin-ci.yml` is deleted | rocketflare | Not filed |
| 6 | Bootstrap with `DEV_UI_PORT` / `DEV_API_PORT` leaves `APP_URL` on :3000 | rocketflare | Not filed |
| 7 | Two kit apps on one host share the `__Host-session` cookie | rocketflare | Not filed |
| 8 | Analytics plugin points at `docs/ADAPTING.md` §2 for something §2 no longer covers | rocketflare-plugins | Not filed |
| 9 | `docs/DEPLOYER.md` does not say what a version upload leaves out | rocketflare | Not filed |
| 10 | Bootstrap refuses to run as root, with no opt-out for a container | rocketflare | Not filed |
| 11 | `--driver neon --db-url` refuses any host but `*.neon.tech`, even with `NEON_LOCAL_PROXY` | rocketflare | Not filed |
| 12 | `rename.mjs`'s `pnpm install` is frozen under `CI=true` and fails after the rename | rocketflare | Not filed |

Related issues already filed, not repeated below:

- **rocketflare#37**: `rename.mjs` rewrites `rocketflare-dev` org references. Launch patches
  `KIT.preserved` in the scaffold job (`PRESERVED_ORG_REFS` in
  `apps/web/src/api/services/launch/rocketflare/scaffold-job.ts`).
- **rocketflare#38**: the test DB compose project is always `web`, so copies of the kit replace
  each other's test Postgres.
- **rocketflare-plugins#8**: analytics 3.4.1's `dashboard-visibility.test.ts` fails the host kit's
  `unscoped-allowlist` test. The plugins repo `main` has a commit after 3.4.1 (`714db3b`,
  "analytics: scope the dashboard-visibility setup delete by tenant") that looks like the fix, but
  it is not released. Launch carries an allow-list entry through `kitTestPatches` until it is.

---

## 1. `appendToArray` counts a value quoted in a comment as already present

**Where.** `apps/web/scripts/provision/patch-toml.ts`, `appendToArray()`, lines 332-356. The
problem is line 337:

```ts
const present = new Set([...inner.matchAll(/"([^"]*)"/g)].map(x => x[1]))
```

Called from `patchToml()` at lines 493-499 for `crons` and `run_worker_first`, which
`pnpm provision cloudflare <env>` uses (`apps/web/scripts/provision.ts` lines 872-881).

**What goes wrong.** `inner` is the raw text between `[` and `]`, comments included. Any quoted
string in it counts as an existing entry. The kit's own tomls have explanatory comments inside both
arrays that quote exactly the analytics plugin's values:

- `apps/web/wrangler.toml` line 86 (staging line 89): `# adds "/cubejs-api" and "/mcp".`
- `apps/web/wrangler.toml` line 115 (staging line 118): `# plugin's is "15 * * * *"`

So provisioning an app with analytics installed never writes the `15 * * * *` cron, and writes only
`/cubejs-api/*` and `/mcp/*` to `run_worker_first`, not the bare `/cubejs-api` and `/mcp`. The
hourly fact-table refresh never runs. Requests to the bare prefixes can be answered by the SPA
asset router instead of the Worker.

The kit's own test (`apps/web/tests/config/patch-toml.test.ts` line 408 on) uses fixture values
(`7 3 * * *`, `/tomlfixture-hook`) that do not appear in the comments, so it does not catch this.

**Repro.** Verified with this script against the kit:

```ts
// repro.mts — run with: npx tsx repro.mts (from the kit root)
import fs from 'node:fs'
import { patchToml } from './apps/web/scripts/provision/patch-toml.ts'
const src = fs.readFileSync('apps/web/wrangler.toml', 'utf8')
const out = patchToml(src, { crons: ['15 * * * *'], workerFirstPrefixes: ['/cubejs-api', '/mcp'] })
console.log(/^crons = \[[\s\S]*?\n\]/m.exec(out)?.[0])
console.log(/^run_worker_first = \[[\s\S]*?\n\]/m.exec(out)?.[0])
```

Output: `crons` is unchanged (no `"15 * * * *"` entry). `run_worker_first` gains only
`"/cubejs-api/*"` and `"/mcp/*"`.

**Suggested fix.** Strip comments before collecting existing values. For example, collect only
strings that start an entry line: `/^\s*"([^"]*)"\s*,?/gm`, or remove `#...` to end of line
(outside strings) before the `matchAll`. Add a test that runs `patchToml` on the real shipped
tomls with the analytics values. Rewording the comments alone would also stop this case, but
leaves the trap for the next one.

Note that the lazy `[\s\S]*?\]` match would also end early at a `]` inside a comment. Parsing
line by line fixes both.

**Launch workaround.** The scaffold job writes the crons and prefixes with its own comment-aware
append (`apps/web/src/api/services/launch/rocketflare/scaffold-job.ts`, step 6).

**Status.** Not filed.

---

## 2. `patch-toml.test.ts`: unanchored HYPERDRIVE regex, and a `workers_dev` assumption

**Where.** `apps/web/tests/config/patch-toml.test.ts`:

- `unprovision()`, lines 27-39, the HYPERDRIVE replace at lines 30-33:
  `/(binding = "HYPERDRIVE"\n(?:[^\n]*\n)*?id = ")[0-9a-f]{32}(")/`
- the test "inserts a workers_dev note after `name` only when no workers_dev line exists",
  lines 165-178.

**What goes wrong.**

*(a) The regex is not anchored to the start of a line.* Under `DATABASE_DRIVER = "neon"` (the
kit's default) there is no real `[[hyperdrive]]` block, but `wrangler.toml` has a commented example
(lines 90-97) containing `#   binding = "HYPERDRIVE"`. The regex matches inside that comment, skips
the commented `id = "<id>"` (not hex), and carries on lazily across lines to the next
`id = "<32 hex>"`, which is the real `RATE_LIMIT_KV` id. It rewrites that to `<HYPERDRIVE_ID>`. The
KV replace that follows then finds nothing. So once a copy has a real KV id in its toml, every
test built on `shippedProd` / `shippedStaging` sees a corrupted file. The kit's own CI never sees
this because its tomls still hold placeholders.

*(b) The `workers_dev` test assumes production has no `workers_dev` line.* `patchWorkersDevComment()`
(`apps/web/scripts/provision/patch-toml.ts` lines 164-174) returns the text unchanged if any line
matches `^\s*#?\s*workers_dev\s*=`. The test then asserts that the line after `name` is its own
note. That fails when the production toml already has a `workers_dev` line, for example:

- `workers_dev = false` (Launch writes this to both files);
- the note the kit itself adds in `pnpm provision urls` for a workers.dev host
  (`apps/web/scripts/provision.ts` lines 1033-1038), which has different text.

**Repro (a).** Verified:

```ts
// repro.mts — npx tsx repro.mts (from the kit root)
import fs from 'node:fs'
const src = fs.readFileSync('apps/web/wrangler.toml', 'utf8')
  .replace('"<KV_RATE_LIMIT_ID>"', '"0123456789abcdef0123456789abcdef"')
const out = src
  .replace(/(binding = "HYPERDRIVE"\n(?:[^\n]*\n)*?id = ")[0-9a-f]{32}(")/, '$1<HYPERDRIVE_ID>$2')
  .replace(/(binding = "RATE_LIMIT_KV"\n(?:[^\n]*\n)*?id = ")[0-9a-f]{32}(")/, '$1<KV_RATE_LIMIT_ID>$2')
console.log(/binding = "RATE_LIMIT_KV"\nid = "[^"]*"/.exec(out)?.[0])
// prints: binding = "RATE_LIMIT_KV"\nid = "<HYPERDRIVE_ID>"
```

Or: put any 32-hex id in `RATE_LIMIT_KV` in `apps/web/wrangler.toml` and run
`tests/config/patch-toml.test.ts`.

**Repro (b).** Add `workers_dev = false` after `name = ...` in `apps/web/wrangler.toml` (or run
`pnpm provision urls` with a workers.dev host) and run `tests/config/patch-toml.test.ts`. The
`workers_dev` test fails. (Reasoned from the code, not run here.)

**Suggested fix.**

- (a) Anchor both regexes to a line start with the `m` flag:
  `/(^binding = "HYPERDRIVE"\n(?:[^\n]*\n)*?id = ")[0-9a-f]{32}(")/m`. Better still, stop the lazy
  span at the next table header, so it cannot run into another block.
- (b) Have `unprovision()` also remove any `workers_dev` line (and the provision note) from the
  production text, or build the `workers_dev` test from a fixture rather than the disk file.

**Launch workaround.** `kitTestPatches()` in `scaffold-job.ts` (around lines 559-590) anchors the
regex and drops Launch's `workers_dev = false` from the production text in `unprovision()`.

**Status.** Not filed.

---

## 3. `update-check-lib.test.ts` assumes the manifest's `app` is `null`

**Where.** `apps/web/tests/config/update-check-lib.test.ts` lines 66-69, "stays silent in the kit
repository itself (its manifest has app: null)". It reads the repo's real `.rocketflare.json` and
expects `skipReason()` to answer "kit itself".

**What goes wrong.** Only the kit has `"app": null`. After `scripts/rename.mjs`, the manifest has
an `app` block, so this test fails in every renamed app. The rename also rewrites the regex at
line 61 (`/no \.rocketflare/` becomes `/no \.<slug>/`), which then no longer matches the message.

**Repro.** `node scripts/rename.mjs myapp "My App" --force`, then run
`tests/config/update-check-lib.test.ts`.

**Suggested fix.** Build the manifest in the test (`copy({ app: null })`, as line 45 already does)
instead of reading the repo's file. Keep the string `.rocketflare` out of the rename's reach, or
match on something the rename does not touch.

**Launch workaround.** `kitTestPatches()` skips the test and restores the regex.

**Status.** Already filed: rocketflare#37 (mentioned under "Impact" and "Suggested fix" there, as
part of the rename issue).

---

## 4. `upgrade-lib.test.ts` reads `HEAD~1`, so it fails in a single-commit repo

**Where.** `apps/web/tests/config/upgrade-lib.test.ts` lines 617-625, `describe('mirror().isAncestor')`.
It calls `repo.isAncestor('HEAD~1', 'HEAD')` against the repository itself. `isAncestor` is
`git merge-base --is-ancestor` (`scripts/lib/git-lib.mjs` lines 171-172), which answers false when
`HEAD~1` does not resolve.

**What goes wrong.** The comment says the repo "always has at least two commits". That is not true
for a freshly scaffolded app whose history is one commit, or for a depth-1 clone. The first
assertion fails. (`plugin-ci.yml` line 292 already notes the same problem and clones the kit
`--depth 2` for it.)

`scripts/release-check.mjs` line 344 also uses `HEAD~1...HEAD`, but it catches the error, so it is
not affected in the same way.

**Repro.**

```bash
git clone --depth 1 --branch 0.15.0 https://github.com/rocketflare-dev/rocketflare.git rf1
cd rf1 && pnpm install
pnpm --dir apps/web exec vitest run --project config tests/config/upgrade-lib.test.ts
```

(Reasoned from the code, not run here.)

**Suggested fix.** Build a throwaway git repo with two commits in a temp dir and test `isAncestor`
there. That tests the predicate without depending on the host repo's history.

**Launch workaround.** The scaffold job commits before it runs the gate, so the kit tests see at
least the app's first commit and the scaffold commit (`scaffold-job.ts`, step 8).

**Status.** Not filed.

---

## 5. `plugin-ci.test.ts` fails when an app deletes `plugin-ci.yml`

**Where.** `apps/web/tests/config/plugin-ci.test.ts` line 18:

```ts
const WORKFLOW = readFileSync(path.join(REPO_ROOT, '.github/workflows/plugin-ci.yml'), 'utf8')
```

**What goes wrong.** `plugin-ci.yml` is a reusable workflow for plugin repositories. It is kit-only
and has no job in an app. An app that deletes it gets `ENOENT` at module load, and the whole test
file fails.

**Repro.**

```bash
rm .github/workflows/plugin-ci.yml
pnpm --dir apps/web exec vitest run --project config tests/config/plugin-ci.test.ts
```

**Suggested fix.** Skip the suite when the workflow is absent
(`describe.skipIf(!existsSync(...))`), or move the test next to the workflow in something the
rename and the app never carry. Also consider listing `plugin-ci.yml` and `notify-plugins.yml` as
kit-only files that `install.sh` or `rename.mjs` can drop, with their tests.

**Launch workaround.** The scaffold job deletes both kit-only workflows and this test
(`KIT_ONLY_WORKFLOWS` in `scaffold-job.ts`, step 7).

**Status.** Not filed.

---

## 6. Bootstrap with `DEV_UI_PORT` / `DEV_API_PORT` leaves `APP_URL` on :3000

**Where.**

- `scripts/bootstrap.mjs` lines 62-65 read the ports once at load (`devPorts()`).
- The `.dev.vars` step (around lines 280-310) fills secrets, `DATABASE_URL` and
  `DATABASE_DRIVER`, but never writes `APP_URL`, `DEV_UI_PORT` or `DEV_API_PORT`.
- `apps/web/.dev.vars.example` lines 9-15 ship `APP_URL=http://localhost:3000` and the two port
  lines commented out.
- `scripts/lib/dev-ports.mjs` lines 9-10 say `APP_URL` "must follow the UI port by hand".

**What goes wrong.** `DEV_UI_PORT=4000 DEV_API_PORT=4001 pnpm bootstrap` runs the bootstrap on the
new ports, but the `.dev.vars` it creates still says `APP_URL=http://localhost:3000`, and the port
lines stay commented. Two things follow:

- The Worker builds OAuth redirects and magic links from `APP_URL`, so they point at :3000.
- A later `pnpm dev` without the shell variables goes back to 3000/3001, because nothing
  remembered the ports.

The kit documents the manual step (SETUP.md "Ports taken?"), but the bootstrap knows the ports
and could write them.

**Repro.** On a fresh clone with no `apps/web/.dev.vars`:

```bash
DEV_UI_PORT=4000 DEV_API_PORT=4001 pnpm bootstrap
grep -E '^(# )?(APP_URL|DEV_UI_PORT|DEV_API_PORT)=' apps/web/.dev.vars
# APP_URL=http://localhost:3000
# # DEV_UI_PORT=3000
# # DEV_API_PORT=3001
```

(Reasoned from the code, not run here.)

**Suggested fix.** When the ports differ from the defaults, have the bootstrap `upsertDevVar`
`DEV_UI_PORT`, `DEV_API_PORT` and `APP_URL=http://localhost:<ui>`, and note it. At least warn
when `APP_URL`'s port differs from the UI port.

**Status.** Not filed.

---

## 7. Two kit apps on one host share the `__Host-session` cookie

**Where.** `apps/web/src/api/auth/cookies.ts` line 13, `SESSION_COOKIE_NAME = '__Host-session'`,
set by `setSessionCookie()` (lines 25-33). `middleware/csrf.ts` re-exports the name. The
`oauth_state` flow cookie (line 15) has the same problem.

**What goes wrong.** Cookies are not scoped by port (RFC 6265, section 8.5). Two kit apps on
`localhost:3000` and `localhost:4000` (for example Launch and an app it scaffolded, or two
checkouts) both set a cookie called `__Host-session` for host `localhost`. Signing in to one
overwrites the other's session. The other app then sees an unknown token and signs the user out.
An OAuth round trip in one app can also pick up the other's `oauth_state`.

**Repro.**

1. Run two copies of the kit: one with the default ports, one with `DEV_UI_PORT=4000`,
   `DEV_API_PORT=4001` and `APP_URL=http://localhost:4000`.
2. Sign in to `http://localhost:3000`.
3. Sign in to `http://localhost:4000`.
4. Reload `http://localhost:3000`: you are signed out.

(Reasoned from the code and the cookie spec, not run here.) Using `localhost` for one and
`127.0.0.1` for the other avoids it, because those are different hosts.

**Suggested fix.** Make the cookie name unique per app, and per port in development. For example
`__Host-<slug>-session` (the rename can set the slug), with the UI port appended when
`APP_ENV=development`. Keep `csrf.ts` reading the same constant. A short SETUP.md note would help
either way.

**Status.** Not filed.

---

## 8. Analytics plugin points at `docs/ADAPTING.md` §2 for something §2 no longer covers

**Repo.** rocketflare-plugins, analytics 3.4.1.

**Where.**
`plugins/analytics/apps/web/src/plugins/analytics/db/schema/facts/tenant-activity-daily-facts.ts`
lines 14-15:

```
 * EXAMPLE (surface `example-cube-tenant-activity-daily`): the shape to copy for a real fact table,
 * and safe to delete with its cube and query — `docs/ADAPTING.md` §2.
```

**What goes wrong.** The claim that §2 is missing is **not quite right**, so this item is corrected
here. In kit 0.15.0, `docs/ADAPTING.md` still has "## 2. Delete once you have real ones" (line 85).
But the reference is stale in two ways:

- The surface `example-cube-tenant-activity-daily` was retired in kit 0.6.0, when analytics
  became a plugin (kit `.rocketflare.json` line 24, under retired surfaces).
- §2 no longer explains how to delete the example fact table. For analytics it says to read "the
  plugin's own `CLAUDE.md`" (`docs/ADAPTING.md` lines 117-121). So the plugin points to the kit,
  and the kit points back to the plugin.

The analytics `CLAUDE.md` files describe the example fact table
(`services/fact-tables/CLAUDE.md` line 4) but we did not find step-by-step removal instructions
there.

**Repro.**

```bash
git -C rocketflare-plugins grep -n "ADAPTING" 3.4.1 -- plugins/analytics
sed -n 104,121p rocketflare/docs/ADAPTING.md
```

**Suggested fix.** Replace the reference with a pointer to the plugin's own docs, and add a short
"removing the examples" section to `plugins/analytics/apps/web/src/plugins/analytics/CLAUDE.md`
(the fact table, its cube, its query, its refresh registration and its migration). Drop the
retired surface id from the comment.

**Status.** Not filed.

---

## 9. `docs/DEPLOYER.md` does not say what a version upload leaves out

**Where.** Kit `docs/DEPLOYER.md`. The `upload` section (lines 112-116) tells a deployer to
store the build as "an undeployed version (Cloudflare: the Workers Versions API)", and `activate`
(line 131 on) to make it live as "a deployment at 100%". The page never mentions
Durable Object migrations, Workflows, queue consumers or cron triggers.

**What goes wrong.** Uploading a version and deploying it is not the same as `wrangler deploy`.
From Launch's P2 work (`docs/plans/p2-create-app.md` section 0, item 2), a version upload does not:

- apply Durable Object `[[migrations]]`;
- register `[[workflows]]`;
- create `[[queues.consumers]]`;
- set `[triggers] crons`.

The kit uses all four, so a deployer that follows the page literally ships a Worker whose DO
classes, workflows, queue consumer and crons are missing or stale. A new DO migration tag in a
later build is the hardest case, because it cannot be applied through a version upload at all.

We did not re-check this against Cloudflare's current documentation while writing this note. It
matches Cloudflare's documented limit that Durable Object migrations are not supported by version
uploads and gradual deployments, and that crons are set per script, not per version.

**Repro.** Implement the protocol against the Versions API (upload a version, then create a 100%
deployment) for a fresh Worker built from the kit, then compare with `wrangler deploy`: the DO
namespaces, workflows, queue consumer and cron schedules are absent. Not reproduced here as a
standalone script.

**Suggested fix.** Add a section to `docs/DEPLOYER.md` listing what the deployer must do outside
the version upload, and when:

- DO migrations: apply them with a script deploy (for example a placeholder Worker) before the
  first version, and refuse or handle a build that adds a new migration tag;
- Workflows and queue consumers: register them through their own APIs;
- crons: set the schedules through the schedules API on `activate`.

**Launch workaround.** A placeholder Worker applies the DO migrations; Launch registers workflows
and queue consumers itself; `activate` applies the schedules. A later build with a new migration
tag is refused with a clear error.

**Status.** Not filed.

---

## 10. Bootstrap refuses to run as root, with no opt-out for a container

**Where.** `scripts/bootstrap.mjs` lines 854-857:

```js
if (typeof os.userInfo === 'function' && os.userInfo().uid === 0) {
  process.stderr.write('bootstrap: refusing to run as root — run as your own user\n')
```

There is no flag or environment variable that skips it.

**What goes wrong.** The check protects a laptop (a root-owned `node_modules` or `.dev.vars`), but
a container is a different case: there the container is the isolation boundary and everything
runs as root. Launch P3 runs the kit's bootstrap inside a Cloudflare Sandbox container (the base
image `cloudflare/sandbox:0.12.10` runs commands as root) to migrate and seed each coding
session's database, and the bootstrap exits there before doing anything. A CI job in a root
container (a common Docker default) hits the same wall.

**Repro.** In any container running as root, with the kit at `0.15.0` and `pnpm install` done:

```bash
node scripts/bootstrap.mjs --db-url postgres://u:p@db:5432/app --driver postgres --no-dev --yes
# bootstrap: refusing to run as root — run as your own user
```

**Suggested fix.** Keep the refusal on a workstation, but allow an explicit opt-out: a
`--allow-root` flag (or `ROCKETFLARE_ALLOW_ROOT=1`), documented for containers and CI.

**Launch workaround.** The session runs the bootstrap with `node --import <preload>`, where the
preload makes `os.userInfo()` report uid 1000 (`NOT_ROOT_PRELOAD` in
`apps/web/src/api/services/sessions/rocketflare-dev.ts`). Everything the bootstrap starts still
runs as root.

**Status.** Not filed.

---

## 11. `--driver neon --db-url` refuses any host but `*.neon.tech`, even with `NEON_LOCAL_PROXY`

**Where.** `scripts/lib/bootstrap-lib.mjs` lines 480-485 (the check) and 503-509
(`isNeonDatabaseUrl`, which is `hostname.endsWith('.neon.tech')`).

**What goes wrong.** The `neon` driver can reach a plain Postgres through the kit's own local Neon
proxy (`NEON_LOCAL_PROXY`, which `pnpm dev:db:up --neon` starts) — the error message itself says
so ("or to the local proxy in front of the Docker database"). But the check looks only at the URL's
host, so a local database URL is refused with `--driver neon` whether or not `NEON_LOCAL_PROXY` is
set. There is then no way to bootstrap an app on the `neon` driver against a local database from
the command line. Launch needs exactly that: a local coding session's app is on the `neon` driver
(as it is deployed) and its database is on the laptop's Postgres, behind the proxy.

**Repro.** With the kit at `0.15.0`:

```bash
NEON_LOCAL_PROXY=http://localhost:4444 node scripts/bootstrap.mjs \
  --db-url postgres://u:p@localhost:5432/app --driver neon --no-dev --yes
# --driver neon needs a Neon --db-url (*.neon.tech): ...
```

(Reasoned from the code, not run here.)

**Suggested fix.** Accept any host when `NEON_LOCAL_PROXY` is set (the proxy routes by database,
not host), or check for the proxy instead of the host.

**Launch workaround.** A local session's database URL uses the host `launch-local.neon.tech`,
which is never resolved: `NEON_LOCAL_PROXY` sends every query to the proxy
(`LOCAL_NEON_HOST` in `apps/web/src/api/services/sessions/db/local-session-db.ts`).

**Status.** Not filed.

---

## 12. `rename.mjs`'s `pnpm install` is frozen under `CI=true` and fails after the rename

**Where.** `scripts/rename.mjs` at 0.15.0, the `spawnSync('pnpm', ['install'])` after the files
are written (around line 358).

**What goes wrong.** The rename rewrites every workspace package name (`@rocketflare/shared` →
`@<slug>/shared`) but not `pnpm-lock.yaml`, and relies on the `pnpm install` it runs next to
rewrite the lockfile. Anywhere `CI=true` is set (every GitHub Actions runner), pnpm defaults to
`--frozen-lockfile` and refuses: `ERR_PNPM_OUTDATED_LOCKFILE … 1 dependencies were added:
@<slug>/shared@workspace:*`. The rename then exits 1.

**Repro.** In a fresh kit checkout at `0.15.0`: `CI=true node scripts/rename.mjs demo-app "Demo"
--force`. (Seen on a real GitHub Actions run of Launch's scaffold job.)

**Suggested fix.** Run `pnpm install --no-frozen-lockfile` there. The rename knowingly changes the
lockfile's inputs, so a frozen install can never succeed.

**Launch workaround.** The scaffold job passes `--skip-install`, then runs `pnpm install
--no-frozen-lockfile` and `pnpm lint:fix` itself (`apps/web/src/api/services/launch/rocketflare/scaffold-job.ts`).

**Status.** Not filed.
