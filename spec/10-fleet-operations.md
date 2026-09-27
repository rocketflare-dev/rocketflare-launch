# 10. Fleet operations

Status: spec, not built.

These are what running many apps over time needs, beyond creating them.

## Health and status

- A cron polls each environment's `health.live` and `health.ready` probes. It records status and
  latency, and alerts the app owners after N failures.
- Deploy webhooks from GitHub keep each environment's version, time and person current.
- The catalogue shows, per app: health, version, template version, open PRs, active sessions,
  pending approvals and grants.

## Template upgrades across the fleet

Each app records its template version (Rocketflare: `.rocketflare.json` `kit.version`). When a
newer template release exists:

1. Launch marks the app "upgrade available" and shows the release notes.
2. An owner, or a platform admin in bulk, clicks **Upgrade**.
3. Launch starts a **coding session** with `adapter.upgradePrompt`. For Rocketflare that is the
   kit's own `/rf-upgrade` skill run inside the app repo: it ports the release, including the
   decisions only an agent or a human can make.
4. The session ends in a PR. The app's CI gate proves it, and it ships through the normal flow
   ([08](08-approvals-audit-ship.md)).

This is the scaled version of what Rocketflare copies already do by hand. It keeps apps from
drifting years behind their template. Plugin upgrades (Rocketflare `pnpm plugin upgrade`) work the
same way.

## Credential rotation

The `ROTATE` Workflow, on a schedule per credential kind:

- Neon role passwords: rotate, update the GitHub `DATABASE_URL` and the Hyperdrive config.
- Resend sending keys: mint a new one, push it, delete the old one.
- Per-Worker deploy tokens: mint, update the GitHub secret, revoke the old one.
- OIDC client secrets: overlapping validity, push, retire the old one.
- Shared grant values: when their owners rotate them ([09](09-config-and-grants.md)).
- **Never** the app's `OAUTH_ENCRYPTION_KEY`. Rotating it would break data the app has sealed.

## Teardown

"Archive" or "Delete" raises an `app.teardown` approval. The `APP_TEARDOWN` Workflow then walks
the recorded ids in `app_operations` in reverse:

- detach the custom domains;
- delete the Workers (both environments);
- delete R2, KV, Queues and Hyperdrive;
- revoke the tokens;
- remove the Resend domain and its DNS records;
- delete the OIDC client;
- revoke the grants.

**Archive** keeps the Neon project (or a final branch snapshot) and the repo, which is archived on
GitHub. **Delete** removes the Neon project too, after a retention period.

Rocketflare's own provisioning has no teardown. This is Launch's own work, and it only works
because every created id was recorded.

## Cost

The cost view per app and per team:

- model tokens from sessions (metered, [07](07-coding-sessions.md));
- Sandbox container time;
- Neon compute and storage (Neon consumption API);
- Cloudflare Workers requests and CPU (GraphQL Analytics).

It is estimates and trends, not billing.

## Per-PR previews (later)

For each open PR:

- a Neon branch from staging;
- a Worker version uploaded with a preview URL;
- a preview link and teardown on close.

This needs the adapter to support deploying a version without promoting it.

## Known gaps

- No fleet-wide policy checks yet, such as "every app must have `SIGNUP_MODE=invite_only`".
  These would be a natural extension of the adapter reading config.
- No SLOs or paging. Alerts are email and in-app only.
