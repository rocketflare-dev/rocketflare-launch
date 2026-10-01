/**
 * `pr.merged` / `pr.closed` in the audit log (Launch P4, plan §1.10 / §1.11) — the one external
 * step of the chain PR → merge → tag → staging → approval → production, since Launch performs the
 * tag and the release itself. Recorded by two paths, both polling (no webhook):
 *
 * - `sessions.checks` (`checks-cron.ts`) follows a shipped session's PR until it is merged or
 *   closed, and records the merge with its SHA;
 * - Release (`release.ts`) records every PR in its compare that is not recorded yet — a PR a person
 *   merged in GitHub, or a session PR the cron had not reached.
 *
 * The row: `targetType 'pull_request'`, `targetId` the PR number (as text), `appId` the app — so
 * "is #N recorded" and the release chain are one indexed lookup each. The summary carries the
 * facts (title, author login, merge SHA, merged at, the session when there is one), never a token.
 */
import type { ReleasePr } from '@launch/shared/launch-releases'
import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { auditEvents } from '../../../../db/schema'
import { type AuditActor, recordAudit, SYSTEM_ACTOR } from '../audit'

export const PR_TARGET_TYPE = 'pull_request'
export const PR_MERGED_ACTION = 'pr.merged'
export const PR_CLOSED_ACTION = 'pr.closed'

/** The PR numbers of `appId` already recorded as merged (or closed, when `closedToo`). */
export async function recordedPrNumbers(
  db: Database,
  tenantId: string,
  appId: string,
  numbers: readonly number[],
  closedToo = false
): Promise<Set<number>> {
  if (numbers.length === 0) return new Set()
  const actions = closedToo ? [PR_MERGED_ACTION, PR_CLOSED_ACTION] : [PR_MERGED_ACTION]
  const rows = await db
    .select({ targetId: auditEvents.targetId })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.appId, appId),
        eq(auditEvents.targetType, PR_TARGET_TYPE),
        inArray(auditEvents.action, actions),
        inArray(
          auditEvents.targetId,
          numbers.map(n => String(n))
        )
      )
    )
  return new Set(rows.map(r => Number(r.targetId)))
}

/** Append `pr.merged` for one PR. The caller has checked it is not recorded yet. */
export async function recordPrMerged(
  db: Database,
  input: {
    tenantId: string
    appId: string
    pr: ReleasePr
    actor?: AuditActor
    /**
     * Which path saw it: the cron following a session, a release's compare, or (issue #5) the
     * session's own landing — Launch's squash (`land.merge`).
     */
    via: 'sessions.checks' | 'release' | 'session.merge'
  }
): Promise<void> {
  const { pr } = input
  await recordAudit(db, {
    ...(input.actor ?? SYSTEM_ACTOR),
    tenantId: input.tenantId,
    action: PR_MERGED_ACTION,
    targetType: PR_TARGET_TYPE,
    targetId: String(pr.number),
    appId: input.appId,
    summary: {
      after: {
        number: pr.number,
        title: pr.title,
        author: pr.author,
        mergeSha: pr.mergeSha,
        mergedAt: pr.mergedAt,
        url: pr.url ?? null,
        sessionId: pr.sessionId ?? null,
        via: input.via,
      },
    },
  })
}

/** Append `pr.closed` — a session's PR closed unmerged, so the cron stops following it. */
export async function recordPrClosed(
  db: Database,
  input: { tenantId: string; appId: string; number: number; sessionId: string; url: string | null }
): Promise<void> {
  await recordAudit(db, {
    ...SYSTEM_ACTOR,
    tenantId: input.tenantId,
    action: PR_CLOSED_ACTION,
    targetType: PR_TARGET_TYPE,
    targetId: String(input.number),
    appId: input.appId,
    summary: { after: { number: input.number, sessionId: input.sessionId, url: input.url } },
  })
}
