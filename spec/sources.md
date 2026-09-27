# Sources

These were checked in September 2026. Flags: **[beta]**, **[uncertain]** (the docs are ambiguous
or weren't re-checked), and **[plan]** (depends on the subscription).

## Cloudflare

- Account-owned API tokens: https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/
- Creating tokens over the API: https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/
- Granular Worker permissions (per-Worker scoping, 2026-09-15): https://developers.cloudflare.com/changelog/post/2026-09-15-granular-worker-permissions/ · https://developers.cloudflare.com/workers/authorization/ — the policy resource-id format is **[uncertain]**
- Worker upload metadata (bindings as JSON): https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
- Static assets direct upload: https://developers.cloudflare.com/workers/static-assets/direct-upload/
- Workers Builds API: https://developers.cloudflare.com/api/resources/workers_builds/ — needs a user token; Git connection automation is **[uncertain]** (https://github.com/cloudflare/workers-sdk/issues/12058)
- API reference (Hyperdrive, KV, Queues, R2, DNS, Custom Domains): https://developers.cloudflare.com/api/
- Secrets Store and Workers: https://developers.cloudflare.com/secrets-store/integrations/workers/ · https://blog.cloudflare.com/secrets-store-beta/ — GA status **[uncertain]**
- Containers and Sandbox GA (2026-04-13): https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/
- Sandbox SDK 1.0 preview **[beta]**: https://developers.cloudflare.com/changelog/post/2026-08-07-sandbox-sdk-1-0-preview/
- Running Claude Code on a Sandbox: https://developers.cloudflare.com/sandbox/tutorials/claude-code/
- Access applications API: https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/
- Workers for Platforms (judged unnecessary here): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/

## Neon

- API keys (org and project-scoped): https://neon.com/docs/manage/api-keys
- Organizations API: https://neon.com/docs/manage/orgs-api
- Create project: https://api-docs.neon.tech/reference/createproject
- API reference (branches, roles, connection URI **[uncertain]** on the exact endpoint): https://neon.com/docs/reference/api-reference
- Hyperdrive guide (use the direct, unpooled string): https://neon.com/docs/guides/cloudflare-hyperdrive
- Preview branches with Cloudflare: https://github.com/neondatabase/preview-branches-with-cloudflare

## Resend

- Create an API key (`sending_access` + `domain_id`): https://resend.com/docs/api-reference/api-keys/create-api-key
- API key permissions: https://resend.com/changelog/new-api-key-permissions

## GitHub (standard REST behaviour, not re-checked this session: **[uncertain]** on the details)

- Create a repo from a template: https://docs.github.com/en/rest/repos/repos#create-a-repository-using-a-template
- Installation access tokens (repo- and permission-scoped): https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
- Actions secrets (sealed with the repo's public key): https://docs.github.com/en/rest/actions/secrets
- Deployment environments: https://docs.github.com/en/rest/deployments/environments
- Rulesets: https://docs.github.com/en/rest/repos/rules
- Custom deployment protection rules (**[plan]**: Enterprise for private repos): https://docs.github.com/en/actions/deployment/protecting-deployments/creating-custom-deployment-protection-rules

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
