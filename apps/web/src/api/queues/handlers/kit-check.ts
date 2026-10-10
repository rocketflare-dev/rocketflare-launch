/**
 * `kit.check` (D36 K3): one phase of a kit's dynamic conformance check — `runKitCheckJob` in
 * `services/launch/kits/dynamic-check.ts` is the whole policy (create the throwaway repo and
 * dispatch the scaffold job, poll it, check the copy, remove the repo, write the result). This
 * file binds it to the platform: the database and config of the message, and `JOBS_QUEUE` for the
 * next phase. A phase that throws is retried by the consumer with backoff (GitHub not having
 * registered the freshly committed workflow yet is the expected one).
 */
import type { JobOf } from '@launch/shared/jobs'
import { runKitCheckJob } from '../../services/launch/kits/dynamic-check'
import type { JobContext } from '../jobs'

export async function handleKitCheck(job: JobOf<'kit.check'>, ctx: JobContext): Promise<void> {
  await runKitCheckJob({ db: ctx.db, cfg: ctx.config, queue: ctx.env.JOBS_QUEUE }, job.payload)
}
