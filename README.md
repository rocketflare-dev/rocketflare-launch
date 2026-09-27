# Rocketflare Launch

**Status: a spec for feasibility review. Nothing is built yet.** Written September 2026. The
external APIs it relies on were checked against vendor docs at that time; see
[spec/sources.md](spec/sources.md).

Launch is an internal developer platform for companies that run on Cloudflare: Lovable, but for
the enterprise. Each company runs its own Launch at one URL, `apps.example.com` in these
docs (the company picks the real domain). Anyone in the company can go there to:

- **see** every app the company runs, with its owner, health, version and URLs;
- **create** a new app. Launch creates the GitHub repo, the Neon database, the Cloudflare
  resources, the email domain and the sign-in client, then deploys it to
  `<slug>.apps.example.com`;
- **build** the app in AI coding sessions (Claude Code in a Cloudflare Sandbox) with a live
  preview; each session ends as a pull request;
- **ship** it: staging on merge, then production once an approval in Launch is granted;
- **share** centrally managed config and secrets, such as the company's M365 connection, with the
  apps that ask for them and are approved to have them.

Launch is a separate product from [Rocketflare](https://github.com/rocketflare-dev/rocketflare).
Rocketflare is the first **app template** Launch can create and manage. Launch talks to it only
through a small, versioned contract made of files and endpoints a Rocketflare app already
exposes. Launch never imports Rocketflare code, and Rocketflare never has to know about Launch.

## Key decisions

| # | Decision | Rejected alternatives | Spec |
|---|---|---|---|
| 1 | **One Launch per company**, deployed into that company's Cloudflare account. The admin credentials never leave it. | A hosted service serving many companies, which would hold every customer's admin keys | [01](spec/01-overview.md) |
| 2 | **Separate product.** It may be seeded from the kit once, and after that it owns its code | Launch as a copy of the kit that tracks kit upgrades; Launch as a kit plugin | [01](spec/01-overview.md) |
| 3 | **Template adapter contract** between Launch and each app template; Rocketflare is adapter v1 | Importing the kit's provisioning code | [02](spec/02-template-contract.md) |
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
