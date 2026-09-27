# 12. Open questions

Each question has a recommendation where there is one. The spikes are in [P0](11-roadmap.md).

| # | Question | Recommendation |
|---|---|---|
| 1 | Custom deployment protection rules need GitHub Enterprise on private repos. Do target companies have it? | Assume most enterprise buyers do. Build the dispatch-only fallback as well, with audit alerts ([08](08-approvals-audit-ship.md)) |
| 2 | Do Custom Domain certificates cover `<slug>.apps.<domain>` (and staging, three levels deep)? | Spike first. The fallback is a flat scheme on a dedicated apps domain ([04](04-hostnames-and-dns.md)) |
| 3 | Build the OIDC issuer on OpenAuth or on `jose`? | Spike OpenAuth; fall back to `jose` ([05](05-identity-sso.md)) |
| 4 | Will Rocketflare adopt a generic OIDC login? | Propose it to the kit on its own merits; the adapter carries it only if the kit declines |
| 5 | Do app roles come from Launch claims, or stay app-local? | App-local in v1; an optional `app_role` claim later |
| 6 | Do apps keep magic link for external guests? | Off by default, allowed per app by policy |
| 7 | Who may create apps? | Anyone in the company, behind an `app.create` policy (auto-approve by default); platform admins can tighten it |
| 8 | Grant granularity: whole bundles or single keys? | Whole bundles in v1 |
| 9 | Can staging grants be self-served, with only production needing approval? | Yes, as a policy option; the default is approval for both |
| 10 | Cloudflare per-account limits (Workers scripts, custom domains, Hyperdrive configs) compared with fleet size | Record the limits and the expected fleet size in the P0 spike; Workers for Platforms is not needed below those limits |
| 11 | Is Secrets Store GA and fit for use? | Stay on Worker secrets behind a seam; re-check at P5 |
| 12 | Session cost policy: default caps per session, team and month | Set them with the first design partner; metering ships in P3 regardless |
| 13 | Sandbox SDK: stable package or 1.0 `@next`? | 1.0 if it has gone GA by P3; otherwise stable |
| 14 | Model provider for sessions: Anthropic direct, Bedrock or Vertex? | Anthropic direct first; Bedrock or Vertex for companies that require their cloud's data terms |
| 15 | Product name ("Launch" is a working name) | Open |
| 16 | Should the approvals engine or the grants model later become Rocketflare plugins that other apps can use? | Not before Launch has proven them; they stay decoupled until then |
