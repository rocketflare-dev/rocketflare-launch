# 12. Open questions

Each question has a recommendation where there is one. The spikes are in [P0](11-roadmap.md).

| # | Question | Recommendation |
|---|---|---|
| 1 | ~~Custom deployment protection rules need GitHub Enterprise on private repos.~~ | **Decided**: Launch deploys every app, so Launch is the gate on any GitHub plan; a protection rule is an optional extra on Enterprise ([08](08-approvals-audit-ship.md), [S1](../spikes/s1-worker-token/RESULT.md)) |
| 2 | ~~Do Custom Domain certificates cover `<slug>.apps.<domain>`?~~ | **Decided**: flat, first-level hosts on a dedicated apps domain, with Worker routes on a wildcard record, so the question no longer arises ([04](04-hostnames-and-dns.md)). Spike S2 checks the routing |
| 3 | ~~Build the OIDC issuer on OpenAuth or on `jose`?~~ | **Decided: `jose`.** OpenAuth issues no `id_token` and has no OIDC discovery; a ~200-line `jose` issuer passed `openid-client`, 15 of 15 checks ([S6](../spikes/s6-oidc-issuer/RESULT.md)) |
| 4 | Will Rocketflare adopt a generic OIDC login? | Propose it to the kit on its own merits; the adapter carries it only if the kit declines |
| 5 | Do app roles come from Launch claims, or stay app-local? | App-local in v1; an optional `app_role` claim later |
| 6 | Do apps keep magic link for external guests? | Off by default, allowed per app by policy |
| 7 | Who may create apps? | Anyone in the company, behind an `app.create` policy (auto-approve by default); platform admins can tighten it |
| 8 | Grant granularity: whole bundles or single keys? | Whole bundles in v1 |
| 9 | Can staging grants be self-served, with only production needing approval? | Yes, as a policy option; the default is approval for both |
| 10 | Per-account limits compared with fleet size | **Decided**: apps don't use Hyperdrive (25 per account would cap the fleet at ~12), and use Neon's serverless driver instead; Launch keeps Hyperdrive. Resend and custom-domain caps no longer apply. The next limits are Workers (500 per account) and Neon projects (100 on Launch, 1,000 on Scale) ([S0](../spikes/s0-limits/RESULT.md), [S3](../spikes/s3-neon-hyperdrive/RESULT.md)) |
| 11 | Is Secrets Store GA and fit for use? | Stay on Worker secrets behind a seam; re-check at P5 |
| 12 | Session cost policy: default caps per session, team and month | Set them with the first design partner; metering ships in P3 regardless |
| 13 | Sandbox SDK: stable package or 1.0 `@next`? | Stable 0.12.10 did everything S7 needed, with `interceptHttps` set explicitly. `1.0.0-rc.0` is out; take 1.0 if it is GA by P3 ([S7](../spikes/s7-sandbox/RESULT.md)) |
| 14 | Model provider for sessions: Anthropic direct, Bedrock or Vertex? | Anthropic direct first; Bedrock or Vertex for companies that require their cloud's data terms |
| 15 | Product name ("Launch" is a working name) | Open |
| 16 | Should the approvals engine or the grants model later become Rocketflare plugins that other apps can use? | Not before Launch has proven them; they stay decoupled until then |
