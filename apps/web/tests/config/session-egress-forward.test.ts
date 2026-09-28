/**
 * The egress FORWARDING CORES (`egress/forward-git.ts`, `egress/forward-model.ts`) — what Launch's
 * own proxies and the sandbox host's handlers share, with no database — and the sandbox host's
 * side of the `host` egress mode (`SESSION_SANDBOX_HOST=remote`): `HostedSessionSandbox` keeps an
 * EGRESS GRANT in its storage, its OWN `outboundByHost` finds it by `ctx.containerId`, and the
 * handlers inject the grant's token and key under the proxies' rules. No grant → 403.
 *
 * The database halves (the session lookup, the sealed token, metering and the budget) are in
 * `tests/api/session-github-egress.test.ts`, `session-model-proxy.test.ts` and
 * `session-host-egress.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  FRESH_TOKEN_RETRY_DELAYS_MS,
  forwardGit,
  type GitToken,
  INSTALLATION_TOKEN_TTL_MS,
  isFreshToken,
  MAX_PUSH_BYTES,
} from '@/api/services/sessions/egress/forward-git'
import { forwardModel } from '@/api/services/sessions/egress/forward-model'
import { MODEL_KEY_PLACEHOLDER } from '@/api/services/sessions/model-key'
import type { EgressGrant } from '@/api/services/sessions/sandbox-host/protocol'
import { hostedAnthropic, hostedGitHub } from '@/sandbox-host/egress'
import { grantLookup, HostedSessionSandbox } from '@/sandbox-host/hosted-session-sandbox'
import SandboxHost from '@/sandbox-host/worker'
import { createFakeAnthropic } from '../helpers/fake-anthropic'
import { FakeSandboxNamespace } from '../mocks/bindings'

const TOKEN = `ghs_${'T'.repeat(36)}`
const KEY = 'sk-ant-api03-forward-key-000000000000000000'
const MODEL = 'claude-sonnet-4-5'
const BRANCH = 'session/abcdefghijkl'
const REPO = { owner: 'acme', repo: 'app' }
const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const ZERO = '0'.repeat(40)

/** A receive-pack body: pkt-line ref commands, a flush, then (pretend) pack bytes. */
function pushBody(commands: [string, string, string][]): string {
  const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`
  const lines = commands.map(([o, n, ref], i) =>
    pkt(`${o} ${n} ${ref}${i === 0 ? '\0report-status side-band-64k' : ''}\n`)
  )
  return `${lines.join('')}0000PACK....`
}

const advertise = (repo = 'acme/app') =>
  new Request(`https://github.com/${repo}.git/info/refs?service=git-upload-pack`, {
    headers: { 'Git-Protocol': 'version=2', Cookie: 'c=1', 'User-Agent': 'git/2.43' },
  })

const push = (commands: [string, string, string][], headers: Record<string, string> = {}) =>
  new Request('https://github.com/acme/app.git/git-receive-pack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-git-receive-pack-request', ...headers },
    body: pushBody(commands),
  })

/** An upstream answering `statuses` in turn (then 200s), recording what reached it. */
function upstream(statuses: number[] = []) {
  const seen: { url: string; method: string; headers: Headers; body: string }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    seen.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.method === 'POST' ? await req.text() : '',
    })
    const status = statuses.shift() ?? 200
    return status === 200
      ? new Response('001e# service=git-upload-pack\n0000', {
          status,
          headers: { 'Set-Cookie': 'x=1', 'Content-Type': 'application/x-git' },
        })
      : new Response('Repository not found.', { status })
  }) as typeof globalThis.fetch
  return { seen, fetch }
}

function recordingSleep() {
  const delays: number[] = []
  return { delays, sleep: async (ms: number) => void delays.push(ms) }
}

const basic = (token: string) => `Basic ${btoa(`x-access-token:${token}`)}`

function gitOpts(token: GitToken | null = { token: TOKEN, fresh: false }) {
  const up = upstream()
  const asked = { count: 0 }
  return {
    up,
    asked,
    opts: {
      repo: REPO,
      branch: BRANCH,
      token: async () => {
        asked.count++
        return token
      },
      upstream: 'https://github.com',
      fetch: up.fetch,
      sleep: async () => {},
    },
  }
}

describe('forwardGit', () => {
  it('refuses anything that is not git on the one repo — before asking for a token', async () => {
    const { up, asked, opts } = gitOpts()
    const other = await forwardGit(advertise('acme/other'), opts)
    expect(other.status).toBe(403)
    expect(await other.text()).toMatch(/own app's repository/)
    const web = await forwardGit(new Request('https://github.com/acme/app/archive/main.zip'), opts)
    expect(web.status).toBe(403)
    expect(await web.text()).toMatch(/only use git over HTTPS/)
    const noRepo = await forwardGit(advertise(), { ...opts, repo: null })
    expect(noRepo.status).toBe(403)
    expect(up.seen).toHaveLength(0)
    expect(asked.count).toBe(0)
  })

  it('injects the token, forwards only git’s headers, and strips Set-Cookie', async () => {
    const { up, opts } = gitOpts()
    const res = await forwardGit(advertise('ACME/App'), opts)
    expect(res.status).toBe(200)
    expect(res.headers.get('Set-Cookie')).toBeNull()
    expect(up.seen).toHaveLength(1)
    const [sent] = up.seen
    expect(sent?.url).toBe('https://github.com/ACME/App.git/info/refs?service=git-upload-pack')
    expect(sent?.headers.get('Authorization')).toBe(basic(TOKEN))
    expect(sent?.headers.get('Git-Protocol')).toBe('version=2')
    expect(sent?.headers.get('Cookie')).toBeNull()
  })

  it('no token (the local git server): forwarded with no Authorization', async () => {
    const { up, opts } = gitOpts(null)
    await forwardGit(advertise(), { ...opts, upstream: 'http://git.local:9418' })
    expect(up.seen[0]?.url).toBe(
      'http://git.local:9418/acme/app.git/info/refs?service=git-upload-pack'
    )
    expect(up.seen[0]?.headers.get('Authorization')).toBeNull()
  })

  it('a push may move only the session’s branch, and never delete it', async () => {
    const { up, asked, opts } = gitOpts()
    const other = await forwardGit(push([[OLD, NEW, 'refs/heads/main']]), opts)
    expect(other.status).toBe(403)
    expect(await other.text()).toMatch(`only push refs/heads/${BRANCH} (refused refs/heads/main)`)
    const mixed = await forwardGit(
      push([
        [OLD, NEW, `refs/heads/${BRANCH}`],
        [OLD, NEW, 'refs/tags/v1'],
      ]),
      opts
    )
    expect(mixed.status).toBe(403)
    const del = await forwardGit(push([[OLD, ZERO, `refs/heads/${BRANCH}`]]), opts)
    expect(del.status).toBe(403)
    const zipped = await forwardGit(
      push([[OLD, NEW, `refs/heads/${BRANCH}`]], { 'Content-Encoding': 'gzip' }),
      opts
    )
    expect(zipped.status).toBe(403)
    const huge = await forwardGit(
      push([[OLD, NEW, `refs/heads/${BRANCH}`]], { 'Content-Length': String(MAX_PUSH_BYTES + 1) }),
      opts
    )
    expect(huge.status).toBe(413)
    expect(up.seen).toHaveLength(0)
    expect(asked.count).toBe(0)

    const ok = await forwardGit(push([[OLD, NEW, `refs/heads/${BRANCH}`]]), opts)
    expect(ok.status).toBe(200)
    expect(up.seen[0]?.body).toBe(pushBody([[OLD, NEW, `refs/heads/${BRANCH}`]]))
    expect(up.seen[0]?.headers.get('Authorization')).toBe(basic(TOKEN))
  })

  it('a fresh token’s 401/404 is retried after each backoff; a settled token’s is not', async () => {
    const fresh = upstream([404, 401])
    const s = recordingSleep()
    const { opts } = gitOpts({ token: TOKEN, fresh: true })
    const res = await forwardGit(advertise(), { ...opts, fetch: fresh.fetch, sleep: s.sleep })
    expect(res.status).toBe(200)
    expect(fresh.seen).toHaveLength(3)
    expect(s.delays).toEqual(FRESH_TOKEN_RETRY_DELAYS_MS.slice(0, 2))

    const settled = upstream([404])
    const s2 = recordingSleep()
    const res2 = await forwardGit(advertise(), {
      ...gitOpts().opts,
      fetch: settled.fetch,
      sleep: s2.sleep,
    })
    expect(res2.status).toBe(404)
    expect(settled.seen).toHaveLength(1)
    expect(s2.delays).toEqual([])
  })

  it('a token that cannot be had is a 502', async () => {
    const { up, opts } = gitOpts()
    const res = await forwardGit(advertise(), {
      ...opts,
      token: () => Promise.reject(new Error('GitHub is down')),
    })
    expect(res.status).toBe(502)
    expect(up.seen).toHaveLength(0)
  })

  it('an upstream that cannot be reached is a 502 naming it, never a thrown handler', async () => {
    const { opts } = gitOpts()
    const res = await forwardGit(advertise(), {
      ...opts,
      upstream: 'http://localhost:9420',
      fetch: () => Promise.reject(new Error('Network connection lost.')),
    })
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('http://localhost:9420')
  })

  it('isFreshToken: minted within the last minute of an hour-long token', () => {
    const now = Date.now()
    expect(isFreshToken(now + INSTALLATION_TOKEN_TTL_MS - 10_000, now)).toBe(true)
    expect(isFreshToken(now + INSTALLATION_TOKEN_TTL_MS - 120_000, now)).toBe(false)
  })
})

const modelRequest = (body: unknown, path = '/v1/messages?beta=true', method = 'POST') =>
  new Request(`https://api.anthropic.com${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': MODEL_KEY_PLACEHOLDER,
      authorization: `Bearer ${MODEL_KEY_PLACEHOLDER}`,
      cookie: 'c=1',
    },
    body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('forwardModel', () => {
  it('drops the placeholder, sets the key, and keeps the path and query', async () => {
    const anthropic = createFakeAnthropic({ text: 'hi' })
    const res = await forwardModel(modelRequest({ model: `${MODEL}-20250929`, max_tokens: 5 }), {
      key: KEY,
      model: MODEL,
      upstream: anthropic.upstream,
    })
    expect(res.status).toBe(200)
    expect(anthropic.requests).toHaveLength(1)
    const [sent] = anthropic.requests
    expect(sent?.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
    expect(sent?.apiKey).toBe(KEY)
    expect(sent?.authorization).toBeNull()
    expect(sent?.body).toMatchObject({ model: `${MODEL}-20250929` })
  })

  it('another path, method or model is an Anthropic-shaped 403 with no upstream call', async () => {
    const anthropic = createFakeAnthropic()
    const opts = { key: KEY, model: MODEL, upstream: anthropic.upstream }
    for (const req of [
      modelRequest({ model: MODEL }, '/v1/models', 'GET'),
      modelRequest({ model: MODEL }, '/v1/messages/batches'),
      modelRequest({ model: 'claude-opus-4-1' }),
      modelRequest('not json'),
    ]) {
      const res = await forwardModel(req, opts)
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
        'permission_error'
      )
    }
    expect(anthropic.requests).toHaveLength(0)
  })

  it('an unreachable upstream is a 502, and says nothing of the key', async () => {
    const res = await forwardModel(modelRequest({ model: MODEL }), {
      key: KEY,
      model: MODEL,
      upstream: { fetch: () => Promise.reject(new Error(`boom ${KEY}`)) },
    })
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain(KEY)
  })
})

// ---- the sandbox host ------------------------------------------------------------------------------

const NAME = '0b7f6a52-3f1c-4a8e-9d0e-5a4b3c2d1e0f'

const grant = (over: Partial<EgressGrant> = {}): EgressGrant => ({
  git: {
    ...REPO,
    branch: BRANCH,
    upstream: 'https://github.com',
    token: TOKEN,
    expiresAt: Date.now() + 30 * 60_000,
  },
  model: { key: KEY, model: MODEL },
  ...over,
})

describe('the sandbox host’s outbound handlers', () => {
  const ctx = { containerId: 'the-do-id', className: 'HostedSessionSandbox' }
  const lookupOf = (g: EgressGrant | null) => async (id: string) => {
    expect(id).toBe(ctx.containerId)
    return g
  }

  it('git with a grant: the grant’s token is injected', async () => {
    const up = upstream()
    const res = await hostedGitHub(advertise(), lookupOf(grant()), ctx, { fetch: up.fetch })
    expect(res.status).toBe(200)
    expect(up.seen[0]?.headers.get('Authorization')).toBe(basic(TOKEN))
  })

  it('git with no grant (or no git half, or a failed lookup) is a 403, and nothing is sent', async () => {
    const up = upstream()
    for (const lookup of [
      lookupOf(null),
      lookupOf({ model: { key: KEY, model: MODEL } }),
      async () => {
        throw new Error('no such object')
      },
    ]) {
      const res = await hostedGitHub(advertise(), lookup, ctx, { fetch: up.fetch })
      expect(res.status).toBe(403)
      expect(await res.text()).toMatch(/not a live Launch session/)
    }
    expect(up.seen).toHaveLength(0)
  })

  it('git to another repo, or a push to another branch, is a 403 even with a grant', async () => {
    const up = upstream()
    const other = await hostedGitHub(advertise('acme/other'), lookupOf(grant()), ctx, {
      fetch: up.fetch,
    })
    expect(other.status).toBe(403)
    const main = await hostedGitHub(push([[OLD, NEW, 'refs/heads/main']]), lookupOf(grant()), ctx, {
      fetch: up.fetch,
    })
    expect(main.status).toBe(403)
    expect(up.seen).toHaveLength(0)
  })

  it('a freshly minted granted token’s 404 is retried, as the proxy does', async () => {
    const up = upstream([404])
    const s = recordingSleep()
    const now = Date.now()
    const fresh = grant()
    if (fresh.git) fresh.git.expiresAt = now + INSTALLATION_TOKEN_TTL_MS - 5_000
    const res = await hostedGitHub(advertise(), lookupOf(fresh), ctx, {
      fetch: up.fetch,
      sleep: s.sleep,
      now: () => now,
    })
    expect(res.status).toBe(200)
    expect(s.delays).toEqual([FRESH_TOKEN_RETRY_DELAYS_MS[0]])
  })

  it('the model with a grant: the key replaces the placeholder; without one, a 403', async () => {
    const anthropic = createFakeAnthropic({ text: 'hi' })
    const fetch = anthropic.upstream.fetch as unknown as typeof globalThis.fetch
    const ok = await hostedAnthropic(modelRequest({ model: MODEL }), lookupOf(grant()), ctx, {
      fetch,
    })
    expect(ok.status).toBe(200)
    expect(anthropic.requests[0]?.apiKey).toBe(KEY)

    const none = await hostedAnthropic(
      modelRequest({ model: MODEL }),
      lookupOf({ git: grant().git }),
      ctx,
      { fetch }
    )
    expect(none.status).toBe(403)
    expect(((await none.json()) as { error: { type: string } }).error.type).toBe('permission_error')
    const other = await hostedAnthropic(
      modelRequest({ model: 'claude-opus-4-1' }),
      lookupOf(grant()),
      ctx,
      { fetch }
    )
    expect(other.status).toBe(403)
    expect(anthropic.requests).toHaveLength(1)
  })
})

/** A Durable Object's storage, in memory. */
function memoryStorage() {
  const map = new Map<string, unknown>()
  return {
    map,
    storage: {
      get: async (key: string) => map.get(key),
      put: async (key: string, value: unknown) => void map.set(key, structuredClone(value)),
      delete: async (key: string) => map.delete(key),
    },
  }
}

describe('HostedSessionSandbox', () => {
  const sandbox = () => {
    const mem = memoryStorage()
    const obj = new HostedSessionSandbox(
      { storage: mem.storage, id: { toString: () => 'the-do-id' } } as never,
      { SESSION_SANDBOX: new FakeSandboxNamespace() } as never
    )
    return { obj, mem }
  }

  it('declares its OWN handlers for both hosts (the registry is keyed by class name)', () => {
    expect(Object.keys(HostedSessionSandbox.outboundByHost ?? {}).sort()).toEqual([
      'api.anthropic.com',
      'github.com',
    ])
  })

  it('merges each half of a grant, and forgets it on clear, destroy and a stopped container', async () => {
    const { obj } = sandbox()
    expect(await obj.getEgressGrant()).toBeNull()
    const { git, model } = grant()
    await obj.setEgressGrant({ git })
    await obj.setEgressGrant({ model })
    expect(await obj.getEgressGrant()).toEqual({ git, model })
    // A later git grant (a checkpoint's push) keeps the model half.
    const later = { ...(git as NonNullable<typeof git>), token: `ghs_${'N'.repeat(36)}` }
    await obj.setEgressGrant({ git: later })
    expect(await obj.getEgressGrant()).toEqual({ git: later, model })

    await obj.clearEgressGrant()
    expect(await obj.getEgressGrant()).toBeNull()

    await obj.setEgressGrant(grant())
    await obj.destroy()
    expect(await obj.getEgressGrant()).toBeNull()

    await obj.setEgressGrant(grant())
    await obj.onStop({ exitCode: 0, reason: 'exit' } as never)
    expect(await obj.getEgressGrant()).toBeNull()
  })

  it('a handler finds the grant by ctx.containerId (idFromString), and refuses without one', async () => {
    const ns = new FakeSandboxNamespace()
    let stored: EgressGrant | null = null
    ns.handlers.getEgressGrant = () => stored
    const containerId = ns.idFromName(NAME).toString()
    const handler = HostedSessionSandbox.outboundByHost?.['github.com']
    if (!handler) throw new Error('no github.com handler')

    const res = await handler(advertise(), { SESSION_SANDBOX: ns } as never, {
      containerId,
      className: 'HostedSessionSandbox',
    })
    expect(res.status).toBe(403)
    expect(ns.calls).toEqual([{ name: NAME, method: 'getEgressGrant', args: [] }])

    stored = grant()
    expect(await grantLookup({ SESSION_SANDBOX: ns } as never)(containerId)).toEqual(stored)
  })
})

describe('the sandbox host’s grant RPC', () => {
  it('stores and clears a grant on the named sandbox’s object, and refuses a bad name', async () => {
    const ns = new FakeSandboxNamespace()
    const host = new SandboxHost({} as never, { SESSION_SANDBOX: ns as never })
    const g = grant()
    expect(await host.setEgressGrant(NAME, g)).toEqual({ ok: true, value: null })
    expect(await host.clearEgressGrant(NAME)).toEqual({ ok: true, value: null })
    expect(ns.calls).toEqual([
      { name: NAME, method: 'setEgressGrant', args: [g] },
      { name: NAME, method: 'clearEgressGrant', args: [] },
    ])
    const bad = await host.setEgressGrant('../etc', g)
    expect(bad.ok).toBe(false)
  })
})
