# 5. Identity and single sign-on

Status: spec, not built.

## Goal

The platform admin configures sign-in **once**, on Launch, with Google Workspace or Microsoft
Entra. Everyone then uses their company identity to sign in to Launch **and** to every app. Launch
decides who may use which app, and records it.

## Decision: Launch is an OIDC issuer

Launch is an OpenID Connect provider at `https://apps.example.com`, and every app is an OIDC
client that Launch registers automatically when it creates the app.

```
user ──► <slug>.apps.example.com/login
          └─► 302 apps.example.com/oidc/authorize?client_id=…&code_challenge=…&redirect_uri=…
                 ├─ no Launch session? → upstream Google/Microsoft sign-in → Launch session
                 ├─ access policy for this app? deny → "request access" page (an approval, 08)
                 └─ allow → 302 back with ?code=…
          ◄── app POST /oidc/token (code + PKCE verifier + client secret) → id_token
          app verifies id_token against /.well-known/jwks.json → mints ITS OWN host-only session
```

If the user already has a Launch session, they go straight back to the app: single sign-on with
no prompt. Each app still owns its own session cookie on its own origin
([04](04-hostnames-and-dns.md)), so the apps stay isolated from each other.

### What Launch provides

- Discovery (`/.well-known/openid-configuration`), `/oidc/authorize`, `/oidc/token`,
  `/oidc/userinfo`, `/.well-known/jwks.json`, and RP-initiated logout (`/oidc/logout`).
- Only the authorization code flow with PKCE. No implicit or hybrid flows.
- Signing keys (ES256) held as Launch secrets. There is a rotation overlap: the old key stays in
  JWKS until the maximum token lifetime has passed.
- Claims:
  - `sub`: a stable Launch user id, not the email address;
  - `email`, `email_verified`, `name`;
  - `groups`: the user's Launch teams.

  Optionally, a later `app_role` per app (below).
- **Access policy per app**, checked at `/authorize`: everyone in the company, named teams, or
  named people. A denied user can **request access**, which becomes an approval for the app owner
  ([08](08-approvals-audit-ship.md)). Every grant, denial and sign-in is written to the audit log.

### What each app does

- It reads `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, which Launch sets during
  app creation ([06](06-registry-and-pipeline.md)).
- It turns off its other sign-in methods, or keeps magic link as an option for external guests.
- It maps `sub` or email to its own user. For Rocketflare in single-tenant mode, the user joins
  the one tenant automatically.

For Rocketflare this needs a **generic OIDC provider** in the kit, which it doesn't have today
([02](02-template-contract.md)).

### Roles

Phase 1: Launch decides **whether** someone may use an app; the app decides **what** they may do
(its own owner, admin and member roles).

Later, an optional `app_role` claim lets Launch assign an app role centrally. The app applies it
on each sign-in, so role changes flow from Launch. Adding it later doesn't change the design.

### Logout

The app logs out locally and can redirect to `/oidc/logout` to end the Launch session as well.
Back-channel logout, where Launch tells every app to drop a user's sessions, is a later phase. It
matters for offboarding. Until then, app sessions are kept short and are refreshed silently
through Launch, so an offboarded user loses access when their next refresh fails.

## Rejected alternatives

- **A shared parent-domain cookie (`Domain=.apps.example.com`).** Every app could read and replay
  it, so one compromised app would compromise every account. It is also incompatible with
  `__Host-` cookies.
- **Cloudflare Access as the primary login.** It is configured once and works for any app, but it
  ties the design to Zero Trust seat licensing. Each app would still need to map the Access JWT to
  a user, and it gives Launch no place to run access requests or approvals. **It is kept as an
  optional extra layer**: Launch can put a network gate in front of an app (for example, only
  managed devices) as well as OIDC.
- **An OAuth client per app at Google or Microsoft.** Google has no API to create OAuth clients.
  Microsoft Graph can create app registrations, but every app would then have its own consent
  screen and its own admin consent. One upstream client, on Launch, avoids both problems.

## Build choice (open)

| Option | For | Against |
|---|---|---|
| `@openauthjs/openauth` | Runs on Workers; has provider adapters; less to write | How complete its OIDC support is (discovery, `id_token`, logout) needs checking; a library to follow |
| A small issuer on `jose` | Exactly the spec subset above; easy to audit | We own the security surface: PKCE, code replay, key rotation |

**Recommendation:** spike OpenAuth first. Fall back to `jose` if it can't produce a standard
`id_token` and discovery document.

## Known gaps

- No SCIM. The user list comes from sign-ins. Directory sync, which would remove users before
  their next sign-in, is later work, and could reuse Rocketflare's connector design for M365 and
  Google.
- No per-app MFA step-up.
- CLI and API access to apps still uses each app's own API keys, not Launch tokens.
