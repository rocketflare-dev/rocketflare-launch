/**
 * The registry's pure parts: spec/04's slug rules, the redirect-URI rule, the OIDC config snippet
 * (which must never carry the secret), and the health strip's bucketing.
 */
import {
  appOidcConfigSnippet,
  appRedirectUriSchema,
  appSlugProblem,
  RESERVED_APP_SLUGS,
} from '@launch/shared/launch-apps'
import { describe, expect, it } from 'vitest'
import { bucketChecks } from '@/ui/pages/apps/components/HealthHistory'
import { groupRuns } from '@/ui/pages/apps/components/OperationsLog'

describe('appSlugProblem (spec/04)', () => {
  it('accepts a first-level label that starts with a letter', () => {
    for (const slug of ['expenses', 'expense-tracker', 'a1', 'hr2-portal']) {
      expect(appSlugProblem(slug)).toBeNull()
    }
  })

  it('refuses what would collide with hostnames or resource names', () => {
    expect(appSlugProblem('')).toMatch(/required/)
    expect(appSlugProblem('1app')).toMatch(/start with a lower-case letter/)
    expect(appSlugProblem('App')).toMatch(/start with a lower-case letter/)
    expect(appSlugProblem('my_app')).toMatch(/only lower-case letters/)
    expect(appSlugProblem('app-')).toMatch(/end with a hyphen/)
    expect(appSlugProblem('a--b')).toMatch(/two hyphens/)
    expect(appSlugProblem('expenses-staging')).toMatch(/-staging/)
    expect(appSlugProblem(`a${'b'.repeat(40)}`)).toMatch(/at most 40/)
    for (const reserved of RESERVED_APP_SLUGS) expect(appSlugProblem(reserved)).toMatch(/reserved/)
  })
})

describe('appRedirectUriSchema', () => {
  it('takes https anywhere and http only on loopback, never with a fragment', () => {
    expect(appRedirectUriSchema.safeParse('https://x.example.com/auth/oidc/callback').success).toBe(
      true
    )
    expect(appRedirectUriSchema.safeParse('http://localhost:3001/cb').success).toBe(true)
    expect(appRedirectUriSchema.safeParse('http://127.0.0.1:8787/cb').success).toBe(true)
    expect(appRedirectUriSchema.safeParse('http://x.example.com/cb').success).toBe(false)
    expect(appRedirectUriSchema.safeParse('https://x.example.com/cb#frag').success).toBe(false)
    expect(appRedirectUriSchema.safeParse('javascript:alert(1)').success).toBe(false)
  })
})

describe('appOidcConfigSnippet', () => {
  it('names the three vars and the secret command, and never a secret', () => {
    const snippet = appOidcConfigSnippet({ issuer: 'https://launch.example.com', clientId: 'lc_x' })
    expect(snippet).toContain('OIDC_ISSUER = "https://launch.example.com"')
    expect(snippet).toContain('OIDC_CLIENT_ID = "lc_x"')
    expect(snippet).toContain('AUTH_OIDC_ONLY = "true"')
    expect(snippet).toContain('wrangler secret put OIDC_CLIENT_SECRET -c wrangler.staging.toml')
    expect(snippet).not.toMatch(/OIDC_CLIENT_SECRET\s*=/)
  })
})

describe('bucketChecks', () => {
  const now = new Date('2026-09-27T12:00:00Z')
  const check = (minutesAgo: number, status: 'up' | 'degraded' | 'down') => ({
    id: crypto.randomUUID(),
    environmentId: crypto.randomUUID(),
    environmentName: 'production' as const,
    checkedAt: new Date(now.getTime() - minutesAgo * 60_000),
    status,
    httpStatus: 200,
    readyStatus: 200,
    latencyMs: 10,
    version: null,
    error: null,
  })

  it('makes 96 quarter-hour slots, the worst status wins, and outside the window is dropped', () => {
    const buckets = bucketChecks(
      [
        check(1, 'up'),
        check(3, 'down'),
        check(6, 'up'),
        check(20, 'degraded'),
        check(25 * 60, 'down'),
      ],
      now
    )
    expect(buckets).toHaveLength(96)
    expect(buckets[95]).toMatchObject({ status: 'down', checks: 3 })
    expect(buckets[94]).toMatchObject({ status: 'degraded', checks: 1 })
    expect(buckets[0]).toMatchObject({ status: 'none', checks: 0 })
  })
})

describe('groupRuns', () => {
  it('groups operations by run, newest run first, steps in start order', () => {
    const op = (runId: string, step: string, at: string) => ({
      id: crypto.randomUUID(),
      runId,
      kind: 'import',
      step,
      status: 'succeeded' as const,
      attempt: 1,
      error: null,
      externalIds: {},
      startedAt: new Date(at),
      finishedAt: new Date(at),
      createdAt: new Date(at),
    })
    const runs = groupRuns([
      op('r2', 'register_production', '2026-09-02T00:00:01Z'),
      op('r2', 'read_repo', '2026-09-02T00:00:00Z'),
      op('r1', 'read_repo', '2026-09-01T00:00:00Z'),
    ])
    expect(runs.map(r => r.runId)).toEqual(['r2', 'r1'])
    expect(runs[0]?.steps.map(s => s.step)).toEqual(['read_repo', 'register_production'])
  })
})
