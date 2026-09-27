# P0 spikes: summary

Run on 2026-09-27 against real accounts: Cloudflare (Workers Paid, zone `clewro.com`), GitHub (org
`guidemode`, **not Enterprise**), Neon (Launch plan), Resend and Anthropic. Everything a spike
created was named `rfspike-*`, recorded by id, and torn down; `node spikes/teardown.mjs --check`
sweeps all four services.

| # | Question | Verdict | What changed in the spec |
|---|---|---|---|
| [S0](s0-limits/RESULT.md) | How big can the fleet get? | yes-with-workaround | Hyperdrive (25/account) capped the fleet at ~12 apps → **apps don't use Hyperdrive** (S3). Next limits: Workers 500/account, Neon projects 100 (Launch) / 1,000 (Scale) |
| [S1](s1-worker-token/RESULT.md) | Can a per-Worker token be CI's deploy credential? | **no** | The format works (`com.cloudflare.edge.worker.script.<tag>`), but **a token for app A can bind app B's KV, R2, Queues and Worker, and Launch's Hyperdrive**. So **Launch deploys every app**, and a separate Launch account is strongly recommended |
| [S2](s2-flat-routes/RESULT.md) | Flat hosts on a dedicated apps domain | **yes** | Wildcard DNS + per-app routes + the free Universal SSL wildcard: every host is live ~100 ms after its route is created. `wrangler deploy` with no routes leaves Launch's routes alone |
| [S3](s3-neon-hyperdrive/RESULT.md) | Neon per app, and Hyperdrive | yes-with-workaround | A branch **inherits its parent's passwords** (reset them); Neon returns **423** while busy (retry); **pin `region_id`**; org keys can't mint project keys. Neon HTTP ≈ Hyperdrive for queries, and WebSocket is needed for transactions: **a kit DB-client change** |
| [S4](s4-resend-shared-domain/RESULT.md) | One Resend domain for every app | **yes** | One-off 87 s verification. Keys are domain-bound, but any app can send as another app's address, and **Resend can't tell you which key sent an email** |
| [S5](s5-deploy-via-launch/RESULT.md) | Deploying through Launch, on non-Enterprise GitHub | **yes** | 14 of 14 checks: GitHub OIDC, approval, check → undeployed version → short-lived `migrator` credentials → migrate → activate. Unapproved runs and foreign bindings stopped **before any migration**. **No GitHub Enterprise needed** |
| [S6](s6-oidc-issuer/RESULT.md) | OIDC issuer: OpenAuth or `jose` | **`jose`** | OpenAuth has no `id_token` or OIDC discovery. A ~200-line `jose` issuer passed `openid-client`, 15 of 15 checks, including SSO, the access policy, replay and PKCE |
| [S7](s7-sandbox/RESULT.md) | Session sandbox: cold start, preview, egress, model key, chat | yes-with-workaround | **24 s** to a live preview, gated by Launch, with a Neon branch per session (from a prepared `dev`). A **streamed, resumable Claude Code chat** works, with **no model key in the sandbox** (an outbound handler injects and meters it). The allowlist needs `interceptHttps = true` and can't carry Postgres TCP. Port 3000 is reserved, and deploys interrupt live sessions |

## What the kit (Rocketflare) needs, from the spikes

In full, with defaults that leave standalone apps unchanged:
[spec/13](../spec/13-rocketflare-changes.md).

1. A generic **OIDC login** (spec/02 gap 1; S6 shows a plain OIDC client works).
2. A **DB client that doesn't need Hyperdrive**: Neon HTTP for queries, WebSocket for
   `db.transaction` (gap 2, S3). Needed in sessions too, including migrate and seed, because
   Postgres TCP can't leave a locked sandbox (S7).
3. A **deploy mode that deploys through Launch**: OIDC, hand-off, per-deploy migration
   credentials (gap 3, S5).
4. **Configurable dev ports** (Vite is pinned to `:3000`, which a Sandbox reserves), and a way
   to run bootstrap without Docker (S7).
5. To confirm: `db-roles.ts`'s `ALTER ROLE … NOSUPERUSER NOBYPASSRLS …` fails on Neon's owner role
   (S7).

## Decisions taken during the spikes

- A dedicated apps domain, with flat first-level hosts (`<slug>.company-apps.com`) and routes on a
  wildcard record.
- One Resend sending domain for the whole fleet (`notifications.<apps domain>`).
- Apps use Neon's serverless driver, not Hyperdrive; Launch keeps Hyperdrive.
- Launch deploys every app. CI holds no Cloudflare token and no production database credential.
- Launch in its own Cloudflare account and on its own domain (strongly recommended).
- The OIDC issuer is built on `jose`.
- Sessions get a Neon branch from a prepared `dev` branch, not Postgres in the image.
- The model key never enters a session sandbox: Launch's outbound handler injects and meters it.
