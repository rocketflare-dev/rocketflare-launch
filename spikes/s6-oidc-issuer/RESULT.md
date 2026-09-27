# S6: the OIDC issuer

Status: **done (2026-09-27)**. Verdict: **OpenAuth: no. A small issuer on `jose`: yes**. It passed a
standard OIDC client, 15 of 15 checks, on two consecutive runs.

## OpenAuth isn't an OpenID Connect provider

Read from the published package (`@openauthjs/openauth` 0.4.3, `dist/esm/issuer.js`):

- `/token` returns `access_token` and `refresh_token` only. There's **no `id_token`**. Its
  `id_token` handling is for consuming *upstream* providers (`provider/oidc.js`).
- It publishes `/.well-known/oauth-authorization-server`, **not
  `/.well-known/openid-configuration`**.
- There's **no `userinfo`** and **no `end_session`**.
- The last release was **March 2025**. Mid-2025 OIDC pull requests (#283, #296) are still open.

A Rocketflare app, or any off-the-shelf OIDC client, can't use it as an issuer without us adding
the OIDC layer ourselves. At that point it brings nothing `jose` doesn't.

## The `jose` issuer

[issuer/src/index.js](issuer/src/index.js): **208 lines**, `jose` only, on a Worker with one Durable
Object for single-use codes. It implements exactly the spec/05 subset:

- discovery and JWKS;
- `authorize`: code flow only, PKCE S256 required, `iss` on the response;
- `token`: `client_secret_basic` or `client_secret_post`;
- an ES256 `id_token` carrying `sub`, `email`, `email_verified`, `name`, `groups`, `nonce` and
  `auth_time`;
- `userinfo`;
- `end_session`.

The upstream Google/Microsoft sign-in was stubbed.

Checked with **`openid-client` 6.8** acting as the app ([run.mjs](run.mjs)):

| Check | Result |
|---|---|
| Discovery accepted by openid-client | ✅ |
| Code flow: openid-client validates the id_token (ES256 signature, `iss`, `aud`, `exp`, `nonce`, and `iss` on the redirect) | ✅ |
| `userinfo` returns the same subject | ✅ |
| Replayed code | ✅ `invalid_grant` |
| Wrong PKCE verifier | ✅ `invalid_grant` |
| Wrong client secret | ✅ 401 `invalid_client` |
| App B redeeming app A's code | ✅ `invalid_grant` |
| Unregistered `redirect_uri` | ✅ error page, **no redirect** |
| No PKCE | ✅ `invalid_request` |
| Per-app access policy (bob, in `eng`, denied a `finance`-only app) | ✅ `access_denied` |
| **Single sign-on**: alice's existing Launch session signs her in to app B with no prompt | ✅ |
| No Launch session → sent to sign in | ✅ |
| Tampered id_token fails against the JWKS | ✅ |
| Logout clears the Launch session and returns to the registered URI | ✅ |
| Logout never redirects to an unregistered URI | ✅ |

The first run failed once at the token endpoint, and the failure didn't reproduce. The likely
cause: the Worker's secrets (signing key, session secret) are set just after deploy, and discovery,
which doesn't need them, answered before they had propagated. Launch's own deploy should set
secrets **before** routing traffic to the issuer.

## What "we own the security surface" means in practice

It was about 200 lines, and a strict RP found nothing. What remains for a production issuer:

- the real upstream sign-in (Google/Microsoft via arctic, as the kit already does);
- **signing-key rotation**: publish the next key in JWKS before using it, and keep the old one
  until the longest token expires;
- **refresh tokens** or silent re-auth for short app sessions (spec/05);
- **revoking tokens issued from a replayed code** (RFC 6749 §4.1.2). The spike refuses the replay
  but doesn't revoke the first tokens;
- the "request access" page instead of an `access_denied` redirect;
- **conformance**: run the OpenID Foundation's Basic OP certification suite against it before
  P1 exits.

## Recommendation

**Build the issuer on `jose`** (spec/05 "Build choice" → decided). Keep it to the spec/05 subset.

On spec/12 question 4 (a generic OIDC login in the kit): an off-the-shelf OIDC client worked
unchanged against this issuer, so the kit's `oidc` provider can be a plain one on arctic's generic
OAuth2 client + `jose`, with nothing Launch-specific in it.
