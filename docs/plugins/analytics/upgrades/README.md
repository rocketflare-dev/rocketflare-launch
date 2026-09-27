# Release notes, written for an agent

One file per release of this plugin, `X.Y.Z.md`, plus `unreleased.md` which accumulates entries
between releases. `CHANGELOG.md` at the repository root is the human index; these are the porting
instructions, and the kit's `scripts/upgrade.mjs` — which `pnpm plugin upgrade analytics` drives —
reads their frontmatter.

They exist for the same reason the kit's do: a plugin is COPIED into an app and translated into its
vocabulary, so the app can never merge from here. `pnpm plugin upgrade` replays a translated diff
of this repository into that copy, and these notes are what tell it, and the agent driving it, what
a release actually did and what it must not do.

## The shape

Frontmatter, then four fixed headings — **What changed**, **How to apply**, **Conflicts to expect**,
**Verify** — in that order.

| Field | Means |
|---|---|
| `version` · `previous` | this release, and the one before it. `previous: null` only on the first. The chain is what `plugin upgrade` walks; a gap is permanent |
| `date` | `YYYY-MM-DD` |
| `breaking` | does an adopter have to change their own code? |
| `requires_kit` | the kit range this release needs. CI resolves the oldest and newest kit inside it and runs the host's whole gate against both |
| `migrations` | **descriptions of the schema change, never file names.** The HOST generates the DDL with `pnpm db:generate`; this plugin ships no migration, ever |
| `areas` · `touches_registries` | where the change lands, and which of the host's registries move |
| `manual` | is there a step no tool can do? |

## The rules

- **Released history is never rewritten.** Every app pins a commit of this repository; a force-push
  to a released tag orphans them.
- **A behaviour change adds an entry to `unreleased.md` in the same commit.** `node
  scripts/release.mjs X.Y.Z` folds it into `X.Y.Z.md` and prepends the `CHANGELOG.md` section.
- **Never rename anything across releases** — expand/contract only. drizzle-kit's rename prompt has
  no non-interactive answer, so a rename stops an unattended install dead.
