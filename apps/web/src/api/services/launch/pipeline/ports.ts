/**
 * The pipeline's PORTS (Launch P2): what the create-an-app Workflow needs from the Rocketflare
 * adapter and the scaffold runner, which slice 2b builds (`services/launch/rocketflare/*`,
 * `services/launch/scaffold/*`). Slice 2c depends on these interfaces only, so the two slices can
 * be built in parallel; `defaultPorts()` is the ONE place that binds them to 2b's modules.
 *
 * `defaultPorts()` binds them to 2b's modules; argument order is adapted HERE, never in the callers:
 *
 * | Port                        | Module                                                  |
 * |-----------------------------|---------------------------------------------------------|
 * | `names(slug, env, domain)`  | `rocketflare/names.ts` `appResourceNames` — plan §1's naming table |
 * | `writeConfig(toml, env, v)` | `rocketflare/toml.ts` `writeConfig(tomlText, env, ConfigValues)` |
 * | `placeholderScript(toml)`   | `rocketflare/placeholder-worker.ts` `placeholderScript(toml, { appliedTag, appName })` |
 * | `scaffoldFiles()`           | `rocketflare/scaffold-job.ts` `scaffoldFiles()` (the workflow + `.launch/scaffold.mjs`) |
 * | `scaffoldRunner`            | `scaffold/github-actions-runner.ts` `GitHubActionsScaffoldRunner` (dispatches `launch-scaffold.yml` on `main` with `launch_url`; `poll` reads its run) |
 *
 * Tests never reach `defaultPorts()`: the Workflow classes take `overrides.ports`, and the route
 * suite mocks this module.
 */
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import type { ScaffoldPlan } from '@launch/shared/launch-pipeline'
import type { WorkerMetadata, WorkerModule } from '../cloudflare'
import type { CommitFile } from '../github-app'
import { appResourceNames } from '../rocketflare/names'
import { placeholderScript } from '../rocketflare/placeholder-worker'
import { scaffoldFiles } from '../rocketflare/scaffold-job'
import { writeConfig } from '../rocketflare/toml'
import { GitHubActionsScaffoldRunner } from '../scaffold/github-actions-runner'

/** Every account-scoped name one environment of an app uses (plan §1 "Naming"). */
export interface AppResourceNames {
  /** `<slug>[-staging]` */
  workerName: string
  /** `<slug>-rate-limit[-staging]` — the KV namespace TITLE (the toml holds only its id). */
  kvTitle: string
  /** `<slug>-jobs[-staging]` */
  queue: string
  /** `<slug>-files[-staging]` */
  r2Bucket: string
  /** `<slug>-agent-run[-staging]` */
  workflow: string
  /** `<slug>[-staging]` — the Resend sending key's name. */
  resendKeyName: string
  /** `<slug>[-staging].<apps domain>` */
  host: string
  /** `https://<host>`, no trailing slash — `[vars].APP_URL` and the environment's URL. */
  url: string
}

/** What `write_config` fills into one environment's toml (plan §0.4 and step 7). */
export interface WriteConfigValues {
  /** `[vars].APP_URL`. */
  appUrl: string
  /** `[vars].EMAIL_FROM`, e.g. `Shop <shop@notifications.clewro.com>`. */
  emailFrom: string
  /**
   * The id of every KV namespace the pipeline created, by the toml BINDING it answers (kit 0.15
   * has one: `RATE_LIMIT_KV`). A declared binding with no id here is an error, not a placeholder.
   */
  kvIds: Record<string, string>
  /** `[vars].OIDC_ISSUER` — Launch's own origin. */
  oidcIssuer: string
  /** `[vars].OIDC_CLIENT_ID`. */
  oidcClientId: string
}

/**
 * The placeholder Worker for one toml: metadata (compatibility, and the `[[migrations]]` the
 * Versions API cannot apply) plus a module exporting a stub class per Durable Object and Workflow
 * `class_name`, so routes, secrets, workflows and queue consumers can attach before the first
 * real deploy.
 */
export interface PlaceholderScript {
  metadata: WorkerMetadata
  modules: WorkerModule[]
  /** The newest DO migration tag the metadata applies (`v1` for kit 0.15), or null. */
  migrationTag: string | null
}

/** What a scaffold runner acts with. The token is a secret: never stored, never returned. */
export interface ScaffoldRunnerContext {
  /** An installation token scoped to the one new repository. */
  token: string
  owner: string
  repo: string
  /** The `scaffold` deploy ticket the job will claim at `/ci/scaffold/token`. */
  ticketId: string
  /** Launch's `APP_URL` — dispatched to the job, which uses it as its OIDC audience and base URL. */
  launchUrl?: string
}

export type ScaffoldRunStatus = 'running' | 'succeeded' | 'failed'

/** The P3 seam (plan §1): P2's implementation is a one-shot GitHub Actions job. */
export interface ScaffoldRunnerPort {
  /** `github-actions` for P2's runner; recorded on the `scaffold.start` row. */
  id: string
  /** Start the job. Returns ids (`runId`…) to record — never a secret. May throw to be retried. */
  start(ctx: ScaffoldRunnerContext, plan: ScaffoldPlan): Promise<Record<string, string>>
  /**
   * Where the job is. `failed` ends the wait at once instead of after its 30 minutes; `runId` and
   * `url` (the run's page) are recorded on the `scaffold.wait` row as soon as they are known.
   */
  poll(
    ctx: ScaffoldRunnerContext,
    ids: Record<string, string>
  ): Promise<{ status: ScaffoldRunStatus; detail?: string; runId?: string; url?: string }>
}

export interface PipelinePorts {
  names(slug: string, env: AppEnvironmentName, appsDomain: string): AppResourceNames
  /** The toml with every placeholder filled and the §0.4 vars set. Must be idempotent. */
  writeConfig(tomlText: string, env: AppEnvironmentName, values: WriteConfigValues): string
  /**
   * `appliedTag` is the DO migration tag the script ALREADY carries (a retried `placeholders`):
   * only the migrations after it are sent, since re-sending an applied tag is refused.
   * `appName` is the display name the launching page shows a browser.
   */
  placeholderScript(
    tomlText: string,
    opts?: { appliedTag?: string | null; appName?: string }
  ): PlaceholderScript
  /** The files `repo` commits before dispatching the scaffold job. */
  scaffoldFiles(): CommitFile[]
  scaffoldRunner: ScaffoldRunnerPort
}

/**
 * The environment the one-shot scaffold ticket is recorded against (`deploy_tickets.environment_id`
 * is required). The scaffold job pushes `main`, production's branch, and carries no `environment`
 * claim, so `/ci/scaffold/*` should resolve its caller with `defaultEnvironment: 'production'`.
 */
export const SCAFFOLD_TICKET_ENVIRONMENT: AppEnvironmentName = 'production'

/** The scaffold job's workflow file, as `resolveCaller` and the dispatch name it. */
export { SCAFFOLD_WORKFLOW_FILE } from '../rocketflare/scaffold-job'

/** The kit's deploy workflow (`workflow_dispatch` with `inputs.environment`). */
export const DEPLOY_WORKFLOW_FILE = 'deploy.yml'

/** The Rocketflare adapter and the GitHub Actions scaffold runner (plan §1). */
export function defaultPorts(): PipelinePorts {
  return {
    names: appResourceNames,
    writeConfig: (tomlText, env, v) =>
      writeConfig(tomlText, env, {
        appUrl: v.appUrl,
        emailFrom: v.emailFrom,
        kvIds: v.kvIds,
        oidc: { issuer: v.oidcIssuer, clientId: v.oidcClientId },
      }),
    placeholderScript: (tomlText, opts) => placeholderScript(tomlText, opts),
    scaffoldFiles,
    scaffoldRunner: new GitHubActionsScaffoldRunner(),
  }
}
