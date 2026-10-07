/**
 * Which coding agent a new session starts with (§18.22, `pages/apps/components/agentChoice.ts`) —
 * the one decision behind Build it and Start session: the menu's lines and their billing words,
 * the remembered choice validated on read, the fallback to the SERVER's default for the person
 * (not the first runtime in the list), and the request each choice sends.
 */
import type { AgentAccountsResponse, AgentRuntimeOption } from '@launch/shared/launch-agents'
import { describe, expect, it } from 'vitest'
import {
  agentChoiceOptions,
  billingLine,
  formatAgentChoice,
  parseAgentChoice,
  resolveAgentChoice,
  startRequestFor,
} from '@/ui/pages/apps/components/agentChoice'

const option = (overrides: Partial<AgentRuntimeOption> = {}): AgentRuntimeOption => ({
  runtime: 'claude_code',
  label: 'Claude Code',
  accountLabel: 'Claude subscription',
  enabled: true,
  credentialMode: 'platform',
  userCredentials: false,
  needsCode: true,
  ...overrides,
})
const codex = (overrides: Partial<AgentRuntimeOption> = {}) =>
  option({ runtime: 'codex', label: 'Codex', accountLabel: 'ChatGPT plan', ...overrides })
const pi = (overrides: Partial<AgentRuntimeOption> = {}) =>
  option({ runtime: 'pi', label: 'Pi', accountLabel: null, ...overrides })

const accounts = (overrides: Partial<AgentAccountsResponse> = {}): AgentAccountsResponse => ({
  runtimes: [option(), codex({ enabled: false }), pi()],
  credentials: [],
  logins: [],
  defaultRuntime: 'claude_code',
  ...overrides,
})

const connected = (runtime: 'claude_code' | 'codex') => ({
  id: 'c0000000-0000-4000-8000-000000000001',
  runtime,
  kind: runtime === 'codex' ? ('codex_chatgpt_auth' as const) : ('claude_oauth_token' as const),
  status: 'active' as const,
  metadata: {},
  expiresAt: null,
  lastUsedAt: null,
  inUse: false,
  createdAt: new Date(),
  updatedAt: new Date(),
})

describe('the stored choice', () => {
  it('round-trips, and anything else reads as none', () => {
    expect(parseAgentChoice(formatAgentChoice({ runtime: 'pi', credential: 'platform' }))).toEqual({
      runtime: 'pi',
      credential: 'platform',
    })
    for (const raw of [null, '', 'pi', 'gemini:platform', 'pi:mine', 'pi:platform:x']) {
      expect(parseAgentChoice(raw)).toBeNull()
    }
  })
})

describe('the menu', () => {
  it('lists each enabled runtime once per account that may pay, Launch’s first', () => {
    const lines = agentChoiceOptions(
      accounts({
        runtimes: [option({ credentialMode: 'user_or_platform' }), codex({ enabled: false }), pi()],
        credentials: [connected('claude_code')],
      })
    )
    expect(lines.map(l => `${l.label} — ${l.billing}`)).toEqual([
      'Claude Code — Launch pays · Anthropic API',
      'Claude Code — Billed to your Claude subscription',
      'Pi — Launch pays · Workers AI',
    ])
  })

  it('says who pays, and where to connect an account that is not', () => {
    expect(billingLine(codex(), 'platform')).toBe('Launch pays · OpenAI API')
    expect(billingLine(codex(), 'user')).toBe('Billed to your ChatGPT plan')
    expect(billingLine(codex(), 'user', false)).toBe(
      'Billed to your ChatGPT plan · connect it on Home first'
    )
  })
})

describe('the current choice', () => {
  it('is null — the plain button, the P3 request — with nothing to choose', () => {
    const one = accounts({
      runtimes: [option(), codex({ enabled: false }), pi({ enabled: false })],
    })
    expect(resolveAgentChoice(one, { runtime: 'pi', credential: 'platform' })).toBeNull()
    expect(resolveAgentChoice(undefined, null)).toBeNull()
    expect(startRequestFor(one, { runtime: 'claude_code', credential: 'user' })).toEqual({})
  })

  it('is the remembered one while it is on offer', () => {
    expect(resolveAgentChoice(accounts(), { runtime: 'pi', credential: 'platform' })).toEqual({
      runtime: 'pi',
      credential: 'platform',
    })
  })

  it('falls back to the server’s default for the person — not the first enabled', () => {
    const zeroKey = accounts({ defaultRuntime: 'pi' })
    expect(resolveAgentChoice(zeroKey, null)).toEqual({ runtime: 'pi', credential: 'platform' })
    // Remembered, then turned off: the default again.
    expect(resolveAgentChoice(zeroKey, { runtime: 'codex', credential: 'platform' })).toEqual({
      runtime: 'pi',
      credential: 'platform',
    })
    // A default that is not on offer (nothing can run): the first enabled.
    expect(resolveAgentChoice(accounts({ defaultRuntime: 'codex' }), null)?.runtime).toBe(
      'claude_code'
    )
  })

  it('re-decides the account when the policy no longer allows the remembered one', () => {
    const platformOnly = accounts()
    expect(
      resolveAgentChoice(platformOnly, { runtime: 'claude_code', credential: 'user' })
    ).toEqual({ runtime: 'claude_code', credential: 'platform' })
  })

  it('bills the person’s own account by default when either may pay and theirs is connected', () => {
    const either = accounts({
      runtimes: [option({ credentialMode: 'user_or_platform' }), codex({ enabled: false }), pi()],
    })
    expect(resolveAgentChoice(either, null)).toEqual({
      runtime: 'claude_code',
      credential: 'platform',
    })
    expect(
      resolveAgentChoice({ ...either, credentials: [connected('claude_code')] }, null)
    ).toEqual({ runtime: 'claude_code', credential: 'user' })
    const userOnly = accounts({
      runtimes: [option({ credentialMode: 'user' }), codex({ enabled: false }), pi()],
    })
    expect(resolveAgentChoice(userOnly, null)).toEqual({
      runtime: 'claude_code',
      credential: 'user',
    })
  })
})

describe('the request', () => {
  it('names the runtime, and the account only where the person may choose it', () => {
    const either = accounts({
      runtimes: [option({ credentialMode: 'user_or_platform' }), codex({ enabled: true }), pi()],
    })
    expect(startRequestFor(either, { runtime: 'pi', credential: 'platform' })).toEqual({
      runtime: 'pi',
    })
    expect(startRequestFor(either, { runtime: 'claude_code', credential: 'user' })).toEqual({
      runtime: 'claude_code',
      credential: 'user',
    })
    expect(startRequestFor(either, { runtime: 'codex', credential: 'user' })).toEqual({
      runtime: 'codex',
    })
  })
})
