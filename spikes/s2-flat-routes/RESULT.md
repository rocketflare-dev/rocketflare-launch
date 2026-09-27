# S2: flat hosts on the dedicated apps domain

Status: **done (2026-09-27)**. Verdict: **yes**. The spec/04 scheme works as designed on `clewro.com`
(a Free-plan zone).

## Setup (`node s2-flat-routes/run.mjs`)

- One proxied wildcard record: `AAAA * → 100::`. The routes answer; there is no origin.
- Worker routes, with Launch's catch-all created **first** to show that creation order doesn't
  matter:
  - `*.clewro.com/*` → `rfspike-launch`
  - `rfspike-a.clewro.com/*` → `rfspike-a`
  - `rfspike-a-staging.clewro.com/*` → `rfspike-a-staging`
  - `rfspike-b.clewro.com/*` → `rfspike-b`

## Results

| Host | Served by | TLS |
|---|---|---|
| `rfspike-a.clewro.com` | `rfspike-a` ✅ | valid |
| `rfspike-a-staging.clewro.com` | `rfspike-a-staging` ✅ | valid |
| `rfspike-b.clewro.com` | `rfspike-b` ✅ | valid |
| `nope-unknown.clewro.com` | `rfspike-launch` ✅ (catch-all) | valid |
| `3000-abc123def-tok16chars00000.clewro.com` (preview-shaped) | `rfspike-launch` ✅ (catch-all) | valid |

- Every certificate is the zone's **Universal SSL** pack (Google Trust Services, SAN
  `clewro.com, *.clewro.com`). No per-host issuance and no wait: each host answered within
  ~100 ms of its route being created. **A new app is reachable as soon as its route exists.**
- The specific route beats the catch-all, whatever order they were created in.
- `rfspike-a` first failed with `ENOTFOUND`. That was my machine's resolver caching NXDOMAIN from a
  lookup made in the same second the wildcard was created; `dig @1.1.1.1` and a pinned `curl`
  served it correctly. In production the wildcard is created once, at setup, so app creates never
  race it.

## `wrangler deploy` with no routes leaves Launch's route alone

`rfspike-b` redeployed with `wrangler@4.141.0` from a toml with `workers_dev = false` and **no
`routes`**:

- wrangler printed `No targets deployed for rfspike-b` and uploaded the new version;
- the route `rfspike-b.clewro.com/*` still existed afterwards, and the host served the new version
  (`__Host-session=rfspike-b-v2`).

So an app's repo can own its code and bindings while Launch owns its routes (spec/04). This was run
with the admin token; S1 repeats it with the per-Worker token, which must also be *unable* to
change routes.

## Not tested here

- Cookie isolation between hosts. It is defined by browsers (host-only and `__Host-` cookies,
  RFC 6265bis), not by Cloudflare, so there is nothing account-specific to test.
- The Sandbox preview itself. The preview-shaped host reaching Launch's catch-all with valid TLS
  is the part S2 can show; S7 covers the rest.
