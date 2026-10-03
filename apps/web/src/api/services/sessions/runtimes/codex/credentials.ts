/**
 * A Codex session on a person's ChatGPT plan (§18.22-B): the lease CLAIMS the credential (one
 * `auth.json` is never used by two turns at once — busy is `CredentialBusyError`), writes it into
 * `$CODEX_HOME`, and on release reads it back, validates it, reseals it only if Codex rotated it
 * (`resealIfVersion`), removes the file and releases the claim.
 *
 * **Stream B owns this file.** Until it lands the lease throws `NotWiredError`.
 */
import { NotWiredError } from '../../ports'
import type { TurnCredentialLease, UserLeaseContext } from '../types'

export async function leaseCodexUserCredential(
  _ctx: UserLeaseContext
): Promise<TurnCredentialLease> {
  throw new NotWiredError('A ChatGPT-plan lease', 'B')
}
