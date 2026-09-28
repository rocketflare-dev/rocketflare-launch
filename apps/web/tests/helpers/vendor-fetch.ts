/**
 * A fake `fetch` for the setup wizard's vendor calls (Cloudflare, Neon, Resend, GitHub): a table of
 * `'<host><path-prefix>'` → JSON body (or a `Response` factory), matched longest-prefix first, and
 * a record of every call so a test can assert what was asked — and that a secret went only where it
 * belonged. `happyVendors(fixture)` is the table for a correctly set-up company; a test overrides
 * one entry to make one probe fail.
 */
export const ACCOUNT_ID = '0123456789abcdef0123456789abcdef'
export const OTHER_ACCOUNT_ID = 'fedcba9876543210fedcba9876543210'
export const ZONE_ID = 'zone0000000000000000000000000001'

export interface VendorCall {
  url: string
  method: string
  authorization: string | null
}

/** A JSON body, or a factory given the URL and the request init (method, body). */
export type VendorRoute = unknown | ((url: string, init?: RequestInit) => Response)

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Cloudflare's envelope. */
export const cf = (result: unknown) => ({ success: true, errors: [], messages: [], result })

export function fakeVendorFetch(routes: Record<string, VendorRoute>) {
  const calls: VendorCall[] = []
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length)
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'),
    })
    const bare = url.replace(/^https:\/\//, '')
    const key = keys.find(k => bare.startsWith(k))
    if (!key) return jsonResponse({ message: `no fake for ${url}` }, 599)
    const route = routes[key]
    return typeof route === 'function'
      ? (route as (u: string, i?: RequestInit) => Response)(url, init)
      : jsonResponse(route)
  }) as typeof fetch
  return { calls, fetch: fetchImpl }
}

export interface HappyFixture {
  domain: string
  org: string
  installationId?: number
  permissions?: Record<string, string>
}

export const FULL_GITHUB_PERMISSIONS = {
  administration: 'write',
  contents: 'write',
  workflows: 'write',
  pull_requests: 'write',
  actions: 'write',
  environments: 'write',
  actions_variables: 'write',
  deployments: 'write',
  metadata: 'read',
  // P3: a session's PR is shipped when its CI is green — check runs plus the combined status.
  checks: 'read',
  statuses: 'read',
}

/** Every vendor answering as a correctly set-up company would. */
export function happyVendors(f: HappyFixture): Record<string, VendorRoute> {
  const CF = 'api.cloudflare.com/client/v4'
  return {
    [`${CF}/accounts/${ACCOUNT_ID}/tokens/verify`]: cf({ id: 'tok123', status: 'active' }),
    [`${CF}/accounts/${ACCOUNT_ID}/workers/scripts`]: cf([{ id: 'a' }, { id: 'b' }]),
    [`${CF}/accounts/${ACCOUNT_ID}/storage/kv/namespaces`]: cf([]),
    [`${CF}/accounts/${ACCOUNT_ID}/queues`]: cf([]),
    [`${CF}/accounts/${ACCOUNT_ID}/r2/buckets`]: cf({ buckets: [] }),
    [`${CF}/zones?name=`]: cf([
      { id: ZONE_ID, name: f.domain, status: 'active', account: { id: ACCOUNT_ID } },
    ]),
    [`${CF}/zones/${ZONE_ID}/dns_records`]: cf([
      { id: 'r1', type: 'AAAA', name: `*.${f.domain}`, content: '100::', proxied: true },
    ]),
    [`${CF}/zones/${ZONE_ID}/workers/routes`]: cf([]),
    'console.neon.tech/api/v2/projects': {
      projects: [{ id: 'p1', name: 'x', region_id: 'aws-us-east-2', org_id: 'org-test-12345' }],
    },
    // What a real ORGANIZATION key gets; the setup check never calls it (see checkNeon).
    'console.neon.tech/api/v2/regions': () =>
      jsonResponse({ message: 'not allowed for organization API keys' }, 404),
    'api.resend.com/api-keys': { data: [{ id: 'k1', name: 'launch' }] },
    'api.resend.com/domains': {
      data: [{ id: 'd1', name: `notifications.${f.domain}`, status: 'verified' }],
    },
    'api.github.com/app/installations': [
      {
        id: f.installationId ?? 4242,
        account: { login: f.org, type: 'Organization' },
        permissions: f.permissions ?? FULL_GITHUB_PERMISSIONS,
        repository_selection: 'all',
        suspended_at: null,
      },
    ],
    'api.github.com/app': {
      id: 123456,
      slug: 'company-launch',
      name: 'Company Launch',
      owner: { login: f.org },
      permissions: FULL_GITHUB_PERMISSIONS,
    },
  }
}
