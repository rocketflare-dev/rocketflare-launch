/**
 * The two subjects this plugin adds to the kit's ability matrix (D10, D31).
 *
 * They were rows in the kit's `tests/config/permissions.test.ts` until analytics left the kit; the
 * kit's matrix lost them and this file gained them, which is the rule in one line — a plugin tests
 * its own behaviour, and the host tests that it is a well-formed plugin.
 *
 * **It is an `api` test rather than a `config` one now, and the reason is the contract.** It used
 * to call `buildAbility` from `@/permissions/abilities` directly; the plugin surface does not
 * publish it, and the declared way to ask "what may this role do" is `makeRequestCtx(...).can(...)`
 * from `@testkit/unit`, which runs the REAL `buildAbility` — including the plugin grants merged
 * into it. Every context builder requires a handle the integration harness handed out, so the file
 * moves to where the database is. The answers it asserts are unchanged.
 *
 * `Dashboard` is an `analytics_pages` row: admin-level roles manage it, a member reads it, and "is
 * this page yours" is never a CASL condition — the route ANDs `visibleAnalyticsPages(scope)` onto
 * the tenant predicate (D29). `Analytics` is the cube API itself, which is read-only by nature and
 * open to every member because every cube scopes its own `sql()` by tenant.
 */

import { ANALYTICS_SUBJECT, DASHBOARD_SUBJECT } from '@launch/shared/plugins/analytics/index'
import type { MembershipRole } from '@launch/shared/tenants'
import { setupTestDatabase } from '@testkit/integration'
import { makeRequestCtx } from '@testkit/unit'
import { describe, expect, it } from 'vitest'

const db = setupTestDatabase()

const CRUD = ['create', 'read', 'update', 'delete'] as const
const ROLES: MembershipRole[] = ['owner', 'admin', 'support', 'member']

const abilityFor = (role: MembershipRole | null, isGlobalAdmin = false) =>
  makeRequestCtx({ db, tenantId: crypto.randomUUID(), role, isGlobalAdmin })

describe('the analytics plugin’s CASL grants', () => {
  for (const role of ROLES) {
    const manages = role !== 'member'

    it(`${role}: ${manages ? 'manage' : 'read'} ${DASHBOARD_SUBJECT}`, () => {
      const ctx = abilityFor(role)
      expect(ctx.can('read', DASHBOARD_SUBJECT)).toBe(true)
      expect(ctx.can('manage', DASHBOARD_SUBJECT)).toBe(manages)
      for (const action of CRUD) {
        expect(ctx.can(action, DASHBOARD_SUBJECT)).toBe(manages || action === 'read')
      }
    })

    it(`${role}: read ${ANALYTICS_SUBJECT}, and never more`, () => {
      const ctx = abilityFor(role)
      expect(ctx.can('read', ANALYTICS_SUBJECT)).toBe(true)
      // The cube API is read-only by nature; nobody gets write on it, not even an owner.
      expect(ctx.can('manage', ANALYTICS_SUBJECT)).toBe(false)
      expect(ctx.can('update', ANALYTICS_SUBJECT)).toBe(false)
    })
  }

  it('a global admin reaches both through `manage all`', () => {
    const ctx = abilityFor(null, true)
    expect(ctx.can('manage', DASHBOARD_SUBJECT)).toBe(true)
    expect(ctx.can('manage', ANALYTICS_SUBJECT)).toBe(true)
  })

  it('a session with no role can do neither', () => {
    const ctx = abilityFor(null)
    expect(ctx.can('read', DASHBOARD_SUBJECT)).toBe(false)
    expect(ctx.can('read', ANALYTICS_SUBJECT)).toBe(false)
  })
})
