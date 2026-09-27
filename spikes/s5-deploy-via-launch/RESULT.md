# S5: deploying through Launch

Status: **done (2026-09-27)**. Verdict: **yes**. All 14 checks passed on the first run, through
real GitHub Actions runs on a private repo in a **non-Enterprise** org (`guidemode`). Full output:
[test-output.txt](test-output.txt).

## What ran

- **`rfspike-gw`** stood in for Launch's deploy endpoint
  ([gateway/src/index.js](gateway/src/index.js), ~250 lines, `jose` + `smol-toml`, tickets in a
  Durable Object).
- **`guidemode/rfspike-deploy`** was a private repo created by the App: a Worker with static
  assets, a KV binding and Neon over HTTP. Its [deploy workflow](app-repo/.github/workflows/deploy.yml)
  holds **no secrets**, and all its dealings with Launch are in
  [launch.mjs](app-repo/launch.mjs) (~100 lines).
- **Neon:** one project with `main` = production and a `staging` branch. Each has a `migrator`
  role (the database owner) and an `app` role; the Worker holds `app`'s pooled URI as a secret.

The job's steps: OIDC → **start** (a ticket; staging is automatic, production waits) → build
(`wrangler deploy --dry-run`, no credentials) → **upload** (Launch checks the bindings, uploads
the assets and an *undeployed* Worker version, and only then returns short-lived `migrator`
credentials) → migrate → **activate** (Launch deploys the version at 100% and resets `migrator`)
→ finish (always runs: resets `migrator` if it's still live).

## Results

| Scenario | Result |
|---|---|
| A forged token | refused 401 |
| Every run: a real GitHub token for another audience | refused 401 (`ERR_JWT_CLAIM_VALIDATION_FAILED`) |
| **A: staging** (automatic) | ✅ deployed. The static asset is served; `/api/state` reads the row this run migrated, over the Worker secret (so **secrets survive a version deploy** with `keep_bindings`); the KV binding works |
| **B: production** (approval) | ✅ A pending ticket opened. Production stayed on the placeholder for 20 s while waiting. After approval in Launch, the run finished **23 s later** |
| **C: production, never approved** | ✅ The run failed at "waiting for approval". **No build was accepted, no credentials were issued, no migration ran**, and production still served B. This is all a repo admin gets by dispatching the workflow by hand |
| **D: staging build binding another app's KV** (the S1 attack) | ✅ Refused at the hand-off: `403 bindings not registered for this app: kv_namespaces RATE_LIMIT_KV=<other app's id>`. **No migration ran**, because credentials are only issued after the check. Staging still served A |
| Every run: the `migrator` password it was given, after finish | dead ("password authentication failed") |

## Findings for the design

1. **Order matters: check before migrate.** The first draft issued `migrator` credentials at
   approval, before the build was checked, so a refused build could already have migrated the
   database. The working order is upload → check → an undeployed **Worker version** → credentials
   → migrate → activate. The Workers Versions API (`POST …/versions`, then
   `POST …/deployments` at 100%) makes this natural, and it gives Launch a rollback point for
   free.
2. **Launch has to bind the ticket to the run.** A ticket stores the `run_id` from the OIDC token.
   Every later call must come from the same run and environment, so another run in the same repo
   can't use someone else's approval.
3. **What Launch checks in the token:**
   - `iss` and `aud`;
   - `repository` → the app;
   - `environment` → the app environment;
   - `job_workflow_ref` must be the deploy workflow;
   - `ref` must be `main` or a tag.

   Without the last two, any workflow file on any branch that can target the environment could
   ask.
4. **The GitHub App needs the Variables permission** (Actions variables, write) to set
   `LAUNCH_URL`. It was missing in the spike and is now in the setup checklist.
5. **Secrets survive deploys.** Launch sets the Worker secrets once, on the placeholder
   (step 10), and code deploys keep them (`keep_bindings: ["secret_text"]`).
6. **The static-assets upload is simple enough to own:**
   - a manifest of `sha256(base64 + ext)[:32]`;
   - an upload session;
   - base64 buckets;
   - a completion JWT in the version metadata.

   About 30 lines.

## Not covered

- Re-dispatching from Launch after approval, instead of a job that waits. Waiting costs runner
  minutes, which is fine for approvals in minutes and wasteful for approvals in hours.
- Launch in its own account. The gateway ran in the same account as the apps.
- The kit's real deploy job (UI build, `db:migrate:ci`, plugins). The stand-in app has the same
  shape; the kit change is gap 3 in spec/02.
