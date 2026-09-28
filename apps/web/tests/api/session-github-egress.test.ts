/**
 * The git proxy (Launch P3 slice 3d, plan §1.5): `handleGitHub` lets a session's sandbox speak git
 * smart-HTTP to its OWN repo only, pushes only its own branch, and injects a one-repo installation
 * token it keeps sealed on the row and re-mints under 10 minutes left — over a `GitHubRepoHost`
 * against the FakeCloud's GitHub, and a `LocalRepoHost` that rewrites to the local git server.
 */
import { generateKeyPairSync } from 'node:crypto'
import { sessionBranchName } from '@launch/shared/launch-sessions'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { decrypt } from '@/api/auth/oauth-encryption'
import {
  FRESH_TOKEN_RETRY_DELAYS_MS,
  handleGitHub,
  parseGitRequest,
  receivePackCommands,
} from '@/api/services/sessions/egress/github'
import { GitHubRepoHost } from '@/api/services/sessions/repo/github-repo-host'
import { LocalRepoHost } from '@/api/services/sessions/repo/local-repo-host'
import { loadConfig } from '@/config'
import { sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import { insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const { privateKey: APP_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

const env = createTestEnv()
const cfg = loadConfig(env)

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

/** An upstream answering `statuses` in turn (then 200s), recording what reached it. */
function flakyUpstream(statuses: number[]) {
  const seen: { authorization: string | null; body: string }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    seen.push({
      authorization: req.headers.get('Authorization'),
      body: req.method === 'POST' ? await req.text() : '',
    })
    const status = statuses.shift() ?? 200
    return status === 200
      ? new Response('001e# service=git-upload-pack\n0000', { status })
      : new Response('Repository not found.', { status })
  }) as typeof globalThis.fetch
  return { seen, fetch }
}

/** A sleep that records its backoffs and returns at once. */
function recordingSleep() {
  const delays: number[] = []
  return { delays, sleep: async (ms: number) => void delays.push(ms) }
}

/** An upstream that records what reached it and answers like git would. */
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
      headers: {
        'Content-Type': 'application/x-git-upload-pack-advertisement',
        'Set-Cookie': 'x=1',
      },
    })
  }) as typeof globalThis.fetch
  return { seen, fetch }
}

async function live() {
  const cloud = createFakeCloud()
  const f = await seedSessionApp(db, cloud)
  // seedSessionApp minted one to create the repo; count only what the proxy mints.
  cloud.github.tokens.clear()
  const sandboxId = `fake-sandbox-${crypto.randomUUID()}`
  const row = await insertSession(db, f, { status: 'working', sandboxId })
  return { cloud, f, row, sandboxId }
}

/** A receive-pack body: pkt-line ref commands, a flush, then (pretend) pack bytes. */
function pushBody(commands: [string, string, string][]): string {
  const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`
  const lines = commands.map(([o, n, ref], i) =>
    pkt(`${o} ${n} ${ref}${i === 0 ? '\0report-status side-band-64k' : ''}\n`)
  )
  return `${lines.join('')}0000PACK....`
}

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const ZERO = '0'.repeat(40)

describe('what counts as git', () => {
  it('parses the three smart-HTTP requests and nothing else', () => {
    const get = (p: string) => parseGitRequest(new Request(`https://github.com${p}`))
    const post = (p: string) =>
      parseGitRequest(new Request(`https://github.com${p}`, { method: 'POST' }))
    expect(get('/acme/app.git/info/refs?service=git-upload-pack')).toMatchObject({
      owner: 'acme',
      repo: 'app',
      service: 'git-upload-pack',
      kind: 'advertise',
    })
    expect(get('/acme/app/info/refs?service=git-receive-pack')).toMatchObject({ repo: 'app' })
    expect(post('/acme/app.git/git-receive-pack')).toMatchObject({ kind: 'rpc' })
    expect(get('/acme/app.git/info/refs')).toBeNull() // dumb HTTP
    expect(get('/acme/app.git/git-upload-pack')).toBeNull() // wrong method
    expect(get('/acme/app/archive/refs/heads/main.zip')).toBeNull()
    expect(get('/login')).toBeNull()
  })

  it('reads the ref commands at the head of a push', () => {
    const body = new TextEncoder().encode(
      pushBody([
        [OLD, NEW, 'refs/heads/session/abc'],
        [OLD, ZERO, 'refs/heads/main'],
      ])
    )
    expect(receivePackCommands(body)).toEqual([
      { oldSha: OLD, newSha: NEW, ref: 'refs/heads/session/abc' },
      { oldSha: OLD, newSha: ZERO, ref: 'refs/heads/main' },
    ])
    expect(receivePackCommands(new TextEncoder().encode('garbage'))).toBeNull()
  })
})

describe('handleGitHub', () => {
  it('another repo, or anything that is not git, is refused before any token is minted', async () => {
    const { cloud, sandboxId } = await live()
    const up = upstream()
    const deps = { repoHost: () => githubHost(cloud), fetch: up.fetch }
    const other = await handleGitHub(
      new Request(
        `https://github.com/${cloud.opts.org}/someone-else.git/info/refs?service=git-upload-pack`
      ),
      env,
      { containerId: sandboxId },
      deps
    )
    expect(other.status).toBe(403)
    expect(await other.text()).toMatch(/own app's repository/)
    const web = await handleGitHub(
      new Request(`https://github.com/${cloud.opts.org}/x/archive/main.zip`),
      env,
      { containerId: sandboxId },
      deps
    )
    expect(web.status).toBe(403)
    expect(up.seen).toHaveLength(0)
    expect(cloud.github.tokens.size).toBe(0)
  })

  it('injects a one-repo token, seals it on the row, and reuses it while it has time left', async () => {
    const { cloud, f, row, sandboxId } = await live()
    const up = upstream()
    const deps = { repoHost: () => githubHost(cloud), fetch: up.fetch }
    const url = `https://github.com/${f.repo.owner}/${f.repo.repo}.git/info/refs?service=git-upload-pack`

    const res = await handleGitHub(new Request(url), env, { containerId: sandboxId }, deps)
    expect(res.status).toBe(200)
    expect(res.headers.get('Set-Cookie')).toBeNull()
    expect(up.seen[0]?.url).toBe(url)
    const [minted] = [...cloud.github.tokens.values()]
    expect(minted?.repositories).toEqual([f.repo.repo])
    expect(minted?.permissions).toEqual({ contents: 'write', pull_requests: 'write' })
    expect(up.seen[0]?.authorization).toBe(`Basic ${btoa(`x-access-token:${minted?.token}`)}`)

    const [stored] = await db.select().from(sessions).where(eq(sessions.id, row.id))
    expect(stored?.githubTokenSealed).toBeTruthy()
    expect(stored?.githubTokenSealed).not.toContain(minted?.token)
    expect(await decrypt(stored?.githubTokenSealed ?? '', cfg.OAUTH_ENCRYPTION_KEY as string)).toBe(
      minted?.token
    )
    expect(stored?.githubTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000)

    await handleGitHub(new Request(url), env, { containerId: sandboxId }, deps)
    expect(cloud.github.tokens.size).toBe(1)
    expect(up.seen[1]?.authorization).toBe(up.seen[0]?.authorization)
  })

  it('re-mints the token when under 10 minutes remain', async () => {
    const { cloud, f, row, sandboxId } = await live()
    const up = upstream()
    const deps = { repoHost: () => githubHost(cloud), fetch: up.fetch }
    const url = `https://github.com/${f.repo.owner}/${f.repo.repo}.git/info/refs?service=git-upload-pack`
    await handleGitHub(new Request(url), env, { containerId: sandboxId }, deps)
    const first = up.seen[0]?.authorization

    // Nine minutes left on the sealed token.
    await db
      .update(sessions)
      .set({ githubTokenExpiresAt: new Date(Date.now() + 9 * 60_000) })
      .where(eq(sessions.id, row.id))
    await handleGitHub(new Request(url), env, { containerId: sandboxId }, deps)
    expect(cloud.github.tokens.size).toBe(2)
    expect(up.seen[1]?.authorization).not.toBe(first)
    const [stored] = await db.select().from(sessions).where(eq(sessions.id, row.id))
    expect(stored?.githubTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000)
  })

  it('re-mints a token that has already expired (a session idle past the hour)', async () => {
    const { cloud, f, row, sandboxId } = await live()
    const up = upstream()
    const deps = { repoHost: () => githubHost(cloud), fetch: up.fetch }
    const url = `https://github.com/${f.repo.owner}/${f.repo.repo}.git/info/refs?service=git-receive-pack`
    await handleGitHub(new Request(url), env, { containerId: sandboxId }, deps)
    await db
      .update(sessions)
      .set({ githubTokenExpiresAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(sessions.id, row.id))
    const res = await handleGitHub(new Request(url), env, { containerId: sandboxId }, deps)
    expect(res.status).toBe(200)
    expect(cloud.github.tokens.size).toBe(2)
    expect(up.seen[1]?.authorization).not.toBe(up.seen[0]?.authorization)
  })

  it('a freshly minted token GitHub has not settled: a 404 then a 200 succeeds after a backoff', async () => {
    const { cloud, f, sandboxId } = await live()
    const up = flakyUpstream([404])
    const clock = recordingSleep()
    const deps = { repoHost: () => githubHost(cloud), fetch: up.fetch, sleep: clock.sleep }
    const url = `https://github.com/${f.repo.owner}/${f.repo.repo}.git/info/refs?service=git-receive-pack`
    const res = await handleGitHub(new Request(url), env, { containerId: sandboxId }, deps)
    expect(res.status).toBe(200)
    expect(up.seen).toHaveLength(2)
    expect(up.seen[1]?.authorization).toBe(up.seen[0]?.authorization)
    expect(clock.delays).toEqual([FRESH_TOKEN_RETRY_DELAYS_MS[0]])
    expect(cloud.github.tokens.size).toBe(1)
  })

  it('a fresh token’s push is replayed whole on a 401, and a 404 that persists is returned after three retries', async () => {
    const { cloud, f, row, sandboxId } = await live()
    const own = `refs/heads/${sessionBranchName(row.shortId)}`
    const body = pushBody([[OLD, NEW, own]])
    const url = `https://github.com/${f.repo.owner}/${f.repo.repo}.git/git-receive-pack`
    const push = (deps: object) =>
      handleGitHub(
        new Request(url, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/x-git-receive-pack-request' },
        }),
        env,
        { containerId: sandboxId },
        deps
      )

    const flaky = flakyUpstream([401])
    const first = recordingSleep()
    const ok = await push({ repoHost: () => githubHost(cloud), fetch: flaky.fetch, ...first })
    expect(ok.status).toBe(200)
    expect(flaky.seen.map(s => s.body)).toEqual([body, body])

    // Make the sealed token fresh again (re-mint), and have GitHub never accept it.
    await db
      .update(sessions)
      .set({ githubTokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, row.id))
    const gone = flakyUpstream([404, 404, 404, 404, 404])
    const second = recordingSleep()
    const res = await push({ repoHost: () => githubHost(cloud), fetch: gone.fetch, ...second })
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('Repository not found')
    expect(gone.seen).toHaveLength(1 + FRESH_TOKEN_RETRY_DELAYS_MS.length)
    expect(second.delays).toEqual([...FRESH_TOKEN_RETRY_DELAYS_MS])
  })

  it('a token that has been valid for a while: its 404 is passed through without a retry', async () => {
    const { cloud, f, row, sandboxId } = await live()
    const url = `https://github.com/${f.repo.owner}/${f.repo.repo}.git/info/refs?service=git-upload-pack`
    await handleGitHub(
      new Request(url),
      env,
      { containerId: sandboxId },
      {
        repoHost: () => githubHost(cloud),
        fetch: upstream().fetch,
      }
    )
    // Minted half an hour ago: 30 minutes left.
    await db
      .update(sessions)
      .set({ githubTokenExpiresAt: new Date(Date.now() + 30 * 60_000) })
      .where(eq(sessions.id, row.id))
    const up = flakyUpstream([404])
    const clock = recordingSleep()
    const res = await handleGitHub(
      new Request(url),
      env,
      { containerId: sandboxId },
      {
        repoHost: () => githubHost(cloud),
        fetch: up.fetch,
        sleep: clock.sleep,
      }
    )
    expect(res.status).toBe(404)
    expect(up.seen).toHaveLength(1)
    expect(clock.delays).toEqual([])
    expect(cloud.github.tokens.size).toBe(1)
  })

  it('two requests re-minting at once converge on the one token the row keeps', async () => {
    const { cloud, f, row, sandboxId } = await live()
    const up = upstream()
    const deps = { repoHost: () => githubHost(cloud), fetch: up.fetch }
    const url = `https://github.com/${f.repo.owner}/${f.repo.repo}.git/info/refs?service=git-upload-pack`
    await Promise.all([
      handleGitHub(new Request(url), env, { containerId: sandboxId }, deps),
      handleGitHub(new Request(url), env, { containerId: sandboxId }, deps),
    ])
    expect(up.seen).toHaveLength(2)
    expect(up.seen[1]?.authorization).toBe(up.seen[0]?.authorization)
    const [stored] = await db.select().from(sessions).where(eq(sessions.id, row.id))
    const token = await decrypt(stored?.githubTokenSealed ?? '', cfg.OAUTH_ENCRYPTION_KEY as string)
    expect(up.seen[0]?.authorization).toBe(`Basic ${btoa(`x-access-token:${token}`)}`)
  })

  it('a push may move only the session’s own branch, and never delete it', async () => {
    const { cloud, f, row, sandboxId } = await live()
    const up = upstream()
    const deps = { repoHost: () => githubHost(cloud), fetch: up.fetch }
    const url = `https://github.com/${f.repo.owner}/${f.repo.repo}.git/git-receive-pack`
    const own = `refs/heads/${sessionBranchName(row.shortId)}`
    const push = (body: string) =>
      handleGitHub(
        new Request(url, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/x-git-receive-pack-request' },
        }),
        env,
        { containerId: sandboxId },
        deps
      )

    const toMain = await push(pushBody([[OLD, NEW, 'refs/heads/main']]))
    expect(toMain.status).toBe(403)
    expect(await toMain.text()).toContain('refs/heads/main')
    expect(
      (
        await push(
          pushBody([
            [OLD, NEW, own],
            [OLD, NEW, 'refs/heads/other'],
          ])
        )
      ).status
    ).toBe(403)
    expect((await push(pushBody([[OLD, ZERO, own]]))).status).toBe(403)
    expect(up.seen).toHaveLength(0)

    const ok = await push(pushBody([[OLD, NEW, own]]))
    expect(ok.status).toBe(200)
    expect(up.seen[0]?.body).toContain(own)
    expect(up.seen[0]?.body).toContain('PACK')
  })

  it('an ended session’s container is nobody', async () => {
    const { cloud, f } = await live()
    const endedId = `fake-sandbox-${crypto.randomUUID()}`
    await insertSession(db, f, { status: 'ended', sandboxId: endedId })
    const res = await handleGitHub(
      new Request(
        `https://github.com/${f.repo.owner}/${f.repo.repo}.git/info/refs?service=git-upload-pack`
      ),
      env,
      { containerId: endedId },
      { repoHost: () => githubHost(cloud), fetch: upstream().fetch }
    )
    expect(res.status).toBe(403)
  })

  it('LocalRepoHost: rewritten to the local git server, with no credential', async () => {
    const { f, sandboxId } = await live()
    const up = upstream()
    const local = new LocalRepoHost({ ...cfg, SESSION_LOCAL_GIT_URL: 'http://localhost:9420/' })
    const res = await handleGitHub(
      new Request(
        `https://github.com/${f.repo.owner}/${f.repo.repo}.git/info/refs?service=git-upload-pack`
      ),
      env,
      { containerId: sandboxId },
      { repoHost: () => local, fetch: up.fetch }
    )
    expect(res.status).toBe(200)
    expect(up.seen[0]?.url).toBe(
      `http://localhost:9420/${f.repo.owner}/${f.repo.repo}.git/info/refs?service=git-upload-pack`
    )
    expect(up.seen[0]?.authorization).toBeNull()
  })
})
