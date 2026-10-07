/**
 * Hand-written types for `cli-parity-nudge.mjs` (the workspace has no `allowJs`). Keep in step with
 * the exports there.
 */
export interface ParityChange {
  kind: 'route' | 'ui'
  file: string
  routes: string[]
}
export function isRouteFile(filePath: string): boolean
export function isUiHookFile(filePath: string): boolean
export function parityChange(payload: unknown): ParityChange | null
export function parityReminder(change: ParityChange): string
export function hookJson(message: string, notice?: string): string
