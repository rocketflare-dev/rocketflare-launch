/**
 * The git proxy for a kit upgrade session (P6 6c, `docs/plans/p6-fleet.md` §1 item 4): `pnpm
 * kit:upgrade` clones the kit into `.upgrade/kit.git` over `github.com`, so a session of kind
 * `upgrade` may FETCH the template pin's repo — upload-pack only, forwarded to GitHub with no token
 * minted and no `Authorization` sent (the kit is public). A push to it is refused, and an ordinary
 * session gains nothing. The same allowance reaches a session on the remote sandbox host through its
 * egress grant (`HostEgress.prepareGit` → `hostedGitHub`).
 *
 * The pin is the code default here (`DEFAULT_TEMPLATE_PIN`, `rocketflare-dev/rocketflare`): this
 * file never writes the deployment-wide setting.
 */
import { generateKeyPairSync } from 'node:crypto'
import { DEFAULT_TEMPLATE_PIN } from '@launch/shared/launch-setup'
import { describe, expect, it } from 'vitest'
import { handleGitHub } from '@/api/services/sessions/egress/github'
import { HostEgress } from '@/api/services/sessions/egress/host'
import { GitHubRepoHost } from '@/api/services/sessions/repo/github-repo-host'
import type { EgressGrantUpdate } from '@/api/services/sessions/sandbox-host/protocol'
import { loadConfig } from '@/config'
import { hostedGitHub } from '@/sandbox-host/egress'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import { FakeSandbox } from '../helpers/fake-sandbox'
import { insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const env = createTestEnv()
const cfg = loadConfig(env)
const KIT = DEFAULT_TEMPLATE_PIN.repo
const { privateKey: APP_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

function githubHost(cloud: FakeCloud) {
  return new GitHubRepoHost(db, cfg, {
    fetch: cloud.fetch,
    github: {
      auth: { appId: String(cloud.opts.appId), privateKey: APP_PEM },
      installationId: cloud.opts.installationId,
      org: cloud.opts.org,
    },
  })
}

/** GitHub as git sees it: records what reached it and answers an advertisement. */
function upstream() {
  const seen: { url: string; method: string; authorization: string | null; body: string }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    seen.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.get('Authorization'),
      body: req.method === 'POST' ? await req.text() : '',
    })
    return new Response('001e# service=git-upload-pack\n0000', {
      status: 200,
      headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' },
    })
  }) as typeof globalThis.fetch
  return { seen, fetch }
}

async function live(kind: 'upgrade' | 'session') {
  const cloud = createFakeCloud()
  const f = await seedSessionApp(db, cloud)
  cloud.github.tokens.clear()
  const sandboxId = `fake-sandbox-${crypto.randomUUID()}`
  const row = await insertSession(db, f, { status: 'working', sandboxId, kind })
  return { cloud, f, row, sandboxId }
}

const kitUrl = (path: string) => `https://github.com/${KIT}.git/${path}`
const advertise = (service = 'git-upload-pack') =>
  new Request(kitUrl(`info/refs?service=${service}`), {
    // Whatever the sandbox sends is never forwarded.
    headers: { Authorization: 'Basic c2FuZGJveDpzZWNyZXQ=', 'Git-Protocol': 'version=2' },
  })
const uploadPack = () =>
  new Request(kitUrl('git-upload-pack'), {
    method: 'POST',
    body: '0014command=ls-refs\n0000',
    headers: { 'Content-Type': 'application/x-git-upload-pack-request' },
  })

describe('handleGitHub: an upgrade session may fetch the kit', () => {
  it('forwards the kit’s upload-pack to GitHub with no token minted and no Authorization sent', async () => {
    const { cloud, sandboxId } = await live('upgrade')
    const up = upstream()
    const deps = { repoHost: () => githubHost(cloud), fetch: up.fetch }

    const refs = await handleGitHub(advertise(), env, { containerId: sandboxId }, deps)
    expect(refs.status).toBe(200)
    const rpc = await handleGitHub(uploadPack(), env, { containerId: sandboxId }, deps)
    expect(rpc.status).toBe(200)

    expect(up.seen.map(s => [s.method, s.url])).toEqual([
      ['GET', kitUrl('info/refs?service=git-upload-pack')],
      ['POST', kitUrl('git-upload-pack')],
    ])
    expect(up.seen.map(s => s.authorization)).toEqual([null, null])
    expect(up.seen[1]?.body).toContain('command=ls-refs')
    expect(cloud.github.tokens.size).toBe(0)
  })

  it('refuses a push to the kit — the advertisement and the RPC — before anything is sent', async () => {
    const { cloud, sandboxId } = await live('upgrade')
    const up = upstream()
    const deps = { repoHost: () => githubHost(cloud), fetch: up.fetch }
    const refs = await handleGitHub(
      advertise('git-receive-pack'),
      env,
      { containerId: sandboxId },
      deps
    )
    expect(refs.status).toBe(403)
    expect(await refs.text()).toMatch(/never push/)
    const push = await handleGitHub(
      new Request(kitUrl('git-receive-pack'), { method: 'POST', body: '0000PACK' }),
      env,
      { containerId: sandboxId },
      deps
    )
    expect(push.status).toBe(403)
    expect(up.seen).toHaveLength(0)
    expect(cloud.github.tokens.size).toBe(0)
  })

  it('a repo other than the session’s own and the kit is still refused', async () => {
    const { cloud, sandboxId } = await live('upgrade')
    const up = upstream()
    const res = await handleGitHub(
      new Request('https://github.com/someone/else.git/info/refs?service=git-upload-pack'),
      env,
      { containerId: sandboxId },
      { repoHost: () => githubHost(cloud), fetch: up.fetch }
    )
    expect(res.status).toBe(403)
    expect(up.seen).toHaveLength(0)
  })

  it('the session’s own repo still gets its own token', async () => {
    const { cloud, f, sandboxId } = await live('upgrade')
    const up = upstream()
    const res = await handleGitHub(
      new Request(
        `https://github.com/${f.repo.owner}/${f.repo.repo}.git/info/refs?service=git-upload-pack`
      ),
      env,
      { containerId: sandboxId },
      { repoHost: () => githubHost(cloud), fetch: up.fetch }
    )
    expect(res.status).toBe(200)
    expect(up.seen[0]?.authorization).toMatch(/^Basic /)
    expect(cloud.github.tokens.size).toBe(1)
  })
})

describe('handleGitHub: an ordinary session gains nothing', () => {
  it('refuses the kit’s upload-pack', async () => {
    const { cloud, sandboxId } = await live('session')
    const up = upstream()
    const res = await handleGitHub(
      advertise(),
      env,
      { containerId: sandboxId },
      { repoHost: () => githubHost(cloud), fetch: up.fetch }
    )
    expect(res.status).toBe(403)
    expect(await res.text()).toMatch(/own app's repository/)
    expect(up.seen).toHaveLength(0)
  })
})

describe('the remote sandbox host: the grant carries the allowance', () => {
  const TOKEN = `ghs_${'U'.repeat(36)}`
  const mintingHost = {
    gitUpstream: () => 'https://github.com',
    gitAuth: async () => ({ token: TOKEN, expiresAt: new Date(Date.now() + 60 * 60_000) }),
    openPullRequest: () => Promise.reject(new Error('not in this test')),
    getChecks: () => Promise.reject(new Error('not in this test')),
    getPullRequest: () => Promise.reject(new Error('not in this test')),
    mergePullRequest: () => Promise.reject(new Error('not in this test')),
    failedCheckLog: () => Promise.reject(new Error('not in this test')),
  }

  async function grantFor(kind: 'upgrade' | 'session') {
    const { row } = await live(kind)
    const grants: EgressGrantUpdate[] = []
    const sink = {
      setEgressGrant: async (_name: string, grant: EgressGrantUpdate) => {
        grants.push(grant)
        return { ok: true as const, value: null }
      },
    }
    await new HostEgress(db, cfg, mintingHost, sink).prepareGit(
      new FakeSandbox({ name: row.id }),
      row
    )
    const git = grants[0]?.git
    if (!git) throw new Error('no git grant')
    return git
  }

  it('an upgrade session’s grant names the kit; the host fetches it with no token and refuses a push', async () => {
    const git = await grantFor('upgrade')
    const [owner, repo] = KIT.split('/')
    expect(git.readOnlyRepos).toEqual([{ owner, repo }])
    const ctx = { containerId: 'the-do-id', className: 'HostedSessionSandbox' }
    const lookup = async () => ({ git })
    const up = upstream()
    const fetched = await hostedGitHub(advertise(), lookup, ctx, { fetch: up.fetch })
    expect(fetched.status).toBe(200)
    expect(up.seen[0]?.authorization).toBeNull()
    const pushed = await hostedGitHub(advertise('git-receive-pack'), lookup, ctx, {
      fetch: up.fetch,
    })
    expect(pushed.status).toBe(403)
    expect(up.seen).toHaveLength(1)
  })

  it('an ordinary session’s grant names nothing extra', async () => {
    const git = await grantFor('session')
    expect(git.readOnlyRepos).toBeUndefined()
  })
})
