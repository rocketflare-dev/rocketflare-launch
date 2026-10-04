/**
 * Kit upgrades for one app (P6 slice 6c, the single-app half — `docs/plans/p6-fleet.md` §1 items
 * 1–6): when the admin moves the template pin above an app's kit version the app "requires
 * upgrade"; one click starts a coding session (kind `upgrade`) that runs the kit's `/rf-upgrade`,
 * ships it, and the next Release records the new version.
 *
 * - `app_upgrades` is Launch's history of upgrades: one row per attempt, its status a closed set
 *   ({@link APP_UPGRADE_STATUSES}), at most one OPEN per app and target (a partial unique index
 *   over {@link OPEN_APP_UPGRADE_STATUSES}). The fleet slice ("Upgrade all") adds `fleet_run_id`
 *   and the `queued` path; one app's upgrade starts `running`.
 * - "Requires upgrade" is computed on READ ({@link kitStatusSchema}), never stored: the app's
 *   `template_version` against the pin's tag ({@link kitVersionBehind}). A pin with no tag (an
 *   unreleased commit) or an app with no recorded version is never behind.
 * - The status codes a refusal answers are {@link UPGRADE_ERROR_CODES}.
 */
import { z } from 'zod'
import { compareReleaseVersions, parseReleaseVersion } from './launch-releases'

// ---- closed sets ---------------------------------------------------------------------------------

/** What an upgrade moves. `plugin` follows with the fleet slice (`plugin_id` is already there). */
export const UPGRADE_TARGET_KINDS = ['kit'] as const
export const upgradeTargetKindSchema = z.enum(UPGRADE_TARGET_KINDS)
export type UpgradeTargetKind = z.infer<typeof upgradeTargetKindSchema>

/**
 * `app_upgrades.status` (text, typed here):
 *
 *   queued → running → pr_open → released
 *              ↘ needs_attention ↗          (and `failed` / `cancelled` from any open status)
 *
 * - `running` — the session is doing the upgrade (and, with auto-ship, shipping it);
 * - `needs_attention` — the session stopped short of a PR (a question, a red gate, a budget stop):
 *   the owner finishes it on the session page, and shipping it moves it on as usual;
 * - `pr_open` — the PR is open (or landing, in `staging` ship mode);
 * - `released` — a Release's `.rocketflare.json` says the kit is at (or past) the target;
 * - `failed` — the session failed; `cancelled` — it ended without a PR.
 */
export const APP_UPGRADE_STATUSES = [
  'queued',
  'running',
  'pr_open',
  'needs_attention',
  'released',
  'failed',
  'cancelled',
] as const
export const appUpgradeStatusSchema = z.enum(APP_UPGRADE_STATUSES)
export type AppUpgradeStatus = z.infer<typeof appUpgradeStatusSchema>

/** Still in flight: `app_upgrades_open_idx`'s predicate is rendered from this list. */
export const OPEN_APP_UPGRADE_STATUSES = [
  'queued',
  'running',
  'pr_open',
  'needs_attention',
] as const satisfies readonly AppUpgradeStatus[]

export function isOpenUpgradeStatus(status: AppUpgradeStatus): boolean {
  return (OPEN_APP_UPGRADE_STATUSES as readonly AppUpgradeStatus[]).includes(status)
}

/** How each status reads on the app page and in the CLI. */
export const APP_UPGRADE_STATUS_LABELS: Record<AppUpgradeStatus, string> = {
  queued: 'Queued',
  running: 'Upgrading',
  pr_open: 'Pull request open',
  needs_attention: 'Needs attention',
  released: 'Released',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** The refusals of `POST /api/apps/:id/upgrade` (all 409s). */
export const UPGRADE_ERROR_CODES = {
  /** The app's kit is not below the pin's tag. */
  notBehind: 'upgrade_not_behind',
  /** The app already has an open upgrade (`details.upgradeId`, `details.status`). */
  open: 'upgrade_open',
  /** The pin is an unreleased commit: there is no version to upgrade to. */
  noPinTag: 'upgrade_no_pin_tag',
} as const

// ---- versions ------------------------------------------------------------------------------------

/** A kit version or tag as `X.Y.Z` — a leading `v` dropped — or null when it is not one. */
export function kitVersionOf(value: string | null | undefined): string | null {
  if (!value) return null
  const version = value.trim().replace(/^v/, '')
  return parseReleaseVersion(version) ? version : null
}

/**
 * Is `current` semver-below `target`? False whenever either is missing or not `X.Y.Z` — an app
 * whose kit version Launch cannot read is never flagged.
 */
export function kitVersionBehind(
  current: string | null | undefined,
  target: string | null | undefined
): boolean {
  const from = kitVersionOf(current)
  const to = kitVersionOf(target)
  if (!from || !to) return false
  return compareReleaseVersions(from, to) < 0
}

/** Has `current` reached `target` (equal or later)? False when either is not `X.Y.Z`. */
export function kitVersionReached(
  current: string | null | undefined,
  target: string | null | undefined
): boolean {
  const from = kitVersionOf(current)
  const to = kitVersionOf(target)
  if (!from || !to) return false
  return compareReleaseVersions(from, to) >= 0
}

// ---- wire shapes ---------------------------------------------------------------------------------

/** One `app_upgrades` row. */
export const appUpgradeSchema = z.object({
  id: z.string().uuid(),
  appId: z.string().uuid(),
  targetKind: upgradeTargetKindSchema,
  pluginId: z.string().nullable(),
  fromVersion: z.string().nullable(),
  toVersion: z.string(),
  status: appUpgradeStatusSchema,
  sessionId: z.string().uuid().nullable(),
  prNumber: z.number().int().positive().nullable(),
  prUrl: z.string().nullable(),
  /** Why it needs attention, failed or was cancelled — a sentence, never a vendor body. */
  error: z.string().nullable(),
  requestedByUserId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type AppUpgrade = z.infer<typeof appUpgradeSchema>

/**
 * The kit an app is on against the pin, computed on read (`services/launch/upgrades.ts`):
 * `current` is `apps.template_version`, `target` the pin's tag (null for a commit pin), `behind`
 * whether the app requires an upgrade, `openUpgrade` the one in flight.
 */
export const kitStatusSchema = z.object({
  current: z.string().nullable(),
  target: z.string().nullable(),
  behind: z.boolean(),
  openUpgrade: appUpgradeSchema.nullable().default(null),
  /** The target release's porting note in the kit repo (`docs/upgrades/<tag>.md` at the tag). */
  notesUrl: z.string().nullable().default(null),
})
export type KitStatus = z.infer<typeof kitStatusSchema>

/** The kit's porting note for `tag` — `docs/upgrades/<version>.md` at the tag, on GitHub. Pure. */
export function kitUpgradeNotesUrl(repo: string, tag: string): string | null {
  const version = kitVersionOf(tag)
  if (!version || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) return null
  return `https://github.com/${repo}/blob/${encodeURIComponent(tag)}/docs/upgrades/${version}.md`
}

/**
 * "Requires upgrade → 0.16.1" — the one phrase the catalogue, the app page and the CLI show for an
 * app behind the pin; null when it is not. Pure.
 */
export function requiresUpgradeLabel(kit: Pick<KitStatus, 'behind' | 'target'>): string | null {
  return kit.behind && kit.target ? `Requires upgrade → ${kit.target}` : null
}

/** `POST /api/apps/:id/upgrade` → 202: the upgrade and the session doing it. */
export const startUpgradeResponseSchema = z.object({
  upgradeId: z.string().uuid(),
  sessionId: z.string().uuid(),
  upgrade: appUpgradeSchema,
})
export type StartUpgradeResponse = z.infer<typeof startUpgradeResponseSchema>

/** `GET /api/apps/:id/upgrades` — the app's upgrades, newest first. */
export const appUpgradeListResponseSchema = z.object({ items: z.array(appUpgradeSchema) })
export type AppUpgradeListResponse = z.infer<typeof appUpgradeListResponseSchema>

// ---- the upgrade session -------------------------------------------------------------------------

/**
 * The line the upgrade prompt asks the agent to END its final message with
 * (`rocketflare/upgrade-prompt.ts`): `DONE` when the upgrade applied cleanly and is committed,
 * `STOPPED` when it stopped to explain. Auto-ship needs `DONE` — and checks the checkout itself
 * (`.rocketflare.json` at the target, the workspace changed) rather than taking the word for it.
 */
export const UPGRADE_RESULT_MARKER = 'LAUNCH-UPGRADE:'
export const UPGRADE_RESULTS = ['DONE', 'STOPPED'] as const
export type UpgradeResult = (typeof UPGRADE_RESULTS)[number]

/** The LAST `LAUNCH-UPGRADE: DONE|STOPPED` line of `text`, or null when it has none. Pure. */
export function upgradeResultOf(text: string | null | undefined): UpgradeResult | null {
  if (!text) return null
  let found: UpgradeResult | null = null
  for (const line of text.split('\n')) {
    const match = /^\s*\**\s*LAUNCH-UPGRADE:\s*(DONE|STOPPED)\s*\**\s*$/.exec(line)
    if (match) found = match[1] as UpgradeResult
  }
  return found
}

/**
 * The `status` session event an upgrade session's auto-ship writes (its data's `reason`), so the
 * chat says what Launch decided after the first turn: shipping it, or handing it to the owner.
 */
export const UPGRADE_SESSION_REASONS = {
  autoShip: 'upgrade.auto_ship',
  needsAttention: 'upgrade.needs_attention',
} as const

export const upgradeSessionStatusDataSchema = z
  .object({
    status: z.string(),
    reason: z.enum([UPGRADE_SESSION_REASONS.autoShip, UPGRADE_SESSION_REASONS.needsAttention]),
    message: z.string(),
  })
  .passthrough()
export type UpgradeSessionStatusData = z.infer<typeof upgradeSessionStatusDataSchema>
