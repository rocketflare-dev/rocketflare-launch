/**
 * `/api/platform/setup` (spec/03, spec/04) — the setup wizard's API. Mounted under
 * `/api/platform`, so `platformAdminMiddleware` already applies: 401 without a session, 403 unless
 * `canAdministerPlatform` (a global admin, or in single mode the organisation's owner/admin), and
 * never a Bearer key.
 *
 *   GET    /                          every step, settings, credential status, identity — no value
 *   PUT    /settings                  apps domain, account id, Neon org/region, notifications domain, org
 *   PUT    /credentials/:kind         validate → seal → check → audit credential.set | .rotated
 *   POST   /credentials/:kind/check   re-run the probes → audit credential.checked
 *   POST   /public-url/check          probe APP_URL from the internet now → audit public_url.checked
 *
 * The PUT and the check are the only calls that may change something upstream: the Cloudflare
 * check creates the apps zone's proxied `*` record when there is none, audited
 * `dns.wildcard.created` (target the zone) before the credential's own row. `GET /` never probes.
 *   DELETE /credentials/:kind         → audit credential.removed
 *   GET    /template-pin/tags[?repo]  the kit repo's tags (the Kit version card's picker)
 *   PUT    /template-pin              a tag, a commit or Follow latest, resolved through GitHub
 *                                     → setting.changed
 *   POST   /template-pin/check        Follow latest's Check now: move to the newest release if
 *                                     there is a newer one → setting.changed (`by: check_now`)
 *   DELETE /template-pin              back to DEFAULT_TEMPLATE_PIN (the row deleted) → setting.changed
 *   PUT    /session-agents            coding agents: on/off, model, who pays — merged into
 *                                     `session_policy.runtimes` → setting.changed (§18.22)
 *   PUT    /session-sandbox           where new sessions' containers run (`session_sandbox_host`:
 *                                     local | remote, remote in development only) → setting.changed
 *
 * **A value never leaves.** The body of a PUT is sealed by `putCredential` and every response is
 * built from `credentialStatus` (which does not even select the sealed column); audit summaries say
 * `'set'`, never the value.
 *
 * **Audit tenant.** `audit_events` is tenant-scoped and these tables are not, so a row goes to the
 * admin's session tenant (always the case for a single-mode owner/admin, recorded with them as the
 * actor) or, for a global admin with none, the deployment's one tenant
 * (`getSingleTenant`). With neither there is nowhere to record the action, and an action Launch
 * cannot record is refused (409) BEFORE anything is written.
 */
import {
  type CredentialKind,
  credentialKindSchema,
  credentialPayloadSchemas,
  kitTagsQuerySchema,
  sessionAgentsUpdateSchema,
  sessionSandboxUpdateSchema,
  setupSettingsUpdateSchema,
  type TemplatePin,
  templatePinRequestSchema,
} from '@launch/shared/launch-setup'
import { z } from 'zod'
import type { Database } from '../../db/client'
import { auditActor, recordAudit } from '../services/launch/audit'
import {
  getSetting,
  putCredential,
  putSetting,
  removeCredential,
} from '../services/launch/credentials'
import {
  listKitTags,
  recordLatestCheck,
  refreshFollowLatest,
  resolveTemplatePinRequest,
} from '../services/launch/kit-pin'
import { runPublicUrlCheck } from '../services/launch/public-url'
import { updateSessionAgents } from '../services/launch/session-agents'
import {
  type CheckEffect,
  fingerprint,
  runCredentialCheck,
  setupCredential,
  setupOverview,
  updateSettings,
} from '../services/launch/setup'
import { updateSessionSandboxHost } from '../services/sessions/sandbox-host'
import type { AppContext } from '../types'
import { ConflictError, NotFoundError, ValidationError } from '../utils/core/errors'
import { getSingleTenant } from '../utils/db/tenant-helpers'
import { withAuth } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const setupRouter = createRouter()

const kindParamSchema = z.object({ kind: credentialKindSchema })

/** The tenant an audit row for a platform action goes to — see the header. */
async function auditTenant(db: Database, sessionTenantId: string | null): Promise<string> {
  if (sessionTenantId) return sessionTenantId
  const single = await getSingleTenant(db)
  if (!single) {
    throw new ConflictError(
      'There is no organisation to record this in yet. Create one first.',
      'no_audit_tenant'
    )
  }
  return single.id
}

function audit(
  c: AppContext,
  db: Database,
  tenantId: string,
  action: string,
  kind: CredentialKind,
  after: Record<string, unknown>
) {
  return recordAudit(db, {
    tenantId,
    ...auditActor(c),
    action,
    targetType: 'Credential',
    targetId: kind,
    summary: { after },
  })
}

/** One audit row per upstream change a check made (the Cloudflare wildcard). */
async function auditEffects(
  c: AppContext,
  db: Database,
  tenantId: string,
  effects: readonly CheckEffect[]
) {
  for (const effect of effects) {
    await recordAudit(db, {
      tenantId,
      ...auditActor(c),
      action: effect.action,
      targetType: effect.targetType,
      targetId: effect.targetId,
      summary: { after: effect.after },
    })
  }
}

/** The organisation the overview's per-organisation facts are for: the session's, else the one. */
async function overviewTenant(db: Database, sessionTenantId: string | null) {
  return sessionTenantId ?? (await getSingleTenant(db))?.id ?? null
}

setupRouter.get('/', async c => {
  const { db, cfg, tenantId } = withAuth(c)
  return c.json(await setupOverview(db, cfg, await overviewTenant(db, tenantId), c.env))
})

setupRouter.put('/settings', validate('json', setupSettingsUpdateSchema), async c => {
  const { db, cfg, user, tenantId } = withAuth(c)
  const auditTenantId = await auditTenant(db, tenantId)
  const changed = await updateSettings(db, c.req.valid('json'), user.id)
  const keys = Object.keys(changed)
  if (keys.length > 0) {
    await recordAudit(db, {
      tenantId: auditTenantId,
      ...auditActor(c),
      action: 'setting.changed',
      targetType: 'Setting',
      targetId: keys.join(','),
      summary: {
        before: Object.fromEntries(keys.map(k => [k, changed[k]?.before ?? null])),
        after: Object.fromEntries(keys.map(k => [k, changed[k]?.after ?? null])),
      },
    })
  }
  return c.json(await setupOverview(db, cfg, auditTenantId, c.env))
})

setupRouter.put('/credentials/:kind', validate('param', kindParamSchema), async c => {
  const { db, cfg, user, tenantId } = withAuth(c)
  const { kind } = c.req.valid('param')
  const parsed = credentialPayloadSchemas[kind].safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw new ValidationError(parsed.error.issues, 'Invalid json')
  const auditTenantId = await auditTenant(db, tenantId)

  const secret = parsed.data
  const metadata = {
    fingerprint: await fingerprint(secret),
    ...(kind === 'github_app' ? { appId: (secret as { appId: string }).appId } : {}),
  }
  const { rotated } = await putCredential(db, cfg, kind, secret, metadata, user.id)
  const { status, checks, effects } = await runCredentialCheck(db, cfg, kind, user.id)
  await auditEffects(c, db, auditTenantId, effects)
  await audit(c, db, auditTenantId, rotated ? 'credential.rotated' : 'credential.set', kind, {
    value: rotated ? 'rotated' : 'set',
    fingerprint: metadata.fingerprint,
    checkStatus: status,
  })
  return c.json({ credential: await setupCredential(db, kind), status, checks })
})

setupRouter.post('/credentials/:kind/check', validate('param', kindParamSchema), async c => {
  const { db, cfg, user, tenantId } = withAuth(c)
  const { kind } = c.req.valid('param')
  const auditTenantId = await auditTenant(db, tenantId)
  const { status, checks, effects } = await runCredentialCheck(db, cfg, kind, user.id)
  await auditEffects(c, db, auditTenantId, effects)
  await audit(c, db, auditTenantId, 'credential.checked', kind, {
    checkStatus: status,
    failed: checks.filter(ch => ch.status === 'failed').map(ch => ch.id),
  })
  return c.json({ credential: await setupCredential(db, kind), status, checks })
})

setupRouter.post('/public-url/check', async c => {
  const { db, cfg, user, tenantId } = withAuth(c)
  const auditTenantId = await auditTenant(db, tenantId)
  const result = await runPublicUrlCheck(db, cfg, user.id)
  await recordAudit(db, {
    tenantId: auditTenantId,
    ...auditActor(c),
    action: 'public_url.checked',
    targetType: 'Setting',
    targetId: 'public_url_check',
    summary: {
      after: {
        url: result.url,
        checkStatus: result.status,
        failed: result.checks.filter(ch => ch.status === 'failed').map(ch => ch.id),
      },
    },
  })
  return c.json(result)
})

setupRouter.delete('/credentials/:kind', validate('param', kindParamSchema), async c => {
  const { db, tenantId } = withAuth(c)
  const { kind } = c.req.valid('param')
  const auditTenantId = await auditTenant(db, tenantId)
  if (!(await removeCredential(db, kind))) {
    throw new NotFoundError(`No ${kind} credential is set`, 'credential_not_set')
  }
  await audit(c, db, auditTenantId, 'credential.removed', kind, { value: 'removed' })
  return c.json({ removed: true as const })
})

// ---- the kit pin (`launch_settings.template_pin`) ------------------------------------------------

setupRouter.get('/template-pin/tags', validate('query', kitTagsQuerySchema), async c => {
  const { db, cfg } = withAuth(c)
  return c.json(await listKitTags(db, cfg, c.req.valid('query').repo))
})

/** A pin change (or reset) is `setting.changed`, before and after — a pin is never a secret. */
async function auditPinChange(
  c: AppContext,
  db: Database,
  tenantId: string,
  before: unknown,
  after: TemplatePin | null
) {
  await recordAudit(db, {
    tenantId,
    ...auditActor(c),
    action: 'setting.changed',
    targetType: 'Setting',
    targetId: 'template_pin',
    summary: { before: { template_pin: before ?? null }, after: { template_pin: after } },
  })
}

setupRouter.put('/template-pin', validate('json', templatePinRequestSchema), async c => {
  const { db, cfg, user, tenantId } = withAuth(c)
  const auditTenantId = await auditTenant(db, tenantId)
  const pin = await resolveTemplatePinRequest(db, cfg, c.req.valid('json'))
  const before = await getSetting(db, 'template_pin')
  await putSetting(db, 'template_pin', pin, user.id)
  // Follow latest just looked the newest release up: that is the card's "Checked" from now.
  if (pin.follow === 'latest') {
    await recordLatestCheck(db, { repo: pin.repo, latest: pin.tag ?? null, error: null })
  }
  await auditPinChange(c, db, auditTenantId, before, pin)
  return c.json(await setupOverview(db, cfg, auditTenantId, c.env))
})

/**
 * Check now: the cron's refresh, on demand. 409 `template_pin_not_following` unless the pin
 * follows latest; a GitHub failure is 502 `github_lookup_failed` (recorded on the check, too).
 */
setupRouter.post('/template-pin/check', async c => {
  const { db, cfg, tenantId } = withAuth(c)
  const auditTenantId = await auditTenant(db, tenantId)
  const result = await refreshFollowLatest(db, cfg, {
    auditTenantId,
    actor: auditActor(c),
    by: 'check_now',
  })
  if (result.status === 'not_following') {
    throw new ConflictError(
      'The kit pin does not follow the latest release: choose Follow latest first',
      'template_pin_not_following'
    )
  }
  return c.json(await setupOverview(db, cfg, auditTenantId, c.env))
})

/** Reset to the code default: the row is deleted, so the default moves with Launch again. */
setupRouter.delete('/template-pin', async c => {
  const { db, cfg, tenantId } = withAuth(c)
  const auditTenantId = await auditTenant(db, tenantId)
  const before = await getSetting(db, 'template_pin')
  if (before !== null) {
    await putSetting(db, 'template_pin', null, null)
    await auditPinChange(c, db, auditTenantId, before, null)
  }
  return c.json(await setupOverview(db, cfg, auditTenantId, c.env))
})

// ---- coding agents (`launch_settings.session_policy.runtimes`, §18.22) ---------------------------

/**
 * Merge per-agent settings into the session policy (its budgets and limits kept) →
 * `setting.changed` with the effective before and after. 409 `session_agents_none_enabled` when
 * nothing would be left on. New sessions only: every session froze its policy at create.
 */
setupRouter.put('/session-agents', validate('json', sessionAgentsUpdateSchema), async c => {
  const { db, cfg, user, tenantId } = withAuth(c)
  const auditTenantId = await auditTenant(db, tenantId)
  const change = await updateSessionAgents(db, c.req.valid('json'), user.id)
  if (change) {
    await recordAudit(db, {
      tenantId: auditTenantId,
      ...auditActor(c),
      action: 'setting.changed',
      targetType: 'Setting',
      targetId: 'session_policy.runtimes',
      summary: { before: { runtimes: change.before }, after: { runtimes: change.after } },
    })
  }
  return c.json(await setupOverview(db, cfg, auditTenantId, c.env))
})

// ---- the session sandbox (`launch_settings.session_sandbox_host`) --------------------------------

/**
 * Where NEW sessions' containers run → `setting.changed`. 409 `session_sandbox_unavailable` when
 * the choice cannot run one on this Worker now (deployed, `remote` never can; under `pnpm dev`,
 * a missing binding or Docker). Running sessions keep the host they started on.
 */
setupRouter.put('/session-sandbox', validate('json', sessionSandboxUpdateSchema), async c => {
  const { db, cfg, user, tenantId } = withAuth(c)
  const auditTenantId = await auditTenant(db, tenantId)
  const change = await updateSessionSandboxHost(db, c.env, cfg, c.req.valid('json').host, user.id)
  if (change) {
    await recordAudit(db, {
      tenantId: auditTenantId,
      ...auditActor(c),
      action: 'setting.changed',
      targetType: 'Setting',
      targetId: 'session_sandbox_host',
      summary: { before: { host: change.before }, after: { host: change.after } },
    })
  }
  return c.json(await setupOverview(db, cfg, auditTenantId, c.env))
})
