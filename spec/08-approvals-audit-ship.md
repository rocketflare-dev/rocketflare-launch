# 8. Approvals, audit and shipping

Status: spec, not built.

## Principle

**Launch is the system of record for approvals and audit, and GitHub carries out the decision.**
People approve things in the Launch console, and the audit trail lives in Launch. GitHub holds
the code, runs CI and runs the deploy jobs. It is gated by Launch through GitHub's own extension
points, not worked around. A session's change is reviewed in Launch by default (an app may keep
review on GitHub instead, see [Code review](#code-review)).

## The approvals engine

A single, generic engine handles every kind of request:

| Kind | Raised when | Default approvers |
|---|---|---|
| `app.create` | someone creates an app | platform admins (or auto-approve) |
| `app.access` | a user is denied at `/oidc/authorize` and asks for access ([05](05-identity-sso.md)) | app owners |
| `deploy.production` | a release reaches the production environment | app owners (not the author) |
| `session.merge` | a session's PR is green and its app asks for a review before merging | app owners (not the session's creator or anyone who wrote in it) |
| `grant.request` | an app asks for shared config ([09](09-config-and-grants.md)) | the shared resource's owner team |
| `config.change` | an app's own var or secret changes ([09](09-config-and-grants.md)) | app owners |
| `session.budget` | a session or team hits its cap ([07](07-coding-sessions.md)) | team lead |
| `app.teardown` | archive or delete ([10](10-fleet-operations.md)) | app owners + platform admins |

- **Policy** is set per kind, with overrides per team, per app and per shared resource:
  - the approver set (people, teams, "owners of X");
  - N of M;
  - whether the requester may approve their own request (off by default);
  - expiry;
  - optionally, conditions such as "staging is automatic, production needs approval".
- **Inbox**: an approvals view in the console. A request shows everything needed to decide: the
  diff link, CI status, what will change, who asked and why. Notifications go out by email, to
  the in-app realtime feed, and optionally to Slack or Teams later.
- **Decision**: approve or reject, with a comment. It is recorded immutably, and the waiting
  Workflow is resumed through `step.waitForEvent`.

## Audit log

`audit_events` is append-only (no update or delete grants on the table). Each row has:

- actor: a user, or Launch itself for an automated step;
- action;
- target: app, environment, grant, session;
- a before and after summary. **Secret values are never recorded**, only "set", "rotated" or
  "removed";
- the request id and the approval id, where there is one;
- IP and user agent for console actions.

It covers every approval request and decision, pipeline step, grant push or revoke, secret
rotation, deploy, sign-in and access change, and session start or end.

Integrity options:

- a **hash chain** (each row stores a hash of the previous one), so tampering is evident;
- CSV and JSON export;
- later, a stream to the company's SIEM (for example over Logpush or a webhook).

## Shipping

**Ship means "my change is live on staging"; Promote means "live in production".** The person who
made the change never has to visit GitHub.

```
Ship ──► Launch's gate in the session (lint, typecheck, tests on a throwaway database; a fix
      │  turn on red) ──► PR opened (kept as the record engineers can read)
      ──► the PR's CI (the repo's required `Gate` check, on the SHA Launch gated)
          └─ red, or no CI, or the branch moved: the session reopens with the reason (for red CI:
             the check and its redacted log tail), so the person asks the agent to fix it and
             ships again
      ──► [optional, per app: a `session.merge` review in Launch — the app's owners or named
          teams, or an admin policy; never the person who made the change]
          └─ rejected or expired: the session reopens with the reviewer's note
      ──► Launch squash-merges the PR as its GitHub App (once; on the gated SHA)
      ──► release on merge: Launch cuts a PATCH release (bump + tag X.Y.Z, one at a time per app;
          merges close together share one) → deploy workflow → STAGING
      ──► staging active and healthy on the version → the session ends on
          "Live on staging: <link>, vX.Y.Z"
          └─ a release, deploy or health failure after the merge does not reopen: the session
             shows "merged, not live yet" and the app page is where to release or retry
      ──► "Promote to production" on the app page (the pipeline strip: what is on staging, what
          it would ship in plain words, who must approve)
          (Rocketflare: publish the GitHub Release → production job starts)
      ──► production job starts in GitHub, and asks Launch to deploy (GitHub Actions OIDC)
          └─ Launch opens deploy.production → approvers decide in Launch
             → approved: the job builds and hands its build to Launch; Launch checks it and stores
               it as an undeployed version, then hands the job short-lived migration credentials;
               the job migrates; Launch activates the version
             → rejected or expired: the job fails, and nothing reached production
      ──► Launch mirrors deploy status, version and health into the registry; audit event
```

Each app chooses where Ship ends: `staging` (the default, the flow above) or `pr` — the PR is
opened and the session ends there, for teams that review and merge on GitHub; a person then
presses Release in Launch. Production is the same either way: Promote, then `deploy.production`.

For Launch to merge and to push the release's version bump, the app repo's default branch is
protected by a Launch **ruleset** (pull request required, the `Gate` check required, no force
push or deletion) that Launch's GitHub App may bypass. Launch applies it to the apps it creates,
and an admin applies it from the app page for an imported repo (classic branch protection cannot
let an App bypass a required check, so it has to go).

Every step is audited (`session.shipped`, the `session.merge` decision, `pr.merged` and
`session.merged`, `release.created`, the staging deploy, `release.staging_active`,
`session.landed`), and a release's chain links PR → release → staging → production.

### Launch deploys, so Launch is the gate

CI holds **no Cloudflare token and no production database credential** ([03](03-trust-and-credentials.md)).
A deploy job can only ask Launch:

1. **Who is asking.** The job requests a GitHub Actions OIDC token (`permissions: id-token: write`)
   with Launch as its audience, fresh for each call. Launch verifies it against GitHub's JWKS and
   requires:
   - `repository` → one app;
   - `environment` → one of its environments;
   - `job_workflow_ref` → the deploy workflow;
   - `ref` → `main` or a release tag.

   There is no stored secret to leak.
2. **May it deploy.** Launch opens a ticket **bound to the run** (`run_id`): later calls must come
   from the same run and environment. Staging follows its policy (usually automatic). Production
   opens a `deploy.production` approval, and the job waits with a timeout (or ends and is
   re-dispatched by Launch on approval).
3. **The build is checked before anything changes.** The job builds
   (`wrangler deploy --dry-run --outdir`, plus the static assets) and uploads the build to Launch.
   Launch **checks every binding against the resource ids the registry holds for that app and
   environment**, and refuses anything else, whether it is another app's KV, R2, Queue or Worker
   ([S1](../spikes/s1-worker-token/RESULT.md)). It uploads the assets and an **undeployed Worker
   version** with its own token, keeping the Worker's secrets.
4. **Migrations.** Only now does Launch reset the environment's `migrator` role password and
   return the URI to that run. The job runs the kit's migrations.
5. **Activate.** Launch deploys the version at 100% and resets `migrator` again. A final step
   that always runs resets it anyway if the job failed part-way.

All of this ran end to end in [S5](../spikes/s5-deploy-via-launch/RESULT.md):
- an approval turned into a production deploy in 23 s;
- an unapproved run and a build that bound another app's KV were both stopped **before any
  migration ran**.

This works on **every GitHub plan**, because GitHub is no longer the enforcement point. A repo admin
who dispatches the workflow by hand gets as far as step 2 and no further. On GitHub Enterprise,
Launch can also register a custom deployment protection rule, so the job shows as waiting in
GitHub's own UI. That is a convenience, not the gate.

*Rejected: a per-Worker Cloudflare token in each GitHub Environment.* It can't stop cross-app
bindings (S1), and a repo admin could deploy with it without an approval.

*Rejected: GitHub custom deployment protection rules as the gate.* They need GitHub Enterprise on
private repos, and they still leave the credentials in GitHub.

### Code review

By default a session's change is reviewed **in Launch**, because the people making changes are not
expected to use GitHub. CI on the PR is always required; on top of it each app picks who reviews
before Launch merges: nobody (the gate plus CI are the guard — the default), the app's owners, or
named teams. An admin `session.merge` approval policy overrides the app's choice and makes a review
mandatory. The reviewer sees the change in plain words — the title, the summary, the diff stat —
with links to the PR and the session's preview, and approves or rejects it with a comment in the
approvals inbox. The person who made the change, and anyone who wrote in the session, can never
approve it. A request lapses after two days.

Teams that want GitHub's diff tooling set the app to `pr`: the PR is the end of the ship, and the
review, the merge and the Release happen as before. Either way Launch shows each PR's checks and
summary beside the app and its sessions, and records merges in the audit log.

## Known gaps

- The deploy hand-off (build upload, assets upload sessions, binding checks) is Launch code to
  build and keep in step with wrangler's upload format.
- Approvals by email reply or chat buttons are a later phase.
- No emergency "break glass" production deploy yet. It needs a policy and a loud audit trail.
- Without webhooks, the CI and deploy follow are bounded by their poll rounds (30 s – 2 min).
- A session waiting for its `session.merge` review holds its database branch and a session slot
  for up to the two days the request lives.
