/**
 * What Home SAYS about the catalogue — pure, so the wording is unit-tested
 * (`tests/config/home-model.test.ts`) and reuses the app page's own vocabulary (`ENV_LABEL`,
 * `notDeployedYet`, `v`) rather than a third way of describing one app.
 *
 * Everything here reads ONE catalogue row (`GET /api/apps`) — no per-app fetch. The row carries each
 * environment's health (with the version its Worker reports) and the app's latest deploy, but not
 * its releases: a release that failed before any deploy started is visible on the app page, not here.
 */
import type {
  AppCatalogueItem,
  AppEnvironmentName,
  AppEnvironmentSummary,
} from '@launch/shared/launch-apps'
import type { SetupStep, SetupStepId, SetupStepStatus } from '@launch/shared/launch-setup'
import { CONNECTION_LABELS, CONNECTION_ORDER, CONNECTION_PATHS } from '@/ui/lib/settings-paths'
import { ENV_LABEL, notDeployedYet } from '../apps/app/appPageModel'
import { v } from '../apps/components/promotionModel'

/** The one word a row shows when somebody should look. Colour for state only (docs/DESIGN.md). */
export interface Attention {
  word: string
  tone: 'error' | 'warning' | 'muted'
}

/**
 * Why an app needs a look, most urgent first — or null when it is live and nothing is moving. One
 * word per row: the health dot already says up or down. Pure.
 */
export function appAttention(
  app: Pick<AppCatalogueItem, 'status' | 'environments' | 'latestDeploy'>
): Attention | null {
  if (app.status === 'failed') return { word: 'setup failed', tone: 'error' }
  if (app.status === 'requested') return { word: 'awaiting approval', tone: 'warning' }
  if (app.status === 'provisioning') return { word: 'setting up', tone: 'muted' }
  const deploy = app.latestDeploy
  if (deploy?.phase === 'failed') {
    return { word: `${ENV_LABEL[deploy.environment]} deploy failed`, tone: 'error' }
  }
  if (deploy?.phase === 'awaiting_approval') return { word: 'awaiting approval', tone: 'warning' }
  if (deploy?.inProgress) {
    return { word: `deploying to ${ENV_LABEL[deploy.environment]}`, tone: 'muted' }
  }
  const live = environmentOf(app, 'production')
  if (!live || notDeployedYet(live)) return { word: 'not live yet', tone: 'muted' }
  return null
}

export function environmentOf(
  app: Pick<AppCatalogueItem, 'environments'>,
  name: AppEnvironmentName
): AppEnvironmentSummary | undefined {
  return app.environments.find(env => env.name === name)
}

/**
 * The version an environment runs, as its Worker last reported it (`v1.4.2`, or a build name), or
 * null before its first deploy or before the first probe that carried one. Pure.
 */
export function runningVersion(env: AppEnvironmentSummary | undefined): string | null {
  if (!env || notDeployedYet(env) || !env.healthVersion) return null
  return v(env.healthVersion)
}

const RANK: Record<Attention['tone'], number> = { error: 0, warning: 1, muted: 2 }

/**
 * Home's app rows: archived apps dropped, the ones that need somebody first (failed, then waiting
 * on a person), then by name — the catalogue arrives sorted by name. Pure.
 */
export function homeAppRows(apps: readonly AppCatalogueItem[]) {
  return apps
    .filter(app => app.status !== 'archived')
    .map(app => ({ app, attention: appAttention(app) }))
    .sort((a, b) => {
      const ra = a.attention && a.attention.tone !== 'muted' ? RANK[a.attention.tone] : 3
      const rb = b.attention && b.attention.tone !== 'muted' ? RANK[b.attention.tone] : 3
      return ra - rb || a.app.displayName.localeCompare(b.app.displayName)
    })
}

/** One line of Home's "Finish setting up Launch": a connection, its state and its page. */
export interface SetupChecklistRow {
  id: SetupStepId
  label: string
  path: string
  status: SetupStepStatus
  /** Working: `ok`, or `warning` — a choice the server flags but that works (magic link only). */
  done: boolean
}

export interface SetupChecklist {
  rows: SetupChecklistRow[]
  done: number
  total: number
  /** Every connection works: Home shows nothing. */
  complete: boolean
}

/**
 * Home's setup checklist from the setup overview's steps, in the Connections menu's order. A
 * `warning` counts as done — the count the old wizard's "n of 7 steps" made — because some are
 * deliberate (no SSO provider: people sign in by magic link) and the list must be able to go away;
 * the Connections menu still shows its dot. Pure.
 */
export function setupChecklist(steps: readonly SetupStep[]): SetupChecklist {
  const byId = new Map(steps.map(step => [step.id, step.status]))
  const rows = CONNECTION_ORDER.map(id => {
    const status = byId.get(id) ?? 'todo'
    return {
      id,
      label: CONNECTION_LABELS[id],
      path: CONNECTION_PATHS[id],
      status,
      done: status === 'ok' || status === 'warning',
    }
  })
  const done = rows.filter(row => row.done).length
  return { rows, done, total: rows.length, complete: done === rows.length }
}
