/**
 * `NeonSessionDb` — the `SessionDbPort` on Neon (`SESSION_BACKEND=cloud`, plan §1.7): the app's
 * `dev` branch (`init_source: 'schema-only'` from `main`, role `session_owner`, empty database
 * `session_app`), and per session a branch of `dev` with `session_owner`'s password reset. Built on
 * `NeonClient` (`services/launch/neon.ts`: `createBranch({ initSource, endpoints })`,
 * `deleteBranch`, `listBranchEndpoints`, `resetRolePassword`, `connectionUri`) and the sealed
 * `neon_org_api_key` credential, read through `getCredential(db, cfg, 'neon_org_api_key')`.
 *
 * **Slice 3b owns this file.** From 3a it is a stub whose every method throws `NotWiredError`.
 */
import type { AppSessionDb, SessionDb } from '@launch/shared/launch-sessions'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { NotWiredError, type SessionAppRef, type SessionBranch, type SessionDbPort } from '../ports'

export class NeonSessionDb implements SessionDbPort {
  constructor(
    readonly db: Database,
    readonly cfg: AppConfig,
    /** Injected `fetch` / `sleep` for tests (the `NeonOptions` of `NeonClient`). */
    readonly opts: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}
  ) {}

  ensureDev(_app: SessionAppRef): Promise<AppSessionDb> {
    throw new NotWiredError('NeonSessionDb.ensureDev', '3b')
  }

  createBranch(
    _app: SessionAppRef,
    _session: { id: string; shortId: string }
  ): Promise<SessionBranch> {
    throw new NotWiredError('NeonSessionDb.createBranch', '3b')
  }

  deleteBranch(_app: SessionAppRef, _db: SessionDb): Promise<void> {
    throw new NotWiredError('NeonSessionDb.deleteBranch', '3b')
  }

  devUriFor(_app: SessionAppRef): Promise<string> {
    throw new NotWiredError('NeonSessionDb.devUriFor', '3b')
  }
}
