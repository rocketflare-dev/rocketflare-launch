/**
 * Launch P3's pure contracts (`@launch/shared/launch-sessions`): the Workflow event type Cloudflare
 * will accept, the status lists the concurrency index is rendered from, the policy defaults, the
 * request bodies, the preview host grammar and the ids behind it — and that no response schema can
 * carry the preview token or a sealed column. Issue #5 (`docs/plans/i5-ship-to-staging.md` §2):
 * the landing, the ship summary, the six new events and the contracts beside them — ship settings,
 * branch protection, `session.merge`, `release_in_progress`, and a promotion change's `summary`.
 */

import { WORKFLOW_EVENT_TYPE_PATTERN } from '@launch/shared/ai/agents'
import {
  APPROVAL_KINDS,
  approvalContextSchema,
  BUILT_APPROVAL_KINDS,
  DEFAULT_APPROVAL_POLICIES,
  SESSION_MERGE_EXPIRY_HOURS,
} from '@launch/shared/launch-approvals'
import {
  appBranchProtectionSchema,
  appDetailSchema,
  BRANCH_PROTECTION_STATES,
  DEFAULT_APP_SHIP_SETTINGS,
  KIT_REQUIRED_CHECK,
  putAppShipSettingsRequestSchema,
  resolveAppShipSettings,
  SESSION_SHIP_MODES,
  SHIP_REVIEW_MODES,
} from '@launch/shared/launch-apps'
import { PROMOTION_SUMMARY_MAX, promotionChangeSchema } from '@launch/shared/launch-promotion'
import { RELEASE_ERROR_CODES } from '@launch/shared/launch-releases'
import {
  ACTIVE_SESSION_STATUSES,
  createSessionRequestSchema,
  DEFAULT_SESSION_POLICY,
  extendBudgetSchema,
  isActiveSessionStatus,
  LANDING_REVIEW_MODES,
  MICROCENTS_PER_USD,
  MOVING_LANDING_STAGES,
  microcentsToUsd,
  newPreviewToken,
  newSessionShortId,
  PREVIEW_TOKEN_RE,
  parsePreviewHost,
  previewLabel,
  previewUrl,
  resolveSessionPolicy,
  SESSION_ATTACHMENTS_MAX,
  SESSION_EVENT_DATA,
  SESSION_EVENT_TYPES,
  SESSION_MESSAGE_MAX,
  SESSION_REALTIME_ENTITY,
  SESSION_SHORT_ID_RE,
  SESSION_STATUSES,
  SESSION_WAKE_EVENT,
  SHIP_CI_MAX_MINUTES,
  SHIP_CI_NONE_GRACE_MINUTES,
  SHIP_LANDING_STAGES,
  SHIP_REOPEN_REASONS,
  SHIP_STALLED_REASONS,
  SHIP_SUMMARY_BODY_MAX,
  SHIP_SUMMARY_DIFFSTAT_MAX,
  SHIP_SUMMARY_TITLE_MAX,
  sessionBranchName,
  sessionEventsQuerySchema,
  sessionLandingSchema,
  sessionPolicySchema,
  sessionSchema,
  sessionShipSummarySchema,
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
      model: 'claude-opus-5-5',
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
  it('a turn is 1..20 000 characters, trimmed — or images with no words at all', () => {
    expect(sessionTurnRequestSchema.parse({ message: '  hi  ' })).toEqual({
      message: 'hi',
      mode: 'queue',
      attachments: [],
    })
    expect(
      sessionTurnRequestSchema.parse({ message: 'hi', mode: 'interrupt', model: 'claude-sonnet-5' })
    ).toEqual({ message: 'hi', mode: 'interrupt', model: 'claude-sonnet-5', attachments: [] })
    const image = crypto.randomUUID()
    expect(sessionTurnRequestSchema.parse({ attachments: [image] })).toEqual({
      message: '',
      mode: 'queue',
      attachments: [image],
    })
    expect(sessionTurnRequestSchema.safeParse({}).success).toBe(false)
    expect(sessionTurnRequestSchema.safeParse({ attachments: ['not-a-uuid'] }).success).toBe(false)
    expect(
      sessionTurnRequestSchema.safeParse({
        message: 'x',
        attachments: Array.from({ length: SESSION_ATTACHMENTS_MAX + 1 }, () => crypto.randomUUID()),
      }).success
    ).toBe(false)
    expect(sessionTurnRequestSchema.safeParse({ message: 'hi', mode: 'now' }).success).toBe(false)
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

// ---- issue #5: ship means live on staging (`docs/plans/i5-ship-to-staging.md` §2) ---------------

const UUID = '6f1c1a3e-2b1f-4d5e-9a3b-1c2d3e4f5a6b'
const AT = '2026-10-01T10:00:00.000Z'

describe('issue #5: the landing', () => {
  it('names the stages, the stall and the reopen reasons, append-only', () => {
    expect(SHIP_LANDING_STAGES).toEqual([
      'ci',
      'approval',
      'merging',
      'releasing',
      'deploying',
      'live',
      'pr',
      'stalled',
    ])
    expect(MOVING_LANDING_STAGES).toEqual(['ci', 'approval', 'merging', 'releasing', 'deploying'])
    expect(SHIP_STALLED_REASONS).toEqual([
      'release_failed',
      'deploy_failed',
      'deploy_timeout',
      'unhealthy',
    ])
    expect(SHIP_REOPEN_REASONS).toEqual([
      'ci_failed',
      'ci_timeout',
      'ci_none',
      'head_moved',
      'pr_closed',
      'review_rejected',
      'review_expired',
      'merge_refused',
    ])
    // The landing's modes are the app setting's — `launch-sessions` imports them from `launch-apps`.
    expect(SESSION_SHIP_MODES).toEqual(['staging', 'pr'])
    expect(LANDING_REVIEW_MODES).toEqual([...SHIP_REVIEW_MODES, 'policy'])
    expect(SHIP_CI_MAX_MINUTES).toBe(120)
    expect(SHIP_CI_NONE_GRACE_MINUTES).toBe(10)
  })

  it('a minimal landing fills its nullable fields; a bad stage or timestamp is refused', () => {
    const minimal = {
      mode: 'staging',
      stage: 'ci',
      prNumber: 4,
      gateSha: 'abc1234',
      startedAt: AT,
      stageAt: AT,
      reviewMode: 'none',
    }
    expect(sessionLandingSchema.parse(minimal)).toEqual({
      ...minimal,
      approvalId: null,
      mergeSha: null,
      mergedAt: null,
      releaseId: null,
      version: null,
      tag: null,
      stagingUrl: null,
      containerReleased: false,
      stalledReason: null,
      error: null,
    })
    // It round-trips through JSON unchanged (a jsonb column: timestamps stay strings).
    const full = sessionLandingSchema.parse({
      ...minimal,
      stage: 'stalled',
      mergeSha: 'def5678',
      mergedAt: '2026-10-01T10:05:00+00:00',
      stalledReason: 'unhealthy',
      error: 'Staging never answered healthy.',
    })
    expect(sessionLandingSchema.parse(JSON.parse(JSON.stringify(full)))).toEqual(full)
    expect(sessionLandingSchema.safeParse({ ...minimal, stage: 'merged' }).success).toBe(false)
    expect(sessionLandingSchema.safeParse({ ...minimal, stageAt: 'yesterday' }).success).toBe(false)
    expect(sessionLandingSchema.safeParse({ ...minimal, reviewMode: 'admins' }).success).toBe(false)
  })

  it('the ship summary is capped at the plan’s sizes', () => {
    const summary = {
      title: 'Change the heading',
      body: 'The heading says hello.',
      source: 'model',
      diffStat: ' 1 file changed, 1 insertion(+)',
      prNumber: 4,
      gateSha: null,
      at: AT,
    }
    expect(sessionShipSummarySchema.parse(summary)).toEqual(summary)
    expect([SHIP_SUMMARY_TITLE_MAX, SHIP_SUMMARY_BODY_MAX, SHIP_SUMMARY_DIFFSTAT_MAX]).toEqual([
      200, 4000, 6000,
    ])
    for (const [field, max] of [
      ['title', SHIP_SUMMARY_TITLE_MAX],
      ['body', SHIP_SUMMARY_BODY_MAX],
      ['diffStat', SHIP_SUMMARY_DIFFSTAT_MAX],
    ] as const) {
      expect(
        sessionShipSummarySchema.safeParse({ ...summary, [field]: 'x'.repeat(max) }).success
      ).toBe(true)
      expect(
        sessionShipSummarySchema.safeParse({ ...summary, [field]: 'x'.repeat(max + 1) }).success,
        field
      ).toBe(false)
    }
    expect(sessionShipSummarySchema.safeParse({ ...summary, source: 'guess' }).success).toBe(false)
  })

  it('a session answer without landing or shipSummary (an older server) parses them as null', () => {
    expect(sessionSchema.shape.landing.parse(undefined)).toBeNull()
    expect(sessionSchema.shape.shipSummary.parse(undefined)).toBeNull()
  })
})

describe('issue #5: the six new events, and ship.pr’s title', () => {
  it('appends the events after ship.config_needs, each with a payload schema', () => {
    expect(SESSION_EVENT_TYPES.slice(-7)).toEqual([
      'ship.config_needs',
      'ship.ci',
      'ship.review',
      'ship.merged',
      'ship.released',
      'ship.staging',
      'ship.reopened',
    ])
  })

  it('parses each event’s data as the plan draws it', () => {
    const cases: [keyof typeof SESSION_EVENT_DATA, unknown][] = [
      [
        'ship.ci',
        {
          state: 'failure',
          headSha: 'abc',
          passed: 2,
          failed: 1,
          pending: 0,
          failedCheck: { name: 'Gate', url: null, logTail: 'Error: 1 test failed' },
        },
      ],
      ['ship.ci', { state: 'pending', headSha: 'abc', passed: 0, failed: 0, pending: 1 }],
      ['ship.review', { status: 'requested', approvalId: UUID }],
      ['ship.review', { status: 'rejected', approvalId: UUID, by: 'Bob', note: 'Not yet' }],
      [
        'ship.merged',
        { number: 4, sha: 'def', url: 'https://github.com/a/b/pull/4', approvalId: null },
      ],
      ['ship.released', { releaseId: UUID, version: '1.2.4', tag: '1.2.4', shared: false }],
      ['ship.staging', { status: 'deploying', version: '1.2.4', url: null }],
      [
        'ship.staging',
        { status: 'live', version: '1.2.4', url: 'https://shop-staging.example.com', health: 'up' },
      ],
      ['ship.reopened', { reason: 'ci_failed', message: 'CI failed on Gate.' }],
      ['ship.pr', { number: 4, url: 'https://github.com/a/b/pull/4' }],
      ['ship.pr', { number: 4, url: 'https://github.com/a/b/pull/4', title: 'Change the heading' }],
    ]
    for (const [type, data] of cases) {
      expect(SESSION_EVENT_DATA[type].safeParse(data).success, type).toBe(true)
    }
    expect(
      SESSION_EVENT_DATA['ship.reopened'].safeParse({ reason: 'bored', message: 'x' }).success
    ).toBe(false)
    expect(
      SESSION_EVENT_DATA['ship.staging'].safeParse({ status: 'gone', version: '1', url: null })
        .success
    ).toBe(false)
  })
})

describe('issue #5: the contracts beside the session', () => {
  it('ship settings default to staging with no review; groups need a team; garbage is the default', () => {
    expect(DEFAULT_APP_SHIP_SETTINGS).toEqual({
      sessionShip: 'staging',
      review: { mode: 'none', groupIds: [] },
    })
    expect(resolveAppShipSettings(null)).toEqual(DEFAULT_APP_SHIP_SETTINGS)
    expect(resolveAppShipSettings({ sessionShip: 'moon' })).toEqual(DEFAULT_APP_SHIP_SETTINGS)
    expect(resolveAppShipSettings({ sessionShip: 'pr', review: { mode: 'app_owners' } })).toEqual({
      sessionShip: 'pr',
      review: { mode: 'app_owners', groupIds: [] },
    })
    expect(
      putAppShipSettingsRequestSchema.safeParse({
        sessionShip: 'staging',
        review: { mode: 'groups', groupIds: [] },
      }).success
    ).toBe(false)
    expect(
      putAppShipSettingsRequestSchema.safeParse({
        sessionShip: 'staging',
        review: { mode: 'groups', groupIds: [UUID] },
      }).success
    ).toBe(true)
    expect(KIT_REQUIRED_CHECK).toBe('Gate')
    expect(BRANCH_PROTECTION_STATES).toEqual(['ok', 'none', 'blocks', 'unavailable', 'unknown'])
    expect(
      appBranchProtectionSchema.parse({
        state: 'ok',
        requiredChecks: ['Gate'],
        appCanBypass: true,
        rulesetId: 12,
        detail: null,
      }).state
    ).toBe('ok')
  })

  it('an app detail without the ship fields (an older server) reads the defaults', () => {
    expect(appDetailSchema.shape.shipSettings.parse(undefined)).toEqual(DEFAULT_APP_SHIP_SETTINGS)
    expect(appDetailSchema.shape.shipReviewSetBy.parse(undefined)).toBe('app')
  })

  it('session.merge is a built kind: app owners, one approval, no self-approval, 48 hours', () => {
    expect(APPROVAL_KINDS.at(-1)).toBe('session.merge')
    expect(BUILT_APPROVAL_KINDS).toContain('session.merge')
    expect(SESSION_MERGE_EXPIRY_HOURS).toBe(48)
    expect(DEFAULT_APPROVAL_POLICIES['session.merge']).toEqual({
      approvers: { appOwners: true, admins: false, groupIds: [], userIds: [] },
      minApprovals: 1,
      allowSelfApproval: false,
      expiresAfterMinutes: 48 * 60,
      autoApproveRole: null,
    })
    const context = {
      kind: 'session.merge',
      sessionId: UUID,
      shortId: 'abcdefghijkl',
      title: 'Hello',
      appSlug: 'shop',
      prNumber: 4,
      prUrl: 'https://github.com/a/shop/pull/4',
      prTitle: 'Change the heading',
      summary: 'The heading says hello.',
      diffStat: ' 1 file changed',
      headSha: 'abc',
      sessionPath: `/sessions/${UUID}`,
    }
    expect(approvalContextSchema.parse(context)).toEqual(context)
    expect(
      approvalContextSchema.safeParse({
        ...context,
        summary: 'x'.repeat(SHIP_SUMMARY_BODY_MAX + 1),
      }).success
    ).toBe(false)
  })

  it('a release in progress has its own code', () => {
    expect(RELEASE_ERROR_CODES.inProgress).toBe('release_in_progress')
  })

  it('a promotion change without `summary` (an older server) still parses, as null', () => {
    const change = {
      version: '1.2.4',
      number: 4,
      title: 'Change the heading',
      url: null,
      sessionId: null,
      sessionTitle: null,
    }
    expect(promotionChangeSchema.parse(change)).toEqual({ ...change, summary: null })
    expect(promotionChangeSchema.parse({ ...change, summary: 'Says hello.' }).summary).toBe(
      'Says hello.'
    )
    expect(PROMOTION_SUMMARY_MAX).toBe(600)
  })
})
