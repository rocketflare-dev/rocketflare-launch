/**
 * What the audit page SAYS about one event — pure, so it is tested rather than eyeballed
 * (`tests/config/audit-model.test.ts`). Audit is the one log: Launch's own actions
 * (`app.imported`, `oidc.signin`) and every kit activity (`member.joined`, `invitation.revoked`,
 * `api_key.created`, …) arrive through the same writer, so one formatter serves both.
 */
import type { AuditEvent } from '@launch/shared/launch-audit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One summary value as a reader would say it: ids shortened, lists joined, objects as JSON. */
export function auditValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return UUID_RE.test(value) ? value.slice(0, 8) : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none'
    if (value.every(v => typeof v !== 'object' || v === null)) {
      return value.map(auditValue).join(', ')
    }
    return `${value.length} items`
  }
  return JSON.stringify(value)
}

/**
 * `{ after: { token: 'set' } }` → `token: set`; a key in both halves reads `role: member → admin`.
 * The summary never carries a secret value (the writers reduce one to `set`).
 */
export function auditSummaryText(summary: AuditEvent['summary']): string {
  const before = summary.before ?? {}
  const after = summary.after ?? {}
  const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])]
  return keys
    .map(key => {
      if (key in before && key in after) {
        return `${key}: ${auditValue(before[key])} → ${auditValue(after[key])}`
      }
      return `${key}: ${auditValue(key in after ? after[key] : before[key])}`
    })
    .join(' · ')
}

/** `member.role_changed` → `Member role changed` — the action's `title`; the code stays visible. */
export function auditActionLabel(action: string): string {
  const words = action.replace(/[._]/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
