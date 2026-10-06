/**
 * Hand-written types for `upgrade-lib.mjs` (the workspace has no `allowJs`). Keep in step with
 * the exports there; `apps/web/tests/config/upgrade-lib.test.ts` is what typechecks against this.
 */
import type { Names } from './rename-lib.d.mts'

export type SurfaceKind = 'plugin'
export interface PluginSource {
  /** Canonical git URL — never null for a `kind: 'plugin'` surface. */
  repo: string
  subdir?: string
  version?: string
  commit?: string | null
}
export interface Surface {
  id: string
  kind: SurfaceKind
  label: string
  /** Presence of this one file decides whether the surface is in the app at all. */
  anchor: string
  paths: string[]
  registries: string[]
  /** Where the plugin came from (D31). */
  source?: PluginSource
  installedAt?: string
  /**
   * The oldest kit release this plugin supports — one version, no ceiling (D31). `null` when the
   * plugin declared none, which means no kit version is ever checked against it.
   */
  minKit?: string | null
  requires?: {
    surfaces?: string[]
    plugins?: Array<string | { id: string; minVersion?: string | null }>
  }
  /**
   * Per host package, the dependencies this plugin brought into the host (absent before it).
   * Missing on a plugin installed before the record was kept — `plugin upgrade` then removes none
   * of its packages.
   */
  addedDependencies?: Record<string, string[]>
  history?: HistoryEntry[]
}
export interface AppBlock {
  slug: string
  display: string
  domain: string
}
export interface HistoryEntry {
  from: string
  to: string
  at: string
}
/** `launch.plugins.json` — the plugins installed in Launch. */
export interface Manifest {
  /** Prose for whoever finds this file and wonders what it is. */
  $purpose: string
  /** The kit plugin-API level a plugin's `minKit` is checked against. */
  kitVersion?: string
  /** Launch's names, which a plugin is translated into on the way in. */
  app: AppBlock | null
  surfaces: Surface[]
}

/** `app === null` means the checkout is the kit itself; never true in Launch. */
export function isKitManifest(manifest: Manifest | null): boolean

/** What `git diff --name-status` says happened to a file. */
export type Change = 'added' | 'modified' | 'deleted' | 'binary'

export interface DiffBlock {
  header: string
  raw: string
}
export function splitDiff(patchText: string): DiffBlock[]
export class BinaryPatchError extends Error {}
export function translateBlock(
  block: DiffBlock,
  /** null: the kit itself — nothing is translated. */
  names: Names | null,
  options?: { translate?: boolean }
): string
export function countLines(text: string): number
export function stripIndexLines(text: string): string

export interface NoteFrontmatter {
  version: string
  previous: string | null
  date: string
  breaking: boolean
  migrations: string[]
  areas: string[]
  touches_surfaces: string[]
  requires_surfaces: string[]
  manual: boolean
}
export interface ParsedNote {
  data: Record<string, unknown> & Partial<NoteFrontmatter>
  body: string
}
export function parseNote(text: string): ParsedNote | null

export function compareVersions(a: string, b: string): -1 | 0 | 1
export const VERSION_RE: RegExp

/**
 * True when a plugin ships inside the kit itself (`source.repo` is the kit's, no subdirectory).
 * The ONE implementation; `plugin-lib.mjs` re-exports it.
 */
export function isVendored(
  source: { repo?: string | null; subdir?: string | null } | null | undefined,
  kitRepo: string | null | undefined
): boolean
