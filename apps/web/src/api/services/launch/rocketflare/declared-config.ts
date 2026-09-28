/**
 * The Rocketflare adapter's `declaredConfig` (spec/02, Launch P5 plan §1.14, §4 5e): what an app
 * says it needs, read-only from files the kit already writes —
 *
 * `launch.plugins.json` / `.rocketflare.json` `surfaces[]` (the `kind: 'plugin'` ones) → each
 * `anchor` (`plugin.json`) → `vars[]`, parsed the way `scripts/lib/plugin-lib.mjs` validates them
 * (`{ key | name, example?, secret? }` or a bare string), plus the kit's own optional secrets
 * (`ANTHROPIC_API_KEY`, `LANGFUSE_*`, …) filed under `KIT_CONFIG_PLUGIN_ID`.
 *
 * **Lenient, like the manifest reader.** Both manifest names are read (a kit app records its plugins
 * in `.rocketflare.json`, a renamed Launch-style copy in `launch.plugins.json`) and their plugin
 * surfaces merged by anchor. A manifest or `plugin.json` that is not JSON, a surface with no anchor
 * and a var entry that names no key are skipped, never thrown — one bad plugin must not hide the
 * others' needs. A repo with no manifest at all is not a Rocketflare app: nothing is declared. A
 * READ that fails (GitHub answering 500) does throw — the caller records it and keeps the previous
 * scan rather than storing a half-read as the truth.
 *
 * `read(path)` answers a repo file's text at the scanned ref, or null when it is absent — the
 * caller (`grants/detect.ts`) binds it to GitHub, a test to a fixture map.
 */
import { type DeclaredConfigItem, KIT_CONFIG_PLUGIN_ID } from '@launch/shared/launch-grants'
import { MANIFEST_PATHS } from '../rocketflare-manifest'

export type RepoFileReader = (path: string) => Promise<string | null>

/**
 * The kit's optional config (spec/02): the AI providers and the observability exporters. Each is a
 * candidate for a company-wide shared resource ("the Anthropic key"), so detection reports them
 * like a plugin's vars. The kit's REQUIRED secrets (`OAUTH_ENCRYPTION_KEY`, `DATABASE_URL`, …) are
 * Launch's to set per app (`ROCKETFLARE_WORKER_SECRETS`) and never shared.
 */
export const KIT_OPTIONAL_CONFIG: readonly Omit<DeclaredConfigItem, 'pluginId'>[] = [
  { key: 'ANTHROPIC_API_KEY', secret: true },
  { key: 'EMBEDDINGS_API_KEY', secret: true },
  { key: 'FIREWORKS_API_KEY', secret: true },
  { key: 'GEMINI_API_KEY', secret: true },
  { key: 'LANGFUSE_PUBLIC_KEY', secret: false },
  { key: 'LANGFUSE_SECRET_KEY', secret: true },
  { key: 'OTEL_EXPORTER_OTLP_ENDPOINT', secret: false },
  { key: 'OTEL_EXPORTER_OTLP_HEADERS', secret: true },
]

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
function pluginSurfaces(manifest: Json): PluginSurface[] {
  const surfaces = Array.isArray(manifest.surfaces) ? manifest.surfaces : []
  return surfaces.flatMap(raw => {
    const surface = asObject(raw)
    if (!surface || surface.kind !== 'plugin') return []
    const id = nonEmpty(surface.id)
    if (!id) return []
    const anchor = nonEmpty(surface.anchor) ?? `apps/web/src/plugins/${id}/plugin.json`
    return [{ id, anchor }]
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

/** Every key the app declares, plugins first (in manifest order), then the kit's optional ones. */
export async function declaredConfig(read: RepoFileReader): Promise<DeclaredConfigItem[]> {
  const surfaces = new Map<string, PluginSurface>()
  let sawManifest = false
  for (const path of MANIFEST_PATHS) {
    const text = await read(path)
    if (text === null) continue
    sawManifest = true
    const manifest = parseObject(text)
    if (!manifest) continue
    for (const surface of pluginSurfaces(manifest)) {
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
  for (const item of KIT_OPTIONAL_CONFIG) {
    if (!pluginKeys.has(item.key)) add({ ...item, pluginId: KIT_CONFIG_PLUGIN_ID })
  }
  return out
}
