/**
 * `pnpm provision setup` — the Setup page's settings and credentials, written by script into the
 * instance's own database so the operator never pastes a token into a browser (and no value ever
 * passes through a chat). It does exactly what `PUT /api/platform/setup/settings` and
 * `PUT /api/platform/setup/credentials/:kind` do (`src/api/routes/setup.ts`), through the same
 * services:
 *
 *   - settings → `updateSettings` (only the keys that change), audited `setting.changed` with
 *     before and after — settings are never secret
 *   - credentials → `putCredential` (validated by the kind's schema and SEALED with the instance's
 *     `OAUTH_ENCRYPTION_KEY`), audited `credential.set` / `credential.rotated` with the fingerprint,
 *     never the value
 *
 * Every audit row goes through `recordAudit`, so the P4 hash chain (`audit_chain`, appended by the
 * database on insert) holds exactly as it does for a click. The actor is `system` with the user
 * agent `launch-provision` — the script is not the admin, and the log says so.
 *
 * Two differences from the routes, both deliberate:
 *
 *   - **An unchanged credential is not rewritten.** The route always rotates (a person pressed
 *     Save); a rerun of `pnpm provision all` is how an instance is UPDATED, and re-sealing an
 *     identical token would clear its check results and log a rotation that did not happen. The
 *     stored fingerprint decides: same fingerprint → `unchanged`, different → `credential.rotated`.
 *   - **The checks are not run.** They reach every vendor and the Cloudflare one may create the
 *     wildcard record; the operator presses Check on each card after signing in (the runbook's
 *     step), which is also the proof the Worker can unseal what this sealed.
 *
 * The audit log is per organisation and a fresh instance has none until its owner signs in. So
 * when there is no tenant yet, this creates it the way the seed does — named after APP_NAME, slug
 * `default`, with the first `LAUNCH_ADMIN_EMAILS` address as its owner (an unverified user row
 * until they sign in; `admitBootstrapAdmin` makes them a global admin on that first verified
 * login, and keeps them the owner).
 */
import {
  type CredentialKind,
  type CredentialPayload,
  credentialPayloadSchemas,
  type SetupSettingsUpdate,
  setupSettingsUpdateSchema,
} from '@launch/shared/launch-setup'
import { sql } from 'drizzle-orm'
import { nameFromEmail } from '../../src/api/services/auth'
import { type AuditActor, recordAudit, SYSTEM_ACTOR } from '../../src/api/services/launch/audit'
import { credentialStatus, putCredential } from '../../src/api/services/launch/credentials'
import { fingerprint, updateSettings } from '../../src/api/services/launch/setup'
import { createTenantForUser, getSingleTenant } from '../../src/api/utils/db/tenant-helpers'
import type { AppConfig } from '../../src/config'
import type { Database } from '../../src/db/client'
import { users } from '../../src/db/schema'

export const PROVISION_ACTOR: Readonly<AuditActor> = Object.freeze({
  ...SYSTEM_ACTOR,
  userAgent: 'launch-provision',
})

export interface InstanceSetupInput {
  settings: SetupSettingsUpdate
  /** Only the kinds the instance file has values for; each is validated by its schema. */
  credentials: Partial<{ [K in CredentialKind]: CredentialPayload<K> }>
  /** For a fresh instance: the organisation's name and its owner (the first admin email). */
  tenantName: string
  ownerEmail: string
  /**
   * Re-seal every credential even when its fingerprint matches — after `secrets --rotate` the
   * stored rows are sealed with a key the Worker no longer has.
   */
  force?: boolean
}

export type CredentialOutcome = 'set' | 'rotated' | 'unchanged'

export interface InstanceSetupResult {
  tenantId: string
  tenantCreated: boolean
  settingsChanged: string[]
  credentials: Partial<Record<CredentialKind, CredentialOutcome>>
}

/** The organisation audit rows go to: the one there is, else created with its owner. */
async function auditTenant(
  db: Database,
  input: Pick<InstanceSetupInput, 'tenantName' | 'ownerEmail'>
): Promise<{ id: string; created: boolean }> {
  const single = await getSingleTenant(db)
  if (single) return { id: single.id, created: false }
  const email = input.ownerEmail.toLowerCase()
  let owner = await db.query.users.findFirst({
    where: sql`lower(${users.email}) = ${email}`,
  })
  if (!owner) {
    const [created] = await db
      .insert(users)
      .values({ email, name: nameFromEmail(email) })
      .returning()
    if (!created) throw new Error(`setup: could not create the owner ${email}`)
    owner = created
  }
  const tenant = await createTenantForUser(db, {
    name: input.tenantName,
    slug: 'default',
    userId: owner.id,
    role: 'owner',
  })
  return { id: tenant.id, created: true }
}

export async function writeInstanceSetup(
  db: Database,
  cfg: AppConfig,
  input: InstanceSetupInput
): Promise<InstanceSetupResult> {
  if (!cfg.OAUTH_ENCRYPTION_KEY)
    throw new Error('OAUTH_ENCRYPTION_KEY is required to seal credentials (run `secrets` first)')
  const settings = setupSettingsUpdateSchema.parse(input.settings)
  // Validate every payload before anything is written: a bad one stops the phase whole.
  const payloads = Object.entries(input.credentials).map(([kind, value]) => {
    const parsed = credentialPayloadSchemas[kind as CredentialKind].safeParse(value)
    if (!parsed.success)
      throw new Error(
        `${kind}: ${parsed.error.issues.map(i => i.message).join('; ')} (the value is not shown)`
      )
    return [kind as CredentialKind, parsed.data] as const
  })

  const tenant = await auditTenant(db, input)

  const changed = await updateSettings(db, settings, null)
  const keys = Object.keys(changed)
  if (keys.length > 0) {
    await recordAudit(db, {
      tenantId: tenant.id,
      ...PROVISION_ACTOR,
      action: 'setting.changed',
      targetType: 'Setting',
      targetId: keys.join(','),
      summary: {
        before: Object.fromEntries(keys.map(k => [k, changed[k]?.before ?? null])),
        after: Object.fromEntries(keys.map(k => [k, changed[k]?.after ?? null])),
      },
    })
  }

  const outcomes: InstanceSetupResult['credentials'] = {}
  // Through the credentials module (the one reader of `admin_credentials`): metadata, no value.
  const stored = new Map((await credentialStatus(db)).map(c => [c.kind, c]))
  for (const [kind, secret] of payloads) {
    const print = await fingerprint(secret)
    const row = stored.get(kind)
    if (row?.set && row.metadata.fingerprint === print && !input.force) {
      outcomes[kind] = 'unchanged'
      continue
    }
    const metadata = {
      fingerprint: print,
      source: 'provision',
      ...(kind === 'github_app' ? { appId: (secret as { appId: string }).appId } : {}),
    }
    const { rotated } = await putCredential(db, cfg, kind, secret as never, metadata, null)
    await recordAudit(db, {
      tenantId: tenant.id,
      ...PROVISION_ACTOR,
      action: rotated ? 'credential.rotated' : 'credential.set',
      targetType: 'Credential',
      targetId: kind,
      summary: { after: { value: rotated ? 'rotated' : 'set', fingerprint: print } },
    })
    outcomes[kind] = rotated ? 'rotated' : 'set'
  }

  return {
    tenantId: tenant.id,
    tenantCreated: tenant.created,
    settingsChanged: keys,
    credentials: outcomes,
  }
}
