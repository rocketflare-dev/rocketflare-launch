/**
 * The cube security context (D19, D31): the one bridge from a request to cube SQL. Pure — no DB.
 *
 * It used to read `c.get('auth')` from inside a drizzle-cube callback, where no Hono context
 * exists. It now takes the kit's `DetachedCtx` — the snapshot a handler builds with
 * `ctx.detached()` — plus the reader's groups, resolved in the route. The builder below is the
 * pure half of that, which is why this file still needs neither a database nor an app.
 */

import type { QueryContext } from 'drizzle-cube/server'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  AnalyticsAuthError,
  analyticsSecurityContext,
  type CubeReader,
  type GroupTypeRef,
  groupFilter,
  tenantIdOf,
} from '../../cubes/security'
import { analyticsPages } from '../../db/schema/analytics-pages'

const reader = (over: Partial<CubeReader> = {}): CubeReader => ({
  tenantId: 't-1',
  userId: 'u-1',
  role: 'admin',
  isAdmin: true,
  ...over,
})

const MEMBERSHIPS: GroupTypeRef[] = [
  { id: 'g-1', name: 'Finance', typeName: 'Department' },
  { id: 'g-2', name: 'Ops', typeName: 'Department' },
  { id: 'g-3', name: 'EMEA', typeName: 'Region' },
]

describe('analyticsSecurityContext', () => {
  it('maps the detached context to { tenantId, userId, role } with the groups by id and by type', () => {
    expect(analyticsSecurityContext(reader(), MEMBERSHIPS)).toEqual({
      tenantId: 't-1',
      userId: 'u-1',
      role: 'admin',
      groupIds: ['g-1', 'g-2', 'g-3'],
      groups: { Department: ['Finance', 'Ops'], Region: ['EMEA'] },
      groupIdsByType: { Department: ['g-1', 'g-2'], Region: ['g-3'] },
      isAdmin: true,
    })
  })

  it('carries no groups for a plain member with none', () => {
    expect(analyticsSecurityContext(reader({ role: 'member', isAdmin: false }), [])).toMatchObject({
      groupIds: [],
      groups: {},
      groupIdsByType: {},
      isAdmin: false,
    })
  })

  it('throws without a tenant — a wiring bug, not an expected path', () => {
    expect(() => analyticsSecurityContext(reader({ tenantId: '' }))).toThrow(AnalyticsAuthError)
  })
})

const queryCtx = (securityContext: Record<string, unknown>) =>
  ({ securityContext }) as unknown as QueryContext

describe('tenantIdOf', () => {
  it('returns the tenant from the security context', () => {
    expect(tenantIdOf(queryCtx({ tenantId: 't-9' }))).toBe('t-9')
  })

  it('refuses an empty or missing tenant instead of compiling `tenant_id = NULL`', () => {
    expect(() => tenantIdOf(queryCtx({}))).toThrow(AnalyticsAuthError)
    expect(() => tenantIdOf(queryCtx({ tenantId: '' }))).toThrow(AnalyticsAuthError)
  })
})

describe('groupFilter (D29)', () => {
  const column = analyticsPages.createdByUserId
  /** The rendered statement plus its bound parameters — what actually reaches Postgres. */
  const rendered = (filter: SQL | undefined) => {
    const query = new PgDialect().sqlToQuery(filter as SQL)
    return `${query.sql} -- ${JSON.stringify(query.params)}`
  }

  it('does not narrow an admin-level reader', () => {
    expect(groupFilter(queryCtx({ isAdmin: true }), 'Department', column)).toBeUndefined()
  })

  it("narrows to the reader's group IDS of that type, never their names", () => {
    const filter = groupFilter(
      queryCtx({ isAdmin: false, groupIdsByType: { Department: ['g-1', 'g-2'] } }),
      'Department',
      column
    )
    // The ids are BOUND PARAMETERS, never interpolated.
    expect(rendered(filter)).toContain('in ($1, $2)')
    expect(rendered(filter)).toContain('["g-1","g-2"]')
  })

  it('FAILS CLOSED for a reader with no group of that type', () => {
    const none = groupFilter(queryCtx({ isAdmin: false, groupIdsByType: {} }), 'Department', column)
    expect(none).toBeDefined()
    expect(rendered(none)).toContain('false')
    // A group of a DIFFERENT type does not open the door either.
    const other = groupFilter(
      queryCtx({ isAdmin: false, groupIdsByType: { Region: ['g-9'] } }),
      'Department',
      column
    )
    expect(rendered(other)).toContain('false')
  })
})
