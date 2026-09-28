/**
 * The placeholder Worker (plan §0.2): what the pipeline PUTs as each environment's script before
 * the app's first real build exists. It exists for what the Versions API cannot do:
 *
 * - **Durable Object migrations.** Only a script upload applies `[[migrations]]`; a version upload
 *   carrying one is refused. So the placeholder carries the toml's migrations, and exports a stub
 *   class for every DO `class_name` the migrations create.
 * - **Workflows.** `putWorkflow` points a Workflow name at a class in a script, so the class must
 *   already be exported: a stub `WorkflowEntrypoint` for every `[[workflows]] class_name`.
 * - A script for the route, the queue consumer and the secrets to attach to. Cloudflare refuses a
 *   consumer on a script with no `queue` handler (11001), so it has one: it retries every message
 *   (a message sent before the first deploy is not lost), and a no-op `scheduled`.
 *
 * Its `fetch` answers 503 "being set up" with `Retry-After`, so the host is honest until the first
 * deploy replaces the code (the version keeps the Worker's secrets: `keep_bindings`).
 *
 * Adapted from the spikes' `echoWorker` / `uploadWorker` (`spikes/lib/worker.mjs`), which is
 * reference only and never imported.
 */
import type { WorkerMetadata, WorkerModule } from '../cloudflare'
import { type DeclaredMigration, resources } from './toml'

/** Used when the toml names none; the kit pins its own. */
const FALLBACK_COMPATIBILITY_DATE = '2026-06-01'
const MAIN_MODULE = 'placeholder.js'
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export interface PlaceholderScript {
  metadata: WorkerMetadata
  modules: WorkerModule[]
  /** The newest DO migration tag this upload leaves applied (null: the toml declares none). */
  migrationTag: string | null
  /** The stub classes the module exports. */
  durableObjectClasses: string[]
  workflowClasses: string[]
}

export interface PlaceholderOptions {
  /**
   * The DO migration tag the script ALREADY has (a retried step, recorded as
   * `resources.doMigrationTag`). Only the migrations after it are sent, with `old_tag` — which is
   * what wrangler does; sending `v1` again to a script at `v1` is refused.
   */
  appliedTag?: string | null
}

/** Cloudflare's migration step shape for one toml `[[migrations]]` entry. */
function migrationStep(m: DeclaredMigration): Record<string, unknown> {
  return {
    ...(m.newClasses.length ? { new_classes: m.newClasses } : {}),
    ...(m.newSqliteClasses.length ? { new_sqlite_classes: m.newSqliteClasses } : {}),
    ...(m.deletedClasses.length ? { deleted_classes: m.deletedClasses } : {}),
    ...(m.renamedClasses.length ? { renamed_classes: m.renamedClasses } : {}),
  }
}

/** The DO classes alive after every migration: created, minus deleted, renamed followed. */
function liveDurableObjectClasses(migrations: DeclaredMigration[]): string[] {
  const live = new Set<string>()
  for (const m of migrations) {
    for (const c of [...m.newClasses, ...m.newSqliteClasses]) live.add(c)
    for (const c of m.deletedClasses) live.delete(c)
    for (const r of m.renamedClasses) {
      live.delete(r.from)
      live.add(r.to)
    }
  }
  return [...live]
}

function checkIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`"${name}" is not a class name a Worker can export`)
  return name
}

/** The module's source: stub classes, a 503 `fetch`, a retrying `queue` and a no-op `scheduled`. */
function placeholderSource(doClasses: string[], workflowClasses: string[]): string {
  const lines = [
    '// Placeholder Worker, uploaded by Launch until the first deploy replaces it.',
    "import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers'",
    '',
  ]
  for (const name of doClasses) {
    lines.push(
      `export class ${name} extends DurableObject {`,
      "  async fetch() { return new Response('Not ready', { status: 503 }) }",
      '}',
      ''
    )
  }
  for (const name of workflowClasses) {
    lines.push(
      `export class ${name} extends WorkflowEntrypoint {`,
      "  async run() { throw new Error('This app has not been deployed yet') }",
      '}',
      ''
    )
  }
  lines.push(
    'export default {',
    '  async fetch() {',
    "    return new Response('This app is being set up by Launch. Try again in a few minutes.', {",
    "      status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' },",
    '    })',
    '  },',
    // Cloudflare refuses a queue consumer on a script with no `queue` handler (11001). A message
    // sent before the first deploy is retried later, not acknowledged and lost.
    '  async queue(batch) {',
    '    batch.retryAll({ delaySeconds: 300 })',
    '  },',
    // A cron attached before the first deploy has nothing to run yet.
    '  async scheduled() {},',
    '}',
    ''
  )
  return lines.join('\n')
}

/**
 * The script upload for one environment's toml (after `writeConfig`, or before — only the
 * compatibility settings, the DO classes, the Workflow classes and the migrations are read).
 * Pass it to `CloudflareClient.putWorkerScript(accountId, workerName, metadata, modules)`.
 */
export function placeholderScript(
  tomlText: string,
  opts: PlaceholderOptions = {}
): PlaceholderScript {
  const declared = resources(tomlText)
  const doClasses = [
    ...new Set([
      ...liveDurableObjectClasses(declared.migrations),
      ...declared.durableObjects.map(d => d.className),
    ]),
  ].map(checkIdentifier)
  const workflowClasses = [...new Set(declared.workflows.map(w => w.className))]
    .filter(name => !doClasses.includes(name))
    .map(checkIdentifier)

  const applied = opts.appliedTag ?? null
  let pending = declared.migrations
  if (applied !== null) {
    const at = declared.migrations.findIndex(m => m.tag === applied)
    if (at === -1) {
      throw new Error(`The script's migration tag ${applied} is not in the toml's [[migrations]]`)
    }
    pending = declared.migrations.slice(at + 1)
  }
  const newTag = pending.at(-1)?.tag ?? null
  const migrations =
    newTag === null
      ? undefined
      : {
          ...(applied !== null ? { old_tag: applied } : {}),
          new_tag: newTag,
          steps: pending.map(migrationStep),
        }

  const metadata: WorkerMetadata = {
    main_module: MAIN_MODULE,
    compatibility_date: declared.compatibilityDate ?? FALLBACK_COMPATIBILITY_DATE,
    compatibility_flags: declared.compatibilityFlags,
    // The DO bindings the toml declares (in-script only), so the namespaces exist from day one.
    bindings: declared.durableObjects.map(d => ({
      type: 'durable_object_namespace',
      name: d.binding,
      class_name: d.className,
    })),
    ...(migrations ? { migrations } : {}),
    // A script upload replaces the Worker's bindings, secrets included: a placeholder PUT again
    // over a Worker that already holds them (a re-scaffold's `placeholders`) must keep them.
    keep_bindings: ['secret_text'],
  }
  return {
    metadata,
    modules: [{ name: MAIN_MODULE, content: placeholderSource(doClasses, workflowClasses) }],
    migrationTag: newTag ?? applied,
    durableObjectClasses: doClasses,
    workflowClasses,
  }
}
