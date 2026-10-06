# DEPLOYMENT — your own Launch, from a fresh clone

This is the runbook for standing up a Launch instance on your own Cloudflare account and domain,
starting from `git clone`. It takes one private file, one skill and one command:

1. **You** fill in `launch.deploy.env` at the repo root: your answers and three account tokens.
2. **You** type `/launch-deploy` in Claude Code, or run `pnpm provision all` yourself.
3. **The scripts** do the rest: the GitHub App, Neon, Cloudflare resources, migrations, DNS, the
   deploy, every Worker secret, the Setup page's credentials and email.

Every step below says who does it, **you** or **the agent** (Claude, driving `/launch-deploy`),
and the exact command. Every phase ends in one `Verify:` line. Don't move on until it prints.

**The worked example** is the first instance deployed this way:

| | Example | Yours |
|---|---|---|
| Zone (`LAUNCH_DOMAIN`) | `rocketflare.dev` | a domain that is a zone in your Cloudflare account |
| Launch itself (`LAUNCH_HOST`) | `launch.rocketflare.dev` (the default, `launch.<domain>`) | |
| Apps | `<slug>.rocketflare.dev` | |
| Coding-session previews | `{label}.rocketflare.dev` | |
| Mail from (`EMAIL_DOMAIN`) | `notifications.rocketflare.dev` (the default) | |
| GitHub org (`LAUNCH_GITHUB_ORG`) | `rocketflare-launch` | |

What this runbook does **not** cover: the topology, the two committed tomls, the release dance and
the parity test are reference material in [`docs/DEPLOY.md`](DEPLOY.md). Local development is
[`SETUP.md`](../SETUP.md) Part 1. The script is `apps/web/scripts/provision.ts`, and
`pnpm provision --help` lists every phase and flag.

**How an instance is kept out of git.** The committed `apps/web/wrangler.toml` and
`wrangler.staging.toml` stay neutral templates. An instance lives in three git-ignored files:

| File | Holds | Written by |
|---|---|---|
| `launch.deploy.env` (repo root) | your answers, the tokens, the GitHub App id, the generated `OAUTH_ENCRYPTION_KEY` | you, plus `github-app` and `secrets` writing values back (mode 0600) |
| `.launch/state.json` and `.launch/github-app.pem` | the ids provisioning created (never a secret), and the GitHub App's private key (0600) | the phases |
| `apps/web/wrangler.deploy.toml` | the wrangler config for this instance, **rendered** from `wrangler.toml` + the file + the state | `render` and `deploy`. Never edit it. Every wrangler call for the instance uses `-c wrangler.deploy.toml` |

---

## 0. Before you start (you)

| You need | Why | Check |
|---|---|---|
| A **Cloudflare account on Workers Paid**, with **your domain as an active zone** (registered there, or its nameservers moved) | Workflows, `[limits]` and Containers (coding sessions) are Paid features. Launch's host, the apps' wildcard route and the email DNS records all live in that zone | dashboard → Websites lists the domain as **Active**; Workers & Pages → Plans says Paid |
| A **GitHub organization** you are an **owner** of | Launch creates every app's repository there, through a GitHub App you create in step 3 | github.com/organizations/&lt;org&gt;/settings opens for you |
| A **Neon** account with an organization | the instance's own database project, and every app's project later | console.neon.tech |
| A **Resend** account | magic-link sign-in and notifications (you can skip email, see the `--skip-email` flag) | resend.com |
| **Docker**, running, able to build **linux/amd64**, with **12 GB or more** of memory | `deploy` builds the coding-session image and pushes it to Cloudflare's registry | `docker version`; `pnpm provision check` tests the rest |
| **Node 24** and **pnpm 10** | the scripts | `node -v`, `pnpm -v` (`nvm install` reads `.nvmrc`; `corepack enable` for pnpm) |

**Docker on an Apple Silicon Mac.** The session image is amd64-only, so Docker has to emulate
amd64. Pick one:

- **Docker Desktop**: Settings → General → turn on "Use Rosetta for x86_64/amd64 emulation on Apple
  Silicon" (QEMU also works, more slowly). Settings → Resources → Memory: 12 GB or more.
- **colima**: start it with Rosetta, `colima start --vm-type vz --vz-rosetta --cpu 6 --memory 12`.
  Or install the amd64 emulators into the running VM with
  `docker run --privileged --rm tonistiigi/binfmt --install amd64`.

`pnpm provision check` fails with the same three remedies when no builder lists `linux/amd64` and an amd64 container will not run, and
warns below 11 GB (a 12 GB colima VM reports about 11.6). The first image push from an ARM Mac takes about 5 minutes; later pushes are
cached.

**Look at your zone first.** Launch serves a Worker route `*.<domain>/*`, so every subdomain that
has no more specific route reaches Launch. A proxied host that you serve some other way (an
origin server, Pages, a tunnel) would be captured. Hosts on a **Worker custom domain** are safe,
because a custom domain wins over a route. A subdomain nothing serves (`bob.<domain>`, an archived
app's slug) gets Launch's holding page, a 404 that says nothing has launched there and links to
Launch, never Launch itself. `pnpm provision check` audits the zone and lists every
proxied host that would be captured. Move each to a Worker custom domain, or accept it, before
you deploy. In the example, `rocketflare.dev` and `www.rocketflare.dev` are custom domains of the
`rocketflare-www` Worker, so the audit is clean. **The instance also needs `LAUNCH_HOST` free:** a
DNS record already at that name blocks the custom domain, and `check` warns about it.

## 1. Clone and open Claude (you)

```bash
git clone https://github.com/rocketflare-dev/rocketflare-launch.git && cd rocketflare-launch
pnpm install
claude          # then type:  /launch-deploy
```

`/launch-deploy` is **user-invoked only**: it creates paid resources, so Claude never starts it on
its own. It walks every step below with you, pausing for your OK before each paid or outward-facing
phase. You don't need to run the app locally first. `/launch-setup` is only for development.

Prefer the terminal? Everything below works without Claude. Run the same commands yourself.

## 2. Fill in `launch.deploy.env` (you)

```bash
cp launch.deploy.env.example launch.deploy.env && chmod 600 launch.deploy.env
```

(The agent does this copy for you if the file is missing. It then tells you which names to fill
in. **It never reads or prints the file's values, and you never paste a token into the chat.**)
Open the file in your editor. Every line has a comment saying where its value comes from.

**The instance** (section 1 of the file):

| Name | Required | Example | Default / notes |
|---|---|---|---|
| `LAUNCH_DOMAIN` | yes | `rocketflare.dev` | the zone apps live under |
| `LAUNCH_HOST` | | | `launch.<domain>`; must be under `LAUNCH_DOMAIN` |
| `LAUNCH_NAME` | | | `launch`: the Worker name and the prefix of every account-scoped resource (`launch-jobs`, `launch-files`, `LAUNCH_RATE_LIMIT`, `launch-agent-run`…) and of the Neon project. Change it only to run a second instance in the same accounts (§ 8) |
| `LAUNCH_ADMIN_EMAILS` | yes | `you@example.com` | comma-separated. The **first** becomes the organisation's owner |
| `LAUNCH_GITHUB_ORG` | yes | `rocketflare-launch` | the org apps are created in |
| `NEON_REGION` | | | `aws-eu-central-1`; the instance's project and every app's |
| `NEON_ORG_ID` | | | only for a *personal* Neon key that belongs to several orgs (`org-…`) |
| `EMAIL_DOMAIN` | | | `notifications.<domain>` |
| `EMAIL_REGION` | | | `us-east-1`. **Permanent per Resend domain** |

**The three account tokens** (section 2). The scripts use them to provision. `setup` then seals
them into the instance, where Launch uses them at runtime:

| Name | Where | What it must be |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | the pre-filled template link below (`pnpm provision check` prints it too) | an **account-owned** token: dashboard → Manage Account → Account API Tokens. A user token fails Launch's own Setup check |
| `CLOUDFLARE_ACCOUNT_ID` | optional | discovered when the token sees exactly one account |
| `NEON_API_KEY` | console.neon.tech → your organization → Settings → API keys | an **organization** key |
| `RESEND_API_KEY` | https://resend.com/api-keys | **Full access**: it creates the domain and mints the Worker's sending key and one per app. Not needed with `--skip-email` |

The Cloudflare token's permissions:

- **Account**: Workers Scripts, Workers KV Storage, Queues, Workers R2 Storage, **Containers**:
  Edit. **Workers AI**, Account Settings: Read.
- **Zone** (your zone): Zone: Read. DNS, Workers Routes: Edit.

[Create the token from the template](https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22queues%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_routes%22%2C%22type%22%3A%22edit%22%7D%5D&name=Launch).
The link pre-fills every permission except **Containers: Edit** and **Workers AI: Read**. Cloudflare
documents no template key for those two, so add them by hand on the same page before you create
the token.

**Leave these blank. The scripts fill them:** `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE` and
`GITHUB_WEBHOOK_SECRET` (written by `github-app`; GitHub generates the webhook secret) and
`OAUTH_ENCRYPTION_KEY` (generated by `secrets`). An instance whose App was made before the webhook
existed: § 12. `GITHUB_APP_NAME` is
optional (default `Launch <org>`; GitHub App names are global).

**Optional Worker secrets** (section 4). The `secrets` phase puts each one that is set:
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` (coding sessions and AI; `setup` also stores them as
Setup credentials), `EMBEDDINGS_API_KEY`, `GOOGLE_CLIENT_ID`/`_SECRET`,
`MICROSOFT_CLIENT_ID`/`_SECRET`, `OIDC_CLIENT_SECRET`, `LANGFUSE_PUBLIC_KEY`/`_SECRET_KEY`,
`OTEL_EXPORTER_OTLP_HEADERS`, `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`. Leave any of them empty
and the feature degrades as `SETUP.md` Part 2 describes. You can add them later and rerun
`pnpm provision secrets`.

**An exported variable of the same name wins over the file** (that's how CI or a one-off run
overrides a value).

Then check it. **The agent** (or you) runs:

```bash
pnpm provision check
```

`check` is read-only. It creates nothing and prints **names only**, never a value. It reports:
each required name present or `MISSING`; Node, wrangler and Docker (amd64, memory); the token as an
active account-owned token; the zone in that account; the zone audit; the wildcard; Workers Routes
readable; the Neon key; the Resend key (full access) and the email domain's status; and the GitHub
App once it exists. A missing token comes with the link to mint it.

```
Verify: check ok — https://launch.rocketflare.dev: names present, Docker builds linux/amd64, account …, zone rocketflare.dev, Neon, Resend, GitHub App pending
```

`check` **cannot** prove Workers Paid or the two hand-added scopes (Containers, Workers AI)
without creating something. It says so, and the first `deploy` fails loudly if either is missing.

## 3. Provision: `pnpm provision all`

```bash
pnpm provision all            # every phase below in order; stops at the first failed Verify
```

`all` is idempotent (find-or-create), so after a failure you fix the cause and rerun the failed
phase, then `all` again. `/launch-deploy` runs the phases **one at a time** instead, so it can stop
for your OK before each one marked *pauses* below. Budget 20 to 40 minutes the first time: the image
push and the Resend DNS check are the slow parts.

| # | Phase | Who | What it creates or does | Costs / touches | Verify line |
|---|---|---|---|---|---|
| 1 | `check` | agent | read-only checks (§ 2) | nothing | `check ok — …` |
| 2 | `github-app` (only when `GITHUB_APP_ID` is blank) | **you click twice** | a local page forwards to GitHub with the app pre-filled (Launch's permissions, and the webhook — `<APP_URL>/api/github/webhook`, five events, § 12). **You** click **Create GitHub App**, then **Install** on your org ("All repositories"). It writes `GITHUB_APP_ID` and `GITHUB_WEBHOOK_SECRET` into the file and the key to `.launch/github-app.pem` | a private GitHub App on your org. Waits up to 15 minutes for your click | `github-app ok — app <slug> (id …) owned by rocketflare-launch; … written to launch.deploy.env; install at …` |
| 3 | `email create` (pauses) | agent | the Resend domain `EMAIL_DOMAIN`, and its DKIM/SPF/MX records in your zone (DNS-only) | a Resend domain (free tier holds one); DNS records in your zone | `email create ok — domain=notifications.rocketflare.dev zone=rocketflare.dev records=n (created …)` |
| 4 | `neon` (pauses) | agent | the instance's Neon project, named `LAUNCH_NAME`, in `NEON_REGION`, Postgres 17. Its id goes in the state, then `SELECT 1` | a Neon project in your org (plan limits apply) | `neon ok — project <id>, branch <id>, host <host> (SELECT 1)` |
| 5 | `cloudflare` (pauses) | agent | KV `LAUNCH_RATE_LIMIT`, queue `launch-jobs`, R2 bucket `launch-files` (plus any installed plugin's), ids into `.launch/state.json` | Cloudflare resources, within Workers Paid's included usage at this size | `cloudflare ok — account …: LAUNCH_RATE_LIMIT, launch-jobs, launch-files; ids in .launch/state.json …` |
| 6 | `migrate` | agent | every migration against the instance database; applied count must equal the journal | the Neon database | `migrate ok — n/n migrations applied on <host>` |
| 7 | `route` (pauses) | agent | the proxied wildcard `AAAA * → 100::` at `*.<domain>`, only if no `*` record exists. A DNS-only one is refused, not changed | one DNS record in your zone | `route ok — zone rocketflare.dev: *.rocketflare.dev created AAAA * → 100:: (proxied); deploy adds the custom domain launch.rocketflare.dev and the route *.rocketflare.dev/*` |
| 8 | `render` | agent | `apps/web/wrangler.deploy.toml`: Worker `name`, account-scoped names, `workers_dev = false`, the routes (`LAUNCH_HOST` as a custom domain, `*.<domain>/*`), `APP_URL`, `EMAIL_FROM`, `SESSION_PREVIEW_URL`, `DATABASE_DRIVER = "neon"`, the KV id, plugin declarations | a local file | `render ok — apps/web/wrangler.deploy.toml: worker launch, routes launch.rocketflare.dev + *.rocketflare.dev/*, no placeholders` |
| 9 | `deploy` (pauses) | agent | renders, builds the UI, `wrangler deploy -c wrangler.deploy.toml` (builds and pushes the session image, creates the custom domain and route, registers the Workflows and Durable Objects), puts `DATABASE_URL` (the pooled Neon URI) on first deploy, then polls `/api/health` and `/api/ready` | **the Worker goes live** on `LAUNCH_HOST`; the container application and its image; workflows. The custom domain's certificate can take a couple of minutes | `deploy ok — https://launch.rocketflare.dev/api/health ok (version …), /api/ready ok` |
| 10 | `secrets` | agent | `OAUTH_ENCRYPTION_KEY` (from the file, else **generated and written back to the file first**), `BOOTSTRAP_ADMIN_EMAILS`, `DATABASE_URL`, every optional secret set in the file, over stdin | Worker secrets | `secrets ok — set n; wrangler secret list shows n: …` |
| 11 | `setup` | agent | the Setup page's settings (apps domain, account id, Neon org and region, notifications domain, GitHub org) and **sealed** credentials (Cloudflare, Neon, Resend, GitHub App, Anthropic/OpenAI when set), audited. Creates the organisation with the first admin as owner if none exists | rows in the instance database | `setup ok — n credential(s) sealed with the instance key (…), n setting(s) changed, audited in organisation <id>` |
| 12 | `email verify` | agent | polls Resend until the domain verifies (up to 10 minutes), mints the Worker's own sending key into `RESEND_API_KEY`, checks `/auth/methods` | a Resend API key (sending only) | `email verify ok — domain=… verified, RESEND_API_KEY set, https://launch.rocketflare.dev/auth/methods reports magic link` |

`all` then prints a close-out checklist (§ 4) and `Verify: all ok — n phases passed; https://launch.rocketflare.dev is live`.

**Not in `all`:** `tokens` (a hidden-input prompt for the tokens, which needs your own terminal: an
alternative to editing the file) and `github [environment]` (CI, § 9). `email status` shows each
email DNS record's presence when verification stalls.

**Flags.**

| Flag | Effect |
|---|---|
| `--dry-run` | `secrets`: list what would be put, generated or skipped (names only) and put nothing |
| `--skip-email` | no Resend: `email create`/`verify` are skipped and magic links only reach the Worker log (`pnpm --filter @launch/web exec wrangler tail -c wrangler.deploy.toml`) |
| `--drained` | `deploy`: you've drained coding sessions, so go ahead with a new session image (§ 6) |
| `--interrupt-turns` | `deploy`: go ahead although sessions are mid-turn; each running turn fails, the sessions survive (§ 6) |
| `--adopt` | `neon`: use an existing project named `LAUNCH_NAME` that the state doesn't record (you lost `.launch/`) |
| `--rotate` | regenerate `OAUTH_ENCRYPTION_KEY` (then rerun `setup --rotate`), the Neon password, the Resend sending key. `github-app --rotate` creates a new app. **Not for routine reruns** |
| `--debug` | print sanitised vendor payloads to stderr |

**When a phase fails**, the error names the phase and the fix. Common ones:

| Failure | Fix |
|---|---|
| `check`: a name `MISSING`, or `invalid` | fill it in the file; rerun `check` |
| `check`: Docker cannot build linux/amd64 | § 0, Docker on an Apple Silicon Mac |
| `check`: the token is not an active account-owned token | recreate it under Manage Account → Account API Tokens, not My Profile |
| `check`: the token sees several accounts | set `CLOUDFLARE_ACCOUNT_ID` |
| `check`: zone not in this account | the domain must be an active zone of the token's account |
| `neon`: a project named `launch` exists but the state doesn't record it | `--adopt` if it is this instance's, otherwise a different `LAUNCH_NAME` |
| `route`: `*.<domain>` is a DNS-only record | turn its proxy on in the dashboard, or delete it; rerun `route` |
| `deploy`: a plan or permission error on containers | Workers Paid, and the token's Containers: Edit scope |
| `deploy`: the session image changed and sessions hold a container | drain first (§ 6), then `pnpm provision deploy --drained` |
| `deploy`: n session(s) are booting or mid-turn | wait for the turns to finish (Admin → Sessions), or `--interrupt-turns` (§ 6) |
| `deploy` / `email verify`: `fetch failed` on the new host | usually this machine cached "no such host" from before the custom domain existed. The probes retry through public DNS (`curl --resolve`); if that fails too the error says so. Flush the cache (macOS: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`) and rerun the phase |
| `deploy`: `/api/ready` not ready | the Worker can't reach Neon. `pnpm provision neon --rotate` resets the Neon password and re-puts the Worker's `DATABASE_URL`. **Not** `secrets --rotate`, which also replaces `OAUTH_ENCRYPTION_KEY` |
| `secrets`: the Worker holds `OAUTH_ENCRYPTION_KEY` but the file has none | restore the key from your backup of the file (§ 7). `--rotate` only if it's truly lost |
| `email verify`: DNS still propagating after 10 minutes | wait, then `pnpm provision email verify`; `pnpm provision email status` shows each record |

## 4. Sign in and finish Setup (you)

1. Open `https://launch.rocketflare.dev/login` and request a magic link for the **first**
   `LAUNCH_ADMIN_EMAILS` address. It arrives from `notifications.rocketflare.dev` (with
   `--skip-email`, copy it from `wrangler tail -c wrangler.deploy.toml`). Signing in makes you the
   organisation's owner and the platform admin. `SIGNUP_MODE` is `approval`: anyone else
   who signs in lands on `/pending` with an access request you approve under Settings → Platform →
   Access requests (or invite them first).
2. **Settings → Platform → Setup** (`/settings/platform/setup`). `setup` stored every value and ran
   each card's check (it printed `check passed` or the failing probes; the Cloudflare one records
   the zone id that creating an app needs), so:
   - every card should be green. Press **Check** on any that isn't once you've fixed the cause
     (a GitHub App that failed because it wasn't installed yet is the usual one). Pressing Check
     here is also the proof that the Worker can unseal what `setup` sealed;
   - run the **Public URL** check (GitHub's runners call Launch back at it, and creating an app is
     refused until it passes).
3. **Settings → Platform → Kit**: pin the kit version apps are created from — a release, **Follow
   latest** (the newest release, re-checked hourly) or, for development, a commit.
4. **Settings → Platform → Coding agents**: turn on the coding agents sessions may run, and who
   pays. With nothing set, it's Claude Code on Launch's key only, which needs `ANTHROPIC_API_KEY`
   or the Anthropic credential.
5. Google or Microsoft sign-in: add `https://launch.rocketflare.dev/auth/google/callback` (or
   `/auth/microsoft/callback`) to that provider's redirect URIs (`SETUP.md` 2.2 / 2.3).
6. Back up `launch.deploy.env` and `.launch/` now (§ 7).

## 5. Smoke test (you, with the agent)

```bash
pnpm cli login --server https://launch.rocketflare.dev     # browser; then:
pnpm cli whoami
curl -s https://launch.rocketflare.dev/api/health          # status ok, the version deployed
```

Then in the UI:

1. **Create a throwaway app.** It should come up at `https://<slug>.rocketflare.dev`, with its repo in
   `rocketflare-launch`.
2. **Start a coding session** on it. The preview should load at `https://{label}.rocketflare.dev`. The
   first boot pulls the image, so give it a minute.
3. **Archive the app** (teardown). Its Worker, database and DNS go away, and the repo is archived.

`pnpm --filter @launch/web exec wrangler tail -c wrangler.deploy.toml` shows the Worker's log while
you do this.

## 6. Updating the instance

An update is a rerun. **You** pull, then type `/launch-deploy` again (it notices the instance
exists), or by hand:

```bash
git pull
pnpm install
pnpm provision all
```

`all` is idempotent: it reapplies migrations, re-renders, redeploys, re-puts the secrets set in the
file (`DATABASE_URL` only when missing) and leaves unchanged Setup credentials alone. **Run the gate before you deploy what you changed
yourself.** Use a separate worktree, not the checkout a dev server runs in:
`pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

**The session drain.** A deploy that changes the session image (`apps/web/containers/session/`) or
the `[[containers]]` block replaces every running session container and cuts off a running turn.
`deploy` records a hash of both. When the hash changed and the database shows sessions holding a
container, it **refuses** and tells you to drain:

1. **You**: Admin → Sessions → **Drain**. New sessions are refused, and live ones checkpoint and
   suspend once their running turn finishes.
2. Wait until Admin → Sessions shows no `ready`, `working` or `booting` session.
3. **The agent**: `pnpm provision deploy --drained`, then `pnpm provision all` to finish the rest.
4. **You**: **Undrain**. People resume their own sessions.

**Running turns.** EVERY deploy, image or not, replaces Launch's Worker and Durable Objects, and
that cuts the stream to Claude Code in a session's container: the turn fails ("Launch lost the
connection to Claude Code in the sandbox"), while the session and its container carry on and the
person just resends. So `deploy` also **refuses** while any session is `booting` or `working`. Wait
for those turns to finish, or pass `--interrupt-turns` to deploy anyway (tell the people first).

## 7. Backups and key loss

Back up **`launch.deploy.env` and the `.launch/` directory** together, to a password manager or
encrypted storage, after the first `all` and after any `--rotate`:

- `OAUTH_ENCRYPTION_KEY` seals every Setup credential, every person's connected accounts and every
  tenant AI key. **Without it, the instance can't read them, and there's no re-encrypt path.**
  Recovery means `pnpm provision secrets --rotate` and `pnpm provision setup --rotate` (which re-seal
  what the file holds), plus every person reconnecting their accounts and every admin re-entering
  AI keys.
- `.launch/github-app.pem` is the GitHub App's only private key. Lost: generate a new key on the
  app's GitHub settings page and point `GITHUB_APP_PRIVATE_KEY_FILE` at it, or
  `pnpm provision github-app --rotate` for a new app.
- `.launch/state.json` holds ids only. Lost: the phases find the resources by name again, and the
  Neon project needs `--adopt`.

The database itself is Neon's: point-in-time restore within your plan's history window.

## 8. A second instance (staging, say)

A second instance is a second file. Its state, GitHub App key and everything else stay apart:

```bash
cp launch.deploy.env.example launch.staging.deploy.env && chmod 600 launch.staging.deploy.env
LAUNCH_DEPLOY_FILE=launch.staging.deploy.env pnpm provision check
LAUNCH_DEPLOY_FILE=launch.staging.deploy.env pnpm provision all
```

`launch.staging.deploy.env` keeps its ids in `.launch/state.staging.json` and its key in
`.launch/github-app.staging.pem`. Rules:

- **In the same Cloudflare account or Neon org, give it a different `LAUNCH_NAME`** (e.g.
  `launch-staging`). Otherwise it would reuse the first instance's Worker, queue, bucket and Neon
  project name.
- **Give it a different `LAUNCH_DOMAIN`**, ideally its own zone. Each instance owns `*.<domain>/*`
  and the wildcard record. A sub-subdomain such as `staging.rocketflare.dev` works for routing, but
  Universal SSL covers only one level, so `{label}.staging.rocketflare.dev` needs an advanced
  certificate.
- Its own GitHub org is the clean choice. Two Launch apps creating repos in one org will work, but
  each sees the other's repos.
- **`apps/web/wrangler.deploy.toml` is shared.** Every phase re-renders it for the file it was
  given, so don't run two instances' phases at the same time. Before a hand-run wrangler
  command, run `LAUNCH_DEPLOY_FILE=… pnpm provision render` so the file names the right instance.

## 9. CI (later)

Today an instance is deployed **from a checkout that holds its file**, by you or the agent. CI
deploy of an instance is **not wired**:

- `.github/workflows/deploy.yml` deploys the **committed** `wrangler.staging.toml` /
  `wrangler.toml` (the kit's tag → staging, Release → production dance, `docs/DEPLOY.md` § CI/CD).
  Those are templates with `<PLACEHOLDER>` ids, so for an instance deployed this way that workflow
  fails at its `REQUIRE_PROVISIONED=1` parity check, and it would deploy the template's settings
  rather than your instance's even if it didn't.
- `pnpm provision github [environment]` (default `production`) still creates a GitHub Environment
  holding `DATABASE_URL` (the direct host), `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
  (it needs `gh auth login` with the `repo` scope). That's the first half of CI. The missing half is
  a job that renders `wrangler.deploy.toml` from the state and the answers (which would have to be
  stored in CI too) and runs `pnpm provision deploy`.
- Putting an account-wide Cloudflare token into CI is exactly what Launch's own apps avoid (the
  external deployer, `docs/DEPLOYER.md`). Consider that before wiring it.

## 10. Rollback

| Situation | Action |
|---|---|
| Bad Worker version, schema unchanged | `pnpm --filter @launch/web exec wrangler rollback -c wrangler.deploy.toml`: the previous version, in seconds. `wrangler versions list -c wrangler.deploy.toml` and `wrangler deployments list -c wrangler.deploy.toml` show what is there; `wrangler rollback <version-id>` picks one |
| A specific earlier commit | `git checkout <commit>`, `pnpm install`, `pnpm provision deploy` (and back to your branch after) |
| A migration must be undone | migrations are forward-only and `wrangler rollback` doesn't touch the database: write a compensating migration and deploy it. Neon's point-in-time restore is the last resort |
| The rollback crosses a session-image change | drain first (§ 6). After a `wrangler rollback`, the image hash `deploy` recorded no longer matches what runs, so drain by hand before the next deploy too |

Verify with `curl https://launch.rocketflare.dev/api/health` (the version), `pnpm cli status` and
`wrangler tail -c wrangler.deploy.toml`.

## 11. Teardown

Nothing tears an instance down automatically. **Archive Launch's apps first, from Launch**: each
app's Worker, Neon project, DNS and repo are created by Launch with the instance's credentials, and
they outlive the instance otherwise. Then, with the example's default `LAUNCH_NAME` (`launch`), run
from the repo root with the instance's file in place (the agent can run the wrangler lines; the
dashboard steps are yours):

```bash
W="pnpm --filter @launch/web exec wrangler"
$W delete -c wrangler.deploy.toml                       # the Worker (named LAUNCH_NAME)
$W containers list                                      # then: $W containers delete <id> (launch-sessionsandbox)
$W containers images list                               # then: $W containers images delete <image>
for wf in launch-agent-run launch-app-create launch-app-teardown launch-session launch-grant-push launch-agent-login; do
  $W workflows delete "$wf"
done
$W queues delete launch-jobs
$W kv namespace list                                    # then: $W kv namespace delete --namespace-id <id of LAUNCH_RATE_LIMIT>
$W r2 bucket delete launch-files                        # empty it first (dashboard → R2 → the bucket)
```

Then, by hand:

| What | Where |
|---|---|
| The Neon project (`LAUNCH_NAME`, id in `.launch/state.json`) | console.neon.tech → the project → Settings → Delete |
| The wildcard record `*.<domain>` (`AAAA 100::`, comment "Launch: apps wildcard") and the email records under `EMAIL_DOMAIN` | Cloudflare dashboard → your zone → DNS |
| Any custom domain or route left on the zone | Workers & Pages → Domains / the zone's Workers Routes |
| The Resend domain and its API keys (the full-access one and the sending key named `LAUNCH_NAME`) | resend.com → Domains, API Keys |
| The GitHub App | github.com/organizations/&lt;org&gt;/settings/apps → the app → Advanced → Delete GitHub App |
| The account tokens | revoke the Cloudflare token and the Neon key you made in § 2 |
| Local | delete `launch.deploy.env`, `.launch/` and `apps/web/wrangler.deploy.toml`, after you're sure nothing else needs the key |

## 12. GitHub App webhooks

Launch polls GitHub: a landing checks its PR's CI every 30 s – 2 min, the merge commit's `Gate`, the
release and its tag's deploy run every 20 s – 2 min, and a cron sweeps every 5 minutes. With the App's
webhook on, GitHub tells Launch the moment a check finishes, a PR closes or a tag is pushed, and the
waiting landing reads GitHub straight away instead of at the end of its round. Polling stays: a
missed or refused delivery only means the round runs out as before.

An App created by `pnpm provision github-app` from this release on has the webhook already (and
`GITHUB_WEBHOOK_SECRET` in the file): skip to step 4. **An App created before** needs these steps,
in this order (the Worker must hold the secret before GitHub's first delivery, or the first deliveries
answer 503 — harmless, but noisy in Recent Deliveries).

1. **Deploy this release** (`pnpm provision all`, or `pnpm provision deploy` after `pnpm provision
   migrate`). It applies migration `0044` (`github_webhook_deliveries`, the delivery dedupe) and
   ships `POST /api/github/webhook`. Until step 2 the route answers 503 and nothing changes.
2. **Make a secret and put it on the Worker.** Generate one (`openssl rand -hex 32`), add it to
   `launch.deploy.env` as `GITHUB_WEBHOOK_SECRET=<value>`, and run `pnpm provision secrets` (it puts
   every optional secret set in the file). By hand instead, from the repo root after `pnpm provision
   render`: `pnpm --filter @launch/web exec wrangler secret put GITHUB_WEBHOOK_SECRET -c
   wrangler.deploy.toml` (it prompts for the value). A deployment from the committed tomls (the CI
   path) puts it on each Worker: `pnpm --filter @launch/web exec wrangler secret put
   GITHUB_WEBHOOK_SECRET` and the same with `-c wrangler.staging.toml`. Never in a toml.
3. **Configure the App** (you, an organization owner): github.com/organizations/&lt;org&gt;/settings/apps
   → the Launch app → **Edit**.
   - **General → Webhook**: tick **Active**. **Webhook URL**: `https://<LAUNCH_HOST>/api/github/webhook`
     (the instance's `APP_URL` plus that path — e.g. `https://launch.rocketflare.dev/api/github/webhook`).
     **Webhook secret**: the value from step 2. Keep **SSL verification** enabled. **Save changes**.
   - **Permissions & events → Subscribe to events**: tick **Check run**, **Workflow run**,
     **Pull request**, **Push** and **Release**. **Save changes**. Leave every permission as it is.
4. **No new permission.** Each event arrives under a permission the App already holds (Setup's check
   requires them): Check run → Checks, Workflow run → Actions, Pull request → Pull requests, Push and
   Release → Contents. Because no permission changes, the organization's installation has nothing to
   accept.
5. **Verify**: the App → **Advanced → Recent Deliveries**. Activating the webhook sends a `ping`: it should
   show **200** (`{"queued":false,"reason":"ping"}`). A 503 means the Worker has no secret yet (step 2),
   a 401 that the two secrets differ; fix it and **Redeliver**. After the next ship, `check_run` and
   `workflow_run` deliveries show **202** (`"queued":true`), and a delivery Launch does not need (a
   check that only started, say) **200** `"reason":"ignored"`. `wrangler tail -c wrangler.deploy.toml`
   shows `github.event: delivered` with how many landings it woke.

Rules that hold either way:

- **One App, one webhook URL.** A second instance (§ 8) has its own App and its own secret. Two
  instances sharing an App would deliver only to the one the App points at; the other keeps polling.
- **Rotating the secret**: put the new value on the Worker (step 2) and on the App (step 3) one after
  the other; deliveries in between answer 401 and the landings poll.
- **Turning it off**: untick **Active** on the App. Launch keeps working by polling; leaving
  `GITHUB_WEBHOOK_SECRET` set does no harm.

**Local development.** `wrangler dev` has no public URL, so locally Launch polls only: leave
`GITHUB_WEBHOOK_SECRET` blank in `apps/web/.dev.vars` (the route answers 503). To try webhooks
against your laptop, use a **separate development GitHub App** (repointing the instance's App takes
its webhooks away from the deployed Launch) and either:

- **the dev tunnel** (`SETUP.md` § 1.10): `pnpm dev:tunnel`, then `pnpm dev`; the App's Webhook URL is
  `<the tunnel's https URL>/api/github/webhook`; or
- **cloudflared** (`cloudflared tunnel --url http://localhost:3001` prints a `https://….trycloudflare.com`
  URL; use it with `/api/github/webhook`), or **smee** (create a channel at https://smee.io, set it as the
  App's Webhook URL, and run `npx smee-client --url https://smee.io/<channel> --target
  http://localhost:3001/api/github/webhook`).

Then set the dev App's webhook secret as `GITHUB_WEBHOOK_SECRET=` in `apps/web/.dev.vars` and restart
`pnpm dev`. Webhooks only matter with `SESSION_BACKEND=cloud` (real GitHub repos): the `local`
backend's git server sends none.
