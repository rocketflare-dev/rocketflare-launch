# S3: Neon + Hyperdrive (pipeline steps 4–5, 10–11)

Status: **done (2026-09-27)**. Verdict: **yes-with-workaround**. Everything works over the APIs, and
four details change the pipeline.

**Decision taken from this spike (2026-09-27): apps don't use Hyperdrive.** They reach Neon with
Neon's serverless driver. Launch itself keeps Hyperdrive. That removes the only binding
fleet-size cap (S0).

## What ran (`node s3-neon-hyperdrive/run.mjs`)

Neon org key → project `rfspike-db` (PG17) → role `app` + database `app` (owned by `app`) on
`main` → `staging` branch → connection URIs → migrate as `app` → Hyperdrive config on the direct
URI → `wrangler deploy` with a `HYPERDRIVE` binding → Worker secret set over the API → route on the
wildcard → queries from inside the Worker.

| Step | Time |
|---|---|
| Neon: create project | 0.6 s |
| Neon: role + database on main | 3.3 s |
| Neon: staging branch | 1.6 s |
| Migrate as `app` (create table, `create extension vector`, insert) | 1.5 s |
| Hyperdrive: create config (it test-connects the origin) | 2.4 s |
| `wrangler deploy` | 7.8 s |
| Worker secret via API | 0.8 s |
| Host answering after its route was created | ~19 s |

Steps 4–5 take **about 10 seconds** of API time per app.

## Findings

1. **A branch copies its parent's roles *with the same passwords*.** `staging`'s `app` role
   accepted `main`'s password until it was reset (`POST …/roles/app/reset_password`). After the
   reset, `main`'s password was refused on staging. **Pipeline step 4 must reset every role on
   the new branch**; otherwise the staging `DATABASE_URL` (in a less-guarded GitHub Environment)
   opens production.
2. **Neon returns `423 Locked` while a project operation runs.** Every step must retry on 423.
   Workflow step retries cover this, but the adapter should treat 423 as "retry" and not as
   "failed".
3. **The Neon org key can't mint project-scoped API keys**: "This endpoint requires a personal
   API key. Organization API keys are not supported." The spec's default of a connection string
   only, with no Neon key for apps, stands. Launch shouldn't hold a personal key.
4. **The default region is not stable.** Four runs landed in `aws-us-east-2`, `aws-us-west-2`,
   `aws-us-east-2` and `aws-us-east-1`. **Launch must pass `region_id` explicitly**, set once in
   the setup wizard.

Confirmed as the spec expected:
- A dedicated role that **owns its database** can run migrations, including
  `create extension vector`, with no superuser.
- `GET /projects/{id}/connection_uri?pooled=false` is the endpoint for the direct URI (resolving
  the **[uncertain]** in sources.md).
- Hyperdrive accepts the direct URI.
- The Worker secrets API works on a Worker deployed by wrangler (step 11).

## Latency: Hyperdrive compared with Neon's serverless driver

The final run: `select 1` from inside the Worker, 5 requests, times in ms. "First" includes
connection setup. The "tx" column is the kit's tenant-scope pattern: `begin; select
set_config('app.tenant_id', …, true); select current_setting(…); commit`.

| Path | First | Second | tx | Interactive transactions |
|---|---|---|---|---|
| postgres.js via **Hyperdrive** | 90–200 (857 cold) | ~95 | — | yes |
| postgres.js **direct TCP** to Neon's pooler | ~800 | ~100 | — | yes |
| **Neon HTTP** (`neon()`) | ~105 | ~105 | 105, as a non-interactive batch | **no** |
| **Neon WebSocket** (`Pool`) | ~410 | ~97 | ~390 | yes |

What this means:

- **HTTP matches Hyperdrive for plain queries** (~105 ms against ~95 ms on this route), with no
  Hyperdrive config.
- **HTTP can't run interactive transactions.** `sql.transaction([...])` is a one-shot batch.
  It can carry the `set_config` + query pair, but not logic between statements. With drizzle,
  `db.transaction(async (tx) => …)` throws on `neon-http`.
- **WebSocket supports them**, and costs ~300 ms more than HTTP to open a connection.
- Direct TCP is the worst of the four, which is why the kit uses Hyperdrive today.

## What that means for the kit (template contract, spec/02)

Rocketflare's DB client (`apps/web/src/db/client.ts`) is postgres.js only. Its header says it
dropped "the Neon HTTP branch" of its reference app. It resolves
`PREVIEW_DATABASE_URL ?? HYPERDRIVE ?? DATABASE_URL`, so a Worker with no Hyperdrive binding already
*runs*, over direct TCP at ~800 ms per request. **That works, but it is too slow to be the answer.**

The kit calls `db.transaction(...)` in 10 places: `members`, `invitations`, `groups`, `access`,
`ai-config`, `ai/ingest`, `ai/retrieval` (`SET LOCAL hnsw.iterative_scan`), `tenant-helpers`,
`plugins/api/db`, and `db/tenant-scope.ts` (`TENANT_SCOPE_MODE=enforce`; the default is `off`).
So "HTTP only" would break those paths. The change to propose upstream:

- **Queries go over Neon HTTP; `db.transaction` goes over a Neon WebSocket connection opened only
  for it.** Both are drizzle `PgDatabase`s, so `createDatabase` can return the HTTP one with
  `transaction` delegated to the WebSocket one. Only requests that open a transaction (mostly
  admin writes and AI ingest) pay the ~300 ms setup.
- Apps with `TENANT_SCOPE_MODE=enforce` pay it on every tenant-scoped request. They could use
  the HTTP batch form for the `set_config` + query pair where the work is a single statement.
- The binding goes from `HYPERDRIVE` to a `DATABASE_URL` Worker secret (the pooled URI).
  Migrations in CI keep using the direct URI.
- It is a contained change to `db/client.ts` and `middleware/database.ts`, plus the places that
  pass `HYPERDRIVE` into the resolver (queues, scheduled, workflows, span-store). It is also worth
  having upstream for its own sake: a Rocketflare app that doesn't want Hyperdrive, or can't get
  more configs.
