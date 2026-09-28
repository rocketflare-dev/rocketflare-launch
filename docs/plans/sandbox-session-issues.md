# Sandbox session issues

Status at the end of 2026-09-28: a coding session has **not yet completed a real Claude turn**.
This records what works, what was tried and where it fails, so the work can resume from here.
Branch `phase-5-grants` at `26e8848`.

## The two ways a session's container can run

| Mode | Set in `apps/web/.dev.vars` | Where the container runs | How it reaches GitHub and Anthropic |
|---|---|---|---|
| Local Docker | `SESSION_SANDBOX_HOST` unset | `wrangler dev`'s Docker (colima on this Mac), amd64 under QEMU emulation | Launch's outbound proxies (`egress/github.ts`, `egress/anthropic.ts`) inject the token and key; the container holds neither |
| Remote (dev only) | `SESSION_SANDBOX_HOST=remote`, `SESSION_BACKEND=cloud` | The deployed Worker `launch-sandbox-dev` on real Cloudflare containers, reached through a remote service binding (`SANDBOX_HOST`) | `direct` egress (`egress/direct.ts`): the key goes into the `claude -p` process env, and a repo-scoped GitHub token goes into a credential file read by a git helper |

`.dev.vars` is currently set to **remote**.

## Deployed resources (created 2026-09-28, with the user's go-ahead)

- **Worker:** `launch-sandbox-dev`, version `cf067059`. No routes, no public URL.
- **Container application:** `launch-sandbox-dev-hostedsessionsandbox` (id `a0318e29-600f-4151-a8dd-7490f86e0445`), `standard-3`, `max_instances = 3`.
- **Cost:** about $0.08 an hour per awake container.
- **Deploy command:** `pnpm --filter @launch/web deploy:sandbox-host`. **Check `wrangler containers list` afterwards.** The first deploy exited 0 after uploading only the Worker: the push of the 730 MB layer (the pre-filled pnpm store) stalled, and wrangler didn't report it. The retry completed.
- **Removal:** `wrangler delete -c wrangler.sandbox-host.toml`, then `wrangler containers delete a0318e29-…`, then `wrangler containers images delete …`.

## What works

- **Local preview routing.** `*.clewro.com` is a CNAME to the cfld tunnel, which routes to `localhost:3001`, where the preview gateway runs. The routes are in `apps/web/package.json`, and cfld needs its local wildcard-quoting patch in `~/work/cfld`. HMR goes through `wsConnect`.
- **Remote mode boots fast.** "Starting sandbox" takes **3–12 s**, against minutes under emulation.
- **The remote binding works.** RPC calls, `writeFile` and `exec` all reach the container.
- **The Neon session branch is created** in both modes. It takes about 13–16 s; see *Slow* below.
- **Fixed today:**
  - `AbortSignal` over the SDK's RPC stub (`DataCloneError`, which failed every turn);
  - HMR over `wsConnect`;
  - an unread turn's process is now killed;
  - no core dumps (`ulimit -c 0`), and the save skips files over 50 MB;
  - a stale `index.lock` is cleared;
  - retries after a fresh token's 401/404 in the git proxy;
  - preview traffic counts as activity;
  - warm suspend, workspace backup and a lighter cold resume.

## Where it fails now

### 1. Remote mode: the clone gets no GitHub credential (blocking)

`Cloning repo` → `Could not check out guidemode/hola-world: fatal: could not read Username for
'https://github.com': No such device or address`. It fails on every attempt, in sessions `2010563f`, `be412bfe`, `8a688779` and `596d40c9`.

**What happens, in order** (`steps.ts` `checkOut` → `DirectEgress.prepareGit` in `egress/direct.ts`):

1. Launch mints (or reuses) the session's installation token (`sessionGitToken`: `contents: write`, one repo, one hour).
2. It writes `https://x-access-token:<token>@github.com` to `/workspace/.launch/git-credentials` (git's `store` format).
3. It runs the setup script: `chmod 600`, then `git config --system credential.https://github.com.helper 'store --file=…'`. The script checks that `git config --get-urlmatch` sees the helper and that the file is non-empty, and fails loudly otherwise.
4. It runs the probe script: `git credential fill` must return a username, and `git ls-remote <repo> HEAD` must succeed. On failure the probe prints the curl trace, redacted.
5. It runs the checkout script (`checkoutScript`): `rm -rf /workspace/app`, `git init`, `git remote add`, `git fetch --depth 50 origin <baseRef>`, then the session branch.

**Evidence:**
- The session at 19:09:23 ran the bundle that contains steps 3 and 4 (bundled 19:08:53; both strings are in `.wrangler/tmp/dev-*/worker.js`).
- It failed at step 5 with the same error. A failure at step 3 or 4 would have replaced the error message.
- **So in the same container, the credential setup and `git ls-remote` with the credential succeed, and seconds later `git fetch` gets no credential at all.**
- The session's sandbox id is `remote:…`, and the bundled `defaultSessionPorts` picks `DirectEgress` for remote, so the credential step really runs.
- The token is not left sealed on the row afterwards. That's expected: a failed session forgets its credentials.

**Tried, and ruled out:**
- **`git config --global`** (the first version). `$HOME/.gitconfig` depends on the SDK shell's `HOME`, which it inherits from the control server (`process.env.HOME || "/root"`). It was moved to `--system`. In the local session image the helper then works with `HOME` unset, missing or `/root`. The clone still fails remotely.
- **A skipped credential step.** The code path was verified in the running bundle.

**Leading hypothesis, not confirmed:** git's `store` helper **erases** a stored credential when GitHub rejects it (a 401 while the credential is in use). A freshly minted installation token can be rejected for about a second; the git proxy saw the same thing, a 404 one second after a mint. If the probe's `ls-remote`, or the first `fetch`, gets that early 401, `store` deletes the line from the file, and every later git in the container finds nothing: "could not read Username". Nothing records this yet: the checkout reports only the last stderr line.

**Next steps, in order:**
1. **Evidence.** In `direct` mode, run the checkout with `GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1`. On failure, report the filtered, redacted trace, as `gitProbeScript` does, plus the credential file's size after the failure. A size of 0 bytes confirms the erase hypothesis.
2. **Fix, whatever the trace shows.** Replace `store` with a **read-only helper** that answers `get` from a Launch-owned file in key=value format (`username=x-access-token`, `password=<token>`) and ignores `store` and `erase`, for example `!f() { if [ "$1" = get ]; then cat /workspace/.launch/git-credentials; fi; }; f`. `--unset-all` the old helper first. Update `gitCredentialLine`, `tests/api/session-direct-egress.test.ts` (it expects the `store` format) and `tests/config/sandbox-host.test.ts`.
3. **Retry a fresh token's first 401/404** in the probe and the checkout, with a short backoff, as `egress/github.ts` does. Alternatively, wait about a second after a mint before the first git call.
4. Show more than the last stderr line in `checkOut`'s error.

### 2. No Anthropic key is configured (blocking a real turn in either mode)

`turn.failed`: "Launch has no Anthropic key configured". Setup has no `anthropic_api_key` credential (only Cloudflare, Neon, Resend and the GitHub App), and `.dev.vars` has no `ANTHROPIC_API_KEY`. **Add it in Settings → Platform** before retesting. No real Claude turn has run yet in either mode.

### 3. Log noise from the local Durable Object (harmless, needs a clean-up)

`Uncaught Error: Containers have not been enabled for this Durable Object class`. Remote mode runs `wrangler dev --enable-containers=false`, but wrangler's local state still holds records of earlier local-Docker sandboxes (`apps/web/.wrangler/state/v3/do/launch-SessionSandbox/*.sqlite`, five of them). Their SDK timers fire and rebuild the class, which throws.
- **Session `bddea1c7…`** is still `ready` on a local-Docker container. In remote mode its calls go to the remote host, where that workspace doesn't exist ("Failed to change directory to '/workspace/app'"). **End it.**
- **Options:** delete those local records while `pnpm dev` is stopped, or make `SessionSandboxBase` survive construction when containers are disabled.

The `internal error; reference = …` bursts and "Network connection lost" around them are the remote binding's proxy. They appeared while the container application was still provisioning or failing to start, and at `pnpm dev` reloads. **Not yet investigated** once the container was healthy.

### 4. Local Docker mode (works, but slow and fragile)

- **Emulation.** The amd64 image runs under QEMU on this arm64 Mac:
  - a cold boot took about 3 minutes (install and seed 2 min 11 s);
  - a Claude process crashed under QEMU and left 11.5 GB of core dumps in `/workspace/app`, which made `git add -A` time out;
  - esbuild's postinstall segfaults, so the image fetches with `--config.ignore-scripts=true`.
- **A resume after an idle destroy** hung on "Starting sandbox" until its 4-minute deadline, twice. It was hardened in `CloudflareSandbox.start` but never confirmed fixed, and warm suspend avoids the path for short idles.
- **Memory.** Docker (colima) needs 12 GB or more.

## Slow, not broken

**`Creating database branch` takes 13–16 s** (`neon-session-db.ts` `createBranch`). It waits for **every** Neon operation in sequence, with a flat 1 s sleep before each poll (`NeonClient.waitForOperations`, `NEON_LOCKED_DELAY_MS = 1000`). That includes `start_compute` (a cold start the first connection would trigger anyway) and a per-session role password reset. Proposed:
- wait only for `create_branch`;
- poll from 200–250 ms with backoff;
- **run the step in parallel with the sandbox start and clone.** The container only needs the database host added to its allow-list, which `setAllowedHosts` can do at runtime.

## How to retest

1. Add the Anthropic key in Settings → Platform, and End `bddea1c7…`.
2. `wrangler containers list` should show `launch-sandbox-dev-hostedsessionsandbox` as `ready`.
3. `pnpm dev`, with `.dev.vars` in remote mode, then start a session on hola-world.
4. Read the session's events. On the dev database (container `launch-dev-postgres-*`, user `launch`, database `launch_dev`):
   `select seq, at, type, data from session_events where session_id = '<id>' order by seq`.
5. A failed remote session destroys its container. Anything needed for diagnosis has to come back in the step's error. `wrangler containers ssh <instance>` exists, but only while an instance is alive.
