# Sandbox session issues

## Status

The fixes for everything that stopped a real session on 2026-09-28 are **merged on
`phase-5-grants` at `e76c3b6`**, with the docs. **Not yet validated end to end**: no coding session
has completed a real Claude turn in either mode. The checklist below is what "validated" means.

| Mode | Set in `apps/web/.dev.vars` | Where the container runs | How it reaches GitHub and Anthropic |
|---|---|---|---|
| Local Docker | `SESSION_SANDBOX_HOST` unset | `wrangler dev`'s Docker (colima on this Mac), amd64 | Launch's outbound handlers (`egress/github.ts`, `egress/anthropic.ts`) inject the token and key |
| Remote (dev only) | `SESSION_SANDBOX_HOST=remote`, `SESSION_BACKEND=cloud` | The deployed Worker `launch-sandbox-dev` on real Cloudflare containers, through the remote service binding `SANDBOX_HOST` | `host` egress (`egress/host.ts`): Launch sends an egress grant; the host's own outbound handlers (`src/sandbox-host/egress.ts`) inject the token and key |

The container holds no credential in either mode: only the placeholder key, no git credential file
or helper.

## Root causes found

1. **Remote clone got no credential.** The old `direct` mode wrote the token to a file read by
   git's `store` helper. `store` **erases** a credential GitHub rejects, and GitHub rejects a freshly
   minted installation token for about a second (the git proxy had already seen a 404 one second
   after a mint). Overlapping checkout attempts in the same container made it worse: one attempt's
   rejection emptied the file under the next. Every later git call then had nothing:
   "could not read Username".
2. **Local Docker ran amd64 under QEMU, not Rosetta.** The Go GC crashes, the esbuild segfault and
   Claude Code's core dumps (11.5 GB in `/workspace/app`) are QEMU user-mode failures.
3. **`--permission-mode acceptEdits` denied Bash.** In `-p` mode it silently denies every shell
   command outside the `settings.local.json` allow-list, so a turn could not run commands.
4. **`HOME` was unset** in the SDK's shells, so the transcript path (derived from `HOME`) and git's
   global config were not where Launch expected them.

## What changed

1. **`host` egress replaces `direct`** (`a7ff9c1`). `HostEgress` sends a per-sandbox `EgressGrant`
   (repo, branch, upstream, the sealed installation token and its expiry; the key and the policy's
   model) over the binding; `HostedSessionSandbox` keeps it in its Durable Object storage (cleared
   on `destroy()` and `onStop`), and its own `outboundByHost` injects it through the proxies' pure
   cores (`forward-git.ts`, `forward-model.ts`): one repo, a push only to `session/<short>`, the
   model allow-list, a fresh token's 401/404 retried. Remote turns are still metered per turn
   (`turn-meter.ts`) and killed at the budget.
2. **Permissions** (`810356f`). Turns run `--permission-mode bypassPermissions` with `IS_SANDBOX=1`
   and `HOME=/root` (the checkpoint's git too); `settings.local.json` is deny-only.
3. **Checkout hardening** (both modes). `GIT_TERMINAL_PROMPT=0`, the whole checkout under `flock` on
   `/workspace/.launch/repo.lock` (120 s), and a failure reports git's last 15 stderr lines.
4. **Local Docker on Rosetta.** colima restarted with `--vm-type vz --vz-rosetta --cpu 6 --memory 12`
   (`docs/SESSIONS-LOCAL.md`).

## Found 2026-09-29 (remote)

1. **The database WebSocket never opened** from a real container: a passed-through 101 carried
   `Upgrade`/`Connection` twice, which Node's clients reject. Fixed in `8de9d75` (the neon handler
   re-wraps the 101 without the origin's copies).
2. **The remote binding drops a long blocking exec RPC** after ~7 min ("Peer closed WebSocket:
   1006"): the result is lost while the command keeps running in the container.
3. **The Sandbox SDK serialises every call behind a running `exec`**: during a 25 s exec,
   `readFile`, `startProcess` and another `exec` all waited. A step retry's short exec ("did not
   answer within 2 min") queued behind the orphaned first run. A BACKGROUND process blocks nothing
   (`startProcess` answers in 0.3 s; its log file reads live).
4. **So the install and the kit bootstrap now run in the background and are polled**
   (`services/sessions/background-command.ts`, branch `observable-bootstrap`): files
   `<name>.log|.pid|.exit` under `/workspace/.launch`, a step retry attaches to the live run, the
   deadline kills the process group, and the running boot step shows the kit's latest `✔ n/10`
   line — which is how the next remote run will show WHERE the bootstrap stalls. Still one
   blocking exec: the ship gate.

## Before retesting

1. **Add the Anthropic key in Settings → Platform** (`anthropic_api_key`). Neither Setup nor
   `.dev.vars` has one; every turn fails "Launch has no Anthropic key configured" without it.
2. **Redeploy `launch-sandbox-dev`, with the user's go-ahead** — the deployed version predates the
   grant handlers: `pnpm --filter @launch/web deploy:sandbox-host`, then
   `pnpm --filter @launch/web exec wrangler containers list` (the application `ready`, on the new
   version).
3. End session `bddea1c7…` if it is still `ready` (its local-Docker workspace is gone).
4. Done: local Docker is Rosetta, 6 CPU / 12 GB; the stale local `SessionSandbox` Durable Object
   state was moved to `/tmp`.

## Validation checklist

Run each item in BOTH modes: local Docker (`SESSION_SANDBOX_HOST` unset) and remote
(`SESSION_SANDBOX_HOST=remote`, `SESSION_BACKEND=cloud`). Events: on the dev database (container
`launch-dev-postgres-*`, user `launch`, database `launch_dev`),
`select seq, at, type, data from session_events where session_id = '<id>' order by seq`.

1. **Boot timings** from `session_events`: each `step` (branch, sandbox start, clone, bootstrap,
   dev server) to `ready`.
2. **A turn that runs shell commands** (e.g. "run `ls` and `pnpm -v`") completes, with `tool.start`
   / `tool.end` for Bash.
3. **`id; echo $HOME`** in a turn prints root and `/root`.
4. **Turn 2 resumes** the conversation (`--resume` works; the model remembers turn 1).
5. **Checkpoint** pushes `session/<short>`.
6. **Ship** opens a PR.

Remote only:

7. **No credential file** in the container (`ls -la /workspace/.launch`, no `git-credentials`;
   `git config --system --get-regexp credential` empty).
8. **`env | grep -i anthropic`** shows only the placeholder.
9. **A push to another branch is refused** with a 403 (e.g. `git push origin HEAD:refs/heads/x`
   from a turn, or by hand over `wrangler containers ssh`).

## Results

| Check | Local Docker | Remote |
|---|---|---|
| 1. Boot timings | | |
| 2. Turn with shell commands | | |
| 3. `id; echo $HOME` | | |
| 4. `--resume` on turn 2 | | |
| 5. Checkpoint push | | |
| 6. Ship → PR | | |
| 7. No credential file | — | |
| 8. Placeholder key only | — | |
| 9. Other-branch push refused | — | |

## Deployed resources (created 2026-09-28, with the user's go-ahead)

- **Worker:** `launch-sandbox-dev`, version `cf067059` — **predates the grant handlers; needs the
  redeploy above.** No routes, no public URL.
- **Container application:** `launch-sandbox-dev-hostedsessionsandbox` (id
  `a0318e29-600f-4151-a8dd-7490f86e0445`), `standard-3`, `max_instances = 3`.
- **Cost:** about $0.08 an hour per awake container.
- **Deploy command:** `pnpm --filter @launch/web deploy:sandbox-host`. **Check `wrangler containers
  list` afterwards.** The first deploy exited 0 after uploading only the Worker: the push of the
  730 MB layer (the pre-filled pnpm store) stalled, and wrangler didn't report it. The retry
  completed.
- **Removal:** `wrangler delete -c wrangler.sandbox-host.toml`, then
  `wrangler containers delete a0318e29-…`, then `wrangler containers images delete …`.

## Slow, not broken

**`Creating database branch` takes 13–16 s** (`neon-session-db.ts` `createBranch`). It waits for
**every** Neon operation in sequence, with a flat 1 s sleep before each poll
(`NeonClient.waitForOperations`, `NEON_LOCKED_DELAY_MS = 1000`). That includes `start_compute` (a
cold start the first connection would trigger anyway) and a per-session role password reset.
Proposed:
- wait only for `create_branch`;
- poll from 200–250 ms with backoff;
- **run the step in parallel with the sandbox start and clone.** The container only needs the
  database host added to its allow-list, which `setAllowedHosts` can do at runtime.

## Log noise

- `Uncaught Error: Containers have not been enabled for this Durable Object class` came from stale
  local `SessionSandbox` records (`apps/web/.wrangler/state/v3/do/launch-SessionSandbox/`) whose SDK
  timers fired under `--enable-containers=false`. **Cleared**: the state was moved to `/tmp`. If it
  comes back, the alternative is making `SessionSandboxBase` survive construction when containers
  are disabled.
- The `internal error; reference = …` bursts and "Network connection lost" are the remote binding's
  proxy; they appeared while the container application was provisioning or failing to start, and at
  `pnpm dev` reloads. Not yet investigated with a healthy container.
- A failed remote session destroys its container, so anything needed for diagnosis has to come back
  in the step's error. `wrangler containers ssh <instance>` works only while an instance is alive.
