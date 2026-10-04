---
name: launch-deploy
description: Deploy (or update) your own Launch instance on your Cloudflare account and domain from one git-ignored file, launch.deploy.env — the GitHub App, Neon, Cloudflare resources, migrations, DNS, the deploy, every Worker secret, the Setup page's credentials and email, pausing before each paid or outward step. Rerun it to update an instance.
disable-model-invocation: true
argument-hint: "[--skip-email] [update]"
---

# /launch-deploy: from a fresh clone to your own Launch

**User-invoked only** (`disable-model-invocation`). It creates paid resources and puts a Worker on
the user's domain. Asked to deploy, point the user at `docs/DEPLOYMENT.md` and tell them to type
`/launch-deploy` themselves.

You drive `pnpm provision <phase>` (`apps/web/scripts/provision.ts`) for someone who may never have
deployed anything. The runbook is **`docs/DEPLOYMENT.md`**. Follow it, and point the user at its
sections rather than re-explaining them. Before each phase, say in one plain sentence what it
does. Show its `Verify:` line. Stop at the first failure. Lookup tables (each phase's calls,
failure causes, file layout) are in `reference.md` next to this file.

All commands run from the **repository root**. `$ARGUMENTS` may carry `--skip-email` (no Resend:
pass it to `check`, `setup` and the closing steps; magic links are only logged) and/or `update`
(go straight to § Updating).

## Rules (read first)

- **Never read, `cat`, `grep`, print or edit the values in `launch.deploy.env`** (or a
  `launch.*.deploy.env`, or `.launch/github-app*.pem`). The scripts read them and redact their
  own output. You learn what is set from `pnpm provision check`, which prints **names only**.
  If the user pastes a token into the chat, tell them to rotate it and put the new one in the
  file.
- You **may** create the file by copying the example (`cp`, then `chmod 600`). That copy has no
  values.
- Never run `pnpm provision tokens` (it needs a real terminal). The user can type
  `! pnpm provision tokens` themselves as an alternative to editing the file.
- **Pause for an explicit "yes" before each of `email create`, `neon`, `cloudflare`, `route` and
  `deploy`.** Each creates something billable or visible on the user's domain. Say what it will
  create (the phase table in `docs/DEPLOYMENT.md` § 3) and wait. Other phases run without
  asking once the user has agreed to the deploy.
- Run phases **one at a time**, not `pnpm provision all`, so the pauses happen. Never pass
  `--rotate` unless the user asks for a rotation and has read what it replaces
  (`docs/DEPLOYMENT.md` § 7).
- Never run `pnpm deploy` / `pnpm deploy:staging` for an instance (they deploy the committed
  templates). Never hand-edit `apps/web/wrangler.deploy.toml` or `.launch/state.json`.
- Don't commit `launch.deploy.env`, `.launch/` or `apps/web/wrangler.deploy.toml` (git-ignored; keep
  it that way). Don't push or open a PR unless asked.
- Long phases: `github-app` waits up to 15 minutes for the user's click, `deploy` builds and pushes
  an image (about 5 minutes the first time from an ARM Mac), and `email verify` polls up to 10
  minutes. Run them with the Bash tool's `run_in_background`, or a 600000 ms timeout, and report
  when they finish.

## 1. Toolchain

Run `node -v` (24), `pnpm -v` (10), `docker version --format '{{.Server.Os}}/{{.Server.Arch}}'`
(Docker running). If `node_modules` is missing, run `pnpm install`. Fix what you can (`nvm install`,
`corepack enable`). Docker that can't build `linux/amd64` on an Apple Silicon Mac: give the user
the options in `docs/DEPLOYMENT.md` § 0 (Docker Desktop Rosetta setting, or
`colima start --vm-type vz --vz-rosetta --cpu 6 --memory 12`, or
`docker run --privileged --rm tonistiigi/binfmt --install amd64`). Starting or reconfiguring their
Docker VM is their call, so ask first.

## 2. The instance file

`test -f launch.deploy.env` (existence only).

- **Missing** → `cp launch.deploy.env.example launch.deploy.env && chmod 600 launch.deploy.env`,
  then tell the user exactly what to fill, in their editor, not in the chat:
  1. `LAUNCH_DOMAIN` (a zone in their Cloudflare account, e.g. `rocketflare.dev`),
     `LAUNCH_ADMIN_EMAILS` (first = owner), `LAUNCH_GITHUB_ORG` (they must be an owner). Anything
     else in section 1 only if the default (in the file's comments) is wrong for them.
  2. The three tokens: `CLOUDFLARE_API_TOKEN` (account-owned, from the template link in
     `docs/DEPLOYMENT.md` § 2, **adding Containers: Edit and Workers AI: Read by hand**),
     `NEON_API_KEY` (an organization key), `RESEND_API_KEY` (full access; skip with
     `--skip-email`).
  3. Optional Worker secrets (`ANTHROPIC_API_KEY` for coding sessions is the one most people want).
  4. Leave `GITHUB_APP_*` and `OAUTH_ENCRYPTION_KEY` blank: the scripts write them.

  Then wait for them to say it's filled.
- **Present** → carry on. If `.launch/state.json` exists too, this is an existing instance: go to
  § Updating unless the user says otherwise.

Then run `pnpm provision check` (add `--skip-email` if chosen). It's read-only. Read its output with
the user:

- `FAIL … MISSING` / `invalid` → which names to fill. Repeat until clean.
- **The zone audit** (`WARN zone audit: n proxied host(s) … would capture`): explain that Launch's
  `*.<domain>/*` route would take those hosts over. The user decides whether to move each to a Worker
  custom domain first. Don't continue past it without their answer.
- `WARN … already has a DNS record` for `LAUNCH_HOST` → they delete that record first.
- The `info` line about Workers Paid and the two hand-added scopes: confirm they're on Workers Paid.

Ends with `Verify: check ok — … GitHub App pending` before the app exists.

## 3. GitHub App

If `check` said `no GitHub App yet`, offer `pnpm provision github-app`. It opens a local page in
their browser that forwards to GitHub with the app pre-filled. **They** click **Create GitHub
App**, then **Install** on the org ("All repositories"). Run it in the background and wait for
`Verify: github-app ok — …`. It writes `GITHUB_APP_ID` and the key path into the file itself.

## 4. Provision, phase by phase

The order is `all`'s. Pause where marked. Each phase is idempotent, so after a fix you rerun
the same phase.

| Phase | Pause? | Command |
|---|---|---|
| email create | **yes**: a Resend domain + DNS records in their zone | `pnpm provision email create` (skip with `--skip-email`) |
| neon | **yes**: a Neon project named `LAUNCH_NAME` | `pnpm provision neon` |
| cloudflare | **yes**: KV, queue, R2 bucket | `pnpm provision cloudflare` |
| migrate | | `pnpm provision migrate` |
| route | **yes**: the proxied wildcard `*.<domain>` record | `pnpm provision route` |
| render | | `pnpm provision render` (must say `no placeholders`) |
| deploy | **yes**: the Worker goes live on `LAUNCH_HOST`, image pushed | `pnpm provision deploy` |
| secrets | | `pnpm provision secrets --dry-run`, show the names, then `pnpm provision secrets` |
| setup | | `pnpm provision setup` (`--skip-email` if chosen) |
| email verify | | `pnpm provision email verify` |

After `secrets` prints `OAUTH_ENCRYPTION_KEY: generated and written to launch.deploy.env`, tell the
user **now** to back up the file and `.launch/` (`docs/DEPLOYMENT.md` § 7).

**On a failure**: read the error (it names the cause), fix it with the user (the table in
`docs/DEPLOYMENT.md` § 3 and `reference.md` § Failures), rerun **that phase**, then continue down the
list. Don't retry blindly: a migration error is a code problem, and a `refused` secret plan
means the key is missing from the file (restore it from backup, don't `--rotate`).

## 5. Close-out

1. Open `https://<LAUNCH_HOST>/login` for them (`open <url>`). They request a magic link for the
   first admin address (with `--skip-email`, run
   `pnpm --filter @launch/web exec wrangler tail -c wrangler.deploy.toml` and point them at the
   link in the log).
2. Walk them through **Settings → Platform → Setup** (`docs/DEPLOYMENT.md` § 4): Check on every
   card, the Public URL check, pin the kit version. Then **Settings → Platform → Coding agents**.
3. The smoke test (`docs/DEPLOYMENT.md` § 5). You run `pnpm cli whoami` after they run
   `! pnpm cli login --server https://<LAUNCH_HOST>` (it opens a browser). They create a
   throwaway app, start a session, check the preview, and archive the app. You can watch
   `wrangler tail -c wrangler.deploy.toml` with them.
4. Remind them: back up `launch.deploy.env` + `.launch/`. To update later, run `/launch-deploy`
   again.

## Updating an existing instance

1. **The gate first, never in the checkout a dev server runs from.** Make a separate clone or
   worktree of the commit being deployed and run
   `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build` there.
   Deploy only a green commit. (The deploy itself runs from the checkout holding
   `launch.deploy.env`.)
2. `pnpm provision check`.
3. **Is there a session-image change?** `deploy` compares a hash of `apps/web/containers/session/`
   and the `[[containers]]` block with the last deploy. Run the phases as in § 4 (pausing only
   before `deploy` on an update, since the others find what exists). If `deploy` refuses because
   sessions hold a container, the drain is the user's: **Admin → Sessions → Drain**, wait until no
   session is `ready`/`working`/`booting`, then `pnpm provision deploy --drained`, then finish
   `secrets` → `setup` → `email verify`, then **Undrain**. Any deploy, image or not, also refuses
   while a session is `booting`/`working` (it would cut that turn): tell the user, wait, and only
   pass `--interrupt-turns` when they say so.
4. Check `curl -s https://<LAUNCH_HOST>/api/health` shows the new version, and tell them what
   changed (the `## Unreleased` / version section of `CHANGELOG.md`).

Rollback, a second instance (`LAUNCH_DEPLOY_FILE=launch.<tag>.deploy.env`), CI and teardown:
`docs/DEPLOYMENT.md` §§ 8 to 11. Teardown deletes paid resources and data, so confirm each command
with the user.
