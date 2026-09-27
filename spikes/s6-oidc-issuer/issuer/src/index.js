// A minimal OpenID Connect issuer on jose: the spec/05 subset and nothing more.
//   discovery · jwks · authorize (code + PKCE S256 only) · token · userinfo · end_session
// The upstream IdP (Google/Microsoft) is stubbed by /stub-login, which signs a user in to "Launch".
import { DurableObject } from 'cloudflare:workers'
import { SignJWT, importJWK, jwtVerify } from 'jose'

// --- Single-use authorization codes: get-and-delete in one Durable Object call is atomic. -------
export class Codes extends DurableObject {
  async put(code, value) {
    await this.ctx.storage.put(code, value)
  }
  async take(code) {
    const v = await this.ctx.storage.get(code)
    if (!v) return undefined
    await this.ctx.storage.delete(code)
    return v
  }
}

const USERS = {
  alice: { sub: 'usr_01alice', email: 'alice@example.com', name: 'Alice', groups: ['finance'] },
  bob: { sub: 'usr_02bob', email: 'bob@example.com', name: 'Bob', groups: ['eng'] },
}

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256 = async (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)))
const timingSafeEqual = (a, b) => a.length === b.length && crypto.subtle.timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b))

async function hmac(env, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))
}
async function readSession(req, env) {
  const m = (req.headers.get('cookie') ?? '').match(/__Host-launch=([^;]+)/)
  if (!m) return undefined
  const [payload, sig] = m[1].split('.')
  if (!timingSafeEqual(sig ?? '', await hmac(env, payload))) return undefined
  const s = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
  return s.exp > Date.now() / 1000 ? s : undefined
}

const err = (status, error, description) => Response.json({ error, error_description: description }, { status, headers: { 'cache-control': 'no-store' } })
const redirect = (url) => new Response(null, { status: 302, headers: { location: url } })

async function keys(env) {
  const jwk = JSON.parse(env.SIGNING_JWK)
  const privateKey = await importJWK(jwk, 'ES256')
  const { d, ...pub } = jwk
  return { privateKey, kid: jwk.kid, publicJwk: { ...pub, alg: 'ES256', use: 'sig' } }
}

async function clientAuth(req, form, env) {
  let id = form.get('client_id')
  let secret = form.get('client_secret')
  const basic = (req.headers.get('authorization') ?? '').match(/^Basic (.+)$/i)
  if (basic) [id, secret] = atob(basic[1]).split(':').map(decodeURIComponent)
  const client = JSON.parse(env.CLIENTS)[id]
  if (!client || !secret) return undefined
  const hash = b64url(await sha256(secret))
  return timingSafeEqual(hash, client.secret_sha256) ? { id, ...client } : undefined
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const iss = env.ISSUER
    const clients = JSON.parse(env.CLIENTS)

    if (url.pathname === '/.well-known/openid-configuration')
      return Response.json({
        issuer: iss,
        authorization_endpoint: `${iss}/oidc/authorize`,
        token_endpoint: `${iss}/oidc/token`,
        userinfo_endpoint: `${iss}/oidc/userinfo`,
        jwks_uri: `${iss}/.well-known/jwks.json`,
        end_session_endpoint: `${iss}/oidc/logout`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'email', 'profile', 'groups'],
        claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'email', 'email_verified', 'name', 'groups'],
      })

    if (url.pathname === '/.well-known/jwks.json') return Response.json({ keys: [(await keys(env)).publicJwk] })

    // Stand-in for the upstream Google/Microsoft sign-in: sets Launch's own host-only session.
    if (url.pathname === '/stub-login') {
      const user = USERS[url.searchParams.get('user')]
      if (!user) return err(400, 'invalid_request', 'unknown user')
      const payload = b64url(new TextEncoder().encode(JSON.stringify({ u: url.searchParams.get('user'), auth_time: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })))
      return new Response('signed in', {
        headers: { 'set-cookie': `__Host-launch=${payload}.${await hmac(env, payload)}; Path=/; Secure; HttpOnly; SameSite=Lax` },
      })
    }

    if (url.pathname === '/oidc/authorize') {
      const p = url.searchParams
      const client = clients[p.get('client_id')]
      // Never redirect to an unregistered URI: errors about the client or redirect_uri are shown here.
      if (!client) return err(400, 'invalid_client', 'unknown client_id')
      if (!client.redirect_uris.includes(p.get('redirect_uri'))) return err(400, 'invalid_request', 'redirect_uri not registered')
      const back = (params) => {
        const u = new URL(p.get('redirect_uri'))
        for (const [k, v] of Object.entries({ ...params, state: p.get('state'), iss })) if (v) u.searchParams.set(k, v)
        return redirect(u.toString())
      }
      if (p.get('response_type') !== 'code') return back({ error: 'unsupported_response_type' })
      if (!(p.get('scope') ?? '').split(' ').includes('openid')) return back({ error: 'invalid_scope', error_description: 'openid is required' })
      if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) return back({ error: 'invalid_request', error_description: 'PKCE S256 is required' })

      const session = await readSession(req, env)
      if (!session) return redirect(`${iss}/stub-login?return=${encodeURIComponent(url.toString())}`)
      const user = USERS[session.u]
      // The per-app access policy (spec/05). Launch proper shows a "request access" page here.
      if (!user.groups.some((g) => client.allowed_groups.includes(g))) return back({ error: 'access_denied', error_description: 'not allowed to use this app' })

      const code = random()
      const store = env.CODES.get(env.CODES.idFromName('codes'))
      await store.put(code, {
        client_id: p.get('client_id'),
        redirect_uri: p.get('redirect_uri'),
        code_challenge: p.get('code_challenge'),
        nonce: p.get('nonce'),
        scope: p.get('scope'),
        user: session.u,
        auth_time: session.auth_time,
        exp: Date.now() + 60_000,
      })
      return back({ code })
    }

    if (url.pathname === '/oidc/token' && req.method === 'POST') {
      const form = await req.formData()
      const client = await clientAuth(req, form, env)
      if (!client) return err(401, 'invalid_client', 'client authentication failed')
      if (form.get('grant_type') !== 'authorization_code') return err(400, 'unsupported_grant_type', 'only authorization_code')
      const store = env.CODES.get(env.CODES.idFromName('codes'))
      const c = await store.take(form.get('code') ?? '')
      // A replayed code finds nothing: take() deleted it on first use.
      if (!c || c.exp < Date.now()) return err(400, 'invalid_grant', 'code is invalid, expired or already used')
      if (c.client_id !== client.id) return err(400, 'invalid_grant', 'code was issued to another client')
      if (c.redirect_uri !== form.get('redirect_uri')) return err(400, 'invalid_grant', 'redirect_uri does not match')
      const verifier = form.get('code_verifier') ?? ''
      if (!timingSafeEqual(b64url(await sha256(verifier)), c.code_challenge)) return err(400, 'invalid_grant', 'PKCE verification failed')

      const user = USERS[c.user]
      const { privateKey, kid } = await keys(env)
      const now = Math.floor(Date.now() / 1000)
      const idToken = await new SignJWT({
        auth_time: c.auth_time,
        ...(c.nonce && { nonce: c.nonce }),
        email: user.email,
        email_verified: true,
        name: user.name,
        groups: user.groups,
      })
        .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
        .setIssuer(iss)
        .setSubject(user.sub)
        .setAudience(client.id)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey)
      const accessToken = await new SignJWT({ scope: c.scope, client_id: client.id })
        .setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' })
        .setIssuer(iss)
        .setSubject(user.sub)
        .setAudience(`${iss}/oidc/userinfo`)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey)
      return Response.json(
        { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken, scope: c.scope },
        { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
      )
    }

    if (url.pathname === '/oidc/userinfo') {
      const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '')
      try {
        const { publicJwk } = await keys(env)
        const { payload } = await jwtVerify(token, await importJWK(publicJwk, 'ES256'), { issuer: iss, audience: `${iss}/oidc/userinfo`, typ: 'at+jwt' })
        const user = Object.values(USERS).find((u) => u.sub === payload.sub)
        return Response.json({ sub: user.sub, email: user.email, email_verified: true, name: user.name, groups: user.groups })
      } catch {
        return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } })
      }
    }

    if (url.pathname === '/oidc/logout') {
      const target = url.searchParams.get('post_logout_redirect_uri')
      const clientId = url.searchParams.get('client_id')
      const allowed = clientId && clients[clientId]?.post_logout_redirect_uris?.includes(target)
      const headers = { 'set-cookie': '__Host-launch=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0' }
      if (!allowed) return new Response('signed out of Launch', { headers })
      const u = new URL(target)
      if (url.searchParams.get('state')) u.searchParams.set('state', url.searchParams.get('state'))
      return new Response(null, { status: 302, headers: { ...headers, location: u.toString() } })
    }

    return new Response('not found', { status: 404 })
  },
}

