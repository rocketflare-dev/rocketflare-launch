# `launch` command map

The authoritative list is generated: `launch commands` (or `--json`), and `launch <group> --help`.
This map groups the commands by the question they answer, so you know where to look. Every read
takes `--json`; ids accept an 8-character prefix where noted in `--help`.

## Where am I

| Group | Commands |
|---|---|
| `servers` | `ls` · `use <name>` · `add <name> <url>` · `rm` · `rename` — named servers (profiles) |
| top level | `login [--server] [--name] [--admin]` · `logout [--all]` · `whoami` · `status [--all] [--ready]` · `config get\|set\|path` |
| discovery | `commands [--json]` · `api ls [word]` · `api show <METHOD> <path>` · `api schema <METHOD> <path>` · `api call <METHOD> <path> [--no-validate]` |

## What is it doing / why did it fail (debugging)

| Thing | Read | Act |
|---|---|---|
| coding session | `sessions show <id>` · `sessions logs <id> [--follow --type --since --limit]` · `sessions ls <app> [--all]` · `sessions attachments <id>` · `sessions attachment <id> <aid> --out` | `sessions start\|say [--follow --attach]\|ship\|end\|resume\|cancel\|withdraw\|landing-retry\|budget\|attach\|preview-url` |
| app | `apps ls` · `apps show <app>` · `apps pipeline <app> [--kind]` · `apps operations <app>` · `apps health <app> [--hours]` · `apps upgrades <app>` | `apps create [--follow]\|import\|set\|teardown\|rescaffold\|health-check\|config-scan\|upgrade\|ship-settings\|branch-protection` · `apps pipeline retry\|cancel` · `apps sign-in …` · `apps thumbnail get\|refresh` |
| deploys | `deploys ls <app>` · `deploys latest <app>` | `deploys production <app>` · `deploys approve\|reject <app> <ticket>` |
| releases | `releases ls\|show\|chain <app> [<ver>]` · `releases promotion <app>` | `releases create\|promote [--wait]\|retry\|rollback\|cancel` |
| approvals | `approvals ls [--box --status --kind --app]` · `approvals show <id>` · `approvals count` | `approvals approve\|reject\|withdraw <id>` |
| agent runs | `agents ls` · `agents runs [--agent --status]` · `agents run <id>` · `agents logs <id> [--follow]` · `agents interrupts` | `agents start\|cancel\|answer\|steer` |
| AI traces | `traces list [--agent --status --run --conversation --since]` · `traces show <id> [--full]` | — (see the `launch-traces` skill) |
| chat | `chat ls` · `chat show <id>` · `chat stats <id>` | `chat new\|send\|rm\|compact` |
| knowledge | `docs ls\|show\|content\|passages <id>` · `docs search "<q>"` | `docs add\|upload\|visibility\|rm` |
| AI config | `ai status` · `ai usage [--days]` · `ai providers` · `ai prompts ls\|show` · `ai models ls` | `ai set\|rm\|test` · `ai prompts set\|reset` · `ai models set\|reset` |
| secrets | `shared ls\|show <slug>` · `shared pushes <slug> [--wait]` · `grants needs\|ls <app>` | `shared set\|rotate\|retry\|create\|edit\|archive` · `grants request\|revoke\|repush` |
| history | `audit ls [--app --action --actor --from --to]` · `audit verify` · `activity ls` · `notifications ls [--unread]\|count` | `audit export --out` · `notifications read` |
| analytics plugin | `analytics pages list\|show` · `analytics templates list` · `analytics check-facts` | `analytics pages create\|update\|visibility\|reset\|rm` · `analytics templates recreate` · `analytics refresh-facts` |

## The organisation

| Group | Commands |
|---|---|
| `members` | `ls` · `set-role <user> <role>` · `rm <user>` · `groups <user> [groups…]` |
| `invites` | `ls` · `pending` · `send <emails…> [--role]` · `resend` · `revoke` |
| `groups` | `list` · `members <id>` · `mine` · `create` · `set` · `rm` · `add` · `remove` · `types ls\|create\|set\|rm` |
| `keys` | `ls` · `create <name>` (prints the key ONCE) · `revoke` |
| `tenant` / `me` | `tenant show\|set\|ls\|settings` · `me show\|set\|prefs` |
| `policies` | `ls` · `set <kind>` · `rm <id>` — approval policies |
| `access` | `check\|request <clientId>` · `policy\|grants\|grant\|ungrant\|requests <app>` — app sign-in access |
| `features` | `list` — flags in effect here (administering flags: `admin flags`) |
| `feedback` / `evals` | `feedback list\|give\|rm\|mine` · `evals promote <id> --dataset <name>` |
| `files` | `put <path>` · `get <id> --out` · `rm <id>` |
| `agent-accounts` | `ls` · `login <runtime>` · `cancel` · `rm` — your Claude/Codex subscription for sessions |

## The deployment (admin key: `launch login --admin`)

| Group | Commands |
|---|---|
| `admin` | `sessions [--scope]` · `drain` · `undrain` · `tenants list\|show\|suspend\|reinstate` · `users list\|show\|block\|unblock\|grant-admin\|revoke-admin` · `flags list\|set\|overrides\|override\|clear` |
| `platform` | `setup` · `settings [set]` · `credentials set\|check\|remove <kind>` · `public-url check` · `kit tags\|pin\|check\|reset` · `agents set` · `sandbox set` · `oidc keys\|rotate` · `access-requests list\|approve\|reject` |

## Input conventions

- Rich bodies: `--data '<json>'`, `--data @file.json` or `--data -` (stdin). The body is checked
  against the route's own zod schema before it is sent; a bad one exits 1 listing every issue.
  `launch api show <METHOD> <path>` shows the fields and an example.
- Secret values are never arguments: a hidden prompt on a terminal, otherwise stdin.
- Destructive commands confirm; `-y` / `--yes` skips the question (only with the user's say-so).
- The header line naming the server is on stderr and only on a TTY: it never pollutes parsed output.
