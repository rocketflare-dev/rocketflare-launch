/**
 * A `sessions` row as the lists speak it (`@launch/shared/launch-sessions`): the summary an app's
 * sessions card and `launch sessions ls` show, and the operator's live-session row. The DETAIL is
 * `toSessionDetail` (`chat.ts`, slice 3c), which every route answering with one session uses.
 *
 * What is never here, by construction: `preview_token`, `db_uri_sealed`, `github_token_sealed`,
 * `pending_message`'s text (only whether one is waiting — the detail carries it, `queuedMessage`),
 * `sandbox_id`, `db`.
 */
import {
  type AdminSession,
  resolveSessionPolicy,
  type SessionSummary,
} from '@launch/shared/launch-sessions'
import type { SessionRow } from '../../../db/schema'

export function toSessionSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    appId: row.appId,
    kind: row.kind,
    shortId: row.shortId,
    title: row.title,
    status: row.status,
    createdByUserId: row.createdByUserId,
    branch: row.branch,
    turnCount: row.turnCount,
    costMicrocents: Number(row.costMicrocents),
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    runtime: row.runtime ?? 'claude_code',
    credentialSource: row.credentialSource ?? 'platform',
    model: resolveSessionPolicy(row.policy).model,
  }
}

export function toAdminSession(row: SessionRow, appSlug: string): AdminSession {
  return {
    ...toSessionSummary(row),
    appSlug,
    tenantId: row.tenantId,
    imageVersion: row.imageVersion,
    containerSeconds: row.containerSeconds,
  }
}
