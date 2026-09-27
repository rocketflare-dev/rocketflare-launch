# Changelog

## Unreleased

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
