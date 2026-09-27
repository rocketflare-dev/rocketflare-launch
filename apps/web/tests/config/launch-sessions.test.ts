/**
 * Launch P3's pure contracts (`@launch/shared/launch-sessions`): the Workflow event type Cloudflare
 * will accept, the status lists the concurrency index is rendered from, the policy defaults, the
 * request bodies, the preview host grammar and the ids behind it — and that no response schema can
 * carry the preview token or a sealed column.
 */

import { WORKFLOW_EVENT_TYPE_PATTERN } from '@launch/shared/ai/agents'
import {
  ACTIVE_SESSION_STATUSES,
  createSessionRequestSchema,
  DEFAULT_SESSION_POLICY,
  extendBudgetSchema,
  isActiveSessionStatus,
  MICROCENTS_PER_USD,
  microcentsToUsd,
  newPreviewToken,
  newSessionShortId,
  PREVIEW_TOKEN_RE,
  parsePreviewHost,
  previewLabel,
  previewUrl,
  resolveSessionPolicy,
  SESSION_EVENT_DATA,
  SESSION_EVENT_TYPES,
  SESSION_MESSAGE_MAX,
  SESSION_REALTIME_ENTITY,
  SESSION_SHORT_ID_RE,
  SESSION_STATUSES,
  SESSION_WAKE_EVENT,
  sessionBranchName,
  sessionEventsQuerySchema,
  sessionPolicySchema,
  sessionSchema,
  sessionTurnRequestSchema,
  TERMINAL_SESSION_STATUSES,
  usdToMicrocents,
} from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'

describe('SESSION_WAKE_EVENT', () => {
  // Golden: Cloudflare rejects anything else with `workflow.invalid_event_type` at RUNTIME — a `.`
  // is the classic mistake — and no fake binding would ever notice.
  it('is a valid Workflows event type, and pinned', () => {
    expect(SESSION_WAKE_EVENT).toMatch(/^[A-Za-z0-9_-]{1,100}$/)
    expect(SESSION_WAKE_EVENT).toMatch(WORKFLOW_EVENT_TYPE_PATTERN)
    expect(SESSION_WAKE_EVENT).toBe('session_wake')
  })

  it('the realtime entity is the query-key root the UI invalidates', () => {
    expect(SESSION_REALTIME_ENTITY).toBe('session')
  })
})

describe('statuses', () => {
  it('active and terminal partition every status but `ready`-style live ones never end', () => {
    const active = new Set<string>(ACTIVE_SESSION_STATUSES)
    const terminal = new Set<string>(TERMINAL_SESSION_STATUSES)
    for (const s of SESSION_STATUSES) expect(active.has(s) !== terminal.has(s), s).toBe(true)
    expect(active.has('suspended')).toBe(true) // it still holds a Neon branch
    expect(isActiveSessionStatus('shipped')).toBe(false)
    expect(isActiveSessionStatus('ending')).toBe(true)
  })

  it('every event type has a payload schema', () => {
    expect(Object.keys(SESSION_EVENT_DATA).sort()).toEqual([...SESSION_EVENT_TYPES].sort())
    expect(new Set(SESSION_EVENT_TYPES).size).toBe(SESSION_EVENT_TYPES.length)
  })
})

describe('policy and money', () => {
  it('the defaults are the plan’s, and valid', () => {
    expect(sessionPolicySchema.parse(DEFAULT_SESSION_POLICY)).toEqual({
      model: 'claude-sonnet-4-5',
      maxSessionUsd: 10,
      appMonthlyUsd: 200,
      maxConcurrentPerApp: 3,
      maxTurnMinutes: 20,
      idleSuspendMinutes: 30,
      suspendedExpiryHours: 24,
      maxSessionHours: 8,
      maxTurns: 100,
    })
  })

  it('a stored policy is merged over the defaults; garbage is the defaults', () => {
    expect(resolveSessionPolicy({ maxSessionUsd: 25 })).toEqual({
      ...DEFAULT_SESSION_POLICY,
      maxSessionUsd: 25,
    })
    expect(resolveSessionPolicy(null)).toEqual(DEFAULT_SESSION_POLICY)
    expect(resolveSessionPolicy({ maxSessionUsd: -1 })).toEqual(DEFAULT_SESSION_POLICY)
  })

  it('microcents are ai_usage’s unit', () => {
    expect(MICROCENTS_PER_USD).toBe(100_000_000)
    expect(usdToMicrocents(10)).toBe(1_000_000_000)
    expect(microcentsToUsd(usdToMicrocents(0.37))).toBeCloseTo(0.37)
  })
})

describe('requests', () => {
  it('a turn is 1..20 000 characters, trimmed', () => {
    expect(sessionTurnRequestSchema.parse({ message: '  hi  ' })).toEqual({ message: 'hi' })
    expect(sessionTurnRequestSchema.safeParse({ message: '   ' }).success).toBe(false)
    expect(
      sessionTurnRequestSchema.safeParse({ message: 'x'.repeat(SESSION_MESSAGE_MAX + 1) }).success
    ).toBe(false)
    expect(SESSION_MESSAGE_MAX).toBe(20_000)
  })

  it('baseRef is a git ref, never something a shell would read', () => {
    for (const ok of ['main', 'release/1.2', 'v0.15.0', 'c7fd5dfbf9cf'])
      expect(createSessionRequestSchema.safeParse({ baseRef: ok }).success, ok).toBe(true)
    for (const bad of ['-rf', 'a..b', 'main;rm', 'a b', '$(x)', 'feat/', 'x.'])
      expect(createSessionRequestSchema.safeParse({ baseRef: bad }).success, bad).toBe(false)
    expect(createSessionRequestSchema.parse({})).toEqual({})
  })

  it('a budget extension is positive and bounded; afterSeq coerces', () => {
    expect(extendBudgetSchema.safeParse({ extraUsd: 5 }).success).toBe(true)
    expect(extendBudgetSchema.safeParse({ extraUsd: 0 }).success).toBe(false)
    expect(extendBudgetSchema.safeParse({ extraUsd: 5000 }).success).toBe(false)
    expect(sessionEventsQuerySchema.parse({ afterSeq: '12' })).toEqual({ afterSeq: 12 })
  })

  it('no response schema can carry the preview token or a sealed column', () => {
    const keys = Object.keys(sessionSchema.shape)
    for (const secret of [
      'previewToken',
      'dbUriSealed',
      'githubTokenSealed',
      'db',
      'sandboxId',
      'claudeSessionId',
      'pendingMessageText',
    ]) {
      expect(keys, secret).not.toContain(secret)
    }
  })
})

describe('ids, branches and preview hosts', () => {
  it('short ids and tokens are DNS-safe and fresh each time', () => {
    const ids = new Set(Array.from({ length: 200 }, newSessionShortId))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(SESSION_SHORT_ID_RE)
    for (let i = 0; i < 50; i++) expect(newPreviewToken()).toMatch(PREVIEW_TOKEN_RE)
    expect(sessionBranchName('abcdefghijkl')).toBe('session/abcdefghijkl')
  })

  it('a label round-trips through the host, under both templates', () => {
    const label = previewLabel(5173, 'abcdefghij23', '0123456789')
    expect(label).toBe('5173-abcdefghij23-0123456789')
    for (const template of ['https://{label}.clewro.com', 'http://{label}.localhost:3001']) {
      const url = previewUrl(template, label)
      expect(parsePreviewHost(new URL(url).host, template)).toEqual({
        port: 5173,
        shortId: 'abcdefghij23',
        token: '0123456789',
      })
    }
    expect(previewUrl('https://{label}.clewro.com', label)).toBe(
      'https://5173-abcdefghij23-0123456789.clewro.com'
    )
  })

  it('anything else is not a preview host', () => {
    const t = 'https://{label}.clewro.com'
    for (const host of [
      'launch.clewro.com', // Launch itself
      'shop.clewro.com', // an app
      '5173-abcdefghij23-0123456789.clewro.com.evil.test', // wrong suffix
      '5173-abcdefghij23-0123456789.other.com',
      '5173-ABCDEFGHIJ23-0123456789.clewro.co', // wrong suffix, whatever the case
      '5173-abcdefghij18-0123456789.clewro.com', // 1 and 8 are not base32
      '5173-abcdefghij23-012345678.clewro.com', // short token
      '99999-abcdefghij23-0123456789.clewro.com', // no such port
      'x.5173-abcdefghij23-0123456789.clewro.com', // a deeper label
    ]) {
      expect(parsePreviewHost(host, t), host).toBeNull()
    }
    // The port is part of the suffix locally: the Worker's own :3001 host is never a preview.
    expect(
      parsePreviewHost(
        '5173-abcdefghij23-0123456789.localhost:3000',
        'http://{label}.localhost:3001'
      )
    ).toBeNull()
    // Hosts compare case-insensitively.
    expect(parsePreviewHost('5173-ABCDEFGHIJ23-0123456789.CLEWRO.COM', t)).toEqual({
      port: 5173,
      shortId: 'abcdefghij23',
      token: '0123456789',
    })
    // A template whose host does not START with {label} matches nothing.
    expect(
      parsePreviewHost('5173-abcdefghij23-0123456789.clewro.com', 'https://x{label}.clewro.com')
    ).toBeNull()
  })
})
