/**
 * Launch P5 contracts (`@launch/shared/launch-grants`, plus the P5 lines of launch-approvals and
 * launch-sessions): the closed sets the text columns and the partial indexes are rendered from,
 * the item and body rules, the write-only values (no response schema carries a secret), the
 * `grant.request` context and default, the ship event, the paths and the codes every slice answers
 * with. Pure — no database.
 */
import {
  approvalContextSchema,
  DEFAULT_APPROVAL_POLICIES,
  grantRequestContextSchema,
} from '@launch/shared/launch-approvals'
import {
  ACTIVE_GRANT_PUSH_STATUSES,
  APP_CONFIG_REALTIME_ENTITY,
  appConfigPath,
  appConfigSchema,
  CONFIG_KEY_RE,
  createSharedResourceSchema,
  GRANT_BACKENDS,
  GRANT_ERROR_CODES,
  GRANT_NOTIFICATION_TYPES,
  GRANT_PUSH_REALTIME_ENTITY,
  GRANT_PUSH_REASONS,
  GRANT_PUSH_STATUSES,
  GRANT_PUSH_TARGET_STATUSES,
  GRANT_STATUSES,
  grantPushParamsSchema,
  grantPushSchema,
  isActiveGrantPush,
  isLiveGrant,
  LIVE_GRANT_STATUSES,
  patchSharedResourceSchema,
  putSharedResourceValuesSchema,
  requestGrantSchema,
  SHARED_RESOURCE_ITEM_KINDS,
  SHARED_RESOURCE_REALTIME_ENTITY,
  SHARED_RESOURCE_VALUE_STATUSES,
  sharedResourceDetailSchema,
  sharedResourceItemsSchema,
  sharedResourceListQuerySchema,
  sharedResourcePath,
  sharedResourceSlugSchema,
} from '@launch/shared/launch-grants'
import { SESSION_EVENT_DATA, SESSION_EVENT_TYPES } from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'

const UUID = '6f1c1a3e-2b1f-4d5e-9a3b-1c2d3e4f5a6b'
const OTHER = '7a2d2b4f-3c2a-4e6f-8b4c-2d3e4f5a6b7c'
const now = new Date().toISOString()
const M365 = [
  { key: 'M365_TENANT_ID', kind: 'var' },
  { key: 'M365_CLIENT_ID', kind: 'var' },
  { key: 'M365_CLIENT_SECRET', kind: 'secret', rotationDays: 180 },
] as const

describe('closed sets (text columns; append-only values)', () => {
  it('keeps every set in its stored order', () => {
    expect(SHARED_RESOURCE_ITEM_KINDS).toEqual(['var', 'secret'])
    expect(SHARED_RESOURCE_VALUE_STATUSES).toEqual(['active', 'retiring', 'retired'])
    expect(GRANT_STATUSES).toEqual([
      'requested',
      'active',
      'revoking',
      'revoked',
      'rejected',
      'expired',
    ])
    expect(GRANT_PUSH_REASONS).toEqual(['grant', 'rotate', 'revoke', 'expire', 'repair'])
    expect(GRANT_PUSH_STATUSES).toEqual(['queued', 'running', 'succeeded', 'partial', 'failed'])
    expect(GRANT_PUSH_TARGET_STATUSES).toEqual(['pending', 'succeeded', 'failed', 'skipped'])
    expect(GRANT_BACKENDS).toEqual(['cloudflare', 'local'])
  })

  it('the index predicates are what "live" and "running" mean, and the helpers agree', () => {
    expect(LIVE_GRANT_STATUSES).toEqual(['requested', 'active', 'revoking'])
    expect(ACTIVE_GRANT_PUSH_STATUSES).toEqual(['queued', 'running'])
    for (const s of GRANT_STATUSES) {
      expect(isLiveGrant(s)).toBe((LIVE_GRANT_STATUSES as readonly string[]).includes(s))
    }
    for (const s of GRANT_PUSH_STATUSES) {
      expect(isActiveGrantPush(s)).toBe(
        (ACTIVE_GRANT_PUSH_STATUSES as readonly string[]).includes(s)
      )
    }
  })
})

describe('a resource', () => {
  it('slugs and keys follow their grammar', () => {
    expect(sharedResourceSlugSchema.safeParse('m365').success).toBe(true)
    expect(sharedResourceSlugSchema.safeParse('openai-company').success).toBe(true)
    for (const bad of ['M365', '1password', '-x', 'a'.repeat(41), 'a_b']) {
      expect(sharedResourceSlugSchema.safeParse(bad).success, bad).toBe(false)
    }
    expect(CONFIG_KEY_RE.test('M365_CLIENT_SECRET')).toBe(true)
    for (const bad of ['m365_id', '1KEY', 'KEY-NAME', ''])
      expect(CONFIG_KEY_RE.test(bad)).toBe(false)
  })

  it('items are 1–50 with unique keys', () => {
    expect(sharedResourceItemsSchema.parse(M365)).toHaveLength(3)
    expect(sharedResourceItemsSchema.safeParse([]).success).toBe(false)
    const dup = sharedResourceItemsSchema.safeParse([
      M365[0],
      { key: 'M365_TENANT_ID', kind: 'secret' },
    ])
    expect(dup.success).toBe(false)
    expect(dup.error?.issues[0]?.path).toEqual([1, 'key'])
  })

  it('create defaults the policies; patch needs something; policies are full ApprovalPolicy values', () => {
    const created = createSharedResourceSchema.parse({
      slug: 'm365',
      displayName: ' M365 ',
      ownerGroupId: UUID,
      items: M365,
    })
    expect(created).toMatchObject({ displayName: 'M365', policies: {} })
    expect(patchSharedResourceSchema.safeParse({}).success).toBe(false)
    expect(
      patchSharedResourceSchema.parse({
        policies: { production: { approvers: { appOwners: false, admins: false } } },
      }).policies?.production
    ).toEqual({
      approvers: { appOwners: false, admins: false, groupIds: [], userIds: [] },
      minApprovals: 1,
      allowSelfApproval: false,
      expiresAfterMinutes: null,
      autoApproveRole: null,
    })
  })

  it('values are keyed by item key and capped at a Worker secret size', () => {
    expect(
      putSharedResourceValuesSchema.parse({
        values: { M365_CLIENT_SECRET: '', M365_TENANT_ID: 'x' },
      })
    ).toEqual({ values: { M365_CLIENT_SECRET: '', M365_TENANT_ID: 'x' } })
    expect(putSharedResourceValuesSchema.safeParse({ values: { bad_key: 'x' } }).success).toBe(
      false
    )
    expect(
      putSharedResourceValuesSchema.safeParse({ values: { K: 'x'.repeat(5 * 1024 + 1) } }).success
    ).toBe(false)
  })

  it('the list query reads archived as a flag', () => {
    expect(sharedResourceListQuerySchema.parse({})).toEqual({ archived: false })
    expect(sharedResourceListQuerySchema.parse({ archived: 'true' })).toEqual({ archived: true })
    expect(sharedResourceListQuerySchema.safeParse({ archived: 'yes' }).success).toBe(false)
  })

  it('no response schema has a place for a secret: a detail strips anything not declared', () => {
    const detail = sharedResourceDetailSchema.parse({
      id: UUID,
      slug: 'm365',
      displayName: 'M365',
      description: null,
      ownerGroup: { id: OTHER, name: 'IT Identity' },
      items: M365,
      environments: [
        {
          environment: 'staging',
          version: 1,
          versionId: UUID,
          setAt: now,
          setBy: null,
          keysSet: ['M365_CLIENT_SECRET'],
          holderCount: 0,
          sealed: 'should-not-survive',
          values: { M365_CLIENT_SECRET: 'nope' },
        },
      ],
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      policies: {},
      createdByUserId: null,
      canManage: false,
      canSetValues: false,
    })
    const text = JSON.stringify(detail)
    expect(text).not.toContain('should-not-survive')
    expect(text).not.toContain('nope')
    expect(detail.holders).toBeUndefined()
    expect(detail.environments[0]?.vars).toBeUndefined()
    expect(detail.activePushes).toEqual([])
  })
})

describe('grants and pushes', () => {
  it('a request names each environment once, a reason, and an optional expiry', () => {
    expect(
      requestGrantSchema.parse({
        resourceId: UUID,
        environments: ['staging', 'production'],
        reason: ' the connector ',
      })
    ).toEqual({
      resourceId: UUID,
      environments: ['staging', 'production'],
      reason: 'the connector',
    })
    for (const bad of [
      { resourceId: UUID, environments: [], reason: 'x' },
      { resourceId: UUID, environments: ['staging', 'staging'], reason: 'x' },
      { resourceId: UUID, environments: ['dev'], reason: 'x' },
      { resourceId: UUID, environments: ['staging'], reason: '  ' },
    ]) {
      expect(requestGrantSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('the Workflow params are ids only', () => {
    expect(grantPushParamsSchema.parse({ tenantId: UUID, pushId: OTHER, extra: 1 })).toEqual({
      tenantId: UUID,
      pushId: OTHER,
    })
  })

  it('a push carries its targets by name only', () => {
    const push = grantPushSchema.parse({
      id: UUID,
      resourceId: OTHER,
      environment: 'production',
      reason: 'rotate',
      grantId: null,
      versionId: UUID,
      version: 2,
      approvalId: null,
      status: 'partial',
      total: 3,
      succeeded: 2,
      failed: 1,
      startedByUserId: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      targets: [
        {
          id: UUID,
          grantId: OTHER,
          app: { id: UUID, slug: 'crm', displayName: 'CRM' },
          status: 'failed',
          attempts: 1,
          error: 'app_has_no_worker',
          names: ['M365_CLIENT_SECRET'],
          finishedAt: now,
        },
      ],
    })
    expect(push.targets[0]?.names).toEqual(['M365_CLIENT_SECRET'])
  })

  it('an app config view parses with nothing declared yet', () => {
    expect(
      appConfigSchema.parse({
        appId: UUID,
        scan: null,
        declared: [],
        matched: [],
        needs: [],
        unmatched: [],
        grants: [],
        canRequest: true,
      }).scan
    ).toBeNull()
  })
})

describe('the grant.request approval (P5 lines of launch-approvals)', () => {
  it('the context carries names and kinds, never a value, and an ISO expiry', () => {
    const context = {
      kind: 'grant.request',
      resourceId: UUID,
      resourceName: 'M365',
      environment: 'production',
      items: M365.map(({ key, kind }) => ({ key, kind })),
      appSlug: 'shop',
      expiresAt: null,
    }
    expect(grantRequestContextSchema.parse(context).declaredBy).toEqual([])
    expect(approvalContextSchema.parse(context)).toMatchObject({ kind: 'grant.request' })
    expect(
      grantRequestContextSchema.safeParse({ ...context, expiresAt: '2026-12-01T00:00:00.000Z' })
        .success
    ).toBe(true)
    expect(grantRequestContextSchema.safeParse({ ...context, expiresAt: 'soon' }).success).toBe(
      false
    )
  })

  it('the default asks the resource owners (eligibleExtra): not app owners, not admins, 7 days', () => {
    expect(DEFAULT_APPROVAL_POLICIES['grant.request']).toEqual({
      approvers: { appOwners: false, admins: false, groupIds: [], userIds: [] },
      minApprovals: 1,
      allowSelfApproval: false,
      expiresAfterMinutes: 7 * 24 * 60,
      autoApproveRole: null,
    })
  })
})

describe('the ship event (P5 line of launch-sessions)', () => {
  it('ship.config_needs is a session event with its own payload schema', () => {
    expect(SESSION_EVENT_TYPES).toContain('ship.config_needs')
    expect(
      SESSION_EVENT_DATA['ship.config_needs'].parse({
        needs: [{ resourceId: UUID, slug: 'm365', displayName: 'M365', keys: ['M365_TENANT_ID'] }],
      })
    ).toEqual({
      needs: [{ resourceId: UUID, slug: 'm365', displayName: 'M365', keys: ['M365_TENANT_ID'] }],
      unmatched: [],
    })
  })
})

describe('paths, entities, notifications and codes', () => {
  it('names the pages notifications link to and the realtime roots', () => {
    expect(sharedResourcePath(UUID)).toBe(`/shared-config/${UUID}`)
    expect(appConfigPath('shop')).toBe('/apps/shop/config')
    expect([
      SHARED_RESOURCE_REALTIME_ENTITY,
      GRANT_PUSH_REALTIME_ENTITY,
      APP_CONFIG_REALTIME_ENTITY,
    ]).toEqual(['shared_resource', 'grant_push', 'app_config'])
    expect(Object.values(GRANT_NOTIFICATION_TYPES)).toEqual([
      'grant_needed',
      'grant_push_failed',
      'grant_expiring',
      'grant_rotation_due',
      'grant_rotated',
    ])
  })

  it('error codes are unique snake_case', () => {
    const codes = Object.values(GRANT_ERROR_CODES)
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) expect(code).toMatch(/^[a-z][a-z_]*$/)
    expect(GRANT_ERROR_CODES.notConfigured).toBe('grants_not_configured')
    expect(GRANT_ERROR_CODES.pushInProgress).toBe('push_in_progress')
    expect(GRANT_ERROR_CODES.pushNotRetryable).toBe('push_not_retryable')
    expect(GRANT_ERROR_CODES.expiryPast).toBe('grant_expiry_past')
  })
})
