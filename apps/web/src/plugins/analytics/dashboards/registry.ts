/**
 * This plugin's OWN dashboard templates — pure data, and importable by the browser.
 *
 * The split from `./index.ts` is a bundle boundary, not taste. `index.ts` composes in whatever
 * another installed plugin contributed (D31 decision 6) and to do that it reads the SERVER plugin
 * barrel, which drags the whole Worker — `postgres` included — into anything that imports it. The
 * UI needs a template's name and description and nothing else, so it imports this file.
 *
 * Layout rules: ./DASHBOARD_PATTERNS.md.
 */
import { GENERAL_TEMPLATES } from './general-templates'
import type { DashboardTemplate } from './types'

export const ANALYTICS_TEMPLATES: Record<string, DashboardTemplate> = {
  ...GENERAL_TEMPLATES,
}

/** One of this plugin's own templates, or null. The browser's lookup. */
export function getTemplate(key: string): DashboardTemplate | null {
  return ANALYTICS_TEMPLATES[key] ?? null
}

/** In nav order, filtered by the features this deployment holds (D30). */
export function sortTemplates(
  map: Record<string, DashboardTemplate>,
  features: readonly string[] = []
): DashboardTemplate[] {
  return Object.values(map)
    .filter(t => t.feature === undefined || features.includes(t.feature))
    .sort((a, b) => a.order - b.order)
}

export type { DashboardTemplate }
