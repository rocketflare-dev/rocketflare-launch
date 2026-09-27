import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * fetch + JSON with a request log. Never throws on HTTP status: spikes assert on status,
 * because negative results (403, 422) are findings.
 */
export async function call(method, url, { headers = {}, body, label } = {}) {
  const init = { method, headers: { ...headers } }
  if (body !== undefined) {
    if (typeof body === 'string' || body instanceof FormData || body instanceof Uint8Array) {
      init.body = body
    } else {
      init.body = JSON.stringify(body)
      init.headers['content-type'] ??= 'application/json'
    }
  }
  const t0 = performance.now()
  const res = await fetch(url, init)
  const ms = Math.round(performance.now() - t0)
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {}
  console.log(`${label ? `[${label}] ` : ''}${method} ${redactUrl(url)} → ${res.status} (${ms}ms)`)
  return { status: res.status, ok: res.ok, json, text, headers: res.headers, ms }
}

const redactUrl = (u) => u.replace(/(key|token|secret)=[^&]+/gi, '$1=***')

export const cf = (token) => (method, path, opts = {}) =>
  call(method, `https://api.cloudflare.com/client/v4${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, ...opts.headers },
  })

export const neon = (key) => (method, path, opts = {}) =>
  call(method, `https://console.neon.tech/api/v2${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...opts.headers },
  })

export const resend = (key) => (method, path, opts = {}) =>
  call(method, `https://api.resend.com${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${key}`, ...opts.headers },
  })

export const gh = (token) => (method, path, opts = {}) =>
  call(method, path.startsWith('http') ? path : `https://api.github.com${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'rocketflare-launch-spike',
      ...opts.headers,
    },
  })

/** A GitHub App JWT (RS256), then an installation token, optionally narrowed to repos/permissions. */
export async function ghInstallationToken({ appId, keyPath, installationId, repositories, permissions }) {
  const now = Math.floor(Date.now() / 1000)
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`
  const sig = createSign('RSA-SHA256').update(unsigned).sign(readFileSync(keyPath), 'base64url')
  const res = await gh(`${unsigned}.${sig}`)('POST', `/app/installations/${installationId}/access_tokens`, {
    body: { ...(repositories && { repositories }), ...(permissions && { permissions }) },
    label: 'gh-app',
  })
  if (!res.ok) throw new Error(`installation token: ${res.status} ${res.text}`)
  return res.json.token
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll fn until it returns a truthy value or the timeout passes; returns { value, ms }. */
export async function poll(fn, { every = 5000, timeout = 600000 } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const value = await fn()
    if (value) return { value, ms: Date.now() - t0 }
    await sleep(every)
  }
  return { value: undefined, ms: Date.now() - t0 }
}

import { Resolver } from 'node:dns'
import { request as httpsRequest } from 'node:https'

// Resolve through 1.1.1.1, so a freshly created host isn't hidden by this machine's cached NXDOMAIN.
const resolver = new Resolver()
resolver.setServers(['1.1.1.1', '1.0.0.1'])
export const publicLookup = (host, opts, cb) =>
  resolver.resolve4(host, (err, addrs) => {
    if (err) return cb(err)
    return opts?.all ? cb(null, addrs.map((address) => ({ address, family: 4 }))) : cb(null, addrs[0], 4)
  })

/** Request a URL over HTTPS using public DNS. Resolves { status, headers, text, json }; never throws on DNS/TLS. */
export function publicGet(url, headers = {}, method = 'GET', body) {
  return new Promise((resolve) => {
    const req = httpsRequest(url, { lookup: publicLookup, headers, method }, (res) => {
      const authorized = res.socket?.authorized
      let text = ''
      res.on('data', (d) => (text += d))
      res.on('end', () => {
        let json
        try {
          json = JSON.parse(text)
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json, authorized })
      })
    })
    req.on('error', (e) => resolve({ status: 0, error: e.code ?? e.message }))
    req.setTimeout(900000)
    req.end(body)
  })
}
