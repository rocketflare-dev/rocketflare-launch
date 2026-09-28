# Changelog

## Unreleased

- Approvals foundations (P4, slice 4a): the approvals engine's tables (`approval_requests`,
  append-only `approval_decisions`, `approval_policies`), releases (`app_releases`) and the audit
  hash chain (`audit_chain`, append-only) in one migration, which also moves every pending
  app-access request onto the new `approval_requests` table (same ids; the request-access page and
  the app's access page work as before) and retires `app_access_requests`. An "Approvals" entry in
  the navigation and Settings → Approvals are in place and empty until the engine lands.
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
