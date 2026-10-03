/**
 * A Codex session on a person's ChatGPT plan (§18.22-B): one turn's lease of their `auth.json`.
 *
 * 1. **Claim** the credential for this session (`claim`, a compare-and-set with an expiry the sweep
 *    enforces): a ChatGPT refresh token ROTATES, so one `auth.json` used by two turns at once would
 *    burn it (`refresh_token_reused` → signed out). Another session holding it is
 *    `CredentialBusyError`; disconnected, refused or unreadable is `CredentialNeedsLoginError`.
 * 2. Hand the turn `auth.json` as a FILE (`$CODEX_HOME/auth.json`) and no key in the environment —
 *    `CODEX_API_KEY` would win over it (`config.ts`).
 * 3. **Release, whatever happened** (the turn's `finally`: success, failure, cancel, a lost
 *    container): read the file back, validate it, and reseal it only if Codex ROTATED the tokens and
 *    what it holds is not older than what is stored (`resealIfVersion` against the version just
 *    read — the egress may already have stored the same rotation, `egress/openai-auth.ts`); then
 *    `rm -f` it and release the claim. A container that is gone answers nothing: the claim is still
 *    released, and a rotation it made mid-turn was already captured by the egress.
 *
 * Nothing here logs, returns or emits the file's contents.
 */
import { AGENT_ACCOUNT_LABELS } from '@launch/shared/launch-agents'
import type { AgentCredentialRow } from '../../../../../db/schema'
import { CredentialBusyError, CredentialNeedsLoginError } from '../../credentials/errors'
import {
  claim,
  getById,
  markNeedsLogin,
  openSecret,
  release,
  resealIfVersion,
  touchLastUsed,
} from '../../credentials/store'
import type { TurnCredentialLease, UserLeaseContext } from '../types'
import { type CodexAuthJson, lastRefreshMs, parseCodexAuthJson, sameTokens } from './auth-json'
import { CODEX_AUTH_PATH } from './config'

const ACCOUNT = AGENT_ACCOUNT_LABELS.codex

/** What the lease's `release` is told went into the container. */
interface Leased {
  row: AgentCredentialRow
  written: CodexAuthJson
}

export async function leaseCodexUserCredential(
  ctx: UserLeaseContext
): Promise<TurnCredentialLease> {
  const { db, cfg, session } = ctx
  const credentialId = session.agentCredentialId
  if (!credentialId) throw new CredentialNeedsLoginError(ACCOUNT)
  const found = await getById(db, session.tenantId, credentialId)
  if (found?.status !== 'active' || found.runtime !== 'codex') {
    throw new CredentialNeedsLoginError(ACCOUNT)
  }

  const claimed = await claim(db, {
    tenantId: session.tenantId,
    id: credentialId,
    sessionId: session.id,
    now: ctx.now(),
  })
  if (!claimed) throw new CredentialBusyError(ACCOUNT)

  const releaseClaim = () =>
    release(db, { tenantId: session.tenantId, id: credentialId, sessionId: session.id })

  let leased: Leased
  let secret: string
  try {
    secret = await openSecret(cfg, claimed)
    const written = parseCodexAuthJson(secret)
    if (!written) {
      // Stored but not an auth.json Codex can use: the person must sign in again.
      await markNeedsLogin(db, session.tenantId, credentialId, ctx.now())
      throw new CredentialNeedsLoginError(ACCOUNT)
    }
    leased = { row: claimed, written }
    await touchLastUsed(db, session.tenantId, credentialId, ctx.now())
  } catch (err) {
    await releaseClaim()
    throw err
  }

  let released = false
  return {
    source: 'user',
    env: {},
    files: [{ path: CODEX_AUTH_PATH, content: secret }],
    async release() {
      if (released) return
      released = true
      try {
        await writeBack(ctx, leased)
      } finally {
        await ctx.sandbox.exec(`rm -f ${CODEX_AUTH_PATH}`, { timeoutMs: 15_000 }).catch(() => {})
        await releaseClaim()
      }
    },
  }
}

/**
 * Reseal what Codex left in the container when it rotated the tokens — and only then, and only if
 * it is not older than what is stored now.
 */
async function writeBack(ctx: UserLeaseContext, leased: Leased): Promise<void> {
  const { db, cfg, session, sandbox } = ctx
  let text: string | null
  try {
    text = await sandbox.readFile(CODEX_AUTH_PATH)
  } catch {
    return // the container is gone: nothing to read, and the egress kept any rotation
  }
  const after = parseCodexAuthJson(text)
  if (!after || sameTokens(after, leased.written)) return

  const current = await getById(db, session.tenantId, leased.row.id)
  if (!current) return // disconnected mid-turn: do not bring it back
  const stored = parseCodexAuthJson(await openSecret(cfg, current))
  if (stored && sameTokens(after, stored)) return // the egress stored this rotation already
  if (stored && lastRefreshMs(after) < lastRefreshMs(stored)) return // older than what is stored
  await resealIfVersion(db, cfg, {
    tenantId: session.tenantId,
    id: current.id,
    expectedVersion: current.version,
    secret: JSON.stringify(after, null, 2),
    now: ctx.now(),
  })
}
