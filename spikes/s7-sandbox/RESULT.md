# S7: session sandbox (cold start, preview, egress, model key, chat)

Status: **done (2026-09-27)**. Verdict: **yes-with-workaround**.
- The spec/07 target of under 90 s to a live preview is beaten comfortably: **24 s** from nothing
  when the session branches from a prepared Neon branch.
- A chat with Claude Code works end to end, streamed, resumable, keyless and metered.
- It needs changes in the image, the kit and the spec (below).

Setup: `@cloudflare/sandbox` **0.12.10 (stable)** with the matching `cloudflare/sandbox:0.12.10`
image, `standard-3` instances, and kit **0.13.0**. The Worker stood in for Launch's SessionDO
([worker/src/index.js](worker/src/index.js)); the driver is [run.mjs](run.mjs).

## Design change from the spike: a Neon branch per session (the user's suggestion)

No Postgres in the image. Each session gets a Neon branch, copied from a `dev` branch; Launch would
keep `dev` migrated and seeded, never with production data. Branch creation took **0.8–1.5 s**. It
avoids the kit's Docker dependency, and migrations run against real Neon.

## Cold start: from nothing to a live, gated preview

| Step | Full (empty `dev`) | **Prepared `dev`** | Prepared, empty pnpm store |
|---|---|---|---|
| Neon session branch | 1.1 s | 0.9 s | 0.8 s |
| Container start (first exec) | 1.8 s | 2.2 s | 3.2 s |
| `git clone --depth 1` kit | 1.1 s | 1.6 s | 1.2 s |
| `pnpm install` | 4.7 s (warm store in image) | 5.0 s | **16.8 s** |
| `.dev.vars`, offline AI | 0.1 s | 0.1 s | 0.1 s |
| `pnpm db:migrate` | **36.6 s** | 9.4 s (nothing to apply) | 10.5 s |
| `pnpm seed` | 7.6 s | — (in the branch) | — |
| `wrangler dev` :3001 + Vite :5173 up | 3.6 s | 4.7 s | 5.2 s |
| **Total** | **56.9 s** | **24.1 s** | **38.0 s** |

Outputs: [full](output-full-session.txt) · [prepared](output-prepared-session.txt) ·
[prepared, empty store](output-prepared-empty-store.txt).

- The **first** container start after a deploy took **36 s**; after that, 1.6–4.3 s.
- Image build + push from an ARM Mac (amd64 emulation) took **310 s**; later deploys with a cached
  image took ~14 s.
- The pnpm store baked into the image saves ~12 s per session. Pin it to the kit tag.
- Migrations are slow from the container (~37 s for the kit's full set; ~10 s just to check an
  already-migrated branch), because of per-statement round trips to Neon. **A prepared `dev`
  branch is the biggest win.**

## Live preview, private to the company

The preview is served by Launch's Worker through `sandbox.containerFetch(request, 5173)` behind a
session check, not through a public tunnel:

- without a Launch session: **401**;
- with one: **200**, the app shell;
- `/api/health` goes through Vite's proxy to `wrangler dev` → `{"status":"ok"}` on the session's
  Neon branch.

The route is Launch's catch-all `*.<domain>/*` (wildcards are only allowed at the start of a route
hostname, so `rfspike-pv-*.<domain>` is refused).

`sandbox.tunnels.get(port)`, which replaces the deprecated `exposePort()`, gives **public**
URLs (`trycloudflare.com`, or named) with no way for Launch to require a session. Worker-fronted
`containerFetch` is the way to keep previews private.

Not tested: Vite HMR over a WebSocket through `containerFetch`.

## The chat: can the user talk to Claude Code in the container? Yes

This is the chat loop in [output-locked-session.txt](output-locked-session.txt). Each user message
is one Claude Code turn:

```
claude -p "<message>" [--resume <session_id>] --output-format stream-json --verbose --permission-mode acceptEdits
```

It runs through `sandbox.exec(…, { stream: true, onOutput })`, and the Worker relays each line
as it arrives. That is what the SessionDO does for the browser over its WebSocket.

- **Turn 1** ("create notes.txt with the word alpha"): events streamed as they happened (`init`
  1.1 s → assistant → tool use → `result` 6.5 s), and `notes.txt` = `alpha` in the sandbox.
- **Turn 2** (`--resume`, "which word did you write?"): answered **`alpha`**. The session carries
  its context across turns.

For the UI, the stream-json events map onto the AG-UI types spec/07 names (text, tool call start
and end, run finished).

Still to design: permission prompts that come up in the UI rather than `acceptEdits`, via the
Agent SDK's permission callback or `--permission-prompt-tool`, and cancelling a turn.

## The model key never enters the sandbox, and every call is metered

The locked class has an `outboundByHost['api.anthropic.com']` handler that runs **in the Worker**.
It strips the sandbox's key, sets the real one, and meters usage from the response stream as it
passes through:

```
meter: {"requests":5,"input":6,"output":115,"cacheRead":40131,"cacheWrite":4865,"status":200,"keySentBySandbox":"sk-ant-api03-PLACE"}
```

The sandbox only ever held a placeholder, and no real key was in its environment. This is stronger
than spec/03's "proxied where possible, per-session key otherwise": **no model key is ever needed
in the sandbox.**

## Egress lockdown

| From a locked session (`enableInternet = false`) | Result |
|---|---|
| HTTPS to a host not on the allowlist | blocked (proxy answers 520) ✅ |
| HTTPS to an allowlisted host (`registry.npmjs.org`) | 200 ✅, **only with `interceptHttps = true`** |
| HTTP to an allowlisted host | 301 ✅ |
| `api.anthropic.com` with an outbound handler but **not on the allowlist** | 520: **the handler never runs**. The host must be allowlisted too |
| Neon over HTTPS (`/sql`, the serverless driver's protocol) | 200 ✅ |
| **Postgres TCP to Neon**, even with the host and `host:5432` allowed at runtime | **blocked**. The allowlist covers HTTP(S) only |

## Findings for the design

1. **`interceptHttps` defaults to `false` on the stable packages** (`@cloudflare/containers` 0.3.7,
   `@cloudflare/sandbox` 0.12.10), although the docs say it's on. Without it, no HTTPS leaves a
   locked sandbox. Set it explicitly.
2. **A locked session can't use Postgres over TCP.** The kit's DB client and its migrations
   (postgres.js) must use Neon's HTTP/WebSocket driver inside sessions too. That makes kit gap 2
   (spec/02) a hard requirement for sessions, and it must cover `migrate.ts` and `seed.ts`, not
   only the Worker. Not tested: whether WebSocket (`wss://`) passes the allowlist; it should, as
   it starts as HTTPS.
3. **Port 3000 inside a sandbox belongs to the SDK's control server.** The kit pins Vite to
   `:3000` (`strictPort`) and its dev supervisor to `[3000, 3001]`. Sessions ran Vite on `:5173`
   directly. The kit needs configurable dev ports (`devBootstrap` in spec/02).
4. **The kit's `bootstrap` needs Docker** for its database, and it refuses to seed a non-local
   database (`SEED_ALLOW_REMOTE=1`). Sessions skip `bootstrap` and run its steps (install,
   `.dev.vars`, offline AI, migrate, seed, dev).
5. **Likely kit bug on Neon:** `db-roles.ts` runs `ALTER ROLE … NOSUPERUSER NOBYPASSRLS …
   NOREPLICATION`, which Neon's owner role may not run ("permission denied to alter role"). The
   same statement is in `db:migrate:ci`, so it probably breaks deploys to Neon too. To confirm with
   the kit.
6. **The base image ships Node 22** first on `PATH`; the kit needs 24. Symlink Node 24 in the image.
7. **`exec` runs in a persistent session shell.** A bare `exit` in a command ends the session's
   shell; wrap scripts in `bash -c`.
8. **Deploys interrupt live sessions.** A config change rolls out by replacing instances: the app
   sat in "updating" until live sandboxes were gone, and one exec was cut off with "interrupted
   while the platform was updating the sandbox runtime". Launch has to drain or checkpoint
   sessions before changing the session image or config.
9. **Destroy sandboxes on failure, not only at the end.** Leftover instances hit
   `max_instances` ("Maximum number of running container instances exceeded"). `max_instances`
   is also the cap on concurrent sessions per class.
10. **Teardown:** deleting the Worker leaves the **container applications and registry images**
    behind (`wrangler containers delete`, `wrangler containers images delete`).
11. **SSH for debugging works:** an `ssh-ed25519` key in `containers.authorized_keys`, user
    **`cloudchamber`** (from wrangler's source; the docs don't say), and
    `ProxyCommand="wrangler containers ssh <instance> --stdio"`. Useful for Launch operators, but
    keep it off for tenant sessions by default.

## Open

- **SDK line** (spec/12 row 13): stable 0.12.10 worked. `1.0.0-rc.0` is out, and the docs'
  defaults (`interceptHttps` on, tunnels) already describe it. Re-check at P3.
- Neon branches per project are capped (10 on Launch, 25 on Scale), which caps concurrent sessions
  per app. Delete branches when sessions end.
