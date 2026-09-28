/**
 * What an app holds, as the deploy gateway asks it (Launch P5, plan §1.5, §1.6, §4 5d):
 *
 * - `grantedKeys`: every item key of every LIVE grant of the app in `environment` — `uploadDeploy`
 *   drops the toml's `plain_text` / `json` bindings with those names and records them as
 *   `shadowedVars` (the grant wins, and the app's repo needs no change);
 * - `pushedSince`: the grants of the app in `environment` whose last push landed after `since` —
 *   `activateDeploy` passes `ticket.uploaded_at` and starts a `repair` push for each, because
 *   `keep_bindings` copied the secrets as of the upload and activating would undo a newer push.
 *
 * **Slice 5d owns this file.** From 5a each throws `NotWiredError`.
 */
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import type { Database } from '../../../db/client'
import type { AppGrantRow } from '../../../db/schema'
import { NotWiredError } from './types'

export async function grantedKeys(
  _db: Database,
  _tenantId: string,
  _appId: string,
  _environment: AppEnvironmentName
): Promise<string[]> {
  throw new NotWiredError('grants/holders.grantedKeys', '5d')
}

export async function pushedSince(
  _db: Database,
  _tenantId: string,
  _appId: string,
  _environment: AppEnvironmentName,
  _since: Date
): Promise<AppGrantRow[]> {
  throw new NotWiredError('grants/holders.pushedSince', '5d')
}
