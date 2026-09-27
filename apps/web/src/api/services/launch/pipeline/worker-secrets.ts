/**
 * Putting secrets on an app's Worker (Launch P2, plan §3 2c step 10, spec/03 "Derived
 * credentials"). A value goes to Cloudflare and nowhere else: never into a step result, an
 * `app_operations` row, an audit summary or a log line — each is registered with `ctx.redact` so
 * even a vendor error echoing it is scrubbed. What the pipeline records is the NAMES it put.
 *
 * `OAUTH_ENCRYPTION_KEY` is the one value Launch keeps (sealed, `app_environments.
 * encryption_key_sealed`): rotating it would orphan everything the app has sealed, so it is
 * generated once and a retry puts the SAME key back.
 */
import type { CloudflareClient } from '../cloudflare'
import type { StepContext } from './operations'

/** A fresh app encryption key: 32 random bytes, base64 — the form the kit's `importKey` prefers. */
export function generateEncryptionKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** Put each secret on `scriptName`, in order. Returns the names put. */
export async function putWorkerSecrets(
  cf: { client: CloudflareClient; accountId: string },
  ctx: Pick<StepContext, 'redact'>,
  scriptName: string,
  secrets: Record<string, string>
): Promise<string[]> {
  for (const value of Object.values(secrets)) ctx.redact(value)
  const names: string[] = []
  for (const [name, value] of Object.entries(secrets)) {
    await cf.client.putWorkerSecret(cf.accountId, scriptName, name, value)
    names.push(name)
  }
  return names
}
