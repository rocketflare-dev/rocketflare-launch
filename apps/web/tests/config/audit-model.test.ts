/**
 * What the audit page says about an event (`pages/auditModel.ts`) — the same formatter for
 * Launch's own actions and the kit activities that now land in the one log.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditActionLabel, auditSummaryText, auditValue } from '@/ui/pages/auditModel'

describe('auditSummaryText', () => {
  it('reads a kit activity (metadata under `after`)', () => {
    expect(auditSummaryText({ after: { email: 'a@example.test', role: 'member' } })).toBe(
      'email: a@example.test · role: member'
    )
  })

  it('reads a key in both halves as a change', () => {
    expect(auditSummaryText({ before: { role: 'member' }, after: { role: 'admin' } })).toBe(
      'role: member → admin'
    )
  })

  it('keeps a key only in `before`, and is empty for nothing', () => {
    expect(auditSummaryText({ before: { token: 'set' } })).toBe('token: set')
    expect(auditSummaryText({})).toBe('')
  })
})

describe('auditValue', () => {
  it('shortens ids, joins scalar lists, counts object lists', () => {
    expect(auditValue('12345678-0000-4000-8000-000000000000')).toBe('12345678')
    expect(auditValue(['read', 'write'])).toBe('read, write')
    expect(auditValue([])).toBe('none')
    expect(auditValue([{ a: 1 }, { b: 2 }])).toBe('2 items')
    expect(auditValue(true)).toBe('true')
    expect(auditValue(null)).toBe('—')
    expect(auditValue({ a: 1 })).toBe('{"a":1}')
  })
})

describe('the real route table', () => {
  // `protected-route.test.tsx` proves `Moved` keeps `?query#hash` on a mirror of the table; this
  // pins that App.tsx itself sends the old Activity page there and no longer mounts it.
  const app = readFileSync(path.resolve(__dirname, '../../src/ui/App.tsx'), 'utf8')

  it('redirects /activity to /audit and no longer imports the Activity page', () => {
    expect(app).toContain('<Route path="/activity" element={<Moved to="/audit" />} />')
    expect(app).not.toMatch(/pages\/Activity['"]/)
  })
})

describe('auditActionLabel', () => {
  it('turns the dotted action into words', () => {
    expect(auditActionLabel('member.role_changed')).toBe('Member role changed')
    expect(auditActionLabel('api_key.created')).toBe('Api key created')
  })
})
