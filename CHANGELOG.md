# Changelog

## Unreleased

- Launch is an OIDC issuer for the company's apps: discovery, JWKS with key rotation,
  authorize (PKCE S256 only), token (single-use codes; a replay revokes the first token),
  userinfo and logout. Each app has an access policy (everyone, or named groups and people),
  and a request-access page for anyone it leaves out. Every sign-in and decision is audited.
- Setup wizard (`/admin/setup`): the apps domain and zone, and the Cloudflare, Neon, Resend and
  GitHub App credentials, each sealed at rest, checked against the vendor, shown only as set /
  when / by whom, and audited.
- Seeded from Rocketflare 0.15.0.
- Branded as Launch by Rocketflare: the Rocketflare icon (tuned 16px favicon, PNG and
  apple-touch icons, a web manifest), a "by Rocketflare" line under the name, and the
  "Afterburner" light/dark theme (flame primary, violet accent, flame-gradient sign-in button,
  per-scheme `theme-color`) with a contrast test over every token pair.
- P1 foundation (slice 1a): the registry, OIDC, credential and audit tables in one migration;
  an append-only audit log (`GET /api/audit`, the Audit page); the sealed credential store and a
  GitHub App client; and the wiring the issuer, setup, import and catalogue slices build on —
  `/oidc` and `/.well-known` mounts, `/api/apps`, `/api/app-access`, `/api/admin/{setup,oidc}`,
  a five-minute health cron, and the Apps, Audit, Setup and Identity pages as placeholders.
