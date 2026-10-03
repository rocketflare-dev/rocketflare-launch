/**
 * Claude's relayed sign-in (§18.22-A): `claude setup-token`, unmodified, in the login sandbox under
 * a small PTY relay (the Sandbox SDK has no stdin) — the authorize URL relayed out, the code the
 * person pastes relayed in, the long-lived inference token it prints captured and sealed.
 *
 * **Stream A owns this file.** Until it lands every step throws `NotWiredError` by name, so a login
 * started on a deployment that already lists `claude_code` in `SESSION_USER_CREDENTIALS` fails
 * with a sentence, not a crash. The hosts come from spike S-A1.
 */
import { NotWiredError } from '../../ports'
import type { LoginDriver } from '../types'

const notWired = (what: string) => new NotWiredError(`Claude sign-in (${what})`, 'A')

export const claudeLoginDriver: LoginDriver = {
  hosts: [],
  needsCode: true,
  start: async () => {
    throw notWired('start')
  },
  readPrompt: async () => {
    throw notWired('readPrompt')
  },
  submitCode: async () => {
    throw notWired('submitCode')
  },
  poll: async () => {
    throw notWired('poll')
  },
  capture: async () => {
    throw notWired('capture')
  },
}
