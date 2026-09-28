# Changelog

## Unreleased

- Shared config (P5): admins create a shared resource — a named bundle of vars and secrets, such
  as the company's M365 app registration, owned by a team — and that team sets its values per
  environment. Values are write-only: no page, command or API answer ever shows a secret, a blank
  field keeps what is set, and every change is a new version. The Shared config list and a page
  per resource show what is set (never a value), who holds it (to the owner team and admins), the
  approval policy per environment and the push history. A team that owns shared config can no
  longer be deleted (409 `group_owns_shared_config`); one migration adds the tables (0025) and a
  second the record of vars a push replaced (0026).
- Grants (P5): an app asks for a shared resource per environment from its Config page (or `launch
  grants request`); the resource's owner team approves it in the approvals inbox — not the admins
  unless a policy says so, and never the requester — with production able to need two approvals.
  Approval pushes the values onto the app's Worker as secrets, replacing the plain vars a plugin
  install left in the live version; the next deploy drops those vars from the upload and keeps the
  secrets, and a deploy that activates after a newer push re-pushes it. Revoking removes the
  secrets from that app's Worker only; a grant may expire, with a reminder a week before.
- Rotation (P5): setting new values where apps hold them pushes them to every holder in one push,
  with live progress; the old version is retired only when every app has the new one, and the
  owner team is then told to revoke the old credential at the vendor. A push that misses some apps
  lists them and offers Retry, which writes only those. Secrets past their rotation age remind the
  owner team.
- Detecting needs (P5): on import, on each Release and on "Re-scan", Launch reads the plugins an
  app's repo installs, matches their declared config to shared resources by name and tells the
  app's owners once what to request; a session's ship panel says when its PR needs shared config.
  CLI: `launch shared ls|show|set|rotate|pushes` (values from a hidden prompt or stdin, never the
  command line) and `launch grants needs|ls|request|revoke`. `GRANT_BACKEND=local` (development
  only) records pushes without calling Cloudflare.
- Setup against real accounts: the Neon step no longer fails with "not allowed for organization
  API keys" — the region is checked against Launch's list of Neon regions (and chosen from a
  select in the wizard), or pinned from where the org's projects already are, else
  `aws-us-east-2`, with a warning to change it before the first app. The Cloudflare step now
  creates the apps domain's proxied `AAAA * → 100::` wildcard record itself when the zone has none
  (audited `dns.wildcard.created`); an existing DNS-only record is left alone, with what to do.
- Approvals (P4): one engine decides everything a second person must approve — who may decide
  each kind (the app's owners, the organisation's admins, named teams or people), how many
  approvals it needs (one rejection is final), whether it expires, and whether a senior enough
  requester is approved at once. The author of a request can never approve it. Approvers are told
  in the app and by email, and the requester when it is decided; what an approval does after it
  is granted (publish a release, start a launch, wake a session) is retried every five minutes if
  it fails. Admins edit the policies under Settings → Approvals, for the organisation or one team
  or app. One migration adds the tables and moves every pending app-access request across with
  its id.
- The stand-ins on the engine (P4): members who could not create an app now ASK — the app waits
  as `requested` until an admin approves (admins and above, or whoever `app_create_role` names,
  are approved at once, as before); an access request is decided in the approvals inbox, by the
  app's owners or the organisation's admins, rather than on the app's Access page; and "extend
  budget" on a session opens a request in its creator's name that an owner or admin approves in
  one click — the creator extending their own session now waits for someone else.
- Releases and the production gate (P4): "Release" on an app bumps its version, tags it (starting
  staging) and lists the merged pull requests since the last release; "Promote" asks for a
  production deploy once staging runs the release, and a second person — never its author —
  approves it, which publishes the GitHub Release and lets exactly that tag's production run
  through. A production run started by hand in GitHub waits for an approval too, and "Deploy to
  production" now asks a second person. Merged session PRs are recorded, and each release shows
  its whole chain from pull request to production.
- A hash-chained audit log (P4): every five minutes the audit log is sealed into a per-organisation
  SHA-256 chain. Admins can verify it (`GET /api/audit/verify`, the audit page, `launch audit
  verify`) and export it as CSV or JSON Lines (`launch audit export`, streamed to a `0600` file);
  every exported row carries its `seq`, `prevHash` and `hash`, and `scripts/verify-audit-export.mjs`
  checks an export offline — the whole chain, or a filtered export row by row with `--filtered`.
- Approvals inbox (P4): `/approvals` lists what is waiting on you, what you asked for and (for
  admins) everything, with a badge in the navigation; each request has its own page with what is
  being approved in plain words, who asked and why, who it is waiting on by name, N-of-M progress,
  the expiry, and Approve / Reject with a comment. The app page gains Releases (cut a release,
  promote it to production through an approval, see its whole history); a session's creator can
  ask for more budget; the audit page can verify the chain and export the log. CLI: `launch
  approvals ls|show|approve|reject`, `launch releases ls|create|promote [--wait]` and `launch
  audit verify|export`.
- Coding sessions (P3): "Start session" on an app boots a sandbox container with the app's repo on
  a `session/<short>` branch and its own database (a Neon branch of the app's `dev`, prepared by
  the first session), runs the kit's bootstrap and dev server, and then runs each message as a
  headless Claude Code turn whose text and tool calls stream into the chat. Every turn is
  committed and pushed; an idle session suspends after 30 minutes (checkpointed, container
  destroyed) and resumes where it left off; a suspended one ends after 24 hours; a turn can be
  cancelled; a session can be ended at any time, which deletes its container and database.
- Session preview: the app running in the session is shown beside the chat through Launch itself,
  on a per-session host that needs a short-lived grant from the session page (no public tunnel);
  it reloads after every turn and only the creator, the app's owners and admins can open it.
- Model proxy and budgets: the sandbox never holds the Anthropic key — Launch adds it on the way
  out, allows only the policy's model, and meters every call into `ai_usage` against the session.
  Sessions have a per-session cap ($10) and a per-app monthly cap ($200, overridable per app); a
  session over its cap is blocked until an app owner or admin extends it, and a call over budget
  is refused before it reaches Anthropic.
- Ship: "Ship" runs the app's gate (`pnpm lint && pnpm typecheck && pnpm test`) in the session,
  lets Claude fix failures, re-runs the gate itself, and only when it is green opens a pull
  request from `session/<short>` with the title and description Claude wrote; the PR's CI is
  shown on the session and refreshed every 5 minutes until it settles. Shipping ends the session.
- Drain: Admin → Sessions → Drain pauses new sessions and suspends every live one (checkpointed)
  before a deploy that changes the session image; Undrain lets people start and resume again.
- CLI: `launch sessions start|say --follow|ship --wait|end|ls|preview-url` — start a session,
  send a message and follow the turn, ship and wait for CI, end, list an app's sessions, and print
  a preview link.
- P3 coding-session UI (slice 3e): the session page (`/apps/:slug/sessions/:id` — chat
  with one-line tool rows and a keyboard-first composer beside a live, grant-gated preview that
  reloads after every turn; header with status, cost against the cap, Ship / End / Resume and
  Extend budget; the ship panel with gate attempts, the PR and its CI; boot progress), a
  "Coding sessions" card with Start session on the app page, and Admin → Sessions with Drain /
  Undrain.
- P3 foundations (slice 3a) for coding sessions: the `sessions` and `session_events` tables,
  `ai_usage.session_id`, the app's session database and monthly budget columns (one migration);
  the `SESSION_SANDBOX` container (`@cloudflare/sandbox` 0.12.10, a placeholder image) and
  `SESSION_WORKFLOW` bindings; `run_worker_first = true` so session previews reach the Worker; the
  session contracts, policy defaults and preview-host grammar; an `anthropic_api_key` credential
  with its Setup check, and the GitHub App now needs `checks` and `statuses` read; PR and CI calls
  to GitHub, branch delete and `schema-only` branches on Neon. No screen changes yet.
- Create an app: "Create app" on the catalogue starts a pipeline that creates the GitHub repo,
  scaffolds it from Rocketflare 0.15.0, creates its Neon project (a `staging` branch, `migrator`
  and `app` roles), KV, queue and R2 per environment, its sign-in client, placeholder Workers
  with their routes, workflows and queue consumers, Worker secrets and a Resend sending key, then
  deploys staging and waits for it to answer healthy. Every step is recorded; a failed run is
  retried from the step that failed, without creating anything twice.
- Deploy gateway (`/ci/deploy`): an app's own `deploy.yml` deploys through Launch with a GitHub
  Actions OIDC token and no Cloudflare or Neon credential. Launch checks every binding against the
  app's recorded resources (another app's KV, bucket, queue or workflow is refused with 403),
  uploads the version, hands out a migration credential for that deploy only and revokes it after.
  Staging deploys are approved automatically; production waits for an app owner or admin.
- Scaffold job: a one-shot GitHub Actions job in the new repo clones the pinned kit, renames it,
  installs the default plugins, runs its gate and pushes `main`, with a one-hour token scoped to
  that repo (`/ci/scaffold`).
- App page: follow a launch step by step, retry it from the failed step, approve or reject a
  production deploy (owners and admins), "Deploy to production", and archive the app, which
  deletes its resources and archives the repo. The create form previews the staging host.
- P2 foundations (slice 2a) for creating apps: `deploy_tickets` and the app columns a launch
  records (GitHub repo id, template ref/commit, run id, archive time, the sealed encryption key)
  in one migration; the `APP_LAUNCH_WORKFLOW` and `APP_TEARDOWN_WORKFLOW` bindings; a public
  `/ci` surface for GitHub Actions (verified GitHub OIDC tokens, mapped to an app, its
  environment, workflow file and branch); the Cloudflare, Neon, Resend and GitHub calls creating
  an app needs; `template_pin` (kit 0.15.0) and `app_create_role` (admin) settings. No screen
  changes yet.
- App registry: import an existing Rocketflare app from GitHub (its manifest and both wrangler
  tomls, read with a token narrowed to that repo), a catalogue with a health dot per environment,
  and an app page with resources, health history, the operations log and its OIDC client. Health
  is checked every 5 minutes (`/api/health` + `/api/ready`: up, degraded or down; changes are
  audited) and on demand. Registering an app's OIDC client shows its secret once, with the config
  to paste.
- OIDC logout asks before signing you out of Launch unless the app proves the request with an
  `id_token_hint` Launch issued; `prompt=login` and `max_age` now make you sign in again.
- Launch is an OIDC issuer for the company's apps: discovery, JWKS with key rotation,
  authorize (PKCE S256 only), token (single-use codes; a replay revokes the first token),
  userinfo and logout. Each app has an access policy (everyone, or named groups and people),
  and a request-access page for anyone it leaves out. Every sign-in and decision is audited.
- Setup wizard (`/admin/setup`): the apps domain and zone, and the Cloudflare, Neon, Resend and
  GitHub App credentials, each sealed at rest, checked against the vendor, shown only as set /
  when / by whom, and audited.
- Seeded from Rocketflare 0.15.0.
- Branded as Launch by Rocketflare: the Rocketflare icon (tuned 16px favicon, PNG and
  apple-touch icons, a web manifest), a "by Rocketflare" line under the name, and the
  "Afterburner" light/dark theme (flame primary, violet accent, flame-gradient sign-in button,
  per-scheme `theme-color`) with a contrast test over every token pair.
- P1 foundation (slice 1a): the registry, OIDC, credential and audit tables in one migration;
  an append-only audit log (`GET /api/audit`, the Audit page); the sealed credential store and a
  GitHub App client; and the wiring the issuer, setup, import and catalogue slices build on —
  `/oidc` and `/.well-known` mounts, `/api/apps`, `/api/app-access`, `/api/admin/{setup,oidc}`,
  a five-minute health cron, and the Apps, Audit, Setup and Identity pages as placeholders.
