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
  GitHubApiError,
  getApp,
  getRepoFile,
  installationToken,
  listInstallations,
  toPkcs8Pem,
} from '@/api/services/launch/github-app'

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
