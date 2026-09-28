/**
 * The Rocketflare `TemplateAdapter`, contract v1 (spec/02): everything the pipeline knows about
 * the kind of app it creates, behind one object, so the Workflow steps never reach into kit
 * internals. Rocketflare is the only template; the interface exists to version the contract
 * across kit releases (`ROCKETFLARE_CONTRACT_VERSION`, recorded on every app).
 *
 * Written against kit 0.15.0 (`DEFAULT_TEMPLATE_PIN`) and its fixtures
 * (`tests/fixtures/rocketflare-0.15/`). What it covers, and where:
 *
 * | Need | Where |
 * |------|-------|
 * | the scaffold job's files and its check | `scaffold-job.ts`, `scaffoldProblems` below |
 * | every resource name | `names.ts` |
 * | what the tomls declare / writing the answers back | `toml.ts` (`resources`, `writeConfig`) |
 * | the placeholder script | `placeholder-worker.ts` |
 * | Worker secrets, release, health, sign-in vars | the constants below |
 * | the config an app declares (P5) | `declared-config.ts` (`declaredConfig`) |
 *
 * `devBootstrap` (spec/02) is not here yet.
 */
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import type { CommitFile } from '../github-app'
import { ManifestError, parseManifest, WRANGLER_PATHS } from '../rocketflare-manifest'
import { declaredConfig } from './declared-config'
import { accountScopedNames, appResourceNames, KIT_BINDINGS } from './names'
import { placeholderScript } from './placeholder-worker'
import { SCAFFOLD_WORKFLOW_FILE, scaffoldFiles } from './scaffold-job'
import { resources, writeConfig } from './toml'

/** The adapter contract version an app records (spec/02, "Rocketflare adapter v1"). */
export const ROCKETFLARE_CONTRACT_VERSION = '1'

/** The Worker secrets every created app gets, per environment (spec/02 `secretTargets`). */
export const ROCKETFLARE_WORKER_SECRETS = [
  'OAUTH_ENCRYPTION_KEY',
  'OIDC_CLIENT_SECRET',
  'BOOTSTRAP_ADMIN_EMAILS',
  'DATABASE_URL',
  'RESEND_API_KEY',
] as const

/** The repo files the scaffold check reads, by what they are. */
export interface ScaffoldedFiles {
  /** `.rocketflare.json`. */
  manifest: string
  /** `apps/web/wrangler.toml`. */
  production: string
  /** `apps/web/wrangler.staging.toml`. */
  staging: string
}

export interface ScaffoldExpectation {
  slug: string
  /**
   * The kit tag the job was pinned to (`kit.version` must equal it, less any leading `v`); null or
   * absent for a commit pin, whose `kit.version` need only be present.
   */
  tag?: string | null
  /** The pinned kit commit; checked against `kit.commit` when given (a commit pin's proof). */
  commit?: string
}

/**
 * Why the scaffolded repo is not the app Launch asked for — one sentence per problem, empty when
 * it is. The `scaffold.verify` step fails with these: `.rocketflare.json` must name the app and the
 * pinned kit, and every account-scoped name in both tomls must be the one `names.ts` computes
 * (plugin resources must at least be the app's: `<slug>-…[-staging]`). A binding kind Launch
 * cannot provision is a problem too.
 */
export function scaffoldProblems(files: ScaffoldedFiles, expected: ScaffoldExpectation): string[] {
  const problems: string[] = []
  try {
    const identity = parseManifest(files.manifest)
    if (identity.slug !== expected.slug) {
      problems.push(
        `.rocketflare.json names the app ${identity.slug ?? '(none)'}, not ${expected.slug}`
      )
    }
    if (expected.tag) {
      const tag = expected.tag.replace(/^v/, '')
      if (identity.kitVersion !== tag) {
        problems.push(`.rocketflare.json says kit ${identity.kitVersion ?? '(none)'}, not ${tag}`)
      }
    } else if (!identity.kitVersion) {
      problems.push('.rocketflare.json records no kit version')
    }
    if (expected.commit && identity.kitCommit !== expected.commit) {
      problems.push(
        `.rocketflare.json says kit commit ${identity.kitCommit ?? '(none)'}, not ${expected.commit}`
      )
    }
  } catch (err) {
    problems.push(err instanceof ManifestError ? err.message : '.rocketflare.json is unreadable')
  }

  for (const env of ['production', 'staging'] as const) {
    const file = WRANGLER_PATHS[env]
    let declared: ReturnType<typeof resources>
    try {
      declared = resources(files[env])
    } catch (err) {
      problems.push(err instanceof Error ? `${file}: ${err.message}` : `${file} is unreadable`)
      continue
    }
    const want = accountScopedNames(expected.slug, env)
    const suffix = env === 'staging' ? '-staging' : ''
    const check = (what: string, got: string | null | undefined, expect: string) => {
      if (got !== expect) problems.push(`${file}: ${what} is ${got ?? '(missing)'}, not ${expect}`)
    }
    check('name', declared.workerName, want.workerName)
    check('APP_ENV', declared.vars.APP_ENV, env)
    const binding = <T extends { binding: string }>(list: T[], name: string) =>
      list.find(b => b.binding === name)
    check('JOBS_QUEUE', binding(declared.queues, KIT_BINDINGS.jobsQueue)?.queue, want.queue)
    check('FILES', binding(declared.r2, KIT_BINDINGS.files)?.bucketName, want.r2Bucket)
    check(
      'AGENT_RUN_WORKFLOW',
      binding(declared.workflows, KIT_BINDINGS.agentRunWorkflow)?.name,
      want.workflow
    )
    if (!binding(declared.kv, KIT_BINDINGS.rateLimitKv)) {
      problems.push(`${file}: no ${KIT_BINDINGS.rateLimitKv} KV namespace`)
    }
    const scoped = [
      ...declared.queues.map(q => q.queue),
      ...declared.queueConsumers.map(q => q.queue),
      ...declared.r2.map(r => r.bucketName),
      ...declared.workflows.map(w => w.name),
    ]
    for (const name of scoped) {
      if (!name.startsWith(`${expected.slug}-`) || (suffix && !name.endsWith(suffix))) {
        problems.push(`${file}: ${name} is not one of ${want.workerName}'s names`)
      }
    }
    if (declared.unsupported.length > 0) {
      problems.push(`${file}: Launch cannot provision ${declared.unsupported.join(', ')}`)
    }
  }
  return problems
}

export interface TemplateAdapter {
  id: 'rocketflare'
  contractVersion: string
  /** Where the adapter reads an app's identity and config in its repo. */
  paths: { manifest: string; tomls: Record<AppEnvironmentName, string> }
  scaffold: {
    /** The workflow file the scaffold job's OIDC token must come from. */
    workflowFile: string
    /** The two files to commit before dispatching the job. */
    files: () => CommitFile[]
    /** `scaffoldProblems`. */
    problems: typeof scaffoldProblems
  }
  names: typeof appResourceNames
  resources: typeof resources
  writeConfig: typeof writeConfig
  placeholderScript: typeof placeholderScript
  /** Worker secret names for an environment (the same set for both today). */
  secretTargets: (env: AppEnvironmentName) => readonly string[]
  /** How a release happens: `workflow_dispatch` of this file with `{ [environmentInput]: env }`. */
  release: { workflowFile: string; environmentInput: string }
  health: { live: string; ready: string }
  /** The var and secret names the app reads for OIDC sign-in (spec/05). */
  auth: { issuer: string; clientId: string; clientSecret: string }
  /** The config keys the app's plugins and the kit declare, read through a file reader (P5). */
  declaredConfig: typeof declaredConfig
}

export const rocketflareAdapter: TemplateAdapter = {
  id: 'rocketflare',
  contractVersion: ROCKETFLARE_CONTRACT_VERSION,
  paths: { manifest: '.rocketflare.json', tomls: WRANGLER_PATHS },
  scaffold: {
    workflowFile: SCAFFOLD_WORKFLOW_FILE,
    files: scaffoldFiles,
    problems: scaffoldProblems,
  },
  names: appResourceNames,
  resources,
  writeConfig,
  placeholderScript,
  secretTargets: () => ROCKETFLARE_WORKER_SECRETS,
  release: { workflowFile: 'deploy.yml', environmentInput: 'environment' },
  health: { live: '/api/health', ready: '/api/ready' },
  auth: { issuer: 'OIDC_ISSUER', clientId: 'OIDC_CLIENT_ID', clientSecret: 'OIDC_CLIENT_SECRET' },
  declaredConfig,
}
