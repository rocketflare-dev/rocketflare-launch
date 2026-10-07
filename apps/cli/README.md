# @launch/cli

`launch` — the command line for a Launch server. Everything the web app can do or show, it can do
or show too. It signs in through the browser (D26 handoff) and stores an API key per server under
`~/.launch/`.

```bash
pnpm cli --help                 # from the repo root (tsx, always current)
pnpm cli login                  # browser → API key for the default server (http://localhost:3001)
pnpm cli whoami
pnpm cli status [--all]
pnpm cli --json apps ls         # raw JSON on stdout, nothing else
```

Build: `pnpm --filter @launch/cli build` bundles `src/cli.ts` with esbuild into `dist/cli.js` (the
`bin`); `@launch/shared` is TypeScript source, so the contracts are inlined. Tests: `pnpm --filter
@launch/cli test` (vitest, no server).

## Servers

`~/.launch/config.json` (directory `0700`, file `0600`) holds named servers and a default:

```bash
launch login --server https://launch.example.com --name prod   # sign in and store it as "prod"
launch servers ls                                              # * default; keys redacted
launch --server prod apps ls                                   # one command (or --profile prod)
LAUNCH_PROFILE=prod launch apps ls                             # a whole shell
launch login --admin                                           # admin key → "<server>-admin"
```

Precedence: `--profile` > `--server <name|url>` > `LAUNCH_URL` > `LAUNCH_PROFILE` > the default
server > `http://localhost:3001`. A URL uses the key stored for that URL, or none. CI:
`LAUNCH_API_KEY` + `LAUNCH_URL` (no browser). Also `LAUNCH_CONFIG_DIR`, `LAUNCH_DEBUG`,
`LAUNCH_BANNER=off|static`. Exit codes: `0` ok · `1` error · `2` not logged in · `3` forbidden.

## For agents

```bash
launch commands --json                     # every command, argument and option
launch api ls [word]                       # every API route and the command that covers it
launch api show POST /api/apps             # fields, an example body
launch api schema POST /api/apps           # the full JSON Schema
launch api call POST /api/apps --data @body.json   # validated locally, then sent
```

Pass `--json` to parse output; the header and progress lines are on stderr, and the header shows
only on a terminal. Destructive commands confirm; `-y, --yes` skips it.

More: `docs/CONCEPTS.md` §11 (what the CLI covers), `.claude/rules/cli.md` (adding a command), and
the `launch-cli` skill (`.claude/skills/launch-cli/`) for debugging from a terminal.
