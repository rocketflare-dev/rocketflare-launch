# Rocketflare Launch

**Unlock your builders, safely.**

Launch is the company console for [Rocketflare](https://rocketflare.dev) ([GitHub](https://github.com/rocketflare-dev/rocketflare))
apps. Anyone can go from an idea to a secure, production app in the browser, while IT keeps
control of credentials, sign-in, approvals and audit.

> Status: **spec for feasibility review, nothing built** (September 2026).

## Why

Rocketflare already makes one app fast to build: multi-tenant auth, Postgres, queues, AI and
agent context on Cloudflare. At company scale, the hard part is everything around each app:
accounts, databases, DNS, secrets, sign-in, deploys, approvals, upgrades. Launch does that part,
so that:

- **Building is self-service.** Describe a change, watch it in a live preview, and ship a pull
  request. Claude Code runs in a Cloudflare Sandbox against the app's real repo.
- **Every app is production-grade from day one.** Each app gets its own repo, Worker, Neon
  database, email domain and `<slug>.apps.<your-domain>` host. They are all set up by Launch and
  all on the company's own Cloudflare account.
- **IT stays in control.** Admin credentials never leave Launch, and each app gets narrowly scoped
  ones. There is one company sign-in across every app. Production deploys and access to shared
  secrets, such as the M365 connection, need an approval in Launch, and all of it is in one audit
  log.
- **The fleet stays current.** Kit upgrades, credential rotation and teardown are run across every
  app by Launch.

## Launch and Rocketflare

**Rocketflare is the only app template Launch creates and manages**: Launch is built for
Rocketflare apps. Every app Launch creates is a normal Rocketflare copy that keeps working, and
can still be deployed from its repo, without Launch.

The two are released separately. Launch drives apps through the files and endpoints every
Rocketflare app already has (`.rocketflare.json`, the wrangler tomls, the deploy workflow, the
health endpoints, plugin manifests). It doesn't import kit code, so each can ship on its own
schedule ([spec/02](spec/02-template-contract.md)).

## Key decisions

| # | Decision | Rejected alternatives | Spec |
|---|---|---|---|
| 1 | **One Launch per company**, deployed into that company's Cloudflare account. The admin credentials never leave it. | A hosted service serving many companies, which would hold every customer's admin keys | [01](spec/01-overview.md) |
| 2 | **Built for Rocketflare, released separately.** Seeded from the kit once, then it owns its code | Launch as a copy of the kit that tracks kit upgrades; Launch as a kit plugin | [01](spec/01-overview.md) |
| 3 | **A versioned Rocketflare contract** (files and endpoints every app has) is the only coupling | Importing the kit's provisioning code | [02](spec/02-template-contract.md) |
| 4 | **Admin credentials stay in Launch.** Each app gets derived, narrowly scoped credentials: a token for its own Worker only, a key for its own Neon project, a sending key for its own email domain | Handing out shared account tokens | [03](spec/03-trust-and-credentials.md) |
| 5 | **Subdomains**: `<slug>.apps.example.com`, each app its own origin | Path routing (`apps.example.com/my-app/`) | [04](spec/04-hostnames-and-dns.md) |
| 6 | **Launch is the company's OIDC sign-in provider.** Google or Microsoft is configured once, every app signs in through Launch, and access is set per app | A shared parent-domain cookie; Cloudflare Access as the main login | [05](spec/05-identity-sso.md) |
| 7 | **Creating an app is a durable Workflow** of idempotent steps that can pause for approval | Running the kit's local provisioning script remotely | [06](spec/06-registry-and-pipeline.md) |
| 8 | **Coding sessions use the Claude Agent SDK on Cloudflare Sandbox**, with a live preview; each session ends in a PR | Claude Managed Agents (beta, not eligible for Zero Data Retention) | [07](spec/07-coding-sessions.md) |
| 9 | **Approvals and audit live in Launch; GitHub carries out the decision.** A custom deployment protection rule gates production | Required reviewers configured only inside GitHub | [08](spec/08-approvals-audit-ship.md) |
| 10 | **Shared config and secrets are granted, not copied.** An app requests a bundle, its owner approves, and Launch pushes the values and re-pushes them on rotation | Apps fetching config from Launch at runtime | [09](spec/09-config-and-grants.md) |

## Architecture

```
                         apps.example.com  (Launch — one Worker in the company's CF account)
  ┌───────────────────────────────────────────────────────────────────────────────────────┐
  │ Console UI        catalogue · create app · sessions · approvals inbox · grants · audit │
  │ OIDC issuer       /oidc/authorize /token /userinfo /jwks — Google/Microsoft upstream     │
  │ Registry (PG)     apps · app_environments · oidc_clients · grants · approvals · audit   │
  │ Workflows         APP_LAUNCH · APP_TEARDOWN · GRANT_PUSH · ROTATE                        │
  │ SessionDO ─┬─►    Cloudflare Sandbox: repo clone · Postgres · `pnpm dev` · Claude Code   │
  │            └─►    live preview URL · event stream to the browser                        │
  │ Admin secrets     CF account token · Neon org key · Resend key · GitHub App · Anthropic  │
  └──────┬──────────────┬───────────────┬───────────────┬───────────────┬─────────────────┘
         │ REST         │ REST          │ REST          │ App API +      │ OIDC
         ▼              ▼               ▼               ▼ webhooks       ▼
   Cloudflare API    Neon API       Resend API       GitHub           each app
   (Workers, KV,     (project per   (domain + key   (repo per app,   <slug>.apps.example.com
    Queues, R2,       app, branch    per app)         Actions deploy,  own Worker · own DB ·
    Hyperdrive, DNS,  per env)                        protection rule) own session cookie
    tokens, secrets)
```

## Roadmap

| Phase | Delivers | Exit test |
|---|---|---|
| P0 | This spec | Reviewed; the open questions have owners |
| P1 | Setup wizard (domain, IdP, OIDC issuer), registry, import of existing Rocketflare apps, audit log | An existing app is listed with live health, and its users sign in through Launch |
| P2 | Rocketflare adapter and the create-app pipeline | "Create app" leads to a live `<slug>.apps.example.com` with no terminal |
| P3 | Coding sessions: sandbox, live preview, PR | A non-engineer changes a screen and opens a PR from the browser |
| P4 | Approvals engine; production gated from Launch | A production deploy waits for, and is released by, an approval in Launch |
| P5 | Grant catalogue and rotation | An app requests M365, is approved, receives the secret; one rotation updates every holder |
| P6 | Fleet upgrades and teardown | One click opens upgrade PRs across the fleet; an archived app leaves no resources behind |

Details: [spec/11-roadmap.md](spec/11-roadmap.md).

## Biggest open questions

- **GitHub Enterprise.** Custom deployment protection rules on private repos need it. There is a
  fallback that dispatches the deploy only after approval, but it is weaker.
- **Two-level hostnames.** Do Cloudflare Custom Domain certificates cover
  `<slug>.apps.example.com`, or does it have to flatten to `<slug>-apps.example.com`?
- **The OIDC issuer.** Build it on OpenAuth or hand-roll it on `jose`? And should Rocketflare add
  a generic OIDC login of its own accord?
- **Session cost policy.** Budgets per session, per team and per month.

All of them: [spec/12-open-questions.md](spec/12-open-questions.md).

## Spec index

1. [Overview and boundary with Rocketflare](spec/01-overview.md)
2. [The app-template contract](spec/02-template-contract.md)
3. [Trust model and credentials](spec/03-trust-and-credentials.md)
4. [Hostnames and DNS](spec/04-hostnames-and-dns.md)
5. [Identity and single sign-on](spec/05-identity-sso.md)
6. [App registry and the launch pipeline](spec/06-registry-and-pipeline.md)
7. [Coding sessions](spec/07-coding-sessions.md)
8. [Approvals, audit and shipping](spec/08-approvals-audit-ship.md)
9. [Shared config and secret grants](spec/09-config-and-grants.md)
10. [Fleet operations](spec/10-fleet-operations.md)
11. [Roadmap](spec/11-roadmap.md)
12. [Open questions](spec/12-open-questions.md)
13. [Sources](spec/sources.md)
