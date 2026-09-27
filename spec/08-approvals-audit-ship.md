# 8. Approvals, audit and shipping

Status: spec, not built.

## Principle

**Launch is the system of record for approvals and audit, and GitHub carries out the decision.**
People approve things in the Launch console, and the audit trail lives in Launch. GitHub stays
the place where code is reviewed and deploys run. It is gated by Launch through GitHub's own
extension points, not worked around.

## The approvals engine

A single, generic engine handles every kind of request:

| Kind | Raised when | Default approvers |
|---|---|---|
| `app.create` | someone creates an app | platform admins (or auto-approve) |
| `app.access` | a user is denied at `/oidc/authorize` and asks for access ([05](05-identity-sso.md)) | app owners |
| `deploy.production` | a release reaches the production environment | app owners (not the author) |
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

```
session PR ──► GitHub review + CI (the app's own gate) ──► merge to main
      ──► Launch: "Release" (or automatic on merge) → adapter.release
          (Rocketflare: bump version + tag X.Y.Z → deploy workflow → STAGING)
      ──► staging healthy → "Promote to production" in Launch
          (Rocketflare: publish the GitHub Release → production job starts)
      ──► production job reaches environment `production`
          └─ GitHub → webhook deployment_protection_rule → Launch opens deploy.production
             approvers decide in Launch → Launch calls GitHub's review API → job proceeds or fails
      ──► Launch mirrors deploy status, version and health into the registry; audit event
```

### Gating production with a custom deployment protection rule

- Launch's GitHub App is registered as a **custom deployment protection rule** on each app's
  `production` environment. Launch does this in pipeline step 8
  ([06](06-registry-and-pipeline.md)).
- When a job targets `production`, GitHub pauses it and sends Launch a
  `deployment_protection_rule` webhook.
- Launch answers through GitHub's API: approved or rejected, with a comment linking to the Launch
  approval.
- GitHub keeps its own deployment record. Launch holds the decision and the audit.

**Caveat, to verify first:** custom deployment protection rules are available to all plans on
public repos, but on **private or internal repos they need GitHub Enterprise**. Company app repos
will be private.

**Fallback without Enterprise:**

- The production job runs only on `workflow_dispatch`.
- The `production` environment restricts deployment refs to release tags, and only Launch's App
  can create those tags (rulesets).
- The per-Worker production token exists only in that environment.
- Launch dispatches the job only after the approval.

This is weaker, because a repo admin could still dispatch it by hand. The audit log catches it
after the fact: a deploy with no approval id raises an alert.

### Code review

Pull request review stays in GitHub, where the diff tooling is. Launch shows each PR's review
state, checks and summary beside the app and its sessions, and records merges in the audit log.
Launch could later offer "approve PR" by acting as the user, but that is out of scope.

## Known gaps

- The Enterprise dependency above.
- Approvals by email reply or chat buttons are a later phase.
- No emergency "break glass" production deploy yet. It needs a policy and a loud audit trail.
