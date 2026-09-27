/**
 * Hand-written types for `rename-lib.mjs` (the workspace has no `allowJs`). Keep in step with
 * the exports there; `apps/web/tests/config/rename-lib.test.ts` is what typechecks against this.
 */

export interface KitNames {
  readonly slug: string
  readonly upper: string
  readonly display: string
  readonly domains: readonly string[]
  readonly preserved: readonly string[]
}
export const KIT: KitNames

export const SLUG_RE: RegExp
export const HEX_COLOUR_RE: RegExp

export function validateSlug(slug: unknown): string | null
export function titleCase(slug: string): string

export interface DeriveOptions {
  domain?: string
  colour?: string
}
export interface Names {
  readonly slug: string
  readonly snake: string
  readonly upper: string
  readonly display: string
  readonly domain: string
  /** `<snake>_` — the API-key prefix as stored. */
  readonly prefix: string
  readonly colour: string | null
}
export function deriveNames(slug: string, display?: string, options?: DeriveOptions): Names

export type ClassId =
  | 'scope'
  | 'env'
  | 'domain'
  | 'cfgdir'
  | 'dbuser'
  | 'snake'
  | 'kebab'
  | 'display'
  | 'bare'
export interface ReplacementClass {
  id: ClassId
  label: string
  pattern: RegExp
  replacement: string
}
export function buildReplacements(names: Names): ReplacementClass[]
export const CLASS_IDS: readonly ClassId[]

export interface ReplacementResult {
  /** The same string instance as the input when nothing matched. */
  text: string
  counts: Record<ClassId, number>
  total: number
  /** Occurrences of `KIT.preserved` literals that were protected. */
  preserved: number
}
export function applyReplacements(text: string, names: Names): ReplacementResult

export function isBinary(buffer: Uint8Array): boolean
