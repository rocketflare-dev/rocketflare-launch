/**
 * Which Workflow instance is running a launch run NOW. `createApp` starts the run as instance
 * `<runId>`; a retry starts `<runId>-rN` with the same run id (`retry.ts`) and records it on
 * `apps.launch_instance_id`. The two senders — `/ci/scaffold/done` (`SCAFFOLD_FINISHED_EVENT`) and
 * `/ci/deploy/:id/finish` (`DEPLOY_FINISHED_EVENT`) — only know the ticket's `launch_run_id`, so
 * they ask here, and the event reaches the instance that is actually waiting instead of the one
 * that failed. (The run polls its tickets each round too: a lost event costs latency, not the run.)
 */
import type { AppRow } from '../../../../db/schema'

export function launchInstanceOf(
  app: Pick<AppRow, 'launchRunId' | 'launchInstanceId'>,
  runId: string
): string {
  return app.launchRunId === runId && app.launchInstanceId ? app.launchInstanceId : runId
}
