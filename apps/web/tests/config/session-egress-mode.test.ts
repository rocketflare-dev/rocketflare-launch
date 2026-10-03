/**
 * `SESSION_EGRESS` (docs/plans/sandbox-websocket-close.md): `allowlist` — internet off, the egress
 * allow-list, everything intercepted — or `open` — internet on, no allow-list, only the model and
 * git hosts intercepted. Missing = `allowlist`. The switch lives in `SessionSandboxBase`, driven
 * here through the host's subclass (it bundles nothing of Launch's database), over the
 * `@cloudflare/sandbox` stub and a fake `ctx` whose storage records what the constructor deletes.
 */
import { describe, expect, it } from 'vitest'
import { SDK_OUTBOUND_CONFIGURATION_KEY } from '@/api/durable-objects/session-sandbox-base'
import { SESSION_BASE_ALLOWED_HOSTS, sessionEgressMode } from '@/api/services/sessions/sandbox-port'
import { loadConfig } from '@/config'
import { HostedSessionSandbox } from '@/sandbox-host/hosted-session-sandbox'
import { createTestEnv } from '../mocks/bindings'

/** A `DurableObjectState` with just the synchronous KV the constructor may touch. */
function fakeCtx() {
  const kv = new Map<string, unknown>([
    [
      SDK_OUTBOUND_CONFIGURATION_KEY,
      { allowedHosts: ['github.com'], hasInterceptAllRegistration: true },
    ],
  ])
  const ctx = { storage: { kv: { delete: (key: string) => kv.delete(key) } } }
  return { ctx, kv }
}

function sandboxIn(mode: string | undefined) {
  const { ctx, kv } = fakeCtx()
  const env = mode === undefined ? {} : { SESSION_EGRESS: mode }
  // The mock's `setAllowedHosts` records what reached the SDK.
  const obj = new HostedSessionSandbox(ctx as never, env as never) as HostedSessionSandbox & {
    allowedHostsSet: string[][]
  }
  return { obj, kv }
}

describe('SESSION_EGRESS in loadConfig', () => {
  it('is allowlist when missing or blank, and takes open or allowlist', () => {
    expect(loadConfig(createTestEnv()).SESSION_EGRESS).toBe('allowlist')
    expect(loadConfig(createTestEnv({ SESSION_EGRESS: '' })).SESSION_EGRESS).toBe('allowlist')
    expect(loadConfig(createTestEnv({ SESSION_EGRESS: 'open' })).SESSION_EGRESS).toBe('open')
    expect(loadConfig(createTestEnv({ SESSION_EGRESS: 'allowlist' })).SESSION_EGRESS).toBe(
      'allowlist'
    )
  })

  it('refuses anything else', () => {
    expect(() => loadConfig(createTestEnv({ SESSION_EGRESS: 'none' }))).toThrow(/SESSION_EGRESS/)
  })
})

describe('sessionEgressMode (read structurally by the Durable Object)', () => {
  it('is open only for "open": missing, blank or unknown is allowlist, fail-closed', () => {
    expect(sessionEgressMode({ SESSION_EGRESS: 'open' })).toBe('open')
    for (const env of [{}, { SESSION_EGRESS: '' }, { SESSION_EGRESS: 'OPEN!' }, null, undefined]) {
      expect(sessionEgressMode(env)).toBe('allowlist')
    }
  })
})

describe('the session sandbox’s egress mode', () => {
  it('allowlist: internet off, the base allow-list, the persisted SDK config left alone', async () => {
    const { obj, kv } = sandboxIn(undefined)
    expect(obj.egressMode).toBe('allowlist')
    expect(obj.interceptHttps).toBe(true)
    expect(obj.enableInternet).toBe(false)
    expect(obj.allowedHosts).toEqual([...SESSION_BASE_ALLOWED_HOSTS])
    expect(kv.has(SDK_OUTBOUND_CONFIGURATION_KEY)).toBe(true)
    await obj.setAllowedHosts(['github.com', 'ep-x.neon.tech'])
    expect(obj.allowedHostsSet).toEqual([['github.com', 'ep-x.neon.tech']])
  })

  it('open: internet on, no allow-list, HTTPS still intercepted, the persisted SDK config deleted', () => {
    const { obj, kv } = sandboxIn('open')
    expect(obj.egressMode).toBe('open')
    expect(obj.interceptHttps).toBe(true)
    expect(obj.enableInternet).toBe(true)
    expect(obj.allowedHosts).toBeUndefined()
    // Else a reused object (prepare-<appId>) restores its allow-list and intercept-all.
    expect(kv.has(SDK_OUTBOUND_CONFIGURATION_KEY)).toBe(false)
  })

  it('open: setAllowedHosts is a no-op, whoever calls it', async () => {
    const { obj } = sandboxIn('open')
    await obj.setAllowedHosts(['registry.npmjs.org', 'ep-x.neon.tech'])
    expect(obj.allowedHostsSet).toEqual([])
    expect(obj.allowedHosts).toBeUndefined()
  })

  it('the model and git hosts keep their handlers in both modes; the database has none', () => {
    // The host handles every host Launch's own sandboxes do (every runtime, either account).
    expect(Object.keys(HostedSessionSandbox.outboundByHost ?? {}).sort()).toEqual([
      'api.anthropic.com',
      'api.openai.com',
      'auth.openai.com',
      'chatgpt.com',
      'github.com',
      'platform.claude.com',
    ])
  })
})
