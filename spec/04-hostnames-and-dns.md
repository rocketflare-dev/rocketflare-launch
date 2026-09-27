# 4. Hostnames and DNS

Status: spec, not built.

## The company's domain

The company brings **one domain of its own**, and the setup wizard asks for it. These docs use
`apps.example.com` as a placeholder. The domain's zone must be in the **same Cloudflare account**
as Launch. The wizard checks this, and checks that the admin token has DNS and Workers Routes
permissions on the zone.

## Decision: subdomains

| Host | What |
|---|---|
| `apps.example.com` | Launch: the console and the OIDC issuer |
| `<slug>.apps.example.com` | an app's production environment |
| `<slug>.staging.apps.example.com` | an app's staging environment |
| `<session>.preview.apps.example.com` | a coding session's live preview, if the sandbox preview URLs can use a custom hostname ([07](07-coding-sessions.md)) |

Each app hostname is a **Workers Custom Domain** (`routes = [{ pattern, custom_domain = true }]`
in the app's toml). Cloudflare creates the DNS record and issues a certificate for that host.

**Reserved slugs**: `www`, `staging`, `preview`, `api`, `auth`, `launch`, `admin`, `mail`, and
anything the company adds. Slugs are also unique across the registry, because the slug is the
naming key for every Cloudflare and Neon resource ([06](06-registry-and-pipeline.md)).

## Why not paths (`apps.example.com/my-app/`)

**Rejected.** Path routing puts every app on **one origin**:

- Cookies, `localStorage`, IndexedDB and service workers are per origin. Any app could read or
  overwrite another app's state, and one app's XSS would compromise them all. Subdomains give each
  app its own origin, and Rocketflare's `__Host-session` cookie is host-only by construction.
- It needs a dispatcher Worker in front of every request, which becomes a shared point of failure
  and a bottleneck for latency.
- Every app would have to be rebased under a prefix: the Vite `base`, the static-assets
  catch-all, `/api`, `/auth`, `/ws`, OAuth redirect URIs and hard-coded links. Rocketflare assumes
  `/` throughout, so each app would permanently diverge from its template.

## Email

Each app sends from its own subdomain (`noreply@<slug>.apps.example.com`). Launch creates the
Resend domain, writes its DKIM, SPF and return-path records into the zone, verifies it, then mints
a sending key **bound to that one domain**.

*Rejected: one shared sending domain.* A Resend key can be bound to a domain, not to a sender
address, so a shared domain would let any app send as any other app.

## To verify before P2

1. **Certificates for two-level hostnames.** Universal SSL covers the apex and one level
   (`*.example.com`). `x.apps.example.com` is two levels deep. Cloudflare says Workers Custom
   Domains issue a certificate per hostname, which should cover it, but that needs a spike on a
   real zone, including staging's three levels. **Fallbacks, in order:**
   - flatten the scheme: `<slug>.example-apps.com` on a dedicated apps domain, with staging as
     `<slug>-staging.…`;
   - buy Advanced Certificate Manager.
2. **Scale.** The per-account limits on Workers scripts and custom domains, compared with the
   expected fleet size.
3. **Email DNS verification time.** It is handled asynchronously in the pipeline, with retries,
   rather than blocking ([06](06-registry-and-pipeline.md)).

## Known gaps

- No vanity domains per app (`hr.example.com`). This is possible later as an extra custom domain
  plus an extra OIDC redirect URI.
- No zone outside the Launch account.
