/**
 * §18.22's pure contracts: the event name Cloudflare must accept, the policy defaults that keep
 * every stored policy on Claude Code and Launch's key (fail-closed: Codex and personal accounts
 * off until an admin turns them on), the session payloads an older server (or CLI) still parses,
 * the priced model lists, and the offer rules (`credentials/resolve.ts`) the routes and the picker
 * share.
 */
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models'
import {
  AGENT_LOGIN_ACTIVE_STATUSES,
  AGENT_LOGIN_CODE_EVENT,
  AGENT_RUNTIME_MODELS,
  AGENT_RUNTIMES,
  agentCredentialSchema,
  agentModelLabel,
  agentPickerVisible,
  agentRuntimeHasAccounts,
  agentRuntimeOptionSchema,
  isPricedRuntimeModel,
  sessionModelLabel,
} from '@launch/shared/launch-agents'
import {
  createSessionRequestSchema,
  DEFAULT_CLAUDE_CODE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_PI_MODEL,
  DEFAULT_SESSION_POLICY,
  defaultRuntimeOf,
  resolveSessionPolicy,
  runtimePolicyOf,
  sessionSchema,
} from '@launch/shared/launch-sessions'
import { sessionAgentsUpdateSchema } from '@launch/shared/launch-setup'
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
    expect(isPricedRuntimeModel('claude_code', DEFAULT_CLAUDE_CODE_MODEL)).toBe(true)
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
    for (const runtime of AGENT_RUNTIMES.filter(agentRuntimeHasAccounts)) {
      expect(runtimeOffer(everything, runtime)).toMatchObject({
        enabled: true,
        userAllowed: true,
        platformAllowed: true,
        credentialMode: 'user_or_platform',
      })
    }
  })
})

describe('Pi (rocketflare-launch#14)', () => {
  const bound = { claude_code: false, codex: false, pi: true }
  const unbound = { claude_code: true, codex: false, pi: false }

  it('is on by default on Launch’s account — and offered only where Workers AI is bound', () => {
    expect(runtimePolicyOf(DEFAULT_SESSION_POLICY, 'pi')).toEqual({
      enabled: true,
      model: null,
      credentialMode: 'platform',
    })
    expect(runtimeOffer(DEFAULT_SESSION_POLICY, 'pi').enabled).toBe(false)
    expect(runtimeOffer(DEFAULT_SESSION_POLICY, 'pi', unbound).enabled).toBe(false)
    expect(runtimeOffer(DEFAULT_SESSION_POLICY, 'pi', bound)).toMatchObject({
      enabled: true,
      platformAllowed: true,
      userAllowed: false,
      userCredentials: false,
    })
    const options = runtimeOptions(DEFAULT_SESSION_POLICY, bound)
    for (const option of options) agentRuntimeOptionSchema.parse(option)
    expect(options.find(o => o.runtime === 'pi')).toMatchObject({
      label: 'Pi',
      accountLabel: null,
      enabled: true,
      needsCode: false,
    })
  })

  it('never bills a personal account, whatever a stored entry says', () => {
    const odd = resolveSessionPolicy({
      runtimes: { pi: { enabled: true, model: null, credentialMode: 'user_or_platform' } },
    })
    expect(runtimeOffer(odd, 'pi', bound)).toMatchObject({ userAllowed: false })
    expect(
      sessionAgentsUpdateSchema.safeParse({
        runtimes: { pi: { enabled: true, model: null, credentialMode: 'user' } },
      }).success
    ).toBe(false)
    expect(
      sessionAgentsUpdateSchema.safeParse({
        runtimes: { pi: { enabled: true, model: DEFAULT_PI_MODEL, credentialMode: 'platform' } },
      }).success
    ).toBe(true)
  })

  it('an admin who turned Pi off keeps it off', () => {
    const off = resolveSessionPolicy({
      runtimes: { pi: { enabled: false, model: null, credentialMode: 'platform' } },
    })
    expect(runtimeOffer(off, 'pi', bound).enabled).toBe(false)
    expect(defaultRuntimeFor(off, { readiness: bound, connected: new Set() })).toBe('claude_code')
  })

  it('is the default when no Claude Code or Codex key or login exists', () => {
    const zeroKey = { claude_code: false, codex: false, pi: true }
    expect(defaultRuntimeFor(DEFAULT_SESSION_POLICY, { readiness: zeroKey })).toBe('pi')
    // Launch's Anthropic key set: Claude Code stays the default.
    expect(
      defaultRuntimeFor(DEFAULT_SESSION_POLICY, { readiness: { ...zeroKey, claude_code: true } })
    ).toBe('claude_code')
    // No Launch key, but the person's own Claude subscription is connected (and allowed).
    const personal = resolveSessionPolicy({
      runtimes: {
        claude_code: { enabled: true, model: null, credentialMode: 'user_or_platform' },
      },
    })
    expect(
      defaultRuntimeFor(personal, { readiness: zeroKey, connected: new Set(['claude_code']) })
    ).toBe('claude_code')
    // Nothing can run (no key, Workers AI unbound): the old rule, the policy's default.
    expect(
      defaultRuntimeFor(DEFAULT_SESSION_POLICY, {
        readiness: { claude_code: false, codex: false, pi: false },
      })
    ).toBe('claude_code')
    // Readiness unknown (an older caller): as before.
    expect(defaultRuntimeFor(DEFAULT_SESSION_POLICY)).toBe('claude_code')
  })

  it('offers priced Workers AI models, its default first, named in words', () => {
    expect(AGENT_RUNTIME_MODELS.pi[0]).toBe(DEFAULT_PI_MODEL)
    expect(DEFAULT_PI_MODEL).toBe('@cf/moonshotai/kimi-k2.7-code')
    expect(isPricedRuntimeModel('pi', DEFAULT_PI_MODEL)).toBe(true)
    expect(isPricedRuntimeModel('pi', 'claude-sonnet-4-5')).toBe(false)
    expect(sessionModelLabel('pi', null)).toBe('Default (Kimi K2.7 Code)')
    expect(sessionModelLabel('claude_code', null)).toBe('Default (Claude Code’s choice)')
  })

  it('every Pi model is in the Workers AI catalog `createAI` resolves models from', () => {
    const catalog = new Set(Object.keys(CLOUDFLARE_WORKERS_AI_MODELS))
    for (const model of AGENT_RUNTIME_MODELS.pi) expect(catalog.has(model), model).toBe(true)
  })
})
