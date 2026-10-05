/**
 * Kit upgrades for one app (P6 slice 6c, the single-app half — `docs/plans/p6-fleet.md` §1 items
 * 1–6, `docs/CONCEPTS.md` §18.27). The ONE module that writes `app_upgrades`:
 *
 * - **"Requires upgrade" is read, not stored** ({@link kitStatusOf}): `apps.template_version`
 *   semver-below the template pin's tag (`kit-pin.ts`, read once per request). Moving the pin is
 *   what "the kit bumped" means, so it flags every app behind it at once, with no cron.
 * - **Starting one** ({@link startAppUpgrade}, `POST /api/apps/:id/upgrade`): the refusals, then a
 *   `running` row and a coding session of kind `upgrade` whose first message is the adapter's
 *   `upgradePrompt`, with `auto_ship` set. A refusal of the session itself (the limit, the budget,
 *   drained sessions…) passes through unchanged, and the row is removed: nothing started.
 * - **Moving it along from the session** — each called where the session writes the state it
 *   follows from: {@link decideAutoShip} after the first turn (`sessions/steps.ts` `turnStep`),
 *   {@link upgradeNeedsAttention} when a ship settles without a PR (`ship-steps.ts`),
 *   {@link upgradePrOpened} when the PR opens (`ship.ts`), and {@link settleUpgradeAtCleanup} when
 *   the session is cleaned up (failed → `failed`, ended without a PR → `cancelled`).
 * - **Recording the new version** ({@link recordKitVersionAtRelease}): every Release re-reads
 *   `.rocketflare.json` at its tag, updates `template_version` / `template_commit` (audit
 *   `app.kit_version_changed`) and settles an open upgrade the version now reaches as `released`.
 *   An upgrade done outside Launch is recorded the same way, at its first Release.
 *
 * Every status write is a compare-and-set on the statuses it may move from, so a late writer never
 * moves a settled upgrade back. Every query names the tenant.
 */
import {
  type AppUpgrade,
  type AppUpgradeStatus,
  type KitStatus,
  kitUpgradeNotesUrl,
  kitVersionBehind,
  kitVersionOf,
  kitVersionReached,
  OPEN_APP_UPGRADE_STATUSES,
  UPGRADE_ERROR_CODES,
  type UpgradeResult,
  upgradeResultOf,
} from '@launch/shared/launch-upgrades'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import {
  type AppRow,
  type AppUpgradeRow,
  apps,
  appUpgrades,
  type SessionRow,
} from '../../../db/schema'
import type { AppBindings } from '../../types'
import { ConflictError, isUniqueViolation } from '../../utils/core/errors'
import { nudge, type Realtime, realtimeEvent } from '../realtime'
import { createSession } from '../sessions/lifecycle'
import { type AuditActor, recordAudit, SYSTEM_ACTOR } from './audit'
import { ensureAppGateVariable, type GateVariableWrite } from './gate-variable'
import { getRepoFile } from './github-app'
import { templatePinStatus } from './kit-pin'
import { withRepoToken } from './releases/github'
import { rocketflareAdapter } from './rocketflare/adapter'
import { MANIFEST_PATHS, ManifestError, parseManifest } from './rocketflare-manifest'

const OPEN = [...OPEN_APP_UPGRADE_STATUSES] as AppUpgradeStatus[]

// ---- reads ---------------------------------------------------------------------------------------

export function toAppUpgrade(row: AppUpgradeRow): AppUpgrade {
  return {
    id: row.id,
    appId: row.appId,
    targetKind: row.targetKind,
    pluginId: row.pluginId,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    status: row.status,
    sessionId: row.sessionId,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    error: row.error,
    requestedByUserId: row.requestedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** What the template pin targets: its tag as `X.Y.Z` (null for a commit pin) and the notes URL. */
export interface KitTarget {
  version: string | null
  notesUrl: string | null
}

/** The version the template pin names, read once per request (`kit-pin.ts`). */
export async function kitTarget(db: Database): Promise<KitTarget> {
  const { pin } = await templatePinStatus(db)
  const version = kitVersionOf(pin.tag ?? null)
  return {
    version,
    notesUrl: version && pin.tag ? kitUpgradeNotesUrl(pin.repo, pin.tag) : null,
  }
}

/** The kit status an app summary carries. Pure. */
export function kitStatusOf(
  app: Pick<AppRow, 'templateVersion'>,
  target: KitTarget,
  open: AppUpgradeRow | null
): KitStatus {
  return {
    current: app.templateVersion,
    target: target.version,
    behind: kitVersionBehind(app.templateVersion, target.version),
    openUpgrade: open ? toAppUpgrade(open) : null,
    notesUrl: target.notesUrl,
  }
}

/** Each app's open kit upgrade, by app id — one query for a whole catalogue. */
export async function openUpgradesByApp(
  db: Database,
  tenantId: string,
  appIds: readonly string[]
): Promise<Map<string, AppUpgradeRow>> {
  const byApp = new Map<string, AppUpgradeRow>()
  if (appIds.length === 0) return byApp
  const rows = await db
    .select()
    .from(appUpgrades)
    .where(
      and(
        eq(appUpgrades.tenantId, tenantId),
        inArray(appUpgrades.appId, [...appIds]),
        eq(appUpgrades.targetKind, 'kit'),
        inArray(appUpgrades.status, OPEN)
      )
    )
  for (const row of rows) byApp.set(row.appId, row)
  return byApp
}

/** The kit status of each app, by id: the pin read once, the open upgrades in one query. */
export async function kitStatuses(
  db: Database,
  tenantId: string,
  list: readonly Pick<AppRow, 'id' | 'templateVersion'>[]
): Promise<Map<string, KitStatus>> {
  const [target, open] = await Promise.all([
    kitTarget(db),
    openUpgradesByApp(
      db,
      tenantId,
      list.map(a => a.id)
    ),
  ])
  return new Map(list.map(app => [app.id, kitStatusOf(app, target, open.get(app.id) ?? null)]))
}

/** An app's upgrades, newest first (`GET /api/apps/:id/upgrades`). */
export async function listAppUpgrades(
  db: Database,
  tenantId: string,
  appId: string
): Promise<AppUpgradeRow[]> {
  return db
    .select()
    .from(appUpgrades)
    .where(and(eq(appUpgrades.tenantId, tenantId), eq(appUpgrades.appId, appId)))
    .orderBy(desc(appUpgrades.createdAt))
    .limit(50)
}

async function loadUpgrade(
  db: Database,
  tenantId: string,
  upgradeId: string
): Promise<AppUpgradeRow | null> {
  const [row] = await db
    .select()
    .from(appUpgrades)
    .where(and(eq(appUpgrades.tenantId, tenantId), eq(appUpgrades.id, upgradeId)))
    .limit(1)
  return row ?? null
}

/** `entity.changed { entity: 'apps' }` — the catalogue and the app page re-read the kit status. */
function nudgeApp(realtime: Realtime | undefined, tenantId: string, appId: string): void {
  nudge(realtime, realtimeEvent('entity.changed', tenantId, { entity: 'apps', id: appId }))
}

/**
 * Move an upgrade to `to` — a compare-and-set on `from` — and audit `action` when it moved. Null
 * when it was not in one of `from` (another writer settled it first).
 */
async function moveUpgrade(
  db: Database,
  input: {
    tenantId: string
    upgradeId: string
    from: readonly AppUpgradeStatus[]
    to: AppUpgradeStatus
    set?: Partial<Pick<AppUpgradeRow, 'prNumber' | 'prUrl' | 'error'>>
    action: string
    actor?: AuditActor
    summary?: Record<string, unknown>
    realtime?: Realtime
  }
): Promise<AppUpgradeRow | null> {
  const [row] = await db
    .update(appUpgrades)
    .set({ ...input.set, status: input.to })
    .where(
      and(
        eq(appUpgrades.tenantId, input.tenantId),
        eq(appUpgrades.id, input.upgradeId),
        inArray(appUpgrades.status, [...input.from])
      )
    )
    .returning()
  if (!row) return null
  await recordAudit(db, {
    ...(input.actor ?? SYSTEM_ACTOR),
    tenantId: input.tenantId,
    action: input.action,
    targetType: 'app_upgrade',
    targetId: row.id,
    appId: row.appId,
    summary: {
      after: {
        status: row.status,
        fromVersion: row.fromVersion,
        toVersion: row.toVersion,
        sessionId: row.sessionId,
        ...input.summary,
      },
    },
  })
  nudgeApp(input.realtime, input.tenantId, row.appId)
  return row
}

// ---- start ---------------------------------------------------------------------------------------

export interface StartAppUpgradeInput {
  tenantId: string
  app: AppRow
  userId: string
  actor: AuditActor
  realtime?: Realtime
  cfg?: AppConfig
}

/**
 * `POST /api/apps/:id/upgrade`: refuse an archived app (409 `app_archived`), one with no repository
 * (409 `app_has_no_repo`), a commit pin (409 `upgrade_no_pin_tag`), an app not behind the pin (409
 * `upgrade_not_behind`) and an app with an upgrade open (409 `upgrade_open`); then a `running`
 * row, the session (kind `upgrade`, auto-ship, the adapter's prompt as its first turn) and audit
 * `app.upgrade.started`.
 *
 * Issue #10: once the session exists, the repo's `LAUNCH_GATE_APP_ID` variable is set (when it
 * differs) — the upgrade may be the one bringing in the kit's `verified` job, and its PR's CI reads
 * it. Best-effort: a refusal is recorded in the audit row (`gateVariable: 'failed'`), never fatal.
 */
export async function startAppUpgrade(
  db: Database,
  env: AppBindings,
  input: StartAppUpgradeInput
): Promise<{ upgrade: AppUpgradeRow; session: SessionRow }> {
  const { tenantId, app } = input
  if (app.status === 'archived') {
    throw new ConflictError('An archived app cannot be upgraded', 'app_archived')
  }
  if (!app.repoOwner || !app.repoName) {
    throw new ConflictError('This app has no repository to upgrade', 'app_has_no_repo')
  }
  const { pin } = await templatePinStatus(db)
  const target = kitVersionOf(pin.tag ?? null)
  if (!target) {
    throw new ConflictError(
      'The template pin is an unreleased commit, so there is no kit version to upgrade to. Pin a release in Setup first.',
      UPGRADE_ERROR_CODES.noPinTag
    )
  }
  if (!kitVersionBehind(app.templateVersion, target)) {
    throw new ConflictError(
      `This app's kit (${app.templateVersion ?? 'unknown'}) is not behind the pinned ${target}`,
      UPGRADE_ERROR_CODES.notBehind,
      { current: app.templateVersion, target }
    )
  }
  const open = (await openUpgradesByApp(db, tenantId, [app.id])).get(app.id)
  if (open) throw upgradeOpen(open)

  const from = app.templateVersion
  let upgrade: AppUpgradeRow | undefined
  try {
    ;[upgrade] = await db
      .insert(appUpgrades)
      .values({
        tenantId,
        appId: app.id,
        targetKind: 'kit',
        fromVersion: from,
        toVersion: target,
        status: 'running',
        requestedByUserId: input.userId,
      })
      .returning()
  } catch (err) {
    // Two clicks at once: the partial unique index lets one through.
    if (!isUniqueViolation(err)) throw err
    const raced = (await openUpgradesByApp(db, tenantId, [app.id])).get(app.id)
    throw raced ? upgradeOpen(raced) : err
  }
  if (!upgrade) throw new Error('app_upgrades insert returned no row')

  const prompt = { from, to: target }
  let session: SessionRow
  try {
    session = await createSession(db, env, {
      tenantId,
      app,
      userId: input.userId,
      request: { title: rocketflareAdapter.upgradeTitle(prompt) },
      actor: input.actor,
      realtime: input.realtime,
      firstMessage: rocketflareAdapter.upgradePrompt(prompt),
      upgrade: { upgradeId: upgrade.id, autoShip: true },
      ...(input.cfg ? { cfg: input.cfg } : {}),
    })
  } catch (err) {
    // The session was refused (or never started): no upgrade began, so there is nothing to keep.
    await db
      .delete(appUpgrades)
      .where(and(eq(appUpgrades.tenantId, tenantId), eq(appUpgrades.id, upgrade.id)))
    throw err
  }
  const [linked] = await db
    .update(appUpgrades)
    .set({ sessionId: session.id })
    .where(and(eq(appUpgrades.tenantId, tenantId), eq(appUpgrades.id, upgrade.id)))
    .returning()
  let gateVariable: GateVariableWrite | 'failed' | 'skipped' = 'skipped'
  if (input.cfg) {
    gateVariable = await ensureAppGateVariable(db, input.cfg, app).catch(() => 'failed' as const)
  }
  await recordAudit(db, {
    ...input.actor,
    tenantId,
    action: 'app.upgrade.started',
    targetType: 'app_upgrade',
    targetId: upgrade.id,
    appId: app.id,
    summary: {
      after: { fromVersion: from, toVersion: target, sessionId: session.id, gateVariable },
    },
  })
  nudgeApp(input.realtime, tenantId, app.id)
  return { upgrade: linked ?? upgrade, session }
}

function upgradeOpen(open: AppUpgradeRow): ConflictError {
  return new ConflictError(
    `This app already has an upgrade to ${open.toVersion} in progress`,
    UPGRADE_ERROR_CODES.open,
    { upgradeId: open.id, status: open.status, sessionId: open.sessionId }
  )
}

// ---- auto-ship -----------------------------------------------------------------------------------

/** What the first turn of an upgrade session came to, as auto-ship reads it. */
export interface UpgradeTurnEvidence {
  /** The turn's outcome status (`completed`, `failed`, `interrupted`, `rejected`, `blocked`). */
  status: string
  /** The agent's `result` line: its subtype, error flag and the end of its final answer. */
  result?: { subtype: string; isError: boolean; tail: string | null }
  /** The workspace differs from the last checkpoint (undefined: not measured). */
  changed?: boolean
  /** The turn called `AskUserQuestion` (it stopped to ask, whatever it said after). */
  askedQuestion: boolean
  /** `.rocketflare.json`'s `kit.version` in the checkout after the turn; null when unreadable. */
  manifestVersion: string | null
}

export type AutoShipVerdict = { ship: true } | { ship: false; reason: string }

/**
 * Did the upgrade's first turn end CLEANLY — ship it — or does it need its owner? Pure. Every one
 * of these must hold, each the positive evidence of a finished upgrade rather than the absence of
 * a failure:
 *
 * 1. the turn completed with a `success` result that is not flagged an error (not failed, stopped,
 *    timed out, over budget or out of turns);
 * 2. it did not call `AskUserQuestion`, and its final answer ends `LAUNCH-UPGRADE: DONE` — a turn
 *    that ends asking a question, or explaining why it stopped, does not (`upgradeResultOf`);
 * 3. the workspace changed;
 * 4. the checkout's `.rocketflare.json` says the target version — the upgrade script writes it
 *    last, and only after a clean apply, so this is the checkout's own word, not the agent's.
 */
export function autoShipVerdict(evidence: UpgradeTurnEvidence, toVersion: string): AutoShipVerdict {
  const notClean = (reason: string): AutoShipVerdict => ({ ship: false, reason })
  if (evidence.status !== 'completed' || !evidence.result) {
    return notClean('The upgrade turn did not run to its end.')
  }
  if (evidence.result.isError || evidence.result.subtype !== 'success') {
    return notClean(`The upgrade turn ended with ${evidence.result.subtype}.`)
  }
  const said: UpgradeResult | null = upgradeResultOf(evidence.result.tail)
  if (evidence.askedQuestion || said !== 'DONE') {
    return notClean('The upgrade stopped to ask or explain something.')
  }
  if (evidence.changed !== true) return notClean('The upgrade changed nothing in the app.')
  if (!kitVersionReached(evidence.manifestVersion, toVersion)) {
    return notClean(
      `.rocketflare.json says kit ${evidence.manifestVersion ?? '(unreadable)'}, not ${toVersion}.`
    )
  }
  return { ship: true }
}

/** The sentence the session and the app page show when an upgrade needs its owner. */
export function needsAttentionMessage(reason: string): string {
  return `Launch did not ship this upgrade: ${reason} Read the last answer, finish the upgrade here, then ship it.`
}

/**
 * Mark the session's upgrade `needs_attention` (from `running`) with `reason`. Used after a first
 * turn that did not end cleanly and after a ship that settled without a PR.
 */
export async function upgradeNeedsAttention(
  db: Database,
  session: Pick<SessionRow, 'tenantId' | 'upgradeId'>,
  reason: string,
  realtime?: Realtime
): Promise<AppUpgradeRow | null> {
  if (!session.upgradeId) return null
  return moveUpgrade(db, {
    tenantId: session.tenantId,
    upgradeId: session.upgradeId,
    from: ['running'],
    to: 'needs_attention',
    set: { error: reason },
    action: 'app.upgrade.needs_attention',
    summary: { reason },
    realtime,
  })
}

/** The upgrade a session is doing, when it is still waiting on the first turn's decision. */
export async function upgradeAwaitingAutoShip(
  db: Database,
  session: Pick<SessionRow, 'tenantId' | 'upgradeId' | 'autoShip'>
): Promise<AppUpgradeRow | null> {
  if (!session.autoShip || !session.upgradeId) return null
  const row = await loadUpgrade(db, session.tenantId, session.upgradeId)
  return row && row.status === 'running' ? row : null
}

// ---- following the session -----------------------------------------------------------------------

/** The PR opened (`ship.pr`): `running` / `needs_attention` → `pr_open`, audit `app.upgrade.pr_opened`. */
export async function upgradePrOpened(
  db: Database,
  session: Pick<SessionRow, 'tenantId' | 'upgradeId'>,
  pr: { number: number; url: string },
  realtime?: Realtime
): Promise<AppUpgradeRow | null> {
  if (!session.upgradeId) return null
  return moveUpgrade(db, {
    tenantId: session.tenantId,
    upgradeId: session.upgradeId,
    from: ['running', 'needs_attention'],
    to: 'pr_open',
    set: { prNumber: pr.number, prUrl: pr.url, error: null },
    action: 'app.upgrade.pr_opened',
    summary: { prNumber: pr.number, prUrl: pr.url },
    realtime,
  })
}

/**
 * The session was cleaned up (`cleanup`, its one settling step): one that shipped has its PR
 * recorded (already `pr_open`, normally); one that failed fails the upgrade; one that ended without
 * a PR cancels it. A `pr_open` or `released` upgrade is left as it is — the PR outlives the session.
 */
export async function settleUpgradeAtCleanup(
  db: Database,
  session: Pick<SessionRow, 'tenantId' | 'upgradeId' | 'status' | 'prNumber' | 'prUrl' | 'error'>,
  realtime?: Realtime
): Promise<AppUpgradeRow | null> {
  if (!session.upgradeId) return null
  if (session.prNumber && session.prUrl) {
    return upgradePrOpened(db, session, { number: session.prNumber, url: session.prUrl }, realtime)
  }
  const failed = session.status === 'failed'
  return moveUpgrade(db, {
    tenantId: session.tenantId,
    upgradeId: session.upgradeId,
    from: ['queued', 'running', 'needs_attention'],
    to: failed ? 'failed' : 'cancelled',
    set: {
      error: failed
        ? (session.error ?? 'The upgrade session failed')
        : 'The upgrade session ended without a pull request',
    },
    action: failed ? 'app.upgrade.failed' : 'app.upgrade.cancelled',
    realtime,
  })
}

// ---- recording the version at a Release -----------------------------------------------------------

export interface KitVersionDeps {
  db: Database
  cfg: AppConfig
  fetch?: typeof fetch
  realtime?: Realtime
}

/**
 * At a Release (`releases/release.ts`, beside the config scan): read `.rocketflare.json` AT THE TAG,
 * and when its kit differs from the app's record, update `template_version` / `template_commit`
 * and audit `app.kit_version_changed`; then settle every open kit upgrade the recorded version now
 * reaches as `released` (audit `app.upgrade.released`). A repo with no readable manifest changes
 * nothing. Throws on a GitHub failure — the caller never lets that fail the Release.
 */
export async function recordKitVersionAtRelease(
  deps: KitVersionDeps,
  input: { tenantId: string; app: AppRow; tag: string }
): Promise<{ version: string | null; changed: boolean; released: number }> {
  const { db } = deps
  const { tenantId, app, tag } = input
  const text = await withRepoToken(
    db,
    deps.cfg,
    app,
    { contents: 'read' },
    (token, { owner, repo }) =>
      getRepoFile(token, owner, repo, MANIFEST_PATHS[0], tag, { fetch: deps.fetch }),
    { fetch: deps.fetch }
  )
  if (text === null) return { version: null, changed: false, released: 0 }
  let identity: ReturnType<typeof parseManifest>
  try {
    identity = parseManifest(text, MANIFEST_PATHS[0])
  } catch (err) {
    if (err instanceof ManifestError) return { version: null, changed: false, released: 0 }
    throw err
  }
  const version = identity.kitVersion
  if (!version) return { version: null, changed: false, released: 0 }

  const commit = identity.kitCommit ?? app.templateCommit
  const changed = version !== app.templateVersion || commit !== app.templateCommit
  if (changed) {
    await db
      .update(apps)
      .set({ templateVersion: version, templateCommit: commit })
      .where(and(eq(apps.tenantId, tenantId), eq(apps.id, app.id)))
    if (version !== app.templateVersion) {
      await recordAudit(db, {
        ...SYSTEM_ACTOR,
        tenantId,
        action: 'app.kit_version_changed',
        targetType: 'app',
        targetId: app.id,
        appId: app.id,
        summary: {
          before: { version: app.templateVersion },
          after: { version, commit: identity.kitCommit, tag },
        },
      })
    }
    nudgeApp(deps.realtime, tenantId, app.id)
  }

  const open = await db
    .select()
    .from(appUpgrades)
    .where(
      and(
        eq(appUpgrades.tenantId, tenantId),
        eq(appUpgrades.appId, app.id),
        eq(appUpgrades.targetKind, 'kit'),
        inArray(appUpgrades.status, OPEN)
      )
    )
  let released = 0
  for (const row of open) {
    if (!kitVersionReached(version, row.toVersion)) continue
    const moved = await moveUpgrade(db, {
      tenantId,
      upgradeId: row.id,
      from: OPEN,
      to: 'released',
      set: { error: null },
      action: 'app.upgrade.released',
      summary: { version, tag },
      realtime: deps.realtime,
    })
    if (moved) released += 1
  }
  return { version, changed, released }
}
