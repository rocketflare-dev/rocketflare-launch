# S1: the per-app deploy token

Status: **done (2026-09-27)**. Verdict: **no**. The token itself works exactly as documented, but
**it does not isolate apps from each other**, so spec/03's "a leak from one app must not reach
another app" fails.

## The policy format (was **[uncertain]**)

Read back from a token made in the dashboard ("Specified Workers"), then minted over the API:

```json
{
  "effect": "allow",
  "resources": {
    "com.cloudflare.api.account.<account id>": {
      "com.cloudflare.edge.worker.script.<script tag>": "*",
      "com.cloudflare.edge.worker.script.<staging script tag>": "*"
    }
  },
  "permission_groups": [{ "id": "<Individual Workers Editor>" }]
}
```

- It must be **nested** under the account. A flat `com.cloudflare.edge.worker.script.*` key, or
  any other spelling, is refused as "not a supported resource type".
- The permission groups are **Individual Workers** Admin / Editor / Content Read-Only /
  Metadata Read-Only (scope `com.cloudflare.edge.worker.script`). They are distinct from the
  account-wide "Workers Editor".
- The resource is the **script tag** (the same value as the Workers API `id`), not the name. So
  **the Worker must exist before its token is minted**: the pipeline uploads a placeholder Worker
  before step 7. The tag survives redeploys, including from wrangler, so the token stays valid.

## What the token can and can't do (`run.mjs`, 13 checks, all as expected)

| Action with app A's token | Result |
|---|---|
| Upload `rfspike-a` / `rfspike-a-staging` (REST) | allowed |
| `wrangler deploy` `rfspike-a` (the real CI path; `workers_dev = false`, no routes) | allowed |
| `wrangler secret list`; set a secret on `rfspike-a` | allowed |
| Upload / set a secret on / read the code of `rfspike-b` | refused 403 |
| Create a new Worker `rfspike-c` | refused 403 |
| Delete `rfspike-a-staging` (Editor) | refused 403 |
| Create a route, or re-point `rfspike-b`'s route at `rfspike-a` | refused 403 |
| Read a KV namespace through the API | refused 401 |

After the wrangler deploy, `rfspike-a` served the new version through its Launch-owned route.

## The problem: bindings are not checked against the token (`cross-bind*.mjs`)

**App A's token deployed A with bindings to other apps' resources, and A's code then read them:**

| A binds… | Result served by `rfspike-a` |
|---|---|
| app B's **KV namespace** | read `B-PRIVATE-DATA` |
| app B's **Worker** (service binding) | got `B-INTERNAL-RESPONSE`, bypassing B's route and anything in front of it |
| app B's **R2 bucket** | read `B-PRIVATE-FILE` |
| app B's **Queue** | sent a message into B's job queue |
| **Launch's Hyperdrive config** | got a working connection string for Launch's registry database |

A token that can't touch B's Worker through the API can still wire B's data into A's Worker,
because a binding only names a resource in the same account, and upload doesn't check the token's
rights over it. The same very probably holds for Durable Object namespaces of other scripts,
Workflows, and Secrets Store secrets, which were not tested.

Who holds this token in the spec's design: GitHub Environment secret `CLOUDFLARE_API_TOKEN`, so
anyone who can change a workflow file or push to a branch whose workflow can reach that
environment. That includes a compromised dependency in the app's CI, and potentially a coding
session. **One app's CI compromise reads every app's KV and R2, and Launch's own database.**

## What to do instead (recommendation)

1. **Launch deploys; CI never holds a Cloudflare token.**
   - CI builds the bundle and hands it to Launch, authenticating with **GitHub Actions OIDC**
     (`id-token: write`). That is a short-lived JWT carrying `repository`, `environment`, `ref` and
     `job_workflow_ref`, so there's no stored secret at all.
   - Launch maps the repo to the app, **checks every binding in the upload against the ids the
     registry recorded for that app and environment**, and uploads with its own token.
   - It also makes **Launch the production gate on any GitHub plan**: Launch refuses a
     `production` deploy without an approval. That is stronger than the non-Enterprise fallback
     in spec/08, and doesn't need custom deployment protection rules (S5 should test it).
2. **Launch in its own Cloudflare account**, separate from the apps' account, as defence in depth.
   Nothing an app can deploy can bind Launch's Hyperdrive, KV, Durable Objects or Worker, whatever
   happens to the deploy path.
3. The per-Worker token stays useful for **companies that opt out of Launch deploys**
   (spec/01: an app can be deployed from its repo without Launch), with the cross-binding risk
   stated plainly.

Open for the gateway design:
- Rocketflare deploys static assets (the `ASSETS` binding), so Launch has to run the assets
  upload session as well as the script upload.
- The kit's deploy job runs migrations. Those keep using the direct `DATABASE_URL` in the GitHub
  Environment, which only reaches the app's own Neon branch.
