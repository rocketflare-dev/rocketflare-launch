# /launch-deploy: reference

The companion to `SKILL.md`. The person-facing runbook is `docs/DEPLOYMENT.md`. The implementation
is `apps/web/scripts/provision.ts`, with its helpers in `apps/web/scripts/provision/`:

| Helper | Does |
|---|---|
| `config.ts` | paths, the instance file, the state, the redacting logger |
| `instance.ts` | the answers, their defaults and their validation |
| `render-toml.ts` | renders `wrangler.deploy.toml` |
| `cloudflare-dns.ts` | Cloudflare REST: zones, DNS, KV, queues, R2, the zone audit |
| `neon.ts` / `resend.ts` | the Neon and Resend REST clients |
| `github-app.ts` | the GitHub App manifest flow |
| `secrets.ts` | the secret plan |
| `setup-db.ts` | the sealed Setup write |
| `token-template.ts` | the Cloudflare token's scopes and template link |

Each client's header comment cites the API page its calls were checked against.

## Files

| Path | What | Who writes it |
|---|---|---|
| `launch.deploy.env` (root; another instance: `LAUNCH_DEPLOY_FILE=<path>`, relative to where `pnpm` was started) | answers, tokens, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE`, `OAUTH_ENCRYPTION_KEY`. `.dev.vars` line conventions. An exported variable of the same name wins | the user; `github-app` and `secrets` write back, atomically, 0600 |
| `launch.deploy.env.example` | the committed template, with no values | git |
| `.launch/state.json` (`state.<tag>.json` for `launch.<tag>.deploy.env`) | account id/name, zone id, KV ids, Neon project/branch/host/role/region, Resend domain id, GitHub App slug, the last deploy's version and container hash. The writer refuses a secret-shaped value | the phases |
| `.launch/github-app.pem` (`github-app.<tag>.pem`) | the GitHub App private key, 0600 | `github-app` |
| `apps/web/wrangler.deploy.toml` | the rendered config, **one file shared by every instance** (re-rendered per run) | `render`, `deploy`, and lazily `secrets`/`email verify` |
| `apps/web/.provision.env` | the pre-instance token file. **No longer read**: `check` fails until it's moved into `launch.deploy.env` and deleted | nobody |

`tokens` (TTY only) is an alternative way to fill the tokens: hidden prompts, each verified, written
to the instance file. Never run it from the agent's shell.

## What each phase calls

| Phase | Calls |
|---|---|
| check | `node`/`pnpm exec wrangler --version`/`docker version`, `docker buildx ls`, `docker info`. Cloudflare: `GET /accounts`, `GET /accounts/{id}/tokens/verify`, `GET /zones?name=` (walking up from `LAUNCH_DOMAIN`), DNS list, `GET /accounts/{id}/workers/domains?zone_id=`, `GET /zones/{id}/workers/routes`. Neon: a project list. Resend: `GET /api-keys`, `GET /domains`. GitHub: Launch's own `checkGitHubApp` once the app exists. Writes nothing |
| github-app | local `127.0.0.1:<random port>` server → `github.com/organizations/<org>/settings/apps/new` (manifest POST) → `POST api.github.com/app-manifests/{code}/conversions` → opens `github.com/apps/<slug>/installations/new` |
| email create | Resend `GET/POST /domains`, `GET /domains/{id}`; Cloudflare DNS upserts (DNS-only records) in the zone holding `EMAIL_DOMAIN` |
| neon | find-or-create project `LAUNCH_NAME` (pg 17, `NEON_REGION`); default branch, endpoint, database, owner role; `reveal_password` or `reset_password`; `SELECT 1` (retries while the compute wakes) |
| cloudflare | REST find-or-create: KV `<NAME>_RATE_LIMIT`, queue `<name>-jobs`, R2 `<name>-files`, plus installed plugins' `kv`/`queue`/`r2`. Ids go to the state. (Not `cf-provision.sh`, which is the committed-toml path) |
| migrate | `pnpm db:migrate:ci` with the direct URL in the child env; applied count vs `migrations/meta/_journal.json` |
| route | DNS list for `*.<domain>`; creates `AAAA * → 100::` proxied only if no record exists; a DNS-only one is refused |
| render | pure render of `wrangler.toml` + answers + state |
| deploy | render → drain guard (hash vs state; counts live sessions in the DB) → `pnpm build:ui` → `wrangler deploy -c wrangler.deploy.toml --var RELEASE_VERSION:<version>-<sha>[-dirty]` → `wrangler secret put DATABASE_URL` (pooled) if absent → `GET /api/health` (up to 2 minutes, for the certificate), `GET /api/ready` |
| secrets | `wrangler secret list`; plan (names only); `OAUTH_ENCRYPTION_KEY` written back to the file **before** `wrangler secret put` (stdin); `--dry-run` stops after the plan |
| setup | the direct Neon URL → `updateSettings` + `putCredential` (sealed with the file's key) + `recordAudit` (actor `system`, user agent `launch-provision`). An unchanged credential is left alone, and `--rotate` forces a re-seal. No vendor checks run |
| email verify | Resend `POST /domains/{id}/verify`, polled up to 10 minutes; `POST /api-keys` (sending, domain-scoped) → `wrangler secret put RESEND_API_KEY` if absent; `GET <APP_URL>/auth/methods` |
| github [env] | `gh api -X PUT repos/<origin>/environments/<env>`, `gh secret set` × 3 (CI later; not in `all`) |

## Failures

| Message contains | Cause → fix |
|---|---|
| `does not exist — cp launch.deploy.env.example` | no file → SKILL.md § 2 |
| `apps/web/.provision.env is no longer read` | the user has the old file → they move its values into `launch.deploy.env` and delete it (you don't read either) |
| `is mode 06xx` | `chmod 600 launch.deploy.env` |
| `the token sees N accounts` | set `CLOUDFLARE_ACCOUNT_ID` |
| `does not verify as an ACCOUNT-owned token` | a user token → recreate it under Manage Account → Account API Tokens |
| `zone … is in account …, not …` / missing zone hint | the domain isn't an active zone of the token's account |
| `Workers routes not readable` | the token lacks Zone: Workers Routes Edit |
| `no buildx builder lists linux/amd64` | amd64 emulation (`docs/DEPLOYMENT.md` § 0) |
| `a Neon project named … exists but … does not record it` | lost state → `--adopt`; otherwise a different `LAUNCH_NAME` |
| `records Neon project …, which this key cannot see` | the project was deleted, or `NEON_API_KEY` is another org's |
| `is a DNS-only … record` (route) | the user turns the proxy on or deletes the record |
| `still has <…> — run pnpm provision cloudflare first` | the state has no KV id → `cloudflare` |
| containers / plan error from `wrangler deploy` | Workers Paid, or the token's Containers: Edit |
| `the session image or [[containers]] changed … Drain first` | SKILL.md § Updating, step 3 |
| `/api/health →` after 2 minutes | the custom domain's certificate isn't issued yet (rerun `deploy`), or the Worker fails at startup (`wrangler tail -c wrangler.deploy.toml`) |
| `/api/ready → …` | the Worker can't reach Neon → `pnpm provision neon --rotate` re-puts `DATABASE_URL` with a new password. Never `secrets --rotate`: it also regenerates `OAUTH_ENCRYPTION_KEY` |
| `REFUSED: the Worker already holds OAUTH_ENCRYPTION_KEY but the instance file has none` | restore the key from the user's backup; `--rotate` only if it's truly lost (then `setup --rotate`) |
| `no Cloudflare account id yet` (setup) | run `cloudflare` (or `check`) first |
| `DNS still propagating` | wait; `pnpm provision email status`; rerun `email verify` |
| `Resend reports … as failed` | `email status` shows which record; usually a conflicting old record in the zone |

## Known limits

- **CI deploy of an instance isn't wired.** `deploy.yml` deploys the committed templates
  (`docs/DEPLOYMENT.md` § 9).
- **Workers Paid isn't checked** before `deploy`; nor are the Containers and Workers AI scopes
  (no template key, and no read-only probe).
- **`apps/web/wrangler.deploy.toml` is shared across instances.** Never run two instances' phases at
  once. Render before a hand-run wrangler command.
- **`setup` doesn't run the Setup checks.** The owner presses Check after signing in, which also
  proves the Worker can unseal what was sealed.
- **`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` alone don't turn on workspace backups.** The template's
  `SESSION_WORKSPACE_BACKUP` and `BACKUP_BUCKET_NAME` vars must be set too (`docs/DEPLOY.md`
  § Coding sessions); render doesn't add them.
- **The database driver is `neon` for an instance** (render sets it). Hyperdrive (`postgres`) is the
  committed-toml path only (`docs/DEPLOY.md` § Database driver).
- **Nothing is ever deprovisioned**, a changed `LAUNCH_NAME` included (the old resources stay).
  Teardown is by hand (`docs/DEPLOYMENT.md` § 11).
- `/auth/methods` always reports `magicLink: true`, so `email verify` proves the Worker is up and the
  key is set, not that mail is delivered. Send yourself a link.
- The Resend region is permanent per domain.
