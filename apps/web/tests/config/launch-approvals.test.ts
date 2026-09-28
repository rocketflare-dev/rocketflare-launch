/**
 * Launch P4 contracts (slice 4a): `@launch/shared/launch-approvals`, `launch-releases` and the
 * audit additions — no database. The closed sets are append-only and the defaults are the plan's
 * table (§1.7); the migration's hand-written policy literal must equal the code default it copies,
 * so the two cannot drift; the release version arithmetic is the one the Release button runs.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  APPROVAL_ERROR_CODES,
  APPROVAL_KINDS,
  APPROVAL_NOTIFICATION_TYPES,
  APPROVAL_REALTIME_ENTITY,
  APPROVAL_STATUSES,
  approvalContextSchema,
  approvalDetailSchema,
  approvalListQuerySchema,
  approvalPath,
  approvalPolicySchema,
  BUILT_APPROVAL_KINDS,
  DEFAULT_APPROVAL_POLICIES,
  decideApprovalSchema,
  githubRequesterLabel,
  isBuiltApprovalKind,
  meetsAutoApproveRole,
  putApprovalPolicySchema,
} from '@launch/shared/launch-approvals'
import { auditExportQuerySchema, auditVerifySchema } from '@launch/shared/launch-audit'
import {
  DEPLOY_DECISION_SOURCES,
  deployTicketSchema,
  productionDeployResponseSchema,
} from '@launch/shared/launch-pipeline'
import {
  bumpVersion,
  createReleaseSchema,
  parseReleaseVersion,
  RELEASE_REALTIME_ENTITY,
  RELEASE_STATUSES,
  releasePrSchema,
  releaseTagRef,
} from '@launch/shared/launch-releases'
import { DEFAULT_SESSION_POLICY, extendBudgetSchema } from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'
import { KIND_HANDLERS, kindHandler } from '@/api/services/approvals/kinds'
import { WEB_ROOT } from '../helpers/source-files'

const UUID = '6f1c1a3e-2b1f-4d5e-9a3b-1c2d3e4f5a6b'

describe('approval closed sets', () => {
  it('names every spec/08 kind, builds four, and keeps the order (values are stored)', () => {
    expect(APPROVAL_KINDS).toEqual([
      'app.create',
      'app.access',
      'deploy.production',
      'session.budget',
      'grant.request',
      'config.change',
      'app.teardown',
    ])
    expect(BUILT_APPROVAL_KINDS).toEqual([
      'app.create',
      'app.access',
      'deploy.production',
      'session.budget',
    ])
    expect(isBuiltApprovalKind('deploy.production')).toBe(true)
    expect(isBuiltApprovalKind('app.teardown')).toBe(false)
    expect(APPROVAL_STATUSES).toEqual(['pending', 'approved', 'rejected', 'expired', 'cancelled'])
  })

  it('the kind registry has exactly the built kinds, and refuses the unbuilt by name', () => {
    expect(Object.keys(KIND_HANDLERS).sort()).toEqual([...BUILT_APPROVAL_KINDS].sort())
    for (const kind of BUILT_APPROVAL_KINDS) expect(kindHandler(kind).kind).toBe(kind)
    expect(() => kindHandler('grant.request')).toThrow(
      expect.objectContaining({ statusCode: 409, code: APPROVAL_ERROR_CODES.kindNotBuilt })
    )
  })

  it('appends `approval` to the deploy decision sources (a pg enum: append-only)', () => {
    expect(DEPLOY_DECISION_SOURCES).toEqual(['auto', 'user', 'intent', 'approval'])
  })
})

describe('policies', () => {
  it('has a valid default for every kind, matching the plan (§1.7)', () => {
    for (const kind of APPROVAL_KINDS) {
      expect(approvalPolicySchema.parse(DEFAULT_APPROVAL_POLICIES[kind])).toEqual(
        DEFAULT_APPROVAL_POLICIES[kind]
      )
      // Self-approval is off everywhere by default (spec/08).
      expect(DEFAULT_APPROVAL_POLICIES[kind].allowSelfApproval).toBe(false)
    }
    const d = DEFAULT_APPROVAL_POLICIES
    expect(d['app.create']).toMatchObject({
      approvers: { admins: true, appOwners: false },
      autoApproveRole: 'admin',
      expiresAfterMinutes: 7 * 24 * 60,
    })
    expect(d['app.access']).toMatchObject({
      approvers: { appOwners: true, admins: true },
      autoApproveRole: null,
      expiresAfterMinutes: 14 * 24 * 60,
    })
    expect(d['deploy.production']).toMatchObject({
      approvers: { appOwners: true, admins: true },
      minApprovals: 1,
      expiresAfterMinutes: 24 * 60,
    })
    expect(d['session.budget']).toMatchObject({
      approvers: { appOwners: true, admins: true },
      expiresAfterMinutes: DEFAULT_SESSION_POLICY.suspendedExpiryHours * 60,
    })
  })

  it("the P4 migrations leave exactly app.access's code default on the moved rows", () => {
    const read = (file: string) => readFileSync(path.join(WEB_ROOT, 'migrations', file), 'utf8')
    const literalOf = (sql: string) => /'(\{"approvers".*?\})'::jsonb/.exec(sql)?.[1]
    // 0023 snapshotted the owners-only default it was written with; 0024 widens exactly that
    // snapshot to owners + admins (P1 parity). Together they must land on today's default.
    const moved = literalOf(read('0023_launch-p4-approvals.sql'))
    const widened = read('0024_launch-p4-access-admins.sql')
    expect(moved).toBeDefined()
    expect(literalOf(widened)).toBe(moved)
    expect(widened).toContain(`jsonb_set("policy", '{approvers,admins}', 'true'::jsonb)`)
    const after = JSON.parse(moved ?? '{}')
    after.approvers.admins = true
    expect(after).toEqual(DEFAULT_APPROVAL_POLICIES['app.access'])
  })

  it('fills the optional fields, and bounds N and the expiry', () => {
    expect(approvalPolicySchema.parse({ approvers: { admins: true } })).toEqual({
      approvers: { appOwners: false, admins: true, groupIds: [], userIds: [] },
      minApprovals: 1,
      allowSelfApproval: false,
      expiresAfterMinutes: null,
      autoApproveRole: null,
    })
    expect(approvalPolicySchema.safeParse({ approvers: {}, minApprovals: 0 }).success).toBe(false)
    expect(approvalPolicySchema.safeParse({ approvers: {}, minApprovals: 11 }).success).toBe(false)
    expect(approvalPolicySchema.safeParse({ approvers: {}, expiresAfterMinutes: 1 }).success).toBe(
      false
    )
  })

  it('a tenant policy has no scope id; a group or app policy must have one', () => {
    const base = { kind: 'deploy.production', approvers: { appOwners: true } }
    expect(putApprovalPolicySchema.safeParse({ ...base, scopeType: 'tenant' }).success).toBe(true)
    expect(
      putApprovalPolicySchema.safeParse({ ...base, scopeType: 'tenant', scopeId: UUID }).success
    ).toBe(false)
    expect(putApprovalPolicySchema.safeParse({ ...base, scopeType: 'app' }).success).toBe(false)
    expect(
      putApprovalPolicySchema.safeParse({ ...base, scopeType: 'group', scopeId: UUID }).success
    ).toBe(true)
  })

  it('ranks roles for auto-approve the way the ability matrix does', () => {
    expect(meetsAutoApproveRole('owner', 'admin')).toBe(true)
    expect(meetsAutoApproveRole('support', 'admin')).toBe(true)
    expect(meetsAutoApproveRole('member', 'admin')).toBe(false)
    expect(meetsAutoApproveRole('member', 'member')).toBe(true)
    expect(meetsAutoApproveRole('stranger', 'member')).toBe(false)
  })
})

describe('context, requests and responses', () => {
  it('context is one shape per kind, discriminated by `kind`', () => {
    expect(
      approvalContextSchema.parse({
        kind: 'deploy.production',
        version: '1.2.3',
        tag: '1.2.3',
        sha: 'a'.repeat(40),
        ref: releaseTagRef('1.2.3'),
        compareUrl: 'https://github.com/acme/shop/compare/1.2.2...1.2.3',
        stagingHealth: 'up',
        stagingVersion: '1.2.3',
      })
    ).toMatchObject({ kind: 'deploy.production', environment: 'production', prs: [] })
    expect(
      approvalContextSchema.safeParse({ kind: 'app.access', userId: UUID, message: null }).success
    ).toBe(true)
    // A session.budget context is not an app.access one.
    expect(approvalContextSchema.safeParse({ kind: 'app.access', sessionId: UUID }).success).toBe(
      false
    )
    expect(
      approvalContextSchema.safeParse({ kind: 'grant.request', description: 'later' }).success
    ).toBe(true)
  })

  it('decide takes approve|reject and an optional comment of at most 1000 characters', () => {
    expect(decideApprovalSchema.parse({ decision: 'approve', comment: '  ok  ' })).toEqual({
      decision: 'approve',
      comment: 'ok',
    })
    expect(decideApprovalSchema.safeParse({ decision: 'maybe' }).success).toBe(false)
    expect(
      decideApprovalSchema.safeParse({ decision: 'reject', comment: 'x'.repeat(1001) }).success
    ).toBe(false)
  })

  it('the list defaults to what is waiting on me', () => {
    expect(approvalListQuerySchema.parse({})).toEqual({ box: 'mine', limit: 50 })
    expect(approvalListQuerySchema.safeParse({ box: 'everyone' }).success).toBe(false)
  })

  it('a detail carries the decisions and why the viewer may not decide', () => {
    const now = new Date().toISOString()
    const parsed = approvalDetailSchema.parse({
      id: UUID,
      kind: 'app.access',
      status: 'pending',
      appId: UUID,
      app: { id: UUID, slug: 'shop', displayName: 'Shop' },
      subjectType: 'user',
      subjectId: UUID,
      requestedByUserId: UUID,
      requestedByLabel: null,
      requester: { id: UUID, name: 'Ann', email: 'ann@example.test' },
      reason: null,
      context: { kind: 'app.access', userId: UUID, message: null },
      policy: DEFAULT_APPROVAL_POLICIES['app.access'],
      requiredApprovals: 1,
      approvals: 0,
      expiresAt: now,
      decidedAt: null,
      appliedAt: null,
      applyError: null,
      createdAt: now,
      updatedAt: now,
      decisions: [],
      canDecide: false,
      whyNot: 'self_approval',
      canCancel: true,
    })
    expect(parsed.whyNot).toBe('self_approval')
    expect(parsed.expiresAt).toBeInstanceOf(Date)
  })

  it('names the realtime entity, the notification types, the page and the CI requester', () => {
    expect(APPROVAL_REALTIME_ENTITY).toBe('approval')
    expect(RELEASE_REALTIME_ENTITY).toBe('release')
    expect(Object.values(APPROVAL_NOTIFICATION_TYPES)).toEqual([
      'approval_requested',
      'approval_decided',
      'approval_expired',
    ])
    expect(approvalPath(UUID)).toBe(`/approvals/${UUID}`)
    expect(githubRequesterLabel('octocat')).toBe('github:octocat')
  })

  it('P4 fields on P2/P3 contracts are additive: old bodies still parse', () => {
    const ticket = deployTicketSchema.parse({
      id: UUID,
      appId: UUID,
      environmentId: UUID,
      environment: 'production',
      purpose: 'deploy',
      status: 'pending',
      repository: null,
      runId: null,
      runAttempt: null,
      sha: null,
      ref: null,
      actor: null,
      version: null,
      cfVersionId: null,
      refused: null,
      decisionSource: 'approval',
      decidedByUserId: null,
      decidedAt: null,
      expiresAt: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
    })
    expect(ticket).toMatchObject({ releaseId: null, approvalId: null })
    expect(productionDeployResponseSchema.parse({ ticket: null, approvalId: UUID })).toEqual({
      ticket: null,
      approvalId: UUID,
    })
    expect(extendBudgetSchema.parse({ extraUsd: 5 })).toEqual({ extraUsd: 5 })
    expect(extendBudgetSchema.parse({ extraUsd: 5, reason: ' more ' }).reason).toBe('more')
  })
})

describe('releases', () => {
  it('bumps X.Y.Z the way the Release button does', () => {
    expect(bumpVersion('0.1.0', 'patch')).toBe('0.1.1')
    expect(bumpVersion('0.1.9', 'minor')).toBe('0.2.0')
    expect(bumpVersion('1.4.2', 'major')).toBe('2.0.0')
    expect(() => bumpVersion('v1.2.3', 'patch')).toThrow(/Not a release version/)
    expect(parseReleaseVersion('10.0.1')).toEqual([10, 0, 1])
    expect(parseReleaseVersion('1.2')).toBeNull()
    expect(parseReleaseVersion('01.2.3')).toBeNull()
    expect(parseReleaseVersion('1.2.3-rc.1')).toBeNull()
    expect(releaseTagRef('1.2.3')).toBe('refs/tags/1.2.3')
  })

  it('statuses are append-only (a pg enum) and bumps are closed', () => {
    expect(RELEASE_STATUSES).toEqual([
      'tagged',
      'staging',
      'staging_active',
      'awaiting_approval',
      'promoting',
      'production_active',
      'rejected',
      'failed',
    ])
    expect(createReleaseSchema.safeParse({ bump: 'patch' }).success).toBe(true)
    expect(createReleaseSchema.safeParse({ bump: 'hotfix' }).success).toBe(false)
  })

  it('a release PR keeps ISO dates (the jsonb round-trips unchanged)', () => {
    const pr = {
      number: 1,
      title: 'Add a thing',
      author: 'octocat',
      mergedAt: '2026-09-28T10:00:00.000Z',
      mergeSha: 'b'.repeat(40),
      sessionId: UUID,
    }
    expect(releasePrSchema.parse(pr)).toEqual(pr)
    expect(releasePrSchema.safeParse({ ...pr, mergedAt: 'yesterday' }).success).toBe(false)
  })
})

describe('audit export and verify', () => {
  it('exports JSON Lines by default and bounds by date', () => {
    expect(auditExportQuerySchema.parse({})).toEqual({ format: 'json' })
    const q = auditExportQuerySchema.parse({ format: 'csv', from: '2026-09-01', action: 'release' })
    expect(q.from).toBeInstanceOf(Date)
    expect(auditExportQuerySchema.safeParse({ format: 'xml' }).success).toBe(false)
  })

  it('a verify result says where the chain broke', () => {
    expect(
      auditVerifySchema.parse({
        ok: false,
        checked: 10,
        sealedThrough: 10,
        unsealed: 2,
        firstBrokenSeq: 4,
        firstBrokenEventId: UUID,
        verifiedAt: new Date().toISOString(),
      }).firstBrokenSeq
    ).toBe(4)
  })
})
