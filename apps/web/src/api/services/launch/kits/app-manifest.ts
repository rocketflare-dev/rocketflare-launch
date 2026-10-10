/**
 * The adapter's READ side (spec/02, D36): what an app's own repo says about it. Pure functions over
 * file text — the import service and the pipeline fetch the files, this module understands them —
 * so the parsing is testable against real tomls with no GitHub in the way. Which FILES to read is
 * the app's kit's business (`TemplateAdapter.paths`: the manifest's `scaffold.appManifest` and
 * `worker.tomls`); how to read them is the same for every kit.
 *
 * - **The app manifest is read leniently.** It carries `app {slug, display, domain}` and
 *   `kit {version, commit}` (`scaffold.appManifest` — Rocketflare's `.rocketflare.json`); the older
 *   Launch-style `launch.plugins.json` carries the same `app` block and a top-level `kitVersion`.
 *   Either shape is accepted, unknown keys are ignored, and a file that is not JSON (or not an
 *   object) is a `ManifestError` the caller turns into a 422.
 * - **The tomls are parsed with `smol-toml`**, never a regex: the name, the app-URL var
 *   (`launchProvides.appUrl`, `APP_URL` by default) and `APP_ENV`, and the ids of every binding the
 *   Worker declares. A kit placeholder (`<KV_RATE_LIMIT_ID>`) is NOT an id — it is reported in
 *   `placeholders` and left out of the resources, because spec/06 records ids so they can be acted
 *   on later, and a placeholder cannot.
 */
import {
  type AppEnvironmentResources,
  type RocketflareManifest,
  rocketflareManifestSchema,
} from '@launch/shared/launch-apps'
import { parse as parseToml } from 'smol-toml'

/**
 * The Rocketflare fallback's app-manifest names, in the order the import tries them — its
 * `scaffold.appManifest` and the legacy Launch-style file (`rocketflare-fallback.ts`). Launch's code
 * reads `TemplateAdapter.paths.manifests`; this constant spells out the fallback's for its tests.
 */
export const MANIFEST_PATHS = ['.rocketflare.json', 'launch.plugins.json'] as const

/** The Rocketflare fallback's `worker.tomls` (code reads `TemplateAdapter.paths.tomls`). */
export const WRANGLER_PATHS = {
  production: 'apps/web/wrangler.toml',
  staging: 'apps/web/wrangler.staging.toml',
} as const

/** A file that exists but cannot be understood. `file` is the repo path, for the 422. */
export class ManifestError extends Error {
  constructor(
    readonly file: string,
    message: string
  ) {
    super(message)
    this.name = 'ManifestError'
  }
}

export interface AppIdentity {
  slug: string | null
  displayName: string | null
  domain: string | null
  /** `kit.version`, else `kitVersion`. */
  kitVersion: string | null
  kitCommit: string | null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** {@link AppIdentity} plus the kit the copy says it came from. */
export interface AppManifestIdentity extends AppIdentity {
  /** `kit.id`, else `kit.name` (a Rocketflare copy made before the kit wrote `id`); null if none. */
  kitId: string | null
}

/**
 * Parse either manifest shape. Throws `ManifestError` on anything that is not a JSON object;
 * `kitName` only words that error (the adapter passes its kit's `kit.name`).
 */
export function parseManifest(
  text: string,
  file: string = MANIFEST_PATHS[0],
  kitName = 'Rocketflare'
): AppIdentity {
  const { kitId: _, ...identity } = parseAppManifest(text, file, kitName)
  return identity
}

/** {@link parseManifest}, with the copy's `kit.id` (or legacy `kit.name`). */
export function parseAppManifest(
  text: string,
  file: string = MANIFEST_PATHS[0],
  kitName = 'Rocketflare'
): AppManifestIdentity {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new ManifestError(file, `${file} is not valid JSON`)
  }
  const parsed = rocketflareManifestSchema.safeParse(json)
  if (!parsed.success || typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ManifestError(file, `${file} is not a ${kitName} manifest`)
  }
  const manifest: RocketflareManifest = parsed.data
  return {
    slug: nonEmpty(manifest.app?.slug),
    displayName: nonEmpty(manifest.app?.display),
    domain: nonEmpty(manifest.app?.domain),
    kitVersion: nonEmpty(manifest.kit?.version) ?? nonEmpty(manifest.kitVersion),
    kitCommit: nonEmpty(manifest.kit?.commit),
    kitId: nonEmpty(manifest.kit?.id) ?? nonEmpty(manifest.kit?.name),
  }
}

export interface WranglerEnvironment {
  /** The Worker's `name`. */
  workerName: string | null
  /** The app-URL var, normalised to an origin-ish URL with no trailing slash; null if absent. */
  url: string | null
  /** `[vars].APP_ENV`, as written. */
  appEnv: string | null
  resources: AppEnvironmentResources
  /** Every `<PLACEHOLDER>` value found where an id belongs — the app is not provisioned there. */
  placeholders: string[]
}

type Table = Record<string, unknown>

function asTable(value: unknown): Table | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Table)
    : null
}

function tables(value: unknown): Table[] {
  return Array.isArray(value) ? value.map(asTable).filter((t): t is Table => t !== null) : []
}

function str(table: Table, key: string): string | null {
  return nonEmpty(table[key])
}

const PLACEHOLDER_RE = /^<[^>]+>$/

/** `https://x.example.com/` → `https://x.example.com`; anything not http(s) → null. */
function normaliseUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/**
 * Parse one wrangler toml. Throws `ManifestError` when the text is not TOML. `appUrlVar` is the
 * kit's name for the app's URL (`launchProvides.appUrl`).
 */
export function parseWranglerToml(
  text: string,
  file: string,
  appUrlVar = 'APP_URL'
): WranglerEnvironment {
  let doc: Table
  try {
    doc = parseToml(text) as Table
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : 'parse error'
    throw new ManifestError(file, `${file} is not valid TOML: ${detail}`)
  }
  const placeholders: string[] = []
  /** The value, or null (and remembered) when it is a kit placeholder. */
  const real = (value: string | null): string | null => {
    if (value && PLACEHOLDER_RE.test(value)) {
      placeholders.push(value)
      return null
    }
    return value
  }

  const vars = asTable(doc.vars) ?? {}
  const resources: AppEnvironmentResources = {}

  const kv = tables(doc.kv_namespaces).flatMap(t => {
    const binding = str(t, 'binding')
    const id = real(str(t, 'id'))
    return binding && id ? [{ binding, id }] : []
  })
  if (kv.length) resources.kv = kv

  const queues = tables(asTable(doc.queues)?.producers).flatMap(t => {
    const binding = str(t, 'binding')
    const queue = real(str(t, 'queue'))
    return binding && queue ? [{ binding, queue }] : []
  })
  if (queues.length) resources.queues = queues

  const r2 = tables(doc.r2_buckets).flatMap(t => {
    const binding = str(t, 'binding')
    const bucketName = real(str(t, 'bucket_name'))
    return binding && bucketName ? [{ binding, bucketName }] : []
  })
  if (r2.length) resources.r2 = r2

  const durableObjects = tables(asTable(doc.durable_objects)?.bindings).flatMap(t => {
    const binding = str(t, 'name')
    const className = str(t, 'class_name')
    return binding && className ? [{ binding, className }] : []
  })
  if (durableObjects.length) resources.durableObjects = durableObjects

  const workflows = tables(doc.workflows).flatMap(t => {
    const binding = str(t, 'binding')
    const name = real(str(t, 'name'))
    const className = str(t, 'class_name')
    return binding && name && className ? [{ binding, name, className }] : []
  })
  if (workflows.length) resources.workflows = workflows

  const hyperdrive = tables(doc.hyperdrive).flatMap(t => {
    const binding = str(t, 'binding')
    const id = real(str(t, 'id'))
    return binding && id ? [{ binding, id }] : []
  })
  if (hyperdrive.length) resources.hyperdrive = hyperdrive

  return {
    workerName: real(str(doc, 'name')),
    url: normaliseUrl(real(str(vars, appUrlVar))),
    appEnv: str(vars, 'APP_ENV'),
    resources,
    placeholders,
  }
}
