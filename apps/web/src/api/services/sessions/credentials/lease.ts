/**
 * One turn's credential (§18.22): `ports.credentials(db).lease(session, sandbox, runtime)` → a
 * `TurnCredentialLease` the turn writes into the process (`env`, `files`) and releases in its
 * `finally`.
 *
 * - `platform` (every session before §18.22, and every one on a default deployment):
 *   `PLATFORM_LEASE` — nothing at all. The process keeps its placeholder and the egress swaps
 *   Launch's key in, exactly as before.
 * - `user`: the runtime's own `userLease` (Claude: Stream A; Codex: Stream B), which checks the
 *   credential and — for Codex — claims it for the turn.
 *
 * `credentialsFor(ports, db)` answers `PLATFORM_CREDENTIALS` for ports that bring none (the fakes):
 * platform rows lease nothing, and a `user` row fails its turn by name rather than running on
 * Launch's key.
 */
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import type { SessionRow } from '../../../../db/schema'
import type { AgentRuntime, SessionCredentialPort, TurnCredentialLease } from '../runtimes/types'
import type { SandboxPort } from '../sandbox-port'
import { CredentialPortMissingError } from './errors'

/** Nothing to lease: Launch's key, swapped in at the egress. */
export const PLATFORM_LEASE: TurnCredentialLease = Object.freeze({
  source: 'platform',
  env: Object.freeze({}) as Record<string, string>,
  files: Object.freeze([]) as unknown as TurnCredentialLease['files'],
  release: async () => {},
}) as TurnCredentialLease

/** For ports without a credential port: platform rows only. */
export const PLATFORM_CREDENTIALS: SessionCredentialPort = {
  async lease(session) {
    if (session.credentialSource === 'user') throw new CredentialPortMissingError()
    return PLATFORM_LEASE
  },
}

/** The real port: platform leases nothing, `user` dispatches to the runtime. */
export function createSessionCredentialPort(
  db: Database,
  cfg: AppConfig,
  opts: { now?: () => Date } = {}
): SessionCredentialPort {
  const now = opts.now ?? (() => new Date())
  return {
    async lease(session: SessionRow, sandbox: SandboxPort, runtime: AgentRuntime) {
      if (session.credentialSource !== 'user') return PLATFORM_LEASE
      if (!runtime.userLease) throw new CredentialPortMissingError()
      return runtime.userLease({ db, cfg, session, sandbox, now })
    },
  }
}
