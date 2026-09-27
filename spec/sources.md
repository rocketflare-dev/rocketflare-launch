# Sources

These were checked in September 2026. Flags: **[beta]**, **[uncertain]** (the docs are ambiguous
or weren't re-checked), and **[plan]** (depends on the subscription).

## Cloudflare

- Account-owned API tokens: https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/
- Creating tokens over the API: https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/
- Granular Worker permissions (per-Worker scoping, 2026-09-15): https://developers.cloudflare.com/changelog/post/2026-09-15-granular-worker-permissions/ · https://developers.cloudflare.com/workers/authorization/ — the policy format, confirmed in S1: `com.cloudflare.edge.worker.script.<script tag>` nested under `com.cloudflare.api.account.<id>`, with the "Individual Workers" permission groups. Bindings are not checked against it
- Worker upload metadata (bindings as JSON): https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
- Static assets direct upload: https://developers.cloudflare.com/workers/static-assets/direct-upload/
- Workers Builds API: https://developers.cloudflare.com/api/resources/workers_builds/ — needs a user token; Git connection automation is **[uncertain]** (https://github.com/cloudflare/workers-sdk/issues/12058)
- API reference (Hyperdrive, KV, Queues, R2, DNS, Custom Domains): https://developers.cloudflare.com/api/
- Secrets Store and Workers: https://developers.cloudflare.com/secrets-store/integrations/workers/ · https://blog.cloudflare.com/secrets-store-beta/ — GA status **[uncertain]**
- Containers and Sandbox GA (2026-04-13): https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/
- Sandbox SDK 1.0 preview **[beta]**: https://developers.cloudflare.com/changelog/post/2026-08-07-sandbox-sdk-1-0-preview/
- Running Claude Code on a Sandbox: https://developers.cloudflare.com/sandbox/tutorials/claude-code/
- Sandbox outbound traffic (allowlists, credential-injecting handlers; `interceptHttps` is off by default on the stable packages, S7): https://developers.cloudflare.com/sandbox/guides/outbound-traffic/
- Sandbox tunnels (public URLs, so not used for previews, S7): https://developers.cloudflare.com/sandbox/api/tunnels/
- Containers SSH (user `cloudchamber`, S7): https://developers.cloudflare.com/containers/ssh/
- Containers limits (instance types): https://developers.cloudflare.com/containers/platform-details/limits/
- Platform limits used in S0: https://developers.cloudflare.com/hyperdrive/platform/limits/ · https://developers.cloudflare.com/workers/platform/limits/
- Access applications API: https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/
- Workers for Platforms (judged unnecessary here): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/

## Neon

- API keys (org and project-scoped): https://neon.com/docs/manage/api-keys
- Organizations API: https://neon.com/docs/manage/orgs-api
- Create project: https://api-docs.neon.tech/reference/createproject
- API reference (branches, roles; the connection URI is `GET /projects/{id}/connection_uri?pooled=false|true`, confirmed in S3): https://neon.com/docs/reference/api-reference
- Hyperdrive guide (Launch's own database only): https://neon.com/docs/guides/cloudflare-hyperdrive
- Serverless driver (HTTP and WebSocket; what apps use): https://neon.com/docs/serverless/serverless-driver
- Preview branches with Cloudflare: https://github.com/neondatabase/preview-branches-with-cloudflare

## Resend

- Create an API key (`sending_access` + `domain_id`): https://resend.com/docs/api-reference/api-keys/create-api-key
- API key permissions: https://resend.com/changelog/new-api-key-permissions

## GitHub (repo creation, the Git Data API, environments and installation tokens exercised in S5)

- Create a repo from a template: https://docs.github.com/en/rest/repos/repos#create-a-repository-using-a-template
- Installation access tokens (repo- and permission-scoped): https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
- Actions secrets (sealed with the repo's public key): https://docs.github.com/en/rest/actions/secrets
- Deployment environments: https://docs.github.com/en/rest/deployments/environments
- Rulesets: https://docs.github.com/en/rest/repos/rules
- Actions OIDC tokens (what Launch deploys on, S5): https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect
- Repository variables (needs the App's Variables permission, S5): https://docs.github.com/en/rest/actions/variables
- Custom deployment protection rules (**[plan]**: Enterprise for private repos; no longer needed, S5): https://docs.github.com/en/actions/deployment/protecting-deployments/creating-custom-deployment-protection-rules

## Anthropic

- Agent SDK hosting: https://platform.claude.com/docs/en/agent-sdk/hosting
- Agent SDK streaming output: https://platform.claude.com/docs/en/agent-sdk/streaming-output
- Managed Agents **[beta]** (not eligible for Zero Data Retention or a HIPAA BAA): https://platform.claude.com/docs/en/managed-agents/overview · https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes
- Cloudflare's Managed Agents template: https://developers.cloudflare.com/sandbox/tutorials/claude-managed-agents/ · https://github.com/cloudflare/claude-managed-agents

## Rocketflare surfaces the adapter relies on

In https://github.com/rocketflare-dev/rocketflare at 0.12.x:

- `scripts/rename.mjs`
- `.rocketflare.json`
- `apps/web/wrangler.toml` and `apps/web/wrangler.staging.toml`
- `.github/workflows/deploy.yml`
- `apps/web/src/api/routes/health.ts`
- `apps/web/src/api/auth/providers/`
- `apps/web/src/plugins/*/plugin.json` (`vars`)
