/**
 * The D10 ability matrix (02 §10b), cell by cell — no database. If `src/permissions/CLAUDE.md`'s
 * table changes, this file changes with it.
 */

import { DEFAULT_APP_CREATE_ROLE, meetsAppCreateRole } from '@launch/shared/launch-setup'
import {
  type Actions,
  CORE_SUBJECTS,
  packedRulesSchema,
  type Role,
} from '@launch/shared/permissions'
import { membershipRoleSchema } from '@launch/shared/tenants'
import { describe, expect, it } from 'vitest'
import {
  abilityFromPackedRules,
  applyFeatureFlags,
  buildAbility,
  emptyAbility,
  getEffectiveRole,
  packRules,
  rolePermissions,
  unpackRules,
} from '@/permissions'

const ROLES = membershipRoleSchema.options
const CRUD: Actions[] = ['create', 'read', 'update', 'delete']

/**
 * `create` = create + read, nothing else (member on `File`). `createOnly` = create and NOT read
 * (member on `Feedback`: they rate answers, and only admin+ read the ratings back). `createUpdate`
 * = create + read + update and NOT delete or manage (member on `Session`: they start and drive
 * their own; the route narrows it to their own).
 */
type Level = 'manage' | 'read' | 'create' | 'createOnly' | 'createUpdate' | 'none'

/** Subject → per-role level, transcribed from the matrix. */
const MATRIX: Record<string, Record<Role, Level>> = {
  Tenant: { owner: 'manage', admin: 'read', support: 'manage', member: 'read' },
  TenantMember: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  Invitation: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  ApiKey: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  ActivityEvent: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  Notification: { owner: 'manage', admin: 'manage', support: 'manage', member: 'manage' },
  File: { owner: 'manage', admin: 'manage', support: 'manage', member: 'create' },
  AiConfig: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  Prompt: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  Conversation: { owner: 'manage', admin: 'manage', support: 'manage', member: 'manage' },
  AgentRun: { owner: 'manage', admin: 'manage', support: 'manage', member: 'manage' },
  Document: { owner: 'manage', admin: 'manage', support: 'manage', member: 'create' },
  // D29 — administering groups is admin+; a member's own groups are a route-scoped read.
  Group: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  AccessRequest: { owner: 'none', admin: 'none', support: 'none', member: 'none' },
  User: { owner: 'none', admin: 'none', support: 'none', member: 'none' },
  // D30 — administering flags is a PLATFORM act (`manage all`), never a tenant role. Using a
  // feature is not this subject at all: it is `AuthContext.features`, which no role can override.
  FeatureFlag: { owner: 'none', admin: 'none', support: 'none', member: 'none' },
  // D32 — traces hold other people's prompts: admin+ read, members nothing, nobody writes one.
  Trace: { owner: 'read', admin: 'read', support: 'read', member: 'none' },
  // D33 — anyone rates an answer; reading the ratings (the promotion queue) is admin+.
  Feedback: { owner: 'create', admin: 'create', support: 'create', member: 'createOnly' },
  // Launch (spec/06) — the app catalogue: everyone reads it, admin+ import and manage.
  App: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  // Launch (spec/08) — the audit log is append-only: admin+ read, members nothing, nobody writes.
  AuditEvent: { owner: 'read', admin: 'read', support: 'read', member: 'none' },
  // Launch P3 — coding sessions: anyone starts one and drives their own; admin+ manage them all.
  Session: { owner: 'manage', admin: 'manage', support: 'manage', member: 'createUpdate' },
  // Launch P4 — approvals: everyone reads (the service filters the rows and the engine decides
  // who may decide); admin+ manage the organisation's. Policies are admin+ only.
  Approval: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
  ApprovalPolicy: { owner: 'manage', admin: 'manage', support: 'manage', member: 'none' },
  // Launch P5 — shared config: everyone reads what they could ask for; admin+ manage. The owner
  // group's rights (values, items, holders) are the service's check, not a role grant.
  SharedResource: { owner: 'manage', admin: 'manage', support: 'manage', member: 'read' },
}

const build = (role: Role | null, features: string[] = [], isGlobalAdmin = false) =>
  buildAbility({ role, isGlobalAdmin, features })

describe('ability matrix (D10)', () => {
  it('covers every core subject except `all`', () => {
    expect(Object.keys(MATRIX).sort()).toEqual(CORE_SUBJECTS.filter(s => s !== 'all').sort())
  })

  for (const role of ROLES) {
    describe(role, () => {
      const ability = build(role)
      for (const [subject, levels] of Object.entries(MATRIX)) {
        const level = levels[role]
        it(`${level} ${subject}`, () => {
          const s = subject as (typeof CORE_SUBJECTS)[number]
          if (level === 'manage') {
            expect(ability.can('manage', s)).toBe(true)
            for (const a of CRUD) expect(ability.can(a, s)).toBe(true)
          } else if (level === 'read') {
            expect(ability.can('read', s)).toBe(true)
            expect(ability.can('manage', s)).toBe(false)
            for (const a of ['create', 'update', 'delete'] as Actions[]) {
              expect(ability.can(a, s)).toBe(false)
            }
          } else if (level === 'create') {
            expect(ability.can('create', s)).toBe(true)
            expect(ability.can('read', s)).toBe(true)
            expect(ability.can('manage', s)).toBe(false)
            for (const a of ['update', 'delete'] as Actions[]) expect(ability.can(a, s)).toBe(false)
          } else if (level === 'createUpdate') {
            for (const a of ['create', 'read', 'update'] as Actions[]) {
              expect(ability.can(a, s)).toBe(true)
            }
            for (const a of ['manage', 'delete'] as Actions[]) expect(ability.can(a, s)).toBe(false)
          } else if (level === 'createOnly') {
            expect(ability.can('create', s)).toBe(true)
            for (const a of ['manage', 'read', 'update', 'delete'] as Actions[]) {
              expect(ability.can(a, s)).toBe(false)
            }
          } else {
            for (const a of ['manage', ...CRUD] as Actions[]) expect(ability.can(a, s)).toBe(false)
          }
        })
      }
      it('never has `manage all`', () => {
        expect(ability.can('manage', 'all')).toBe(false)
      })
    })
  }

  it('globalAdmin manages all, including platform subjects and every feature', () => {
    const ability = build(null, [], true)
    expect(ability.can('manage', 'all')).toBe(true)
    for (const s of CORE_SUBJECTS) expect(ability.can('manage', s)).toBe(true)
    expect(ability.can('delete', 'Tenant')).toBe(true)
    expect(ability.can('access', 'Feature:anything')).toBe(true)
    // The flag wins over whatever membership role is present.
    expect(build('member', [], true).can('manage', 'AccessRequest')).toBe(true)
  })

  it('no role → no permissions', () => {
    const ability = build(null)
    expect(ability.rules).toEqual([])
    for (const s of CORE_SUBJECTS) expect(ability.can('read', s)).toBe(false)
    expect(emptyAbility().can('read', 'Tenant')).toBe(false)
  })
})

describe('feature flags (access)', () => {
  it('owner/admin/member only access the injected features', () => {
    for (const role of ['owner', 'admin', 'member'] as Role[]) {
      const ability = build(role, ['analytics'])
      expect(ability.can('access', 'Feature:analytics')).toBe(true)
      expect(ability.can('access', 'Feature:ai')).toBe(false)
      expect(build(role).can('access', 'Feature:analytics')).toBe(false)
    }
  })

  it('support accesses every feature', () => {
    const ability = build('support')
    expect(ability.can('access', 'Feature:analytics')).toBe(true)
    expect(ability.can('access', 'Feature:ai')).toBe(true)
  })

  it('features never grant anything but `access`', () => {
    const ability = build('member', ['Tenant', 'all'])
    expect(ability.can('manage', 'Tenant')).toBe(false)
    expect(ability.can('manage', 'all')).toBe(false)
    expect(ability.can('access', 'Feature:Tenant')).toBe(true)
  })

  it('applyFeatureFlags is exported for custom builders', () => {
    const calls: unknown[][] = []
    applyFeatureFlags(((...args: unknown[]) => calls.push(args)) as never, ['a', 'b'])
    expect(calls).toEqual([
      ['access', 'Feature:a'],
      ['access', 'Feature:b'],
    ])
  })
})

describe('getEffectiveRole', () => {
  it('prefers the global-admin flag, then the membership role', () => {
    expect(getEffectiveRole({ isGlobalAdmin: true, tenantUser: { role: 'member' } })).toBe(
      'globalAdmin'
    )
    expect(getEffectiveRole({ isGlobalAdmin: false, tenantUser: { role: 'admin' } })).toBe('admin')
    expect(getEffectiveRole({ role: 'support' })).toBe('support')
    expect(getEffectiveRole({ isGlobalAdmin: false, tenantUser: null })).toBeNull()
  })

  it('rolePermissions has exactly one handler per effective role', () => {
    expect(Object.keys(rolePermissions).sort()).toEqual([...ROLES, 'globalAdmin'].sort())
  })
})

describe('pack / unpack round-trip (D13)', () => {
  for (const role of ROLES) {
    it(`${role} survives the wire`, () => {
      const original = build(role, ['analytics'])
      const packed = packRules(original)
      // What /auth/session sends is what the UI validates.
      const parsed = packedRulesSchema.parse(JSON.parse(JSON.stringify(packed)))
      const restored = abilityFromPackedRules(parsed)
      for (const s of CORE_SUBJECTS) {
        for (const a of ['manage', 'read', 'create', 'update', 'delete'] as Actions[]) {
          expect(restored.can(a, s), `${role} ${a} ${s}`).toBe(original.can(a, s))
        }
      }
      expect(restored.can('access', 'Feature:analytics')).toBe(true)
      expect(restored.can('access', 'Feature:other')).toBe(original.can('access', 'Feature:other'))
      // unpackRules normalises (arrays for action/subject, `inverted: false`); compare the shape.
      const arr = (v: unknown) => (Array.isArray(v) ? v : [v])
      const shape = (rules: { action: unknown; subject?: unknown }[]) =>
        rules.map(r => ({ action: arr(r.action), subject: arr(r.subject) }))
      expect(shape(unpackRules(parsed))).toEqual(shape(original.rules))
    })
  }

  it('globalAdmin `manage all` survives packing', () => {
    const restored = abilityFromPackedRules(packRules(build(null, [], true)))
    expect(restored.can('manage', 'all')).toBe(true)
    expect(restored.can('delete', 'User')).toBe(true)
  })
})

describe('who may create an app (Launch P2, launch_settings.app_create_role)', () => {
  // Creating is `manage App` (admin+) AND at least the configured role — the setting can only
  // NARROW or widen within the tenant roles, never hand a member `manage App`.
  it.each([
    ['admin', { owner: true, admin: true, support: true, member: false }],
    ['owner', { owner: true, admin: false, support: false, member: false }],
    ['member', { owner: true, admin: true, support: true, member: true }],
  ] as const)('app_create_role=%s', (required, expected) => {
    for (const role of ROLES) {
      expect(meetsAppCreateRole(role, required), `${role} vs ${required}`).toBe(expected[role])
    }
    expect(meetsAppCreateRole('nobody', required)).toBe(false)
  })

  it('the default is admin, which is exactly who holds manage App', () => {
    for (const role of ROLES) {
      expect(meetsAppCreateRole(role, DEFAULT_APP_CREATE_ROLE)).toBe(
        build(role).can('manage', 'App')
      )
    }
  })
})
