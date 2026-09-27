/**
 * The app's email key (Launch P2, plan §3 2c step 11, spec/04 "Email"): one Resend
 * `sending_access` key per environment, bound to the fleet's shared `notifications.` domain, put on
 * the Worker as `RESEND_API_KEY` in the same breath and never kept. Only the key's id is recorded —
 * first on the row (`resendKey.<env>`, so teardown can revoke it even if the put fails) and then on
 * `app_environments.resend_key_id` once the Worker holds it.
 *
 * A retry that finds a minted-but-unconfirmed key revokes it and mints again: its token was shown
 * once and is gone, so the old key could never be put anywhere.
 */
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import { isResendNotFound, type ResendClient } from '../resend'
import type { StepContext } from './operations'
import { idKey } from './provision-cloudflare'

export async function mintSendingKey(
  resend: { client: ResendClient; domainId: string | null },
  ctx: StepContext,
  input: { env: AppEnvironmentName; keyName: string; confirmedKeyId: string | null },
  put: (token: string) => Promise<void>
): Promise<{ keyId: string; minted: boolean }> {
  if (input.confirmedKeyId) return { keyId: input.confirmedKeyId, minted: false }
  if (!resend.domainId) {
    throw new Error('The Resend credential has no notifications domain id — run its check in Setup')
  }
  const stale = ctx.prior[idKey('resendKey', input.env)]
  if (stale) {
    try {
      await resend.client.deleteApiKey(stale)
    } catch (err) {
      if (!isResendNotFound(err)) throw err
    }
  }
  const key = await resend.client.createSendingKey(input.keyName, resend.domainId)
  ctx.redact(key.token)
  await ctx.record({ [idKey('resendKey', input.env)]: key.id })
  await put(key.token)
  return { keyId: key.id, minted: true }
}
