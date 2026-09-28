# Build status

Paused on 2026-09-28, after P5.

**Where the code is.** Everything is on the local branch `phase-5-grants`. Each phase branch is stacked on the one before it:

```
main → phase-0-seed → phase-1-foundation → … → phase-5-grants
```

Nothing has been pushed, merged into `main` or deployed.

**Status.** Every phase below is built and tested locally against fakes: FakeCloud, FakeSandbox and a fake Anthropic. The gate is green:
- lint;
- typecheck;
- tests: web about 2,900, CLI 104, evals 22;
- `build:ui` and `build:api`.

## Phases

| Phase | Plan | State |
|---|---|---|
| P0 | seed, cut the cord, brand | Done. Seeded from Rocketflare 0.15.0 with the Afterburner theme; analytics kept. |
| P1 | [p1-foundation](p1-foundation.md) | Built. Covers the audit log, setup wizard, OIDC issuer, registry/import and health. The local end-to-end test passed with a real kit app signing in through Launch. |
| P2 | [p2-create-app](p2-create-app.md) | Built. Covers the adapter, scaffold job, the APP_LAUNCH/APP_TEARDOWN workflows and the deploy gateway. End-to-end test against FakeCloud with the real `deployer.mjs`. |
| P3 | [p3-sessions](p3-sessions.md) | Built. Covers sandbox sessions, model proxy and budgets, preview gateway, and ship → PR. End-to-end test with fakes. A real local container booted before the merge, but no real model turn has run (no Anthropic key yet). |
| P4 | [p4-approvals](p4-approvals.md) | Built. Covers the approvals engine and inbox, releases → promote → production gate, and the audit hash chain. The exit test passes. |
| P5 | [p5-grants](p5-grants.md) | Built. Covers shared config, grant requests, push/rotate/revoke (with the 10053 var-shadow remedy) and needs detection. The exit test passes. |
| P6 | — | Not started: fleet upgrades, teardown at scale, cost view, per-PR previews ([spec/10](../../spec/10-fleet-operations.md)). |

Known gaps for each phase are in [docs/CONCEPTS.md](../CONCEPTS.md) §18. Kit issues are in [upstream-kit-issues.md](upstream-kit-issues.md). Three are filed:
- rocketflare #37 and #38;
- rocketflare-plugins #8.

The rest are unfiled.

## What remains

1. **Deploy Launch (P1 step 1e).** This needs the user's go-ahead.
   - Launch goes to `launch.clewro.com`, in the single `clewro.com` account.
   - The database is a `launch` database and role in an existing Neon project, with `DATABASE_DRIVER=neon`.
   - Set secrets before routing traffic to it.
   - Then finish the setup wizard against the real accounts. The Neon region check and the auto-created wildcard DNS record are already fixed.
2. **Prove each phase on real infrastructure.** Each plan's "What is left for real infrastructure" section lists the checks. The main ones:
   - Neon: `GRANT migrator TO app`.
   - Cloudflare:
     - the Versions API and `keep_bindings`;
     - DO migrations on a placeholder Worker;
     - the 10053 name-clash behaviour;
     - git through `interceptHttps`;
     - Vite HMR through the preview.
   - GitHub:
     - the App's permissions;
     - pushing workflow files with an installation token;
     - the OIDC claim shapes.
   - A real Claude turn in a session, with an Anthropic key.
3. **Local session check on the merged tree.** Set the `SESSION_*` values in `apps/web/.dev.vars`, following [SESSIONS-LOCAL.md](../SESSIONS-LOCAL.md). Also set `GRANT_BACKEND=local` there, so local grant pushes don't call the real Cloudflare API.
4. **P6: fleet operations.** Plan it the same way:
   - write the plan doc;
   - build a foundations slice first;
   - build the rest as parallel slices in worktrees;
   - finish with an integration pass and an exit test.
5. **Housekeeping.**
   - Decide how the stacked phase branches reach `main`: one PR per phase, or squash.
   - File the remaining kit issues.
   - Replace the kit's example agents (`summarize-text`, `research-topic`) once Launch has a real agent.

## Local dev notes

- `pnpm dev:tunnel` runs only the tunnel (cfld). `pnpm dev` switches to the tunnel URL while that tunnel is up.
- **cfld cert zone.** cfld routed `local.clewro.com` with the `guidemode.dev` cert, which created `local.clewro.com.guidemode.dev`. Fix it with `pnpm web exec cfld login --reauth` for `clewro.com`, then restart the tunnel. Delete the stray record in the `guidemode.dev` zone.
