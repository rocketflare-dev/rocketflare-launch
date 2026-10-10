/**
 * The adapter's `declaredConfig` (spec/02, Launch P5 plan §1.14, §4 5e, D36 `declaredConfig`): what
 * an app says it needs, read-only from files the kit already writes —
 *
 * the app manifest's `surfaces[]` (the `kind: 'plugin'` ones — `pnpm plugin add` records them) →
 * each `anchor` (`plugin.json`; absent, the kit's `declaredConfig.pluginManifests` glob with the
 * plugin's id for its `*`) → `vars[]`, parsed the way `scripts/lib/plugin-lib.mjs` validates them
 * (`{ key | name, example?, secret? }` or a bare string), plus the kit's own optional config
 * (`declaredConfig.optional` — Rocketflare's `ANTHROPIC_API_KEY`, `LANGFUSE_*`, …; secret unless
 * listed in `plain`) filed under `KIT_CONFIG_PLUGIN_ID`.
 *
 * **Lenient, like the manifest reader.** Every app-manifest name the adapter knows is read (a
 * Rocketflare app records its plugins in `.rocketflare.json`, a renamed Launch-style copy in
 * `launch.plugins.json`) and their plugin surfaces merged by anchor. A manifest or `plugin.json`
 * that is not JSON, a surface with no anchor and a var entry that names no key are skipped, never
 * thrown — one bad plugin must not hide the others' needs. A repo with no app manifest at all is not
 * an app of the kit: nothing is declared. A READ that fails (GitHub answering 500) does throw — the
 * caller records it and keeps the previous scan rather than storing a half-read as the truth.
 *
 * `read(path)` answers a repo file's text at the scanned ref, or null when it is absent — the
 * caller (`grants/detect.ts`) binds it to GitHub, a test to a fixture map.
 */
import type { KitManifest } from '@launch/shared/kit-manifest'
import { type DeclaredConfigItem, KIT_CONFIG_PLUGIN_ID } from '@launch/shared/launch-grants'
import { MANIFEST_PATHS } from './app-manifest'
import { rocketflareFallbackManifest } from './rocketflare-fallback'

export type RepoFileReader = (path: string) => Promise<string | null>

/** What `declaredConfig` reads a kit's app by: its manifest's block and the app-manifest names. */
export interface DeclaredConfigSource {
  manifest: Pick<KitManifest, 'declaredConfig'>
  /** The app-manifest files to read, in order (`TemplateAdapter.paths.manifests`). */
  manifests: readonly string[]
}

const FALLBACK: DeclaredConfigSource = {
  manifest: rocketflareFallbackManifest(),
  manifests: MANIFEST_PATHS,
}

/**
 * A kit's optional config (spec/02, `declaredConfig.optional`): Rocketflare's AI providers and
 * observability exporters. Each is a candidate for a company-wide shared resource ("the Anthropic
 * key"), so detection reports them like a plugin's vars. The kit's REQUIRED secrets (the generated
 * key, `DATABASE_URL`, …) are Launch's to set per app (`TemplateAdapter.secretTargets`) and never
 * shared.
 */
export function optionalConfigOf(
  manifest: Pick<KitManifest, 'declaredConfig'>
): Omit<DeclaredConfigItem, 'pluginId'>[] {
  const plain = new Set(manifest.declaredConfig.plain)
  return manifest.declaredConfig.optional.map(key => ({ key, secret: !plain.has(key) }))
}

/** The Rocketflare fallback's optional config. */
export const KIT_OPTIONAL_CONFIG: readonly Omit<DeclaredConfigItem, 'pluginId'>[] =
  optionalConfigOf(FALLBACK.manifest)

/** A plugin's default `plugin.json`: the kit's glob with the id for its first `*`. */
function defaultAnchor(glob: string | undefined, id: string): string | null {
  return glob?.includes('*') ? glob.replace('*', id) : null
}

type Json = Record<string, unknown>

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** JSON text as an object, or null when it is not one. */
function parseObject(text: string): Json | null {
  try {
    return asObject(JSON.parse(text))
  } catch {
    return null
  }
}

interface PluginSurface {
  id: string
  anchor: string
}

/** A manifest's plugin surfaces — the default anchor is the kit's, as `buildPluginSurface` writes it. */
function pluginSurfaces(manifest: Json, glob: string | undefined): PluginSurface[] {
  const surfaces = Array.isArray(manifest.surfaces) ? manifest.surfaces : []
  return surfaces.flatMap(raw => {
    const surface = asObject(raw)
    if (!surface || surface.kind !== 'plugin') return []
    const id = nonEmpty(surface.id)
    if (!id) return []
    const anchor = nonEmpty(surface.anchor) ?? defaultAnchor(glob, id)
    return anchor ? [{ id, anchor }] : []
  })
}

/**
 * One `plugin.json`'s `vars[]` — a bare string is a var; an object's key is `key`, else `name`;
 * `secret` counts only when it is `true` (the kit's validator refuses a non-boolean, so a stray
 * `"true"` is treated as the plain var it would have been rejected as).
 */
export function parsePluginVars(manifest: Json, pluginId: string): DeclaredConfigItem[] {
  const vars = Array.isArray(manifest.vars) ? manifest.vars : []
  const out: DeclaredConfigItem[] = []
  for (const entry of vars) {
    const object = asObject(entry)
    const key = object ? (nonEmpty(object.key) ?? nonEmpty(object.name)) : nonEmpty(entry)
    if (!key) continue
    const example = object ? nonEmpty(object.example) : null
    out.push({
      key,
      secret: object?.secret === true,
      pluginId,
      ...(example ? { example } : {}),
    })
  }
  return out
}

/**
 * Every key the app declares, plugins first (in manifest order), then the kit's optional ones.
 * `source` is the app's kit (the Rocketflare fallback by default).
 */
export async function declaredConfig(
  read: RepoFileReader,
  source: DeclaredConfigSource = FALLBACK
): Promise<DeclaredConfigItem[]> {
  const surfaces = new Map<string, PluginSurface>()
  const glob = source.manifest.declaredConfig.pluginManifests
  let sawManifest = false
  for (const path of source.manifests) {
    const text = await read(path)
    if (text === null) continue
    sawManifest = true
    const manifest = parseObject(text)
    if (!manifest) continue
    for (const surface of pluginSurfaces(manifest, glob)) {
      if (!surfaces.has(surface.anchor)) surfaces.set(surface.anchor, surface)
    }
  }
  if (!sawManifest) return []

  const out: DeclaredConfigItem[] = []
  const seen = new Set<string>()
  const add = (item: DeclaredConfigItem) => {
    const id = `${item.pluginId}\u0000${item.key}`
    if (seen.has(id)) return
    seen.add(id)
    out.push(item)
  }
  for (const surface of surfaces.values()) {
    const text = await read(surface.anchor)
    if (text === null) continue
    const manifest = parseObject(text)
    if (!manifest) continue
    const pluginId = nonEmpty(manifest.id) ?? surface.id
    for (const item of parsePluginVars(manifest, pluginId)) add(item)
  }
  // A key a plugin already declares is that plugin's need, not the kit's.
  const pluginKeys = new Set(out.map(item => item.key))
  for (const item of optionalConfigOf(source.manifest)) {
    if (!pluginKeys.has(item.key)) add({ ...item, pluginId: KIT_CONFIG_PLUGIN_ID })
  }
  return out
}
