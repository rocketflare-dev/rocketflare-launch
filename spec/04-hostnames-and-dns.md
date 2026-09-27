# 4. Hostnames and DNS

Status: spec, not built.

## The apps domain

The company brings **a dedicated domain for its apps**, separate from its main public domain, and
the setup wizard asks for it. These docs use `company-apps.com` as a placeholder. The domain's zone
must be in the **apps account** ([01](01-overview.md)), because Worker routes can only point at
Workers in the zone's own account. The wizard checks this, and checks that the admin token has DNS
and Workers Routes permissions on the zone.

**Launch's own hosts.** With the recommended separate Launch account, Launch needs a zone in *its*
account, for example `company-launch.com`: `launch.company-launch.com` for the console and OIDC
issuer, and `*.company-launch.com` for session previews ([07](07-coding-sessions.md)). Previews
then sit on a different *site* from the apps, which is better isolation too. With a single account,
Launch uses `launch.company-apps.com` and the catch-all route below, as in the table.

A dedicated domain keeps app names out of the corporate namespace, keeps app cookies well away
from the company's main site, and makes every host below **first-level**, so the zone's Universal
SSL wildcard (`*.company-apps.com`) covers all of them at no extra cost.

## Decision: flat, first-level subdomains

| Host | What |
|---|---|
| `launch.company-launch.com` (or `launch.company-apps.com` with one account) | Launch: the console and the OIDC issuer |
| `<slug>.company-apps.com` | an app's production environment |
| `<slug>-staging.company-apps.com` | an app's staging environment |
| `<port>-<sandbox>-<token>.company-launch.com` (or `.company-apps.com` with one account) | a coding session's live preview ([07](07-coding-sessions.md)) |
| `notifications.company-apps.com` | the one sending domain for every app's email |

**Routing.** The zone has one proxied wildcard DNS record (`*`). Each app environment is a
**Worker route** (`<slug>.company-apps.com/*`), and Launch holds a catch-all route
(`*.company-apps.com/*`) for previews and for unknown hosts. The more specific route wins, so an
app's own route always beats the catch-all.

*Rejected: a Workers Custom Domain per app host.* Custom Domains can't be wildcards, issue a
certificate per host (a wait on every create), and are capped at **100 per zone**, so 50 apps.
Routes are capped at 1,000 per zone, and the wildcard certificate already covers them.

**Launch owns the routes, not the app.** A route permission is zone-wide, so a deploy token that
could edit routes could take over another app's hostname. Launch creates and deletes each app's
routes over the API with its admin token, and apps deploy only through Launch
([08](08-approvals-audit-ship.md)). The app's tomls carry `workers_dev = false` and no `routes`,
so a deploy from the repo, with or without Launch, leaves the routes as they are.

**Slug rules.** Every resource is named after the slug ([06](06-registry-and-pipeline.md)), and
the flat scheme puts slugs, staging hosts and preview hosts in one label space, so:

- a slug starts with a letter (preview hosts start with a port number);
- a slug may not end in `-staging`;
- reserved: `launch`, `notifications`, `www`, `api`, `auth`, `admin`, `mail`, and anything the
  company adds;
- slugs are unique across the registry.

## Cookies and sites

Every app host is its own **origin**, so cookies, `localStorage`, IndexedDB and service workers are
isolated between apps. Launch's session cookie is host-only on Launch's host, and
Rocketflare's `__Host-session` is host-only by construction, so no app can read or overwrite
another's session.

All the hosts are the same **site** (`company-apps.com`), though. `SameSite=Lax` therefore does not
stop one app from sending credentialed requests to another. Apps must check `Origin` on
state-changing requests rather than rely on `SameSite` (to confirm in the kit).

## Why not paths (`apps.company-apps.com/my-app/`)

**Rejected.** Path routing puts every app on **one origin**:

- Cookies, `localStorage`, IndexedDB and service workers are per origin, and a cookie `Path` is not
  a security boundary: a script on `/app-a/` can read `/app-b/`'s state through a same-origin
  iframe. One app's XSS would compromise them all. Rocketflare's `__Host-session` also requires
  `Path=/`, so every app would have to rename its cookie.
- Every app would have to be rebased under a prefix: the Vite `base`, the static-assets
  catch-all, `/api`, `/auth`, `/ws`, OAuth redirect URIs and hard-coded links. Rocketflare assumes
  `/` throughout, so each app would permanently diverge from its template.
- It doesn't help session previews, which need their own hostnames anyway.

(It would not need a dispatcher Worker: zone routes can match paths. That is not the reason it
was rejected.)

## Email

Every app sends from the one domain `notifications.company-apps.com`, verified once in the setup
wizard, with its own address and display name:
`"Expense Tracker" <expense-tracker@notifications.company-apps.com>`. Each app gets its own
Resend `sending_access` key **bound to that domain**, so one app's key can be revoked or rotated on
its own.

*Rejected: a Resend domain per app.* Each create would wait on DNS verification, and Resend caps
domains per plan (10 on Pro), which caps the fleet.

**Known trade-off.** A Resend key can be bound to a domain, not to a sender address, so a
compromised app could send as another app's address. The apps are all internal to one company,
and v1 accepts this. **It can't be detected afterwards either**: Resend's email records don't say
which key sent them ([S4](../spikes/s4-resend-shared-domain/RESULT.md)). All apps also share one
sending reputation. A later option is Cloudflare Email
Service, whose `send_email` binding restricts each Worker to its own sender address
(`allowed_sender_addresses`) with no key at all. It would change the template contract
([02](02-template-contract.md)).

## To verify before P2

1. **Routes on the wildcard.** Per-app routes beat Launch's catch-all; Universal SSL serves every
   first-level host; a `wrangler deploy` with no `routes` leaves Launch-created routes alone
   (spikes S1, S2).
2. **Scale.** The per-account limits compared with the expected fleet size
   ([spikes/s0-limits](../spikes/s0-limits/RESULT.md)).

## Known gaps

- No vanity domains per app (`hr.example.com`). This is possible later as a Custom Domain plus an
  extra OIDC redirect URI.
- No zone outside the Launch account.
