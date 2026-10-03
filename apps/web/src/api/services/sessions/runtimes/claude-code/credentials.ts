/**
 * A Claude session on a person's own subscription (§18.22-A): the lease checks the credential is
 * active and unexpired (else `CredentialNeedsLoginError` — "Reconnect your Claude account in
 * Profile") and stamps `last_used_at`. It carries NO secret into the container: the turn runs with
 * a placeholder OAuth token (`claudeTurnEnv(model, 'user')`) and the model proxy
 * (`egress/anthropic.ts`) swaps the real one in. The token never expires mid-year and is never
 * refreshed, so there is nothing to claim, write back or release — concurrent sessions are fine.
 */
import type { AgentCredentialRow } from '../../../../../db/schema'
import { CredentialNeedsLoginError } from '../../credentials/errors'
import { getById, touchLastUsed } from '../../credentials/store'
import type { TurnCredentialLease, UserLeaseContext } from '../types'

/** What the turn's sentence calls the account. */
export const CLAUDE_ACCOUNT_LABEL = 'Claude account'

/**
 * Is `row` a Claude token this session may spend right now? The same rule the lease and the model
 * proxy apply: the session's own credential (same tenant, the session creator's), Claude's kind,
 * active, and not past its expiry.
 */
export function usableClaudeCredential(
  row: AgentCredentialRow | null,
  session: { createdByUserId: string | null },
  now: Date
): row is AgentCredentialRow {
  return Boolean(
    row &&
      row.runtime === 'claude_code' &&
      row.kind === 'claude_oauth_token' &&
      row.userId === session.createdByUserId &&
      row.status === 'active' &&
      (!row.expiresAt || row.expiresAt.getTime() > now.getTime())
  )
}

export async function leaseClaudeUserCredential(
  ctx: UserLeaseContext
): Promise<TurnCredentialLease> {
  const { db, session } = ctx
  const now = ctx.now()
  const row = session.agentCredentialId
    ? await getById(db, session.tenantId, session.agentCredentialId)
    : null
  if (!usableClaudeCredential(row, session, now)) {
    throw new CredentialNeedsLoginError(CLAUDE_ACCOUNT_LABEL)
  }
  await touchLastUsed(db, session.tenantId, row.id, now)
  return { source: 'user', env: {}, files: [], release: async () => {} }
}
