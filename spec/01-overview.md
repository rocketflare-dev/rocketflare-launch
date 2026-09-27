# 1. Overview and boundary with Rocketflare

Status: spec, not built.

## What Launch is

Launch is the control plane for a company's internal apps. It holds:

- **the fleet**: a registry of every app, its environments, resources, owners and health;
- **the admin credentials**: the Cloudflare account, the Neon organisation, Resend, a GitHub App
  and Anthropic. Every app is built from these, and none of them is ever handed to an app
  ([03](03-trust-and-credentials.md));
- **identity**: the company's single sign-on for every app ([05](05-identity-sso.md));
- **change control**: approvals, audit, and shared config and secrets
  ([08](08-approvals-audit-ship.md), [09](09-config-and-grants.md));
- **the build surface**: AI coding sessions against each app's repo ([07](07-coding-sessions.md)).

Each app is an ordinary, independent deployment: its own GitHub repo, its own Worker, its own
Neon project and its own hostname. If Launch disappeared, every app would keep running and could
still be deployed from its repo by hand.

## One Launch per company

Launch is deployed **into the company's own Cloudflare**, with one instance per company. This
decides the trust model.

**Two accounts are strongly recommended**, both owned by the company: a **Launch account** for
Launch's own Worker, database and storage, and an **apps account** where every app's Workers and
resources live. Any Worker in an account can bind any resource in that account, whatever the
deploying token was scoped to ([S1](../spikes/s1-worker-token/RESULT.md)). Keeping Launch in its own
account means nothing an app deploys can reach Launch's database or storage. A single account also
works; it is then only as safe as Launch's deploy checks ([08](08-approvals-audit-ship.md)). The account token, the Neon organisation key and the Resend key are
the most powerful credentials the company owns, and here they never leave its infrastructure.

It also makes Launch single-tenant: the company is the only tenant. Teams inside the company are
Launch's grouping unit, used for ownership, approval policies and app access.

*Rejected: a hosted service serving many companies.* That is closer to Lovable, but it would hold
every customer's admin credentials. That is a compliance and blast-radius problem, and no
enterprise security review would pass it at this stage. It can be reconsidered once the
single-company product has proven itself.

## Launch is its own product

Launch is a separate repository, release train and data model. It is **not** a Rocketflare copy
that follows kit upgrades, and it is **not** a Rocketflare plugin:

- A plugin is a feature inside one tenant-scoped app. Launch is a platform over many apps, and it
  needs container bindings, which plugins can't declare.
- Launch will grow things that have no reason to exist in the kit: fleet operations, approvals,
  grants, sessions and billing. Tying it to the kit's release cadence and upgrade tooling would
  slow down both projects.

Two directions of independence, both rules:

1. **Launch never imports Rocketflare code.** It depends only on the published
   [template contract](02-template-contract.md): files and endpoints any Rocketflare app has.
2. **Rocketflare never references Launch.** Whatever Launch needs from an app has to be something
   worth having in the kit anyway, such as a generic OIDC login ([05](05-identity-sso.md)).

## How the Launch codebase starts

**Recommended: seed from Rocketflare once, then cut the cord.** Run the kit's installer and
rename it to `launch`, then delete everything that ties it to the kit:

- `.rocketflare.json` (Launch keeps a `launch.plugins.json` that records only its plugins),
- the `kit-update-check` SessionStart hook,
- the kit's upgrade and release tooling, and the `rf-upgrade` skill.

Launch keeps the plugin barrels and tooling, because it uses the analytics plugin.

From that commit on it is Launch's own code. It gets the parts that take weeks to build for free:

- sessions, Google and Microsoft login, and API keys,
- Drizzle over the Neon serverless driver (`DATABASE_DRIVER=neon`), with Launch's own `launch`
  database and role in a Neon project. Launch doesn't use Hyperdrive, and neither do the apps it
  creates ([02](02-template-contract.md)),
- Queues, Workflows and Durable Objects wiring,
- sealed secrets,
- the AG-UI event rendering (useful for session transcripts),
- the approval, interrupt and activity patterns,
- the two-toml deploy flow.

The cost is inheriting code Launch will later diverge from. Nothing flows back automatically; a
useful later kit fix gets ported by hand, the same as any fork.

*Alternative: a fresh Hono and React Worker.* It is cleaner, but slower to reach phase 1, and
most of what would be written is what the kit already has.

## Who uses it

| Persona | Uses Launch to |
|---|---|
| Anyone in the company | find apps they can use and sign in to them |
| App builder (engineer or not) | create an app, run coding sessions, open PRs |
| App owner | approve production releases, request grants, manage access |
| Resource owner (e.g. the M365 admin team) | approve or revoke grants of the shared config they own |
| Platform admin | configure the domain, IdP and admin credentials; set policies; read the audit log |

## Known gaps

- There is no multi-cloud or multi-account story: one Cloudflare account per Launch.
- There is no billing or chargeback beyond a cost view ([10](10-fleet-operations.md)).
- Only Rocketflare apps. There are no mobile or desktop targets, and no other app templates.
