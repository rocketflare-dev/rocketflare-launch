/**
 * Detecting what an app needs (Launch P5, plan §1.14–§1.15, §4 5e) — read-only, through the
 * adapter's `declaredConfig` (`launch/rocketflare/declared-config.ts`):
 *
 * - `scanAppConfig`: read the repo at `ref` (`withRepoToken(…, { contents: 'read' })` +
 *   `getRepoFile`), match each declared key to resource items by exact name, upsert
 *   `app_config_scans` (`declared`, `needs`), and notify the app's owners ONCE (`grant_needed`) for
 *   each newly needed resource. Called after commit by `importApp`, `createRelease` (at the tag) and
 *   `POST /api/apps/:id/config/scan`. A failure is recorded on `app_config_scans.error` and never
 *   thrown to the caller — it must not fail an import, a release or a ship;
 * - `scanShipConfig`: the same scan at a session's PR head, returned as the `ship.config_needs`
 *   event's data and never stored (`sessions/ship.ts` emits it after `openPullRequest`).
 *
 * **Slice 5e owns this file.** From 5a each throws `NotWiredError`.
 */
import type { SessionShipConfigNeedsData } from '@launch/shared/launch-sessions'
import type { AppConfigScanRow } from '../../../db/schema'
import { type GrantDeps, NotWiredError } from './types'

export type ScanTrigger = 'import' | 'release' | 'rescan'

export interface ScanAppConfigInput {
  tenantId: string
  appId: string
  /** The ref to read (a tag, a sha, a branch); null = the default branch. */
  ref: string | null
  trigger: ScanTrigger
}

export async function scanAppConfig(
  _deps: GrantDeps,
  _input: ScanAppConfigInput
): Promise<AppConfigScanRow> {
  throw new NotWiredError('grants/detect.scanAppConfig', '5e')
}

export interface ScanShipConfigInput {
  tenantId: string
  appId: string
  /** The PR head. */
  sha: string
}

export async function scanShipConfig(
  _deps: GrantDeps,
  _input: ScanShipConfigInput
): Promise<SessionShipConfigNeedsData> {
  throw new NotWiredError('grants/detect.scanShipConfig', '5e')
}
