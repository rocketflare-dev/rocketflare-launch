/**
 * FakeCloud — one STATEFUL, in-memory stand-in for every vendor Launch drives (Cloudflare, Neon
 * + its HTTP SQL endpoint, Resend, GitHub, GitHub's Actions JWKS) and for the app hosts Launch
 * health-checks, behind a single `fetch`. It is what lets the P2 pipeline, teardown and deploy
 * gateway run end to end with no network: resources get ids, a deleted one answers 404, a
 * retried create meets the conflict a real vendor would give, and every call is recorded.
 * `tests/helpers/vendor-fetch.ts` (P1's static route table) is still the tool for one-probe
 * setup checks; this is for anything that CREATES.
 *
 * ## Making one
 *
 * ```ts
 * import { createFakeCloud } from '../helpers/fake-cloud'
 * const cloud = createFakeCloud()            // or createFakeCloud({ domain: 'clewro.com', … })
 * cloud.opts                                 // { accountId, zoneId, domain, org, appId,
 *                                            //   installationId, resendDomainId, … } — seed
 *                                            //   launch_settings / credential metadata from these
 * ```
 *
 * ## Installing it as fetch
 *
 * - Hand it to a client: `new CloudflareClient(token, { fetch: cloud.fetch })`,
 *   `verifyGitHubOidc(token, { audience, fetch: cloud.fetch })`, `runSql(uri, q, [], cloud.fetch)`.
 * - Or make it the GLOBAL fetch for code that uses the default (a Workflow step, a route):
 *   `const restore = cloud.install()` … `restore()` in `afterEach` — or
 *   `vi.spyOn(globalThis, 'fetch').mockImplementation(cloud.fetch)`. Either way the test file needs
 *   `// @vitest-isolate` on line 1 (`.claude/rules/testing.md`).
 *
 * An unmatched URL answers **599** `{ message: 'no fake for …' }` and is recorded, so a stray call
 * fails loudly rather than reaching the network.
 *
 * ## Driving failures
 *
 * - `cloud.failNext(match, status, body?)` — the NEXT call matching answers `status` (once), before
 *   any vendor sees it; stack several. `match` is a substring of `"<METHOD> <url>"`
 *   (`'POST https://api.cloudflare.com/client/v4/accounts/…/r2/buckets'`, or just `'/r2/buckets'`),
 *   a RegExp over that line, or `({ method, url }) => boolean`. The body defaults to one every
 *   client's error parser reads (`{ success:false, errors:[{code,message}], message }`).
 * - `cloud.lockNeon(n)` — the next `n` Neon API calls answer **423 Locked** (a burst the client's
 *   retry must ride out; pair with `new NeonClient(key, { fetch: cloud.fetch, sleep: async () => {} })`).
 *
 * ## Inspecting state
 *
 * - `cloud.calls` — every call `{ vendor, method, url, host, path, authorization, body, status }`;
 *   `cloud.callsTo('neon')` filters by vendor (`cloudflare | neon | neon-sql | resend | github |
 *   actions-oidc | app`). Zero Neon calls = `cloud.callsTo('neon').length === 0`.
 * - `cloud.resourcesFor(slug)` — every live resource named for the app, as
 *   `'<vendor>:<kind>:<name>'` (KV titles, queues, consumers, R2 buckets, scripts, workflows,
 *   routes, Neon projects, Resend keys, and NON-archived repos). Empty after a clean teardown.
 * - `cloud.cloudflare` (`FakeCloudflare`): `kv` (id → `{id,title}`), `queues` (id →
 *   `{queue_id, queue_name, consumers}`), `r2` (name → `{name, objects}`), `scripts` (name →
 *   `{metadata, modules, secrets, secretPuts (names only, in order), migrationTag, workersDev,
 *   schedules, settings, versions[{id, metadata, bindings}], deployments, activeVersionId}`),
 *   `workflows` (name → `{class_name, script_name}`), `routes` (id → `{pattern, script, zoneId}`),
 *   `assetBlobs`, `activeVersion(script)`, `scriptForHost(host)`.
 * - `cloud.neon` (`FakeNeon`): `projects` (id → `{name, region_id, org_id, pg_version, branches:
 *   id → {name, parent_id, init_source, host, roles: name → {password, resets}, databases}}`),
 *   `branchNamed(projectId, name)`, `resetCount(projectId, role)`, `sql` (every HTTP SQL statement
 *   with its role), `grants`. P3: branches take `init_source` and `endpoints: []`, list their
 *   endpoints and can be DELETEd (not the default one, not one with children).
 * - `cloud.resend` (`FakeResend`): `apiKeys` (id → `{name, token, permission, domain_id}`),
 *   `domains`.
 * - `cloud.github` (`FakeGitHub`): `repos` (`owner/name` lower-case → `{id, archived, refs,
 *   environments, variables}`), `repo(owner, name)`, `tokens` (installation tokens with their
 *   `repositories`, `permissions`, `revoked`), `issueToken(scope)`, `commits`, `trees`,
 *   `readFile(owner, repo, path, ref?)`, `filesAt(owner, repo, ref?)`,
 *   `pushCommit(owner, repo, files, message?)` (what a scaffold job's push leaves — no token),
 *   `runs` (every dispatch as a run), and `onDispatch = run => …` (awaited inside the dispatch
 *   call — the test's stand-in for the job starting). P3: `pulls` (every PR opened: `{number, head,
 *   base, title, body, state, headSha}`), and the head commit's CI through
 *   `setCheckRuns(owner, repo, ref, [{ name, status, conclusion? }])` and
 *   `setStatuses(owner, repo, ref, [{ context, state }])` — no statuses reads back `pending`.
 *   P4: tags (`POST …/git/refs`), `releases` (every Release published: `{tag, sha, via:
 *   'api'|'hook'}`, `releaseFor(owner, repo, tag)`) with `onRelease = release => …` (awaited after
 *   an API publish — `release: published` starting the production job), compare and commit →
 *   pulls, PRs with `author`/`merged`/`mergedAt`/`mergeSha`, and the hooks `openPull(owner, repo,
 *   {head, title, author?})`, `merge(owner, repo, number)` (→ the merge commit's sha),
 *   `closePull(owner, repo, number)` and `publish(owner, repo, tag)` (a Release published by hand).
 *
 * ## App hosts
 *
 * A request to any other host is an APP request. `cloud.onHost(host, handler)` answers it your
 * way; otherwise the host's Worker route decides: a script with a deployed version answers
 * `/api/health` 200 `{ status: 'ok', version: <its RELEASE_VERSION> }` and `/api/ready` 200; a
 * placeholder that was only ever PUT answers 503; no route is a 404.
 *
 * GitHub's Actions JWKS (`tests/helpers/github-oidc.ts`) is served at its real URL, so tokens from
 * `mintActionsToken` verify through `cloud.fetch`.
 */
import { ACTIONS_JWKS_URL, actionsJwks } from '../github-oidc'
import { ACCOUNT_ID, ZONE_ID } from '../vendor-fetch'
import { FakeCloudflare } from './cloudflare'
import {
  type CallMatch,
  type FakeCall,
  type FakeRequest,
  IdSource,
  json,
  matches,
  type ResourceLabel,
  toFakeRequest,
  type Vendor,
} from './core'
import { FakeGitHub } from './github'
import { FakeNeon } from './neon'
import { FakeResend } from './resend'

export { FakeCloudflare } from './cloudflare'
export type { CallMatch, FakeCall, FakeRequest, ResourceLabel, Vendor } from './core'
export { FakeGitHub } from './github'
export { FakeNeon } from './neon'
export { FakeResend } from './resend'

export interface FakeCloudOptions {
  accountId: string
  zoneId: string
  /** The apps domain (the zone's name). */
  domain: string
  /** The GitHub organisation the app is installed on. */
  org: string
  appId: number
  installationId: number
  /** The Resend domain id of `notifications.<domain>`. */
  resendDomainId: string
  /** When set, the Cloudflare fake requires exactly this bearer. */
  cloudflareToken?: string
  /** When set, the Neon fake requires exactly this bearer. */
  neonApiKey?: string
}

export type HostHandler = (req: FakeRequest) => Response | Promise<Response>

interface PendingFailure {
  match: CallMatch
  status: number
  body?: unknown
}

export class FakeCloud {
  readonly opts: FakeCloudOptions
  readonly ids = new IdSource()
  readonly cloudflare: FakeCloudflare
  readonly neon: FakeNeon
  readonly resend: FakeResend
  readonly github: FakeGitHub
  readonly calls: FakeCall[] = []
  private readonly failures: PendingFailure[] = []
  private readonly hosts = new Map<string, HostHandler>()

  constructor(opts: Partial<FakeCloudOptions> = {}) {
    this.opts = {
      accountId: ACCOUNT_ID,
      zoneId: ZONE_ID,
      domain: 'clewro.com',
      org: 'acme',
      appId: 123456,
      installationId: 4242,
      resendDomainId: 'resend-domain-1',
      ...opts,
    }
    this.cloudflare = new FakeCloudflare(this.ids, {
      accountId: this.opts.accountId,
      zoneId: this.opts.zoneId,
      zoneName: this.opts.domain,
      apiToken: this.opts.cloudflareToken,
    })
    this.neon = new FakeNeon(this.ids, { apiKey: this.opts.neonApiKey })
    this.resend = new FakeResend(this.ids, {
      notificationsDomain: `notifications.${this.opts.domain}`,
      domainId: this.opts.resendDomainId,
    })
    this.github = new FakeGitHub(this.ids, {
      org: this.opts.org,
      appId: this.opts.appId,
      installationId: this.opts.installationId,
    })
  }

  /** The fake `fetch`. Bound, so it can be passed around bare. */
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = await toFakeRequest(input, init)
    const vendor = vendorOf(req.url)
    const url = req.url.toString()
    const record = (status: number) =>
      this.calls.push({
        vendor,
        method: req.method,
        url,
        host: req.url.host,
        path: req.url.pathname,
        authorization: req.headers.get('authorization'),
        body: req.form ? '[form]' : (req.json ?? (req.text || null)),
        status,
      })

    const failure = this.failures.findIndex(f => matches(f.match, req.method, url))
    if (failure >= 0) {
      const [f] = this.failures.splice(failure, 1)
      const message = `FakeCloud failNext ${f.status}`
      record(f.status)
      return json(
        f.body ?? { success: false, errors: [{ code: f.status, message }], message },
        f.status
      )
    }

    const res = await this.dispatch(vendor, req)
    record(res.status)
    return res
  }) as typeof fetch

  private async dispatch(vendor: Vendor, req: FakeRequest): Promise<Response> {
    switch (vendor) {
      case 'cloudflare':
        return (await this.cloudflare.handle(req)) ?? unmatched(req)
      case 'neon':
      case 'neon-sql':
        return (await this.neon.handle(req)) ?? unmatched(req)
      case 'resend':
        return this.resend.handle(req) ?? unmatched(req)
      case 'github':
        return (await this.github.handle(req)) ?? unmatched(req)
      case 'actions-oidc':
        return req.url.toString() === ACTIONS_JWKS_URL ? json(await actionsJwks()) : unmatched(req)
      case 'app':
        return this.appHost(req)
    }
  }

  /** Answer requests to `host` (e.g. `shop-staging.clewro.com`) with `handler`. */
  onHost(host: string, handler: HostHandler): void {
    this.hosts.set(host, handler)
  }

  private async appHost(req: FakeRequest): Promise<Response> {
    const custom = this.hosts.get(req.url.host)
    if (custom) return custom(req)
    const script = this.cloudflare.scriptForHost(req.url.host)
    if (!script) return json({ message: `no fake for ${req.url}` }, 599)
    const version = this.cloudflare.activeVersion(script.name)
    if (!version) return json({ error: 'placeholder Worker', statusCode: 503 }, 503)
    if (req.url.pathname === '/api/health') {
      const release = version.bindings.find(
        b => b.type === 'plain_text' && b.name === 'RELEASE_VERSION'
      )
      return json({ status: 'ok', version: (release?.text as string | undefined) ?? null })
    }
    if (req.url.pathname === '/api/ready') return json({ status: 'ready' })
    return json({ error: 'Not found', statusCode: 404 }, 404)
  }

  /** The next call matching `match` answers `status` (once). */
  failNext(match: CallMatch, status: number, body?: unknown): void {
    this.failures.push({ match, status, body })
  }

  /** The next `n` Neon API calls answer 423 Locked. */
  lockNeon(n: number): void {
    this.neon.lockedCalls += n
  }

  callsTo(vendor: Vendor): FakeCall[] {
    return this.calls.filter(c => c.vendor === vendor)
  }

  /** Every live resource named for `slug`, across vendors — `[]` after a clean teardown. */
  resourcesFor(slug: string): ResourceLabel[] {
    return [
      ...this.cloudflare.resourcesFor(slug),
      ...this.neon.resourcesFor(slug),
      ...this.resend.resourcesFor(slug),
      ...this.github.resourcesFor(slug),
    ]
  }

  /**
   * Make this the global `fetch`; returns the restore. The file must be `// @vitest-isolate`.
   * Loopback requests still reach the network: under `pnpm test:neon` the database driver speaks
   * HTTP to the local Neon proxy, and a test's own bridge server lives there too.
   */
  install(): () => void {
    const original = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      return /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)
        ? original(input, init)
        : this.fetch(input, init)
    }) as typeof fetch
    return () => {
      globalThis.fetch = original
    }
  }
}

function vendorOf(url: URL): Vendor {
  const host = url.hostname
  if (host === 'api.cloudflare.com') return 'cloudflare'
  if (host === 'console.neon.tech') return 'neon'
  if (/^api\..*\.neon\.tech$/.test(host)) return 'neon-sql'
  if (host === 'api.resend.com') return 'resend'
  if (host === 'api.github.com') return 'github'
  if (host === 'token.actions.githubusercontent.com') return 'actions-oidc'
  return 'app'
}

function unmatched(req: FakeRequest): Response {
  return json({ message: `no fake for ${req.method} ${req.url}` }, 599)
}

/** A fresh FakeCloud (see the header for the whole API). */
export function createFakeCloud(opts: Partial<FakeCloudOptions> = {}): FakeCloud {
  return new FakeCloud(opts)
}
