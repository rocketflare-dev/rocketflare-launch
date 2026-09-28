/**
 * Sealing a shared resource's values (Launch P5, plan §1.2): one environment's values are one JSON
 * object `{ KEY: value }`, sealed with `encryptToken` (AES-GCM under `OAUTH_ENCRYPTION_KEY`, the
 * P1 `admin_credentials` pattern) into `shared_resource_values.sealed`. Written by 5b's `setValues`,
 * opened by 5c's push step (inside the step, never returned) and by 5b's merge of a blank field.
 *
 * Real from 5a so neither slice waits on the other for it. Slice 5a owns this file.
 */
import type { AppConfig } from '../../../config'
import { decryptToken, encryptToken } from '../../auth/oauth-encryption'

/** Seal `values`. 503 `oauth_encryption_key_missing` without a key (checked at use time, D3). */
export async function sealValues(
  cfg: AppConfig,
  values: Readonly<Record<string, string>>
): Promise<string> {
  const sealed = await encryptToken(cfg, JSON.stringify(values))
  if (sealed === null) throw new Error('sealValues: encryptToken returned null')
  return sealed
}

/**
 * Open a sealed blob. A blob that does not decrypt, or is not an object of strings, throws — a
 * push must fail loudly rather than put a half-read secret.
 */
export async function openValues(cfg: AppConfig, sealed: string): Promise<Record<string, string>> {
  const text = await decryptToken(cfg, sealed)
  const parsed: unknown = JSON.parse(text ?? 'null')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('openValues: the sealed values are not an object')
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`openValues: ${key} is not a string`)
    out[key] = value
  }
  return out
}
