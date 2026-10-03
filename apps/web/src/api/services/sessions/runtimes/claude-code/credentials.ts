/**
 * A Claude session on a person's own subscription (§18.22-A): the lease checks the credential is
 * active and unexpired (else `CredentialNeedsLoginError` — "Reconnect your Claude account in
 * Profile") and stamps `last_used_at`. It carries NO secret into the container: the turn runs with
 * a placeholder OAuth token (`claudeTurnEnv(model, 'user')`) and the egress swaps the real one in.
 *
 * **Stream A owns this file.** Until it lands the lease throws `NotWiredError`, so a `user`
 * session's turn fails with a sentence.
 */
import { NotWiredError } from '../../ports'
import type { TurnCredentialLease, UserLeaseContext } from '../types'

export async function leaseClaudeUserCredential(
  _ctx: UserLeaseContext
): Promise<TurnCredentialLease> {
  throw new NotWiredError('A Claude subscription lease', 'A')
}
