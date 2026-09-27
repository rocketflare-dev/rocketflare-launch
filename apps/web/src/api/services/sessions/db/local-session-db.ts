/**
 * `LocalSessionDb` — the `SessionDbPort` on the laptop (`SESSION_BACKEND=local`,
 * `docs/SESSIONS-LOCAL.md`): `dev` is the database `launch_sessdev_<slug>` on the local Postgres
 * (`SESSION_LOCAL_DB_URL`), and a session's is `CREATE DATABASE launch_sess_<short> TEMPLATE
 * launch_sessdev_<slug>`. The sandbox reaches it through the kit's local Neon proxy
 * (`SESSION_LOCAL_NEON_PROXY`), because a locked sandbox speaks only HTTP(S) to Postgres (S7).
 *
 * **Slice 3b owns this file.** From 3a it is a stub whose every method throws `NotWiredError`.
 */
import type { AppSessionDb, SessionDb } from '@launch/shared/launch-sessions'
import type { AppConfig } from '../../../../config'
import { NotWiredError, type SessionAppRef, type SessionBranch, type SessionDbPort } from '../ports'

export class LocalSessionDb implements SessionDbPort {
  constructor(readonly cfg: AppConfig) {}

  ensureDev(_app: SessionAppRef): Promise<AppSessionDb> {
    throw new NotWiredError('LocalSessionDb.ensureDev', '3b')
  }

  createBranch(
    _app: SessionAppRef,
    _session: { id: string; shortId: string }
  ): Promise<SessionBranch> {
    throw new NotWiredError('LocalSessionDb.createBranch', '3b')
  }

  deleteBranch(_app: SessionAppRef, _db: SessionDb): Promise<void> {
    throw new NotWiredError('LocalSessionDb.deleteBranch', '3b')
  }

  devUriFor(_app: SessionAppRef): Promise<string> {
    throw new NotWiredError('LocalSessionDb.devUriFor', '3b')
  }
}
