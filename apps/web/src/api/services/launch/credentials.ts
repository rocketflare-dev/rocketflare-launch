/**
 * The sealed credential store (spec/03): the platform credentials Launch acts with — a Cloudflare
 * account token, the Neon org key, a full-access Resend key, the GitHub App — and the non-secret
 * platform settings beside them. The ONLY module that reads `admin_credentials` or
 * `launch_settings`.
 *
 * - **Sealed at rest** with `OAUTH_ENCRYPTION_KEY` (`encryptToken` / `decryptToken`,
 *   `auth/oauth-encryption.ts`). No key → 503 `oauth_encryption_key_missing`, checked at use.
 * - **Values never leave the server.** `getCredential` unseals for a vendor call and is never
 *   handed to a response; `credentialStatus` is what a route returns, and it carries no value.
 * - One row per kind: putting a kind that exists is a ROTATION (`rotatedAt` set), which is how the
 *   caller tells `credential.set` from `credential.rotated` when it audits.
 *
 * Neither table has a tenant, so nothing here takes one; the setup routes are global-admin only.
 */
import {
  CREDENTIAL_KINDS,
  type CredentialCheck,
  type CredentialCheckStatus,
  type CredentialKind,
  type CredentialMetadata,
  type CredentialPayload,
  type CredentialStatus,
  credentialPayloadSchemas,
  type LaunchSettingKey,
} from '@launch/shared/launch-setup'
import { eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { adminCredentials, launchSettings } from '../../../db/schema'
import { decryptToken, encryptToken } from '../../auth/oauth-encryption'

export interface StoredCredential<K extends CredentialKind = CredentialKind> {
  kind: K
  /** The unsealed secret. Server only — never put it in a response or a log line. */
  secret: CredentialPayload<K>
  metadata: CredentialMetadata
  setAt: Date
  rotatedAt: Date | null
}

export interface PutCredentialResult {
  /** True when a credential of this kind already existed and was replaced. */
  rotated: boolean
  setAt: Date
}

/**
 * Validate, seal and store `secretJson` for `kind`, replacing any existing one. The previous
 * check result is cleared: it described the old value. `metadata` is non-secret facts only.
 */
export async function putCredential<K extends CredentialKind>(
  db: Database,
  cfg: AppConfig,
  kind: K,
  secretJson: CredentialPayload<K>,
  metadata: CredentialMetadata,
  userId: string | null
): Promise<PutCredentialResult> {
  const secret = credentialPayloadSchemas[kind].parse(secretJson)
  const sealed = await encryptToken(cfg, JSON.stringify(secret))
  if (!sealed) throw new Error('encryptToken returned nothing for a non-null value')
  const now = new Date()
  const [row] = await db
    .insert(adminCredentials)
    .values({ kind, sealed, metadata, setByUserId: userId, setAt: now })
    .onConflictDoUpdate({
      target: adminCredentials.kind,
      set: {
        sealed,
        metadata,
        setByUserId: userId,
        setAt: now,
        rotatedAt: now,
        lastCheckStatus: null,
        lastCheck: null,
        lastCheckedAt: null,
      },
    })
    .returning({ rotatedAt: adminCredentials.rotatedAt, setAt: adminCredentials.setAt })
  if (!row) throw new Error('admin_credentials upsert returned no row')
  // A fresh insert leaves `rotated_at` NULL; only the conflict branch sets it.
  return { rotated: row.rotatedAt !== null, setAt: row.setAt }
}

/** The unsealed credential for `kind`, or null when none is set. Server only. */
export async function getCredential<K extends CredentialKind>(
  db: Database,
  cfg: AppConfig,
  kind: K
): Promise<StoredCredential<K> | null> {
  const [row] = await db.select().from(adminCredentials).where(eq(adminCredentials.kind, kind))
  if (!row) return null
  const plain = await decryptToken(cfg, row.sealed)
  if (!plain) return null
  const secret = credentialPayloadSchemas[kind].parse(JSON.parse(plain)) as CredentialPayload<K>
  return {
    kind,
    secret,
    metadata: row.metadata,
    setAt: row.setAt,
    rotatedAt: row.rotatedAt,
  }
}

/** Remove the credential for `kind`. Returns whether there was one. */
export async function removeCredential(db: Database, kind: CredentialKind): Promise<boolean> {
  const removed = await db
    .delete(adminCredentials)
    .where(eq(adminCredentials.kind, kind))
    .returning({ id: adminCredentials.id })
  return removed.length > 0
}

/**
 * Every kind, set or not, with when / by whom / how it last checked. **Never a value** — the
 * `sealed` column is not even selected.
 */
export async function credentialStatus(db: Database): Promise<CredentialStatus[]> {
  const rows = await db
    .select({
      kind: adminCredentials.kind,
      metadata: adminCredentials.metadata,
      setAt: adminCredentials.setAt,
      setByUserId: adminCredentials.setByUserId,
      rotatedAt: adminCredentials.rotatedAt,
      lastCheckStatus: adminCredentials.lastCheckStatus,
      lastCheck: adminCredentials.lastCheck,
      lastCheckedAt: adminCredentials.lastCheckedAt,
    })
    .from(adminCredentials)
  const byKind = new Map(rows.map(r => [r.kind, r]))
  return CREDENTIAL_KINDS.map(kind => {
    const row = byKind.get(kind)
    return row
      ? { ...row, set: true }
      : {
          kind,
          set: false,
          setAt: null,
          setByUserId: null,
          rotatedAt: null,
          metadata: {},
          lastCheckStatus: null,
          lastCheck: null,
          lastCheckedAt: null,
        }
  })
}

/** The worst status in a check run: any `failed` fails it, else any `warning` warns. */
export function overallCheckStatus(checks: readonly CredentialCheck[]): CredentialCheckStatus {
  if (checks.some(c => c.status === 'failed')) return 'failed'
  if (checks.some(c => c.status === 'warning')) return 'warning'
  return 'ok'
}

/**
 * Store the result of a vendor probe run against `kind`, optionally merging new non-secret
 * metadata (an installation id the check discovered). Returns the overall status, or null when
 * no credential of that kind is set.
 */
export async function recordCheck(
  db: Database,
  kind: CredentialKind,
  checks: CredentialCheck[],
  metadata?: CredentialMetadata
): Promise<CredentialCheckStatus | null> {
  const status = overallCheckStatus(checks)
  const [existing] = await db
    .select({ metadata: adminCredentials.metadata })
    .from(adminCredentials)
    .where(eq(adminCredentials.kind, kind))
  if (!existing) return null
  await db
    .update(adminCredentials)
    .set({
      lastCheckStatus: status,
      lastCheck: checks,
      lastCheckedAt: new Date(),
      ...(metadata ? { metadata: { ...existing.metadata, ...metadata } } : {}),
    })
    .where(eq(adminCredentials.kind, kind))
  return status
}

/** A platform setting's value, or null when unset. */
export async function getSetting<T = unknown>(
  db: Database,
  key: LaunchSettingKey
): Promise<T | null> {
  const [row] = await db
    .select({ value: launchSettings.value })
    .from(launchSettings)
    .where(eq(launchSettings.key, key))
  return row ? (row.value as T) : null
}

/** Every platform setting that is set, keyed by name. */
export async function getSettings(
  db: Database
): Promise<Partial<Record<LaunchSettingKey, unknown>>> {
  const rows = await db.select().from(launchSettings)
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

/** Set (or replace) a platform setting. `null` removes it. */
export async function putSetting(
  db: Database,
  key: LaunchSettingKey,
  value: unknown,
  userId: string | null
): Promise<void> {
  if (value === null || value === undefined) {
    await db.delete(launchSettings).where(eq(launchSettings.key, key))
    return
  }
  await db
    .insert(launchSettings)
    .values({ key, value, updatedByUserId: userId })
    .onConflictDoUpdate({
      target: launchSettings.key,
      set: { value, updatedByUserId: userId, updatedAt: new Date() },
    })
}
