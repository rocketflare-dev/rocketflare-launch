/**
 * Codex's relayed sign-in (§18.22-B): `codex login --device-auth` in a scratch `CODEX_HOME` in the
 * login sandbox — the device URL and user code relayed out (the person types the code AT OpenAI;
 * nothing comes back through Launch), then the `auth.json` it writes captured, its id token decoded
 * for the plan and account metadata, sealed, and deleted from the sandbox.
 *
 * **Stream B owns this file.** Until it lands every step throws `NotWiredError` by name.
 */
import { NotWiredError } from '../../ports'
import type { LoginDriver } from '../types'

const notWired = (what: string) => new NotWiredError(`Codex sign-in (${what})`, 'B')

export const codexLoginDriver: LoginDriver = {
  hosts: [],
  needsCode: false,
  start: async () => {
    throw notWired('start')
  },
  readPrompt: async () => {
    throw notWired('readPrompt')
  },
  poll: async () => {
    throw notWired('poll')
  },
  capture: async () => {
    throw notWired('capture')
  },
}
