/**
 * §18.22's pure contracts: the event name Cloudflare must accept, the policy defaults that keep
 * every stored policy on Claude Code and Launch's key, the session payloads an older server (or
 * CLI) still parses, the two fail-closed deployment flags, and the offer rules
 * (`credentials/resolve.ts`) the routes and the picker share.
 */
import {
  AGENT_LOGIN_ACTIVE_STATUSES,
  AGENT_LOGIN_CODE_EVENT,
  agentCredentialSchema,
  agentPickerVisible,
  agentRuntimeOptionSchema,
} from '@launch/shared/launch-agents'
import {
  createSessionRequestSchema,
  DEFAULT_SESSION_POLICY,
  defaultRuntimeOf,
  resolveSessionPolicy,
  runtimePolicyOf,
  sessionSchema,
} from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RUNTIME_FLAGS,
  runtimeFlagsOf,
  runtimeOffer,
  runtimeOptions,
} from '@/api/services/sessions/credentials/resolve'
import { loadConfig } from '@/config'
import { createTestEnv } from '../mocks/bindings'

describe('the login event', () => {
  it('is a valid Cloudflare event type (a `.` is workflow.invalid_event_type)', () => {
    expect(AGENT_LOGIN_CODE_EVENT).toMatch(/^[A-Za-z0-9_-]{1,100}$/)
  })
})

describe('the session policy', () => {
  it('an old stored policy is Claude Code on its own model and Launch’s key', () => {
    const old = resolveSessionPolicy({ model: 'claude-opus-4-1', maxTurns: 10 })
    expect(old.runtime).toBeUndefined()
    expect(old.runtimes).toBeUndefined()
    expect(defaultRuntimeOf(old)).toBe('claude_code')
    expect(runtimePolicyOf(old, 'claude_code')).toEqual({
      enabled: true,
      model: 'claude-opus-4-1',
      credentialMode: 'user_or_platform',
    })
    // …which the default flags narrow to exactly what it always was.
    expect(runtimeOffer(DEFAULT_RUNTIME_FLAGS, old, 'claude_code')).toMatchObject({
      enabled: true,
      model: 'claude-opus-4-1',
      credentialMode: 'platform',
      userAllowed: false,
    })
    expect(runtimeOffer(DEFAULT_RUNTIME_FLAGS, old, 'codex').enabled).toBe(false)
    // The defaults themselves are unchanged — a frozen policy reads exactly as before.
    expect(resolveSessionPolicy(undefined)).toEqual(DEFAULT_SESSION_POLICY)
    expect(Object.keys(DEFAULT_SESSION_POLICY)).not.toContain('runtimes')
  })

  it('per-runtime settings parse, and an unknown runtime key is dropped', () => {
    const policy = resolveSessionPolicy({
      runtime: 'codex',
      runtimes: {
        codex: { enabled: true, model: 'gpt-5-codex', credentialMode: 'user' },
        bogus: { enabled: true },
      },
    })
    expect(defaultRuntimeOf(policy)).toBe('codex')
    expect(runtimePolicyOf(policy, 'codex').credentialMode).toBe('user')
    expect(Object.keys(policy.runtimes ?? {})).toEqual(['codex'])
  })
})

describe('the request and response bodies', () => {
  it('create takes an optional runtime and credential', () => {
    expect(createSessionRequestSchema.parse({})).toEqual({})
    expect(createSessionRequestSchema.parse({ runtime: 'codex', credential: 'user' })).toEqual({
      runtime: 'codex',
      credential: 'user',
    })
    expect(createSessionRequestSchema.safeParse({ runtime: 'cursor' }).success).toBe(false)
  })

  it('a session payload without the new fields (an older server) still parses, as Claude on Launch’s key', () => {
    const shape = sessionSchema.shape
    expect(shape.runtime.parse(undefined)).toBe('claude_code')
    expect(shape.credentialSource.parse(undefined)).toBe('platform')
    expect(shape.credentialOwnerUserId.parse(undefined)).toBeNull()
  })

  it('a credential as the API speaks of it has no value field', () => {
    expect(Object.keys(agentCredentialSchema.shape).sort()).toEqual(
      [
        'createdAt',
        'expiresAt',
        'id',
        'inUse',
        'kind',
        'lastUsedAt',
        'metadata',
        'runtime',
        'status',
        'updatedAt',
      ].sort()
    )
    expect(AGENT_LOGIN_ACTIVE_STATUSES).not.toContain('succeeded')
  })
})

describe('the deployment flags fail closed', () => {
  it('missing or blank: Claude Code only, no personal accounts', () => {
    const cfg = loadConfig(createTestEnv())
    expect(cfg.SESSION_RUNTIMES).toEqual(['claude_code'])
    expect(cfg.SESSION_USER_CREDENTIALS).toEqual([])
    const blank = loadConfig(createTestEnv({ SESSION_RUNTIMES: '', SESSION_USER_CREDENTIALS: '' }))
    expect(blank.SESSION_RUNTIMES).toEqual(['claude_code'])
    expect(blank.SESSION_USER_CREDENTIALS).toEqual([])
    expect(runtimeFlagsOf(undefined)).toEqual(DEFAULT_RUNTIME_FLAGS)
  })

  it('a list is parsed, de-duplicated, and an unknown runtime is a config error', () => {
    const cfg = loadConfig(
      createTestEnv({
        SESSION_RUNTIMES: 'claude_code, codex,codex',
        SESSION_USER_CREDENTIALS: 'claude_code',
      })
    )
    expect(cfg.SESSION_RUNTIMES).toEqual(['claude_code', 'codex'])
    expect(cfg.SESSION_USER_CREDENTIALS).toEqual(['claude_code'])
    expect(() => loadConfig(createTestEnv({ SESSION_RUNTIMES: 'claude_code,cursor' }))).toThrow()
  })
})

describe('what a deployment offers', () => {
  const policy = DEFAULT_SESSION_POLICY

  it('by default: Claude Code on Launch’s key, nothing else — and no picker', () => {
    const options = runtimeOptions(DEFAULT_RUNTIME_FLAGS, policy)
    for (const option of options) agentRuntimeOptionSchema.parse(option)
    expect(options.filter(o => o.enabled).map(o => o.runtime)).toEqual(['claude_code'])
    expect(options.find(o => o.runtime === 'claude_code')).toMatchObject({
      credentialMode: 'platform',
      userCredentials: false,
    })
    expect(agentPickerVisible(options)).toBe(false)
  })

  it('the deployment flag wins over the policy: a personal account needs SESSION_USER_CREDENTIALS', () => {
    const userPolicy = resolveSessionPolicy({
      runtimes: {
        claude_code: { enabled: true, model: 'claude-sonnet-4-5', credentialMode: 'user' },
      },
    })
    expect(runtimeOffer(DEFAULT_RUNTIME_FLAGS, userPolicy, 'claude_code').enabled).toBe(false)
    const flags = { ...DEFAULT_RUNTIME_FLAGS, userCredentials: ['claude_code' as const] }
    expect(runtimeOffer(flags, userPolicy, 'claude_code')).toMatchObject({
      enabled: true,
      credentialMode: 'user',
      userAllowed: true,
      platformAllowed: false,
    })
  })

  it('one flag turns personal accounts on; a policy entry can narrow it back', () => {
    const flags = { ...DEFAULT_RUNTIME_FLAGS, userCredentials: ['claude_code' as const] }
    expect(runtimeOffer(flags, policy, 'claude_code').credentialMode).toBe('user_or_platform')
    const platformOnly = resolveSessionPolicy({
      runtimes: {
        claude_code: { enabled: true, model: 'claude-sonnet-4-5', credentialMode: 'platform' },
      },
    })
    expect(runtimeOffer(flags, platformOnly, 'claude_code').userAllowed).toBe(false)
  })

  it('both runtimes on, Claude on either account: the picker shows', () => {
    const flags = {
      runtimes: ['claude_code', 'codex'] as const,
      userCredentials: ['claude_code'] as const,
      hostEgress: false,
    }
    const options = runtimeOptions(flags, policy)
    expect(options.filter(o => o.enabled).map(o => o.runtime)).toEqual(['claude_code', 'codex'])
    expect(options.find(o => o.runtime === 'claude_code')?.credentialMode).toBe('user_or_platform')
    // Codex's personal accounts are not in the flag: platform only.
    expect(options.find(o => o.runtime === 'codex')?.credentialMode).toBe('platform')
    expect(agentPickerVisible(options)).toBe(true)
  })

  it('the sandbox host runs Claude Code on Launch’s key only', () => {
    const flags = {
      runtimes: ['claude_code', 'codex'] as const,
      userCredentials: ['claude_code', 'codex'] as const,
      hostEgress: true,
    }
    expect(runtimeOffer(flags, policy, 'codex').enabled).toBe(false)
    expect(runtimeOffer(flags, policy, 'claude_code')).toMatchObject({
      enabled: true,
      userAllowed: false,
      credentialMode: 'platform',
    })
  })
})
