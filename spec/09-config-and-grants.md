# 9. Shared config and secret grants

Status: spec, not built.

## The problem

Companies have shared integration credentials that many apps want: the company's Microsoft 365
connection (tenant id, client id, client secret), a company OpenAI key, a Salesforce sandbox, a
Slack bot token. Today they get pasted into each app by hand, nobody knows which apps hold which
credentials, and rotating one means hunting through every app.

## Decision: grants, owned and approved in Launch, pushed to apps

### Shared resources (the catalogue)

A **shared resource** is a named bundle of config items with an **owner team** and an
**approval policy**:

```
M365 (company tenant)            owner: IT Identity team     policy: owner approves; prod needs 2
  M365_TENANT_ID        var
  M365_CLIENT_ID        var
  M365_CLIENT_SECRET    secret   (rotates every 180 days)
```

- Values are sealed at rest in Launch and never shown again after they are entered, only
  "set, rotated <date> by <who>".
- Each item is a **var** (not secret; it goes into the app's toml through a PR) or a **secret**
  (it goes into Worker secrets).
- A resource can carry different values per environment, for example a staging M365 tenant and a
  production one.

### How an app asks

1. **From the console**: "Request access to M365" on the app's page, with a reason.
2. **Declaratively**: the adapter reads what the app says it needs ([02](02-template-contract.md)).
   In Rocketflare, installed plugins declare their config in `plugin.json` (`vars[]`, with
   `secret: true` for secrets). So when an app installs the `m365` connector plugin, Launch sees
   that it needs `M365_CLIENT_SECRET` and the rest, matches them to the catalogue, and shows
   "This app needs M365, request it?". This is read-only use of an existing Rocketflare surface;
   the kit doesn't change.

### Grant lifecycle

```
request ──► grant.request approval (resource owner; policy per environment) ──► approved
   ──► GRANT_PUSH workflow, per environment in scope:
         secrets → Cloudflare Worker secrets API on <slug>[-staging] (creates a new version)
         vars    → adapter.writeConfig → PR on the app repo (vars are code-reviewed)
   ──► grant row: app × resource × environments × expiry × status
   ──► audit events for every step
```

- **Rotation**: rotate the value once in Launch, and `GRANT_PUSH` re-pushes it to **every app
  holding the grant**, then marks the old value retired. Each push is audited.
- **Revocation**: removes the secrets from the app's Worker (vars are removed through a PR),
  marks the grant revoked and audits it. The app's own code has to cope with the missing config.
  Rocketflare's convention of answering 503 when config is missing covers this.
- **Expiry**: a grant can expire. A reminder goes to the app owner before it does.
- **Visibility**: the resource page lists the apps that hold it; the app page lists its grants.

### An app's own config

Changing an app's own vars or secrets (not shared resources) is a `config.change` request through
the same push path, with the app owners as approvers. Launch-minted credentials (Neon passwords,
Resend keys, OIDC client secrets) are rotated on a schedule by the `ROTATE`
Workflow ([10](10-fleet-operations.md)).

## Why push, not pull

*Rejected for now: apps fetch config from Launch at runtime* with a client credential.

- With push, apps keep running if Launch is down or deleted, and they need no Launch client
  library.
- Pull would make Launch a runtime dependency of every request, which changes its availability
  requirements completely.
- The cost of push is a Worker version bump on each change, which is fine for how often config
  changes.

## Cloudflare Secrets Store

Secrets Store holds account-level secrets that can be bound into Workers. It fits "one secret,
many apps" well, and has its own permissions and audit log. As of September 2026 its GA status is
unclear: the docs no longer say beta, but there is no GA announcement. The design keeps the
**backing behind a seam**:

- v1 uses per-Worker secrets.
- A later backing binds a Secrets Store secret instead. That needs a toml binding (a PR), but
  then rotation is a single write with no per-app push.

## Known gaps

- Grants are all-or-nothing per bundle in v1. Granting single keys is an open question.
- There is no dynamic or short-lived credential brokering (for example, minting a scoped M365
  token per app). That is a natural later step built on Rocketflare's connector design.
- Whether staging can be self-served and only production approved is a policy choice, and the
  engine supports both ([08](08-approvals-audit-ship.md)).
