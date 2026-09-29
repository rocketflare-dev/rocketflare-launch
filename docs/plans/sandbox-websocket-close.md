# A database WebSocket never finishes closing in a remote session container

Written 2026-09-29. Status: **root cause found; option B chosen for now, behind a switch**
(`SESSION_EGRESS=open`, see "Decision"). It is unproven on a real container until the rollout
check below passes. This doc covers what was found, the research, the options, the decision and
how to report it to Cloudflare. Background
and earlier findings are in `sandbox-session-issues.md` (the "Open" section).

## The short version

Our containers run with `enableInternet = false` plus an allow-list and `interceptHttps = true`. In
that mode every outbound connection, including a session's Neon database WebSocket, goes through
Cloudflare's egress interceptor.

**On real Cloudflare containers, the interceptor never closes the container's TCP/TLS connection
after a WebSocket closes.** The close handshake completes: the container sends a close frame and
gets the answer back. But the stream is never ended (no FIN, no `close_notify`). Node's built-in
WebSocket only reports `close` once the TCP connection ends, so the socket stays in CLOSING for
ever. **A Node process does not exit while a socket is open.**

So the kit's `migrate.ts`, `db-roles.ts` and `seed.ts` do all their work, end their pool, and then
never exit. They rely on Node exiting on its own, and nothing ever makes it. That is the remote
bootstrap "hang" at step 5.

`db:check` calls `process.exit(0)` and so always "worked". So did every earlier probe, which is why
none of them reproduced it. Local Docker (`wrangler dev`) is not affected. Launch's deployed
`SessionSandbox` uses the same real containers, so **production sessions have this too**.

## Evidence

All from session containers on `launch-sandbox-dev`, with the `/tmp/sbx-probe` harness (see
`sandbox-session-issues.md`, "The probe harness").

**Session `d0d0cbc5`, the passthrough handler.** The kit's `migrate.ts` was stuck with three
ESTABLISHED sockets to the intercept address `[fd00::119:1]:443`.
- `wrangler tail` showed all three `/v2` upgrades reach our handler and end
  (`responseStreamDisconnected`) within 3 s.
- Postgres had no backend left, and the branch already had all 18 migrations.
- In the same container:
  - A `Pool` query plus `pool.end()` finished in 190 ms. The process still hadn't exited 20 s later,
    when `timeout` killed it.
  - A bare `WebSocket.close(1000)` never fired `onclose` in 8 s (readyState stayed 2, CLOSING).

**Session `57d30e1a`, with our handler relaying through a `WebSocketPair`** (commit `edd0541`,
deployed as host version `fb05399a`). The relay answers every close, and invocations now end `ok`.
The migrator held one stuck socket instead of three, but it still never exited. At byte level
(`rawclose.js` below), after the container sent a close frame:

```
101 received 109ms "HTTP/1.1 101 Switching Protocols"
sent CLOSE frame 411ms
bytes from server 413ms 8802 (a CLOSE frame, no code)
bytes from server 413ms 03e8
bytes from server 413ms 8802 (a CLOSE frame, no code)
bytes from server 413ms 03e8
after 8s: socket still open; destroyed false 8044ms
```

- The close answer arrives: `88 02 03 e8`, code 1000.
- It arrives twice, once from our relay's `close()` and once from the runtime's auto-reply. The
  relay should stop echoing the close on the side that sent it; see "Loose ends".
- The TLS stream is never ended.

**The `ws` package is no way round it.** A preload replacing the global `WebSocket` with `ws`
(`terminate()` could force the socket shut) got the 101 and opened, then the relay saw the
container side close within 30 ms, before any Postgres answer ("WebSocket disconnected without
sending Close frame"). That happened with or without `permessage-deflate` and ALPN `http/1.1`. The
interceptor treats `ws` differently from Node's built-in WebSocket; not investigated further.

## Why we have the interceptor at all

1. **Credential injection.** `outboundByHost` for `api.anthropic.com` and `github.com` adds the
   model key and the installation token, so the container holds neither. This is Cloudflare's own
   pattern (`sandbox-sdk/examples/authentication`).
2. **The egress allow-list** (spec/03, "Egress is allowlisted"). `enableInternet = false` plus
   `allowedHosts` limits a prompt-injected agent to Anthropic, GitHub, npm and its own Neon
   endpoint.

The database gains nothing from (1): the container already holds its own branch's URI. It goes
through the interceptor only because of (2).

In `@cloudflare/containers` 0.3.7 (`applyOutboundInterception`), setting `allowedHosts` (or
`deniedHosts`, or any runtime override) turns on intercept-all: `interceptAllOutboundHttp`, plus
`interceptOutboundHttps('*')` with `interceptHttps`. With only static `outboundByHost`, it
intercepts just those hosts. Everything else is then blocked (`enableInternet = false`) or goes
direct (`enableInternet = true`). **There is no "block everything, let this one host through
un-intercepted" mode** on the stable packages (but see `interceptOutboundTcp` under "Research").

## Research (2026-09-29)

The question was whether we were holding it wrong. Cloudflare's source, docs and issues say no.

- **We are on the latest stable packages.** `@cloudflare/containers` 0.3.7 and
  `@cloudflare/sandbox` 0.12.10. `ContainerProxy.fetch` is a plain fetch handler with no WebSocket
  or upgrade logic of its own.
- **The production interceptor is closed source.** workerd's `container-client.c++` is the local
  `wrangler dev` path only. Its pumps call `shutdownWrite()` on EOF, which is why local runs work
  and deployed ones don't.
- **The docs never mention WebSocket egress**, and none of Cloudflare's examples makes an outbound
  WebSocket from a container.
- **Outbound handlers only see HTTP/HTTPS on ports 80 and 443**, so plain Postgres TCP (:5432)
  can't leave a locked container at all.
- **The real long-term answer exists but can't be used yet.** `ctx.container.interceptOutboundTcp`
  → `connect()` (Postgres TCP, or Hyperdrive) is in workerd behind the `experimental`
  compatibility flag, and its docs PR (cloudflare-docs#32441) isn't merged. So the claim above
  that there is no alternative holds only for stable, documented APIs.
- **No matching issue has been filed.** The same family: containers#220 (no `close_notify`),
  #195, and sandbox-sdk#844.
- **The duplicate close in our relay has a documented cause.** From compatibility date 2026-04-07
  (`web_socket_auto_reply_to_close`) the runtime answers a received Close frame itself before
  firing `close`. A proxy should `accept({ allowHalfOpen: true })` and close only the other side.
  The relay now does (see "Loose ends").
- **One cheap, untested way to keep the allow-list:** plain `ws://` through the HTTP (not HTTPS)
  interceptor to a made-up host (`neon.internal`), using the kit's existing `NEON_LOCAL_PROXY`
  support (`src/db/client.ts`). A handler then upgrades the connection to `wss://` on to Neon
  (`egress/forward-database.ts` is the core). This is the first probe of Part 2 below.

**What the SDK does, checked in source** (`@cloudflare/containers` 0.3.7,
`dist/lib/container.js`):
- The egress fields (`enableInternet`, `allowedHosts`, `interceptHttps`) are read inside the
  constructor's `blockConcurrencyWhile`, after its first `await`, and again at start. A subclass
  constructor can set them from `env` after `super()`. `Sandbox` 0.12.10 reads only
  `interceptHttps` in its constructor, also after an `await`, and does not override
  `setAllowedHosts`.
- Any allowed or denied hosts, a persisted `hasInterceptAllRegistration`, or a runtime override
  turns on intercept-all. Without those, only the static `outboundByHost` keys are intercepted.
- The configuration is persisted under the storage key `OUTBOUND_CONFIGURATION` and restored in
  the constructor, so a reused object keeps intercept-all. The per-app `prepare-<appId>` sandbox is
  the one that is reused. The runtime cannot remove an interception from a running container.

## Decision

Made by the owner, 2026-09-29:

1. **Now: take only the database out of interception (option B), behind a switch.**
   `SESSION_EGRESS = open | allowlist` (`apps/web/src/config.ts`; missing = `allowlist`, the
   fail-closed default for anyone else's deployment). The three tomls say `open`.
   - Under `open`, `SessionSandboxBase` sets `enableInternet = true` and no allow-list, makes
     `setAllowedHosts` a no-op (so no caller can turn intercept-all back on), and deletes the
     persisted `OUTBOUND_CONFIGURATION` before `super()`.
   - `interceptHttps` stays on, and the `api.anthropic.com` and `github.com` handlers stay, so the
     container still holds no model key or GitHub token. What is given up is the egress
     allow-list (spec/03).
   - `*.neon.tech` is no longer an `outboundByHost` key in either mode: a static key makes the SDK
     intercept that host even with internet on.
2. **Then:** the probes and the Cloudflare issue (Part 2 below). If the `neon.internal` probe
   works, `allowlist` can use it and the tomls go back.

**Rollout (user-run).**
- Deploy `launch-sandbox-dev`. The image doesn't change, but a `[vars]` change still redeploys.
- Wait for `wrangler containers list` to say `ready`.
- Start a fresh remote session (a container already running keeps its interception) and check it
  reaches `ready`.
- Inside it (SSH), `timeout 20 node exitprobe.mjs` should exit 0.

**Part 2, after the rollout is green** (on the dev host, with the `/tmp/sbx-probe` harness):
1. Plain `ws://` through the HTTP interceptor: a temporary `neon.internal` handler on
   `HostedSessionSandbox` that rewrites `/v2` to `wss://<endpoint>/v2` through `forwardDatabase`,
   with `neon.internal` on the allow-list, under `SESSION_EGRESS=allowlist`. Run `rawclose.js`
   with `net.connect(80, 'neon.internal')`, then `exitprobe.mjs` with
   `NEON_LOCAL_PROXY=http://neon.internal`. A FIN means `allowlist` can use it.
2. Why the interceptor refuses the `ws` client: hex-dump the bytes after the 101, log `ws`'s
   `error` / `close` / `unexpected-response` events.
3. The Neon-free minimal repro ("Before filing", below), then the issue, which the owner files.

## Where the bug bites (not just the bootstrap)

1. **The bootstrap:** `migrate`, `db-roles` and `seed` hang after doing their work.
2. **An agent's own scripts:** `pnpm db:migrate` or `pnpm seed` in a turn hang the same way, until
   the Bash tool's timeout. The agent sees a failure although the migration probably applied.
3. **The running app** (`pnpm dev`, the app's Worker under `wrangler dev` in the container). The
   kit's `db/client.ts` sends plain queries over neon-http (fine), but each `db.transaction` opens
   a WebSocket pool.
   - `pool.end()` does not block: it resolved in under 1 ms in the probe. So a request isn't held
     up.
   - But each transaction probably leaves a half-closed socket in workerd: a slow leak that could
     hit a connection limit over a long session. **Unmeasured.**
4. **Deployed Launch:** same containers, same bug.

## Options

| Option | Fixes | Cost |
|---|---|---|
| A. Cloudflare fixes the interceptor (end the stream after a WebSocket closes) | everything | their timeline; report below |
| B. Neon bypasses the interceptor: `enableInternet = true`, no allow-list, keep the two credential handlers | everything, incl. the app's transactions; plain Postgres TCP would work too | loses the egress allow-list: code, the branch URI and anything the agent reads could be sent anywhere. A spec/03 change, the owner's call. **Chosen for now, as `SESSION_EGRESS=open`** ("Decision") |
| H. Plain `ws://` to a made-up host (`neon.internal`) through the HTTP interceptor, upgraded to `wss://` by our handler (`NEON_LOCAL_PROXY`) | everything, if the HTTP interceptor ends the stream | untested (Part 2, probe 1); keeps the allow-list |
| I. `interceptOutboundTcp` → `connect()` (Postgres TCP or Hyperdrive) | everything, and plain TCP | behind workerd's `experimental` flag, undocumented; not usable yet |
| C. Kit scripts over HTTP only: `openScriptSql` on neon-http; `migrate.ts` applies each migration file as one `sql.transaction([...])` batch (drizzle's `neon-http` migrator runs statements one by one, with no transaction); `db-roles`' fixed statement list as a batch | 1 and 2 | a kit change and release; apps pick it up only when they update the kit |
| D. Kit scripts call `process.exit(0)` when done, as `db:check` already does | 1 and 2 | a kit change and release; smallest possible |
| E. Launch rewrites the bootstrap's `db:migrate` to a wrapper: import the kit's exported `runMigrations()`, await it, `process.exit(0)` | 1, migrate only | Launch-only, works for existing apps today; `seed` has no exported function (needs D); does nothing for 2 or 3 |
| F. App transactions as batches (`db.batch` / `sql.transaction([...])`): drop INTERACTIVE transactions, keep atomicity | 3 | kit-wide change plus a lasting rule for app authors and the agent ("no interactive `db.transaction` under neon"). The kit has 11 `db.transaction(` sites in `src`; most batch cleanly (`members.ts` is two deletes; `retrieval.ts` is `SET LOCAL` plus one query, fine in a batch). `tenant-scope.ts` (`TENANT_SCOPE_MODE=enforce`) wraps arbitrary route code and cannot be batched |
| G. A Node preload in the container that exits once every WebSocket is closing and only their sockets remain | 1 and 2 | guesses when a process is idle; does nothing for workerd (3). Not recommended |

**Recommended, in order** (B is now in place behind the switch, see "Decision"):
1. **Report the bug to Cloudflare** (A), since a fix there retires the rest. Ask for
   `interceptOutboundTcp` (I) to leave experimental too.
2. **Kit scripts over HTTP, or at least `process.exit(0)`** (C, or D), in `~/work/rocketflare` on a
   branch, then a kit release.
3. **Measure (3) before touching app code** (F). Get a session to `ready`: E applied temporarily,
   or a kit with C/D. Then:
   - drive app requests that run transactions;
   - count half-closed sockets in the container (`lsof -nP -i`, the SSH below);
   - watch for slowdowns or errors over an hour.

   If the leak is harmless for a session's lifetime, leave app transactions alone.
4. **B was decided** (the owner, 2026-09-29): on for the deployed tomls and the dev host, as a
   switch that goes back to `allowlist` when A, H or I lands.

## Filing it with Cloudflare

**Where.** Open an issue on `cloudflare/containers`
(<https://github.com/cloudflare/containers/issues/new>): the interception is `ContainerProxy` /
`interceptOutboundHttps`, which lives there, and the Sandbox SDK only sets it up. Cross-link these
related open issues:
- `cloudflare/sandbox-sdk#844`: allow-listed HTTPS stalls, handler never invoked.
- `cloudflare/containers#220`: the interceptor rewrites responses as close-delimited, with no TLS
  `close_notify`. This is the closest match, as the same "stream never properly ended" family.
- `cloudflare/containers#195`: interception is not transparent.

If it is closed as "wrong repo", `cloudflare/workerd` is the other candidate (`container-client`
does the TCP handling). Mention it on the Cloudflare Developers Discord `#containers` channel too.

**Before filing, make a Neon-free minimal repro** (not done yet):
- A Worker with a `Container` subclass (`enableInternet = false`, `interceptHttps = true`,
  `allowedHosts = ['<a public WebSocket echo host>']`, and `ContainerProxy` exported).
- Its image runs `rawclose.js` (below) against that host.
- Confirm it shows the same thing: close answered, stream never ended.
- Also confirm it passes under `wrangler dev`, and passes with `enableInternet = true` and no
  allow-list. That proves it is the interceptor.
- Keep the repro in a public gist or repo. It must hold no Launch code and no credentials.

**Draft issue** (fill in the versions and the repro link):

> **Title:** HTTPS egress interception never ends the container's TCP/TLS stream after a WebSocket
> closes (client stuck in CLOSING; Node processes can't exit)
>
> **Versions:** `@cloudflare/containers` 0.3.7, `@cloudflare/sandbox` 0.12.10, wrangler 4.x,
> compatibility_date 2026-06-01, `standard-3`, deployed (not reproducible under `wrangler dev`).
>
> **Setup:** `enableInternet = false`, `interceptHttps = true`, `allowedHosts` set, so the SDK
> registers `interceptAllOutboundHttp` + `interceptOutboundHttps('*')`. The allow-listed host is
> reached either with no handler (plain `fetch(request)` passthrough) or with an `outboundByHost`
> handler that relays the upgrade through a `WebSocketPair`. Both behave the same.
>
> **What happens:** a client in the container opens `wss://<host>/…` (101 fine, data flows both
> ways), then sends a close frame. The close answer comes back (`88 02 03 e8`), but the TLS stream
> is never ended: no `close_notify`, no FIN. The socket stays ESTABLISHED (`lsof`) indefinitely.
> Node's built-in WebSocket never fires `close` (readyState 2 for ever), and since the socket is
> open, **the Node process never exits**. `wrangler tail` shows the Worker side finished
> (`outcome: ok` with a relay, `responseStreamDisconnected` with the passthrough).
>
> **Expected:** once the WebSocket is closed on the Worker side, the interceptor ends the
> container-side stream, as it does under `wrangler dev`.
>
> **Repro:** <link>. `node rawclose.js <host>` prints the bytes; `after 8s: socket still open`
> is the bug.
>
> **Impact:** any script that opens a WebSocket (e.g. `@neondatabase/serverless`'s Pool) and
> relies on Node exiting naturally hangs for ever. A long-running process leaks one half-open
> socket per connection. Possibly related: #220 (no `close_notify` on close-delimited
> responses), sandbox-sdk#844.
>
> **Also seen (secondary):** the 101 through the interceptor carries a `cf-int-ctrl-1` header,
> and an upgrade from the `ws` npm client is closed by the interceptor straight after the 101,
> while Node's built-in WebSocket works.

**`rawclose.js`**: the byte-level repro. Node, no dependencies; run it inside the container.

```js
const tls = require('tls'), crypto = require('crypto')
const EP = process.argv[2]; const t0 = Date.now(); const t = () => `${Date.now() - t0}ms`
const s = tls.connect({ host: EP, port: 443, servername: EP, ALPNProtocols: ['http/1.1'] }, () => {
  s.write(['GET /v2 HTTP/1.1', `Host: ${EP}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='].join('\r\n') + '\r\n\r\n')
})
let upgraded = false
s.on('data', d => {
  if (!upgraded) { upgraded = true; console.log('101 received', t(), JSON.stringify(d.toString('latin1').split('\r\n')[0]))
    setTimeout(() => { const mask = crypto.randomBytes(4); const payload = Buffer.from([0x03, 0xe8]); const m = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
      s.write(Buffer.concat([Buffer.from([0x88, 0x80 | 2]), mask, m])); console.log('sent CLOSE frame', t()) }, 300); return }
  console.log('bytes from server', t(), d.toString('hex').slice(0, 40), d[0] === 0x88 ? '(a CLOSE frame, ' + (d.length >= 4 ? 'code ' + d.readUInt16BE(2) : 'no code') + ')' : '')
})
s.on('end', () => console.log('server ENDED the TLS stream (FIN / close_notify)', t()))
s.on('close', () => { console.log('socket CLOSED', t()); process.exit(0) })
s.on('error', e => console.log('error', e.code, t()))
setTimeout(() => { console.log('after 8s: socket still open; destroyed', s.destroyed, t()); process.exit(0) }, 8000)
```

(Replace the `/v2` path for a generic echo host. The request line is the only Neon-specific part.)

**`exitprobe.mjs`**: the user-visible symptom, a process that can't exit. Run it with
`timeout 20 node exitprobe.mjs`; exit code 124 is the bug.

```js
const { Pool } = require('@neondatabase/serverless') // or any WebSocket client
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
await pool.query('select 1'); console.log('queried')
await pool.end(); console.log('pool.end() resolved')
process.on('exit', () => console.log('process exiting naturally'))
```

## State left behind

- **Host.** `launch-sandbox-dev` is deployed at version `fb05399a` with the `WebSocketPair` relay
  (`egress/forward-database.ts`) and **SSH enabled** (`wrangler containers instances`, then
  `wrangler containers ssh <id>`; the `launch-dev` ed25519 key in `wrangler.sandbox-host.toml`).
  After a deploy, the container application is `provisioning` for a few minutes: a session started
  then fails with "the session container stopped … came back empty" (session `42b76ee6`). Wait
  for `wrangler containers list` to say `ready`.
- **Sessions.** `d0d0cbc5` and `57d30e1a` were ended; `42b76ee6` failed (the rollout). No live
  containers.
- **Already landed and still right, whatever option is chosen:**
  - Launch makes the kit's RLS role on `dev`.
  - The bootstrap preload skips `db:check` and runs the migrator without `db-roles`.
  - A session branched from a ready `dev` inherits its migrations hash.

  (`d2aaf15`: prepare 5 → 2 connections, a new session 5 → 0 or 1.)
- **The probe harness** is in `/tmp/sbx-probe`, not committed. `runfile.mjs`/`runpair.mjs` copy
  scripts into a live container and run them. `.dburi` is a 0600 file holding the ended session's
  URI; delete it.

## Loose ends

- **The relay answered a close twice** (fixed): our `close()` on the side that sent it, plus the
  runtime's auto-reply. `forwardDatabase` now accepts both sockets with `allowHalfOpen: true`, and
  `relaySockets` passes a close on to the OTHER side only; the far side's answer completes the
  first side's handshake.
- **Keep the relay?** No sandbox class maps a host to it now (`*.neon.tech` is gone from both
  `outboundByHost` maps). It is kept as the core of probe H (`neon.internal`).
- **Why `ws` is refused** by the interceptor straight after the 101 (above).
- **The `configure` RPC every ~2.5 s** in the host's tail is Launch's own polling. Each host call
  goes through `getSandbox()`, which sends the SDK's `configure(options)`: a no-op when nothing
  changed. Noise, not a cause.
