# Security Policy

## Supported versions

Launch is pre-release. Security fixes land on `main`; there are no maintained release lines. Launch
was seeded from the Rocketflare kit and does not track it: a kit security fix that applies here is
ported by hand.

## Reporting a vulnerability

Please **do not** open a public issue for anything exploitable. Use GitHub's private reporting:
[Report a vulnerability](https://github.com/rocketflare-dev/rocketflare-launch/security/advisories/new).
Include the subsystem (auth, tenancy, files, AI, analytics…), reproduction steps and the impact you
believe it has. You will get an acknowledgement, and a fix or a reasoned response, before anything is
made public.

Anything non-sensitive (a hardening suggestion, a missing header, a dependency advisory) is fine as
an [ordinary issue](https://github.com/rocketflare-dev/rocketflare-launch/issues/new) titled "Security: ".
