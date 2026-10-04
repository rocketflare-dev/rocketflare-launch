/**
 * Every `agent_credentials` query (§18.22) — the one module that reads or writes the table, so the
 * rules are written once:
 *
 * - **Tenant first, always.** Every function takes the tenant id from its caller (the auth context,
 *   or the session row the caller already scoped) and puts it in the predicate. The only exception
 *   is `sweepStaleClaims`, the cron's cross-tenant pass (an `unscoped-allowlist` entry), which
 *   writes each row inside its own tenant.
 * - **The secret never leaves sealed except through `openSecret`**, which a lease or an egress
 *   handler calls at use time and drops. `listPublic` / `toPublicCredential` are the only shapes a
 *   route returns, and they carry no value.
 * - **Rotation is a compare-and-set on `version`** (`resealIfVersion`); **use is a claim**
 *   (`claim` / `release`, with an expiry the sweep enforces) — never a lock or a `Map`.
 */
import type {
  AgentCredential,
  AgentCredentialKind,
  AgentCredentialMetadata,
  AgentRuntimeId,
} from '@launch/shared/launch-agents'
import { and, eq, inArray, isNotNull, isNull, lt, notExists, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { type AgentCredentialRow, agentCredentials, sessions } from '../../../../db/schema'
import { decryptToken, encryptToken } from '../../../auth/oauth-encryption'

/** How long one turn may hold a claim before the sweep may take it back. */
export const AGENT_CREDENTIAL_CLAIM_MS = 2 * 60 * 60_000

/**
 * The session statuses in which a turn runs (a chat turn, or a ship's fix turn). A claim only
 * blocks while its holder is in one: a turn killed before its `finally` (a deploy, a crash, a
 * `wrangler dev` reload — seen live) leaves the claim behind with its holder idle, and the next
 * turn takes it over instead of waiting out the expiry.
 */
export const CLAIM_HOLDING_SESSION_STATUSES = ['working', 'shipping'] as const

/** A row as the API may speak of it. */
export function toPublicCredential(
  row: AgentCredentialRow,
  now: Date = new Date()
): AgentCredential {
  return {
    id: row.id,
    runtime: row.runtime,
    kind: row.kind,
    status: row.status,
    metadata: row.metadata ?? {},
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    inUse: Boolean(
      row.claimedBySessionId && row.claimExpiresAt && row.claimExpiresAt.getTime() > now.getTime()
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** The person's credential for `runtime` in `tenantId` (sealed — server-only), or null. */
export async function getForUser(
  db: Database,
  tenantId: string,
  userId: string,
  runtime: AgentRuntimeId
): Promise<AgentCredentialRow | null> {
  const [row] = await db
    .select()
    .from(agentCredentials)
    .where(
      and(
        eq(agentCredentials.tenantId, tenantId),
        eq(agentCredentials.userId, userId),
        eq(agentCredentials.runtime, runtime)
      )
    )
    .limit(1)
  return row ?? null
}

/** One credential by id, inside `tenantId` (sealed — server-only), or null. */
export async function getById(
  db: Database,
  tenantId: string,
  id: string
): Promise<AgentCredentialRow | null> {
  const [row] = await db
    .select()
    .from(agentCredentials)
    .where(and(eq(agentCredentials.tenantId, tenantId), eq(agentCredentials.id, id)))
    .limit(1)
  return row ?? null
}

/** The person's credentials, value-free, for `GET /api/me/agent-credentials`. */
export async function listPublic(
  db: Database,
  tenantId: string,
  userId: string,
  now: Date = new Date()
): Promise<AgentCredential[]> {
  const rows = await db
    .select()
    .from(agentCredentials)
    .where(and(eq(agentCredentials.tenantId, tenantId), eq(agentCredentials.userId, userId)))
    .orderBy(agentCredentials.runtime)
  return rows.map(row => toPublicCredential(row, now))
}

export interface PutCredentialInput {
  tenantId: string
  userId: string
  runtime: AgentRuntimeId
  kind: AgentCredentialKind
  /** The credential itself. Sealed here; never stored or returned in the clear. */
  secret: string
  expiresAt: Date | null
  metadata: AgentCredentialMetadata
  now?: Date
}

/**
 * Seal and store the person's credential for the runtime — a new row, or a reconnect replacing the
 * old one (status back to `active`, `version` bumped, any claim dropped). Returns the public shape.
 */
export async function putSealed(
  db: Database,
  cfg: AppConfig,
  input: PutCredentialInput
): Promise<AgentCredential> {
  const now = input.now ?? new Date()
  const sealed = (await encryptToken(cfg, input.secret)) as string
  const [row] = await db
    .insert(agentCredentials)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      runtime: input.runtime,
      kind: input.kind,
      secretSealed: sealed,
      status: 'active',
      metadata: input.metadata,
      expiresAt: input.expiresAt,
      lastRefreshedAt: now,
    })
    .onConflictDoUpdate({
      target: [agentCredentials.tenantId, agentCredentials.userId, agentCredentials.runtime],
      set: {
        kind: input.kind,
        secretSealed: sealed,
        version: sql`${agentCredentials.version} + 1`,
        status: 'active',
        metadata: input.metadata,
        expiresAt: input.expiresAt,
        claimedBySessionId: null,
        claimedAt: null,
        claimExpiresAt: null,
        lastRefreshedAt: now,
        updatedAt: now,
      },
    })
    .returning()
  if (!row) throw new Error('putSealed: the upsert returned no row')
  return toPublicCredential(row, now)
}

/** The credential in the clear — at USE time only (a lease, an egress swap); never returned. */
export async function openSecret(cfg: AppConfig, row: Pick<AgentCredentialRow, 'secretSealed'>) {
  return (await decryptToken(cfg, row.secretSealed)) as string
}

/**
 * Write a rotated secret back, but only if nobody else did first (`version` still `expected`).
 * True when this write won; false means a newer secret is already stored — keep that one.
 */
export async function resealIfVersion(
  db: Database,
  cfg: AppConfig,
  input: {
    tenantId: string
    id: string
    expectedVersion: number
    secret: string
    expiresAt?: Date | null
    now?: Date
  }
): Promise<boolean> {
  const now = input.now ?? new Date()
  const sealed = (await encryptToken(cfg, input.secret)) as string
  const updated = await db
    .update(agentCredentials)
    .set({
      secretSealed: sealed,
      version: sql`${agentCredentials.version} + 1`,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      lastRefreshedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentCredentials.tenantId, input.tenantId),
        eq(agentCredentials.id, input.id),
        eq(agentCredentials.version, input.expectedVersion)
      )
    )
    .returning({ id: agentCredentials.id })
  return updated.length > 0
}

/** The provider refused it: the person must reconnect. Idempotent. */
export async function markNeedsLogin(
  db: Database,
  tenantId: string,
  id: string,
  now: Date = new Date()
): Promise<void> {
  await db
    .update(agentCredentials)
    .set({ status: 'needs_login', updatedAt: now })
    .where(and(eq(agentCredentials.tenantId, tenantId), eq(agentCredentials.id, id)))
}

/** A turn used it. */
export async function touchLastUsed(
  db: Database,
  tenantId: string,
  id: string,
  now: Date = new Date()
): Promise<void> {
  await db
    .update(agentCredentials)
    .set({ lastUsedAt: now })
    .where(and(eq(agentCredentials.tenantId, tenantId), eq(agentCredentials.id, id)))
}

/**
 * Claim the credential for one session's turn: a compare-and-set that wins when nobody holds it,
 * the claim expired, or this session already holds it (a retried turn). The row (sealed) on a win,
 * null when another session holds it.
 */
export async function claim(
  db: Database,
  input: { tenantId: string; id: string; sessionId: string; now?: Date; ttlMs?: number }
): Promise<AgentCredentialRow | null> {
  const now = input.now ?? new Date()
  const [row] = await db
    .update(agentCredentials)
    .set({
      claimedBySessionId: input.sessionId,
      claimedAt: now,
      claimExpiresAt: new Date(now.getTime() + (input.ttlMs ?? AGENT_CREDENTIAL_CLAIM_MS)),
    })
    .where(
      and(
        eq(agentCredentials.tenantId, input.tenantId),
        eq(agentCredentials.id, input.id),
        or(
          isNull(agentCredentials.claimedBySessionId),
          eq(agentCredentials.claimedBySessionId, input.sessionId),
          lt(agentCredentials.claimExpiresAt, now),
          // The holder is not in a turn: its claim outlived the turn that took it.
          notExists(
            db
              .select({ one: sql`1` })
              .from(sessions)
              .where(
                and(
                  eq(sessions.tenantId, input.tenantId),
                  eq(sessions.id, agentCredentials.claimedBySessionId),
                  inArray(sessions.status, [...CLAIM_HOLDING_SESSION_STATUSES])
                )
              )
          )
        )
      )
    )
    .returning()
  return row ?? null
}

/** Release this session's claim (another session's is left alone). Idempotent. */
export async function release(
  db: Database,
  input: { tenantId: string; id: string; sessionId: string }
): Promise<void> {
  await db
    .update(agentCredentials)
    .set({ claimedBySessionId: null, claimedAt: null, claimExpiresAt: null })
    .where(
      and(
        eq(agentCredentials.tenantId, input.tenantId),
        eq(agentCredentials.id, input.id),
        eq(agentCredentials.claimedBySessionId, input.sessionId)
      )
    )
}

/** Disconnect: delete the person's credential for the runtime. True when there was one. */
export async function removeForUser(
  db: Database,
  tenantId: string,
  userId: string,
  runtime: AgentRuntimeId
): Promise<boolean> {
  const deleted = await db
    .delete(agentCredentials)
    .where(
      and(
        eq(agentCredentials.tenantId, tenantId),
        eq(agentCredentials.userId, userId),
        eq(agentCredentials.runtime, runtime)
      )
    )
    .returning({ id: agentCredentials.id })
  return deleted.length > 0
}

/**
 * The sweep (`logins/sweep.ts`): clear every claim past its expiry — a turn whose Workflow died
 * holding it. CROSS-TENANT by design (a cron; the `unscoped-allowlist` entry); `tenantIds` scopes it
 * (the tests). Returns how many were cleared.
 */
export async function sweepStaleClaims(
  db: Database,
  opts: { now?: Date; tenantIds?: readonly string[] } = {}
): Promise<number> {
  const now = opts.now ?? new Date()
  const cleared = await db
    .update(agentCredentials)
    .set({ claimedBySessionId: null, claimedAt: null, claimExpiresAt: null })
    .where(
      and(
        isNotNull(agentCredentials.claimedBySessionId),
        lt(agentCredentials.claimExpiresAt, now),
        opts.tenantIds ? inArray(agentCredentials.tenantId, [...opts.tenantIds]) : undefined
      )
    )
    .returning({ id: agentCredentials.id })
  return cleared.length
}
