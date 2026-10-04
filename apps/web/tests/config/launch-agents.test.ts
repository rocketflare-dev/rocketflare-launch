/**
 * §18.22's pure contracts: the event name Cloudflare must accept, the policy defaults that keep
 * every stored policy on Claude Code and Launch's key (fail-closed: Codex and personal accounts
 * off until an admin turns them on), the session payloads an older server (or CLI) still parses,
 * the priced model lists, and the offer rules (`credentials/resolve.ts`) the routes and the picker
 * share.
 */
import {
  AGENT_LOGIN_ACTIVE_STATUSES,
  AGENT_LOGIN_CODE_EVENT,
  AGENT_RUNTIME_MODELS,
  AGENT_RUNTIMES,
  agentCredentialSchema,
  agentModelLabel,
  agentPickerVisible,
  agentRuntimeOptionSchema,
  isPricedRuntimeModel,
} from '@launch/shared/launch-agents'
import {
  createSessionRequestSchema,
  DEFAULT_CODEX_MODEL,
  DEFAULT_SESSION_POLICY,
  defaultRuntimeOf,
  resolveSessionPolicy,
  runtimePolicyOf,
  sessionSchema,
} from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'
import {
  defaultRuntimeFor,
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
    // Fail-closed: Claude Code on Launch's key, Codex off — exactly what it always was.
    expect(runtimePolicyOf(old, 'claude_code')).toEqual({
      enabled: true,
      model: 'claude-opus-4-1',
      credentialMode: 'platform',
    })
    expect(runtimePolicyOf(old, 'codex')).toMatchObject({
      enabled: false,
      credentialMode: 'platform',
    })
    expect(runtimeOffer(old, 'claude_code')).toMatchObject({
      enabled: true,
      model: 'claude-opus-4-1',
      credentialMode: 'platform',
      userAllowed: false,
    })
    expect(runtimeOffer(old, 'codex').enabled).toBe(false)
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

describe('runtimes are a platform setting, not a deployment var', () => {
  it('the config has no runtime switches — and where the sandbox runs is a setting too', () => {
    const cfg = loadConfig(createTestEnv({ SESSION_SANDBOX_HOST: 'remote' })) as Record<
      string,
      unknown
    >
    expect(cfg).not.toHaveProperty('SESSION_RUNTIMES')
    expect(cfg).not.toHaveProperty('SESSION_USER_CREDENTIALS')
    expect(cfg).not.toHaveProperty('SESSION_SANDBOX_HOST')
  })

  it('every model the Setup page offers is priced (a budget needs a price)', () => {
    for (const runtime of AGENT_RUNTIMES) {
      for (const model of AGENT_RUNTIME_MODELS[runtime]) {
        expect(isPricedRuntimeModel(runtime, model), `${runtime} ${model}`).toBe(true)
      }
    }
    expect(isPricedRuntimeModel('claude_code', DEFAULT_SESSION_POLICY.model)).toBe(true)
    expect(isPricedRuntimeModel('codex', DEFAULT_CODEX_MODEL)).toBe(true)
    // A model of the other vendor, or one the table does not know, is not.
    expect(isPricedRuntimeModel('codex', 'claude-sonnet-4-5')).toBe(false)
    expect(isPricedRuntimeModel('claude_code', 'claude-mystery-9')).toBe(false)
  })

  it('names every offered Claude model in words, and any other model by its id', () => {
    expect(AGENT_RUNTIME_MODELS.claude_code.map(agentModelLabel)).toEqual([
      'Opus 5.5',
      'Sonnet 5',
      'Fable 5.1',
      'Haiku 4.5',
    ])
    expect(agentModelLabel('gpt-6.1-sol')).toBe('gpt-6.1-sol')
    expect(agentModelLabel('constructor')).toBe('constructor')
  })
})

describe('what a deployment offers', () => {
  const policy = DEFAULT_SESSION_POLICY

  it('by default: Claude Code on Launch’s key, nothing else — and no picker', () => {
    const options = runtimeOptions(policy)
    for (const option of options) agentRuntimeOptionSchema.parse(option)
    expect(options.filter(o => o.enabled).map(o => o.runtime)).toEqual(['claude_code'])
    expect(options.find(o => o.runtime === 'claude_code')).toMatchObject({
      credentialMode: 'platform',
      userCredentials: false,
    })
    expect(agentPickerVisible(options)).toBe(false)
  })

  it('the policy alone opens personal accounts: a `user` entry bills only the person', () => {
    const userPolicy = resolveSessionPolicy({
      runtimes: {
        claude_code: { enabled: true, model: 'claude-sonnet-4-5', credentialMode: 'user' },
      },
    })
    expect(runtimeOffer(userPolicy, 'claude_code')).toMatchObject({
      enabled: true,
      credentialMode: 'user',
      userAllowed: true,
      platformAllowed: false,
      userCredentials: true,
    })
  })

  it('a disabled entry offers nothing, personal accounts included', () => {
    const off = resolveSessionPolicy({
      runtimes: {
        claude_code: {
          enabled: false,
          model: 'claude-sonnet-4-5',
          credentialMode: 'user_or_platform',
        },
      },
    })
    expect(runtimeOffer(off, 'claude_code')).toMatchObject({
      enabled: false,
      userCredentials: false,
    })
  })

  it('both runtimes on, Claude on either account: the picker shows', () => {
    const both = resolveSessionPolicy({
      runtimes: {
        claude_code: {
          enabled: true,
          model: 'claude-sonnet-4-5',
          credentialMode: 'user_or_platform',
        },
        codex: { enabled: true, model: 'gpt-6.1-sol', credentialMode: 'platform' },
      },
    })
    const options = runtimeOptions(both)
    expect(options.filter(o => o.enabled).map(o => o.runtime)).toEqual(['claude_code', 'codex'])
    expect(options.find(o => o.runtime === 'claude_code')?.credentialMode).toBe('user_or_platform')
    expect(options.find(o => o.runtime === 'codex')).toMatchObject({
      credentialMode: 'platform',
      userCredentials: false,
    })
    expect(agentPickerVisible(options)).toBe(true)
  })

  it('a request naming no runtime gets the first enabled one when the default is off', () => {
    const codexOnly = resolveSessionPolicy({
      runtimes: {
        claude_code: { enabled: false, model: 'claude-sonnet-4-5', credentialMode: 'platform' },
        codex: { enabled: true, model: 'gpt-6.1-sol', credentialMode: 'platform' },
      },
    })
    expect(defaultRuntimeFor(codexOnly)).toBe('codex')
    expect(defaultRuntimeFor(policy)).toBe('claude_code')
  })

  it('nothing narrows the policy any more: every runtime on either account is offered as set', () => {
    const everything = resolveSessionPolicy({
      runtimes: {
        claude_code: {
          enabled: true,
          model: 'claude-sonnet-4-5',
          credentialMode: 'user_or_platform',
        },
        codex: { enabled: true, model: 'gpt-6.1-sol', credentialMode: 'user_or_platform' },
      },
    })
    for (const runtime of AGENT_RUNTIMES) {
      expect(runtimeOffer(everything, runtime)).toMatchObject({
        enabled: true,
        userAllowed: true,
        platformAllowed: true,
        credentialMode: 'user_or_platform',
      })
    }
  })
})
