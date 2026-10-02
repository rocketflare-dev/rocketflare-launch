/**
 * The GitHub App client (`services/launch/github-app.ts`): the app JWT is RS256 with the right
 * claims and verifies against the app's public key; the PKCS#1 PEM GitHub actually issues is
 * accepted (wrapped to PKCS#8 for WebCrypto); every call sends a `User-Agent` (GitHub refuses a
 * request without one) through an INJECTED `fetch`, so nothing here reaches GitHub.
 */
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { importSPKI, jwtVerify } from 'jose'
import { describe, expect, it } from 'vitest'
import {
  appJwt,
  createRuleset,
  GITHUB_TOKEN_PERMISSIONS,
  GitHubApiError,
  getApp,
  getBranchProtection,
  getJobLogs,
  getRepoFile,
  getRuleset,
  installationToken,
  listCheckRunAnnotations,
  listInstallations,
  listRulesets,
  mergePullRequest,
  toPkcs8Pem,
  updateRuleset,
} from '@/api/services/launch/github-app'
import { REQUIRED_GITHUB_PERMISSIONS } from '@/api/services/launch/setup'

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})
const pkcs1Pem = pair.privateKey
const publicPem = pair.publicKey
const auth = { appId: '123456', privateKey: pkcs1Pem }
const NOW = 1_800_000_000

interface Recorded {
  url: string
  method: string
  headers: Headers
  body: string | null
}

function recordingFetch(respond: (url: string) => Response) {
  const calls: Recorded[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    })
    return respond(url)
  }) as typeof fetch
  return { calls, fetch: fetchImpl }
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('toPkcs8Pem', () => {
  it('wraps a PKCS#1 key as PKCS#8, and passes a PKCS#8 key through', () => {
    expect(pkcs1Pem).toContain('BEGIN RSA PRIVATE KEY')
    const wrapped = toPkcs8Pem(pkcs1Pem)
    expect(wrapped).toContain('-----BEGIN PRIVATE KEY-----')
    expect(toPkcs8Pem(wrapped)).toBe(wrapped)
    // Byte-exact with Node's own PKCS#8 export of the same key — not merely importable.
    const expected = createPrivateKey(pkcs1Pem).export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(wrapped).toBe(expected)
  })

  it('accepts a PEM whose newlines were escaped (a pasted secret), and refuses a non-key', () => {
    expect(toPkcs8Pem(pkcs1Pem.replace(/\n/g, '\\n'))).toBe(toPkcs8Pem(pkcs1Pem))
    expect(() =>
      toPkcs8Pem('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')
    ).toThrow()
  })
})

describe('appJwt', () => {
  it('is RS256, iss = app id, iat now − 60, exp now + 540, and verifies with the public key', async () => {
    const token = await appJwt(auth.appId, pkcs1Pem, { now: () => NOW })
    const key = await importSPKI(publicPem, 'RS256')
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      currentDate: new Date(NOW * 1000),
    })
    expect(protectedHeader.alg).toBe('RS256')
    expect(payload).toMatchObject({ iss: '123456', iat: NOW - 60, exp: NOW + 540 })
  })
})

describe('GitHub REST calls', () => {
  it('GET /app and /app/installations with the app JWT and a User-Agent', async () => {
    const { calls, fetch } = recordingFetch(url =>
      url.endsWith('/app')
        ? jsonResponse({
            id: 123456,
            slug: 'launch',
            name: 'Launch',
            owner: { login: 'acme' },
            permissions: {},
          })
        : jsonResponse([{ id: 99, account: { login: 'acme' }, permissions: { contents: 'write' } }])
    )
    const app = await getApp(auth, { fetch, now: () => NOW })
    expect(app.slug).toBe('launch')
    const installations = await listInstallations(auth, { fetch, now: () => NOW })
    expect(installations[0]?.id).toBe(99)

    expect(calls.map(c => c.url)).toEqual([
      'https://api.github.com/app',
      'https://api.github.com/app/installations?per_page=100',
    ])
    for (const call of calls) {
      expect(call.headers.get('user-agent')).toBeTruthy()
      expect(call.headers.get('authorization')).toMatch(/^Bearer ey/)
      expect(call.headers.get('accept')).toBe('application/vnd.github+json')
    }
  })

  it('mints a narrowed installation token', async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ token: 'ghs_x', expires_at: '2030-01-01T00:00:00Z' }, 201)
    )
    const token = await installationToken(
      auth,
      99,
      { repositories: ['widgets'], permissions: { contents: 'read' } },
      { fetch, now: () => NOW }
    )
    expect(token.token).toBe('ghs_x')
    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/app/installations/99/access_tokens',
      method: 'POST',
    })
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      repositories: ['widgets'],
      permissions: { contents: 'read' },
    })
    expect(calls[0]?.headers.get('user-agent')).toBeTruthy()
  })

  it('reads a raw file at a ref, and a missing one is null', async () => {
    const { calls, fetch } = recordingFetch(url =>
      url.includes('missing')
        ? new Response('{"message":"Not Found"}', { status: 404 })
        : new Response('name = "widgets"\n')
    )
    const text = await getRepoFile('ghs_x', 'acme', 'widgets', 'apps/web/wrangler.toml', 'main', {
      fetch,
    })
    expect(text).toBe('name = "widgets"\n')
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/acme/widgets/contents/apps/web/wrangler.toml?ref=main'
    )
    expect(calls[0]?.headers.get('accept')).toBe('application/vnd.github.raw+json')
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer ghs_x')
    expect(calls[0]?.headers.get('user-agent')).toBeTruthy()
    expect(
      await getRepoFile('ghs_x', 'acme', 'widgets', 'missing.json', undefined, { fetch })
    ).toBeNull()
  })

  it('a GitHub error surfaces as GitHubApiError with GitHub’s message', async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ message: 'Bad credentials' }, 401))
    const error = await getApp(auth, { fetch, now: () => NOW }).catch(e => e)
    expect(error).toBeInstanceOf(GitHubApiError)
    expect(error).toMatchObject({ status: 401, message: 'Bad credentials', path: '/app' })
  })
})

describe('issue #5 calls: merge, CI logs, rulesets, protection', () => {
  const opts = (fetchImpl: typeof fetch) => ({ fetch: fetchImpl })

  it('merges with PUT, squash by default, pinned to the head sha; a 409 throws with GitHub’s message', async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({ sha: 'm1', merged: true, message: 'Pull Request successfully merged' })
    )
    const merged = await mergePullRequest(
      'ghs_x',
      'acme',
      'widgets',
      7,
      { sha: 'abc', commitTitle: 'Title (#7)', commitMessage: 'Body' },
      opts(fetch)
    )
    expect(merged).toEqual({ sha: 'm1', merged: true, message: 'Pull Request successfully merged' })
    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/widgets/pulls/7/merge',
      method: 'PUT',
    })
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      merge_method: 'squash',
      sha: 'abc',
      commit_title: 'Title (#7)',
      commit_message: 'Body',
    })

    const moved = recordingFetch(() =>
      jsonResponse({ message: 'Head branch was modified. Review and try the merge again.' }, 409)
    )
    const error = await mergePullRequest(
      'ghs_x',
      'acme',
      'widgets',
      7,
      { sha: 'abc' },
      opts(moved.fetch)
    ).catch(e => e)
    expect(error).toBeInstanceOf(GitHubApiError)
    expect(error).toMatchObject({ status: 409, message: expect.stringContaining('Head branch') })
    expect(JSON.parse(moved.calls[0]?.body ?? '{}')).toEqual({ merge_method: 'squash', sha: 'abc' })
  })

  it('reads a job’s log as text; an expired (410) or missing (404) log is null', async () => {
    const { calls, fetch } = recordingFetch(url =>
      url.includes('/jobs/1/')
        ? new Response('line 1\nline 2\n')
        : url.includes('/jobs/2/')
          ? new Response('{"message":"Gone"}', { status: 410 })
          : new Response('{"message":"Not Found"}', { status: 404 })
    )
    expect(await getJobLogs('ghs_x', 'acme', 'widgets', 1, opts(fetch))).toBe('line 1\nline 2\n')
    expect(await getJobLogs('ghs_x', 'acme', 'widgets', 2, opts(fetch))).toBeNull()
    expect(await getJobLogs('ghs_x', 'acme', 'widgets', 3, opts(fetch))).toBeNull()
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/widgets/actions/jobs/1/logs')
  })

  it('lists a check run’s annotations', async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse([{ path: 'a.ts', start_line: 1, annotation_level: 'failure', message: 'Nope' }])
    )
    const annotations = await listCheckRunAnnotations('ghs_x', 'acme', 'widgets', 42, opts(fetch))
    expect(annotations[0]?.message).toBe('Nope')
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/acme/widgets/check-runs/42/annotations?per_page=50'
    )
  })

  it('lists (with the org’s), reads, creates and updates rulesets; a missing one is null', async () => {
    const ruleset = {
      id: 5,
      name: 'launch',
      enforcement: 'active',
      current_user_can_bypass: 'always',
    }
    const { calls, fetch } = recordingFetch(url =>
      url.endsWith('/rulesets/6') ? new Response('{}', { status: 404 }) : jsonResponse(ruleset)
    )
    const input = {
      name: 'launch',
      target: 'branch' as const,
      enforcement: 'active' as const,
      bypass_actors: [{ actor_id: 123456, actor_type: 'Integration', bypass_mode: 'always' }],
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [{ type: 'non_fast_forward' }],
    }
    await listRulesets('ghs_x', 'acme', 'widgets', opts(fetch))
    expect(await getRuleset('ghs_x', 'acme', 'widgets', 5, opts(fetch))).toMatchObject({ id: 5 })
    expect(await getRuleset('ghs_x', 'acme', 'widgets', 6, opts(fetch))).toBeNull()
    await createRuleset('ghs_x', 'acme', 'widgets', input, opts(fetch))
    await updateRuleset('ghs_x', 'acme', 'widgets', 5, input, opts(fetch))
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.github.com/repos/acme/widgets/rulesets?includes_parents=true&per_page=100',
      'GET https://api.github.com/repos/acme/widgets/rulesets/5',
      'GET https://api.github.com/repos/acme/widgets/rulesets/6',
      'POST https://api.github.com/repos/acme/widgets/rulesets',
      'PUT https://api.github.com/repos/acme/widgets/rulesets/5',
    ])
    expect(JSON.parse(calls[3]?.body ?? '{}')).toEqual(input)
  })

  it('reads classic protection; an unprotected branch (404) is null, a 403 throws', async () => {
    const { calls, fetch } = recordingFetch(url =>
      url.includes('/branches/main/')
        ? jsonResponse({ required_status_checks: { contexts: ['Gate'] } })
        : url.includes('/branches/dev/')
          ? new Response('{"message":"Branch not protected"}', { status: 404 })
          : jsonResponse({ message: 'Upgrade to GitHub Pro' }, 403)
    )
    expect(await getBranchProtection('ghs_x', 'acme', 'widgets', 'main', opts(fetch))).toEqual({
      required_status_checks: { contexts: ['Gate'] },
    })
    expect(await getBranchProtection('ghs_x', 'acme', 'widgets', 'dev', opts(fetch))).toBeNull()
    const denied = await getBranchProtection('ghs_x', 'acme', 'widgets', 'x', opts(fetch)).catch(
      e => e
    )
    expect(denied).toMatchObject({ status: 403 })
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/widgets/branches/main/protection')
  })

  it('narrows each call’s token to what it needs, and asks for no new App permission', () => {
    expect(GITHUB_TOKEN_PERMISSIONS).toEqual({
      merge: { contents: 'write', pull_requests: 'write' },
      readPullRequest: { pull_requests: 'read' },
      jobLogs: { actions: 'read' },
      tagRun: { actions: 'read' },
      checks: { checks: 'read', statuses: 'read' },
      rulesetsWrite: { administration: 'write' },
      rulesetsRead: { administration: 'read' },
      // App page P2: Retry / Cancel of a release's run, and re-pushing a lost tag.
      releaseRun: { actions: 'write', contents: 'read' },
      releaseTag: { contents: 'write', actions: 'read' },
    })
    const levels = { read: 1, write: 2 } as const
    for (const scope of Object.values(GITHUB_TOKEN_PERMISSIONS)) {
      for (const [permission, level] of Object.entries(scope)) {
        const required = REQUIRED_GITHUB_PERMISSIONS[permission]
        expect(required, permission).toBeDefined()
        expect(levels[required as 'read' | 'write']).toBeGreaterThanOrEqual(
          levels[level as 'read' | 'write']
        )
      }
    }
  })
})
