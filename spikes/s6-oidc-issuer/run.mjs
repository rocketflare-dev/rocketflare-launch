// S6: is a small jose-based issuer a standard OIDC provider? A standard RP (openid-client) tries it.
// OpenAuth was ruled out by reading its code (no id_token, no discovery, no userinfo): see RESULT.md.
import { execSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as oidc from 'openid-client'
import { createRemoteJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose'
import { need } from '../lib/env.mjs'
import { cf, poll, publicGet } from '../lib/http.mjs'
import { ensureWildcard } from '../lib/worker.mjs'
import { record } from '../lib/created.mjs'

const e = need('CF_ACCOUNT_ID', 'CF_ZONE_ID', 'CF_ZONE_NAME', 'CF_ADMIN_TOKEN')
const ADMIN = cf(e.CF_ADMIN_TOKEN)
const must = (r) => {
  if (!r.ok) throw new Error(`${r.status} ${r.text.slice(0, 300)}`)
  return r.json
}
const HOST = `rfspike-issuer-${randomBytes(3).toString('hex')}.${e.CF_ZONE_NAME}` // fresh name: no stale local DNS
const ISS = `https://${HOST}`
const sha = (s) => createHash('sha256').update(s).digest('base64url')

// --- Deploy -------------------------------------------------------------------------------------
const { privateKey } = await generateKeyPair('ES256', { extractable: true })
const jwk = { ...(await exportJWK(privateKey)), kid: `k-${randomBytes(4).toString('hex')}` }
const secretA = randomBytes(24).toString('base64url')
const secretB = randomBytes(24).toString('base64url')
const clients = {
  'app-a': { secret_sha256: sha(secretA), redirect_uris: ['https://app-a.example/callback'], post_logout_redirect_uris: ['https://app-a.example/'], allowed_groups: ['finance', 'eng'] },
  'app-b': { secret_sha256: sha(secretB), redirect_uris: ['https://app-b.example/callback'], post_logout_redirect_uris: [], allowed_groups: ['finance'] },
}
const dir = join(import.meta.dirname, 'issuer')
writeFileSync(
  join(dir, 'wrangler.toml'),
  `name = "rfspike-issuer"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\nworkers_dev = false\n\n[vars]\nISSUER = "${ISS}"\nCLIENTS = ${JSON.stringify(JSON.stringify(clients))}\n\n[[durable_objects.bindings]]\nname = "CODES"\nclass_name = "Codes"\n\n[[migrations]]\ntag = "v1"\nnew_sqlite_classes = ["Codes"]\n`,
)
execSync('pnpm dlx wrangler@latest deploy', { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CLOUDFLARE_API_TOKEN: e.CF_ADMIN_TOKEN, CLOUDFLARE_ACCOUNT_ID: e.CF_ACCOUNT_ID } })
record('cf.worker', 'rfspike-issuer')
for (const [name, text] of [['SIGNING_JWK', JSON.stringify(jwk)], ['SESSION_SECRET', randomBytes(32).toString('hex')]])
  must(await ADMIN('PUT', `/accounts/${e.CF_ACCOUNT_ID}/workers/scripts/rfspike-issuer/secrets`, { body: { name, text, type: 'secret_text' } }))
await ensureWildcard(e.CF_ADMIN_TOKEN, e.CF_ZONE_ID, e.CF_ZONE_NAME, record)
const route = must(await ADMIN('POST', `/zones/${e.CF_ZONE_ID}/workers/routes`, { body: { pattern: `${HOST}/*`, script: 'rfspike-issuer' } }))
record('cf.route', route.result.id, { pattern: `${HOST}/*` })
await poll(async () => (await publicGet(`${ISS}/.well-known/openid-configuration`)).status === 200, { every: 2000, timeout: 120000 })

// --- The RP side --------------------------------------------------------------------------------
const results = []
const check = (label, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` · ${detail}` : ''}`)
}
const signIn = async (user) => {
  const r = await fetch(`${ISS}/stub-login?user=${user}`)
  return r.headers.get('set-cookie').split(';')[0]
}
/** Start an authorization request as a browser with `cookie` would; returns the redirect Location. */
async function authorize(config, cookie, extra = {}) {
  const verifier = oidc.randomPKCECodeVerifier()
  const nonce = oidc.randomNonce()
  const state = oidc.randomState()
  const params = {
    redirect_uri: extra.redirect_uri ?? config.clientMetadata().redirect_uris?.[0] ?? `https://${config.clientMetadata().client_id}.example/callback`,
    scope: 'openid email profile groups',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    nonce,
    state,
    ...extra.params,
  }
  const url = oidc.buildAuthorizationUrl(config, params)
  if (extra.dropPkce) {
    url.searchParams.delete('code_challenge')
    url.searchParams.delete('code_challenge_method')
  }
  const r = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} })
  return { status: r.status, location: r.headers.get('location'), verifier, nonce, state, redirect_uri: params.redirect_uri, body: r.status === 400 ? await r.text() : '' }
}
const rawToken = (body) =>
  fetch(`${ISS}/oidc/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then(async (r) => ({ status: r.status, body: await r.json() }))

const A = await oidc.discovery(new URL(ISS), 'app-a', { client_secret: secretA, redirect_uris: ['https://app-a.example/callback'] })
check('discovery: openid-client accepts the issuer metadata', A.serverMetadata().issuer === ISS, Object.keys(A.serverMetadata()).length + ' fields')
const B = await oidc.discovery(new URL(ISS), 'app-b', { client_secret: secretB, redirect_uris: ['https://app-b.example/callback'] })
// Log any non-2xx response the RP gets, so a failure shows the issuer's own error.
for (const c of [A, B])
  c[oidc.customFetch] = async (url, opts) => {
    const r = await fetch(url, opts)
    if (r.status >= 300) console.log(`  (issuer answered ${r.status} to ${new URL(url).pathname}: ${(await r.clone().text()).slice(0, 300)})`)
    return r
  }

// Happy path: alice signs in to app A.
const alice = await signIn('alice')
const a1 = await authorize(A, alice)
const tokens = await oidc.authorizationCodeGrant(A, new URL(a1.location), { pkceCodeVerifier: a1.verifier, expectedNonce: a1.nonce, expectedState: a1.state, idTokenExpected: true })
const claims = tokens.claims()
check('code flow: openid-client validates the id_token (ES256 signature, iss, aud, exp, nonce, iss on the redirect)', claims.sub === 'usr_01alice', JSON.stringify({ sub: claims.sub, email: claims.email, groups: claims.groups }))
const info = await oidc.fetchUserInfo(A, tokens.access_token, claims.sub)
check('userinfo returns the same subject', info.sub === claims.sub && info.email === 'alice@example.com')

// Replay the same code.
const code1 = new URL(a1.location).searchParams.get('code')
const replay = await rawToken({ grant_type: 'authorization_code', code: code1, redirect_uri: a1.redirect_uri, code_verifier: a1.verifier, client_id: 'app-a', client_secret: secretA })
check('a replayed code is refused', replay.status === 400 && replay.body.error === 'invalid_grant', JSON.stringify(replay.body))

// Wrong PKCE verifier.
const a2 = await authorize(A, alice)
const wrongPkce = await rawToken({ grant_type: 'authorization_code', code: new URL(a2.location).searchParams.get('code'), redirect_uri: a2.redirect_uri, code_verifier: oidc.randomPKCECodeVerifier(), client_id: 'app-a', client_secret: secretA })
check('a wrong PKCE verifier is refused', wrongPkce.body.error === 'invalid_grant', JSON.stringify(wrongPkce.body))

// Wrong client secret.
const a3 = await authorize(A, alice)
const wrongSecret = await rawToken({ grant_type: 'authorization_code', code: new URL(a3.location).searchParams.get('code'), redirect_uri: a3.redirect_uri, code_verifier: a3.verifier, client_id: 'app-a', client_secret: 'nope' })
check('a wrong client secret is refused', wrongSecret.status === 401 && wrongSecret.body.error === 'invalid_client')

// A code issued to app A, redeemed by app B.
const a4 = await authorize(A, alice)
const crossClient = await rawToken({ grant_type: 'authorization_code', code: new URL(a4.location).searchParams.get('code'), redirect_uri: a4.redirect_uri, code_verifier: a4.verifier, client_id: 'app-b', client_secret: secretB })
check("app B can't redeem app A's code", crossClient.body.error === 'invalid_grant', JSON.stringify(crossClient.body))

// An unregistered redirect_uri: no redirect at all.
const badRedirect = await authorize(A, alice, { redirect_uri: 'https://attacker.example/callback' })
check('an unregistered redirect_uri gets an error page, not a redirect', badRedirect.status === 400 && !badRedirect.location, badRedirect.body)

// No PKCE.
const noPkce = await authorize(A, alice, { dropPkce: true })
check('a request without PKCE is refused', new URL(noPkce.location).searchParams.get('error') === 'invalid_request')

// Access policy: bob is in eng; app B allows finance only.
const bob = await signIn('bob')
const denied = await authorize(B, bob)
check('access policy: bob is denied app B', new URL(denied.location).searchParams.get('error') === 'access_denied')

// SSO: alice, already signed in to Launch, goes to app B: straight back with a code.
const sso = await authorize(B, alice)
const ssoTokens = await oidc.authorizationCodeGrant(B, new URL(sso.location), { pkceCodeVerifier: sso.verifier, expectedNonce: sso.nonce, expectedState: sso.state, idTokenExpected: true })
check('single sign-on: an existing Launch session signs alice in to app B with no prompt', ssoTokens.claims().sub === 'usr_01alice' && ssoTokens.claims().aud === 'app-b')

// No session: sent to sign in.
const anon = await authorize(A, undefined)
check('no Launch session: redirected to sign in', anon.status === 302 && new URL(anon.location).pathname === '/stub-login')

// A tampered id_token fails against the published JWKS.
const [h, p, s] = tokens.id_token.split('.')
const tampered = `${h}.${Buffer.from(JSON.stringify({ ...claims, sub: 'usr_02bob' })).toString('base64url')}.${s}`
const jwks = createRemoteJWKSet(new URL(`${ISS}/.well-known/jwks.json`))
const tamperedOk = await jwtVerify(tampered, jwks, { issuer: ISS, audience: 'app-a' }).then(() => true, () => false)
check('a tampered id_token fails verification against the JWKS', !tamperedOk)

// RP-initiated logout.
const endUrl = oidc.buildEndSessionUrl(A, { post_logout_redirect_uri: 'https://app-a.example/', client_id: 'app-a', state: 'bye' })
const lo = await fetch(endUrl, { redirect: 'manual', headers: { cookie: alice } })
check('logout clears the Launch session and returns to the registered URI', lo.status === 302 && lo.headers.get('location') === 'https://app-a.example/?state=bye' && /Max-Age=0/.test(lo.headers.get('set-cookie')))
const loBad = await fetch(oidc.buildEndSessionUrl(A, { post_logout_redirect_uri: 'https://attacker.example/', client_id: 'app-a' }), { redirect: 'manual' })
check('logout never redirects to an unregistered URI', loBad.status === 200)

console.log(`\n${results.every(Boolean) ? 'ALL PASS' : `${results.filter((x) => !x).length} FAILED`} (${results.length} checks) against ${ISS}`)
