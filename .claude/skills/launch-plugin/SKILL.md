---
name: launch-plugin
description: Install, upgrade, remove and audit Launch plugins — a plugin is a git repository copied into this app, not an npm package. Use when someone asks to add a plugin, pull in a plugin's later releases, uninstall one, check the installed set, or author a plugin of their own.
argument-hint: "[add <repo|path> | upgrade <id> | remove <id> | list | check]"
---

# /launch-plugin — the capabilities this app installs

A plugin is a **git repository copied into this app**, exactly like the kit itself: never an npm
package, never a build artefact. Its code lands as ordinary source under three roots
(`apps/web/src/plugins/<id>/`, `packages/shared/src/plugins/<id>/`, `apps/cli/src/plugins/<id>/`),
translated into this app's own vocabulary on the way in, and it reaches the host through six
barrel files and nothing else. In the other direction it imports the host only through the DECLARED
entries — `@/plugins/api` (the context family), `@/db/schema/kit`, the shared and CLI entries,
`@testkit/*` — and receives everything else as injected context; `docs/plugin-api.md` is the
generated reference for that surface, and its `## Surface ledger` block is what every plugin's
declared `uses` is checked against. `docs/CONCEPTS.md` §16 is the design;
`apps/web/src/plugins/CLAUDE.md` is the seam; `reference.md` beside this file is the manifest shape,
the exit codes and what each command verifies.

**The rule that matters most:** installing a plugin gives it full Worker and database access, so it
is as trusting as merging a pull request. Every command prints a plan and stops. **You show the
plan to the user and get an explicit yes before you ever type `--apply`.** Never chain the two.

`$ARGUMENTS` is the command and its target. With none, run step 4 (`list` + `check`) and ask what
they want to do.

## 1. Check the ground

```
git status --short && pnpm plugin list && pnpm plugin check
```

Expect a clean tree, one line per installed plugin (`id  version  repo  installedAt`, `(local)` for
a sidecar install), and either `✔ n plugin(s) check out: …` or `No plugins installed.`

A dirty tree: ask them to commit or stash. `add` and `upgrade` refuse one (`--allow-dirty` exists
and is for people who know why they are using it) because the install should be one reviewable diff.

## 2. `add` — read the plan, then ask

```
pnpm plugin add <repo|path>[@ref] [--subdir <dir>]
```

A **repo URL** is mirrored under `.plugin-cache/` (`--no-fetch` reuses the cache offline); a
**local path** is read directly, which is the authoring loop (step 6). Expect a plan with these
blocks and **"Nothing written. Read the plan, then re-run with --apply to install."** at the end:

- `Plugin` / `Source` / `Host` / `Names` — what, from where, into which manifest file, and whether
  the names are being translated into this app's vocabulary or copied in kit vocabulary.
- `Requirements` — four `✔` lines or one `✖` per unmet requirement: the kit is at or above the
  plugin's `minKit` floor (or `⚠` when it declares none, meaning no kit version is ever checked
  against it); **`surface`, the measured one** — every symbol the plugin `uses` is in this kit's
  ledger; then `surfaces` and `plugins`. **Any `✖` is exit 6 and nothing is written** — report it
  and stop. A surface `✖` names the symbol and the import that replaces it, so it is actionable
  without reading anything else.
- `Files (n)` — a count per root, plus `(not copied) migrations/` for any install fragment.
- `Skills` — only when the plugin ships agent skills: each `.claude/skills/<dir>/` it installs.
  Nothing to do for them; after the install, tell the person the skill exists and what it is for
  (its `description`), because a skill nobody knows about is only found by accident.
- `Barrel lines` — the exact line each of the six barrels gains (the sixth, `worker-exports.ts`,
  only when the plugin ships a Durable Object or Workflow class).
- `Dependencies` — what will be installed into which package.
- **`Steps — nothing below is done for you`** — split into **Human steps** (a decision: the
  tooling stops and waits) and **Agent steps** (a command PLUS the assertion that proves it ran).
  Each carries `run` / `expect` / `assert`. `--json` emits the same list with a `kind` on every
  entry, which is the form to use when you are driving this rather than reading it.
- `Verify` — the plugin's own note, if it ships one.

Summarise it in three or four lines — what the plugin is, what it adds, what tables it wants, and
**every `human` step it will need** — then **ask** (`AskUserQuestion`): install it, or stop. On yes:

```
pnpm plugin add <repo|path>[@ref] --apply
```

Expect `✔ n file(s) copied and translated`, `✔ n barrel line(s) written`, `✔ surface '<id>'
recorded in launch.plugins.json`. Then do step 3 — **the app does not typecheck or run until the
tables exist.**

## 3. The steps the plan printed

The script does not do these, and each says which KIND it is. An **agent** step is an instruction
plus a check — run the command, then run the assertion. A **human** step is a decision: stop, and
ask. Each appears only when the plugin declares the thing it is about.

Nothing about the barrel lines, the bindings, the crons, the route prefixes, the `[vars]` keys or a
Durable Object's `[[migrations]]` tag is here any more: those are **declarative**, written by
`plugin add`, and rendered into a deployed instance's config by `pnpm provision render`, and a step that has become declarative is
removed rather than reworded.

| What | Kind | How | Expect | What you change |
|---|---|---|---|---|
| **The migration** (`schema.tables` declared) | agent | `pnpm db:generate --name plugin-<id>-<version>`, **read the SQL**, then `pnpm db:migrate` | `CREATE TABLE` for each declared table, at YOUR migration index, in YOUR journal | Nothing by hand. Never copy a migration from the plugin repo — a foreign snapshot teaches drizzle a current state that never heard of your tables, and your next `db:generate` drops them |
| **An install fragment** (`migrations/` in the repo) | agent | `pnpm db:generate --custom --name plugin-<id>-install`, then paste the named file into it | an empty custom migration to fill | The data half only (backfills, extensions, triggers) — DDL still comes from the schema |
| **Bindings, crons, route prefixes, non-secret `[vars]`** | agent | on a deployed instance: `pnpm provision cloudflare && pnpm provision render` (then deploy, or `pnpm provision all`) | the plugin's resources in `.launch/state.json`, its declarations in `apps/web/wrangler.deploy.toml`; `render` reports no placeholders | Nothing by hand. You never type a resource id into a toml (`/launch-deploy`, `docs/DEPLOYMENT.md`) |
| **A `vars` entry marked `secret`** — the KEY | agent | add `KEY=` to `apps/web/.dev.vars.example` | the key in that file and in NEITHER toml | One line. A secret is never a `[vars]` key — not even in staging |
| **A `vars` entry marked `secret`** — the VALUE | **human** | the value in `launch.deploy.env`, then `pnpm provision secrets` | the key listed by `wrangler secret list -c wrangler.deploy.toml` | Nothing you can derive: ask for the credential |
| **The gate** | agent | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` | exit 0 | Nothing. A failure here is the install, not the kit — read it before committing |

**`workerExports` is no longer a row here.** A Durable Object or Workflow class reaches
`apps/web/src/worker.ts` through the sixth barrel, `apps/web/src/plugins/worker-exports.ts`, which
`plugin add` writes — and `pnpm provision render` writes the matching
`[[workflows]]` / `[[durable_objects.bindings]]` blocks and the `plugin-<id>-v1` `[[migrations]]`
tag into the instance's rendered `wrangler.deploy.toml`. Removing such a plugin DOES have a human step: a `deleted_classes` migration
deletes the namespace and everything stored in it.

Then commit: one commit, message `Install plugin <id>@<version>`, so the next upgrade reads against it.

## 4. `list` and `check` — the audit

```
pnpm plugin list
pnpm plugin check
```

`check` exits 1 with one `✖` line per failure, and **every line carries the edit**:
`<file>:<line> <what is wrong> — <the exact change>`. Do what the line says; you should not need
`reference.md` to act on one, only to understand why the rule exists.

Three other kinds of line, none of which changes the exit code:

- `warn: …` — the same shape, for a finding that is not a fault in the plugin itself. **There is no
  longer a tier a plugin opts into**: every installed plugin is checked strictly, because nothing
  left is a rule a released plugin cannot retroactively satisfy.
- `note: …` — a state that is legitimately fine, or a silence worth knowing about: a plugin
  declaring no `minKit` (so no kit version is ever checked against it).
- `✔ n plugin(s) check out` — nothing to do.

Use `pnpm plugin check --json` when you are driving rather than reading: `{ ok, plugins, failures,
warnings, notes }`, and every failure carries `file`, `line`, `problem`, `fix` and `assert` as
fields rather than as a sentence you have to parse.

The common failure is `apps/web/migrations/meta/_journal.json names no migration for '<id>' …` —
step 3's first row was never done.

## 5. `upgrade` and `remove`

**Upgrade** ports the plugin's *own* later releases — its diff, translated into Launch's names:

```
pnpm plugin upgrade <id> [--to <ref>]        # the plan
pnpm plugin upgrade <id> [--to <ref>] --apply
```

The plan ends with a **`Dependencies`** block: each dependency whose declaration the release
changes, marked `+` added, `~` range changed or `-` removed, with what `--apply` will do — `install`
(`pnpm add`, then the declared range written back and one `pnpm install --no-frozen-lockfile`),
`remove`, `keep` (with the reason: another installed plugin declares it, the host pins a range
this plugin never declared, the host declared it before any plugin did, or the plugin was installed
before Launch recorded what it added), or `nothing to do`. `--json` carries it as `dependencies`. Show it to
the person before applying; a `remove` deletes a package from their `package.json`. A new range
another installed plugin cannot use is **exit 6 with nothing written** — report the clash it names.

Exit 4 means hunks rejected — **work remaining, not a failure**, and the script deliberately does
not stamp the new version until the `*.rej` files are gone. Exit 6 means the release needs a newer
kit plugin API than `kitVersion` in `launch.plugins.json`: Launch does not track the kit, so the
host changes that release relies on have to be ported by hand first.

**Remove** is the mirror, and it takes the data with it:

```
pnpm plugin remove <id>                       # the plan: directories, barrel lines, tables
pnpm plugin remove <id> --archive --apply     # --archive first copies each table into schema `archive`
pnpm db:generate --name plugin-<id>-remove    # → DROP TABLE …; read it, then pnpm db:migrate
```

Ask about `--archive` **before** applying — after the drop it is not a choice any more. The plan
also prints what to deprovision as HUMAN steps: provisioning creates a plugin's Cloudflare resources but
never deletes one, and `pnpm remove` on a dependency is printed rather than run.

## 6. Authoring a plugin

The loop is a local path plus the sidecar:

```
pnpm plugin add ../launch-plugin-<id> --local --apply   # read directly, recorded in launch.plugins.local.json
# edit it in place; the host's own `pnpm test` runs its tests
pnpm plugin export <id> <dir>                                 # copy it back out as a repository
```

`--local` records the install in the **git-ignored `launch.plugins.local.json` sidecar** rather
than in `launch.plugins.json` — an authoring convenience on this machine only. `export` writes the three trees plus a regenerated `rocketflare-plugin.json`; `git init &&
git add -A && git commit` makes it a plugin repository.

**Only the SIDECAR is git-ignored — the copied source files are not.** So in the host, `git add -A`
after a `--local` install stages the whole plugin tree, which commits a working copy. Stage by path while authoring, and check
`git status --short` before every commit.

Cutting a plugin release happens in the plugin's own repository, with that repository's release
tooling — Launch has no release script. It must write `docs/upgrades/X.Y.Z.md` (four headings and
a `previous` chain), which is what `pnpm plugin upgrade` walks. `pnpm plugin add` writes the
in-tree anchor from the source manifest, so a plugin's version exists in one place.

Everything the plugin keys carries its id: tables prefixed with the id's first hyphen-separated
segment (`orders` → `orders_*`; `pnpm plugin check` fails when two installed plugins
declare one table name), job types `<id>.verb`, the API prefix
`/api/<id>`, query-key roots `<id>:…`, the CLI command `<id>`, feature/prompt/agent keys, and AG-UI
CUSTOM events under `<id>.`. Two manifest keys carry its compatibility, and only one of them is
written by a person: a top-level **`minKit`** — one bare `X.Y.Z`, the oldest kit release it
supports, a floor with no ceiling — and **`uses`**, the host symbols it imports. **Never hand-write
`uses`**: `pnpm plugin export` derives it from the plugin's own imports, and a hand-written one is
exactly the prediction this replaced. Re-export after any change to what the plugin imports, and
paste the block it writes into the manifest.

**Ship a skill with anything a person has to SET UP or OPERATE.** A plugin that needs an app
registered somewhere, a secret created, a console clicked, or an error decoded should carry an
agent skill that drives those steps and coaches the human through the ones only they can do. Put it
at `skills/<id>/SKILL.md` (or `skills/<id>-<what>/`) in the plugin repository — frontmatter
`name: <dir>` and a `description:` that says when to use it — list the directory in the manifest's
`"skills"`, and `add` installs it at `.claude/skills/<dir>/`. Companion files (`reference.md`, one
file per provider) sit beside SKILL.md and travel with it. Never put it under the repository's own
`.claude/`, which is never copied. `pnpm plugin export` writes installed skills back to `skills/`.

A plugin that builds on another (`requires.plugins: ["connectors"]`) needs that one installed
first; `pnpm plugin check` fails a missing requirement.

## 7. Hand back

End the turn with `AskUserQuestion`, not a paragraph. After an install: **run it** (`pnpm dev` and
open the plugin's page), **provision its resources** (`/launch-deploy` on a deployed instance, if it
declared bindings — they type that one themselves), **install another**, or **stop**.

## Rules

- **Read the printed plan, show it, and get a human yes before `--apply`.** A plugin has full Worker
  and database access; this stop is the only review there is.
- **Never copy a plugin's migration**, and never touch `apps/web/migrations/meta/`. The host
  generates its own once the schema barrel line exists.
- **Never edit `launch.plugins.json`, `launch.plugins.local.json` or any of the six barrels by hand.**
  The script writes them, and `pnpm plugin check` is what proves the two halves agree.
- **Never write a resource id into a wrangler toml.** A declared binding is created by `pnpm
  provision cloudflare` (ids into `.launch/state.json`) and rendered by `pnpm provision render`.
- **Never `kit.` for a plugin's AG-UI CUSTOM events** — that namespace is the kit's, and a
  third-party client is entitled to ignore it. Use `<id>.`.
- **Expand and contract; never rename.** Add a column or a table, migrate, then remove the old one
  in a later release — drizzle-kit's rename prompt has no non-interactive answer.
- A plugin writes only inside its own roots. A file outside them is a refusal, not a warning: an
  install has to stay reversible by deleting a directory.
- `rm -rf .upgrade` is always safe — it is a cache.
