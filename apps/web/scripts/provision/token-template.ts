/**
 * The Cloudflare API token an instance needs, and the dashboard link that pre-fills it. Pure.
 *
 * ONE token does both jobs: `pnpm provision` acts with it (wrangler deploy, the resources, the
 * DNS), and `setup` seals it into the instance as the `cloudflare_api_token` credential Launch acts
 * with at runtime (every app's Worker, KV, queue, bucket, route and DNS record — spec/03). So it
 * is the UNION of both, and it must be **account-owned**: Launch's own check verifies it at
 * `/accounts/{id}/tokens/verify`, which refuses a user token.
 *
 * The link format is Cloudflare's "API token template URL" for account tokens
 * (developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/, checked
 * 2026-10-04): `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=<url-encoded
 * JSON [{key,type}]>&name=<name>`. Only keys that page documents are in `TEMPLATE_KEYS`; the
 * groups it does not list a key for (`MANUAL_SCOPES`) are added by hand on the same screen.
 */

/** Every permission group the token needs, as the dashboard names them. */
export const CLOUDFLARE_TOKEN_SCOPES = [
  'Account · Workers Scripts · Edit (Workers, Durable Objects, Workflows, secrets, custom domains)',
  'Account · Workers KV Storage · Edit',
  'Account · Queues · Edit',
  'Account · Workers R2 Storage · Edit',
  'Account · Containers · Edit (the coding-session image is pushed on deploy)',
  'Account · Workers AI · Read',
  'Account · Account Settings · Read',
  'Zone · Zone · Read',
  'Zone · DNS · Edit',
  'Zone · Workers Routes · Edit',
] as const

/** The documented template keys for the groups above. */
export const TEMPLATE_KEYS: ReadonlyArray<{ key: string; type: 'read' | 'edit' }> = [
  { key: 'workers_scripts', type: 'edit' },
  { key: 'workers_kv_storage', type: 'edit' },
  { key: 'queues', type: 'edit' },
  { key: 'workers_r2', type: 'edit' },
  { key: 'account_settings', type: 'read' },
  { key: 'zone', type: 'read' },
  { key: 'dns', type: 'edit' },
  { key: 'workers_routes', type: 'edit' },
]

/** No documented template key: add these on the pre-filled page before creating the token. */
export const MANUAL_SCOPES = ['Account · Containers · Edit', 'Account · Workers AI · Read'] as const

export function cloudflareTokenTemplateUrl(name = 'Launch'): string {
  const keys = encodeURIComponent(JSON.stringify(TEMPLATE_KEYS))
  return `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${keys}&name=${encodeURIComponent(name)}`
}
