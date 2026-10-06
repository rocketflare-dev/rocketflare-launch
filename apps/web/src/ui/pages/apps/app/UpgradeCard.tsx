/**
 * The kit on the Overview (P6 6c): shown only while the app requires an upgrade or one is open.
 *
 * - **Behind, nothing open**: "Requires upgrade → 0.16.1", the version it is on, the target
 *   release's porting note, and **Upgrade** — for the app's owners and admins who may start a
 *   session (`viewerCanDeploy` + `useCanStartSession`, the server's rule). It starts a coding
 *   session that runs the kit upgrade and ships it, and opens that session, as "Fix in a session"
 *   does. A refusal says why in a toast.
 * - **An upgrade open**: where it stands in words, the PR when there is one, why it needs the
 *   owner when it does, and the session it runs in. Issue #22: once its session ships, the
 *   sentence follows the landing (`shipping` on the active sessions list) — "merged, releasing to
 *   staging" rather than "merge it and release" — and once the release records the kit, it says
 *   the app is on the new version.
 * - **The last attempt** that ended without a release (failed, cancelled) is one line under the
 *   button, so a second click knows what happened to the first.
 *
 * Plain text, one row of actions, no panel and no badge — `docs/DESIGN.md`.
 */

import type { SessionShipping } from '@launch/shared/launch-sessions'
import { shippingSummaryText } from '@launch/shared/launch-ship-progress'
import {
  APP_UPGRADE_STATUS_LABELS,
  type AppUpgrade,
  type KitStatus,
  requiresUpgradeLabel,
  UPGRADE_STOPPED_NEXT_STEP,
} from '@launch/shared/launch-upgrades'
import { Link, useNavigate } from 'react-router-dom'
import { showToast } from '@/ui/components/shared'
import { useAppSessions } from '@/ui/hooks/useSessions'
import { useAppUpgrades, useStartUpgrade } from '@/ui/hooks/useUpgrades'
import { startRefusal } from '../components/SessionsCard'
import { appPath } from './appPageModel'
import { ExternalLink, SectionHeading } from './bits'
import { useAppPage } from './context'
import { useCanStartSession } from './ReleaseActions'

/** Whether the card has anything to say. Pure. */
export function showUpgradeCard(kit: KitStatus | null | undefined): kit is KitStatus {
  return Boolean(kit && (kit.behind || kit.openUpgrade))
}

/**
 * The open upgrade in one sentence — following its session's ship when that is in flight
 * (`shipping`), and saying so once the kit reads the new version (`current`). Pure.
 */
export function openUpgradeSentence(
  upgrade: AppUpgrade,
  shipping: Pick<SessionShipping, 'stage' | 'stalledReason' | 'version' | 'mainCi'> | null = null,
  current: string | null = null
): string {
  const to = `to ${upgrade.toVersion}`
  if (current && current === upgrade.toVersion) return `The app is on ${upgrade.toVersion}.`
  if (shipping) {
    switch (shipping.stage) {
      case 'ci':
      case 'approval':
        return `The upgrade ${to} is shipping: ${shippingSummaryText(shipping).toLowerCase()}. Launch merges it when that’s done.`
      case 'merging':
      case 'releasing':
        return `The upgrade ${to} is merged, releasing to staging.`
      case 'deploying':
        return `The upgrade ${to} is merged and released, deploying to staging.`
      case 'stalled':
        return `The upgrade ${to} is merged, but it isn’t on staging yet: ${shippingSummaryText(shipping).toLowerCase()}.`
      default:
        break
    }
  }
  switch (upgrade.status) {
    case 'queued':
      return `An upgrade ${to} is queued.`
    case 'running':
      return `Upgrading ${to}: a coding session is running the kit upgrade and will ship it.`
    case 'pr_open':
      return `The upgrade ${to} is in a pull request. Merge it and release to record the new kit.`
    case 'needs_attention':
      return `The upgrade ${to} needs its owner. ${UPGRADE_STOPPED_NEXT_STEP}`
    default:
      return `Upgrade ${to}: ${APP_UPGRADE_STATUS_LABELS[upgrade.status].toLowerCase()}.`
  }
}

/** The last finished attempt worth mentioning (failed or cancelled, not the open one). Pure. */
export function lastEndedUpgrade(items: readonly AppUpgrade[]): AppUpgrade | null {
  const last = items[0]
  return last && (last.status === 'failed' || last.status === 'cancelled') ? last : null
}

export function UpgradeCard({ kit }: { kit: KitStatus }) {
  const { app } = useAppPage()
  const canStart = useCanStartSession()
  const start = useStartUpgrade(app.id)
  const navigate = useNavigate()
  const history = useAppUpgrades(app.id, kit.behind && !kit.openUpgrade)
  const open = kit.openUpgrade
  // The same active list the Overview reads (one request): the upgrade's ship, once in flight.
  const sessions = useAppSessions(open?.sessionId ? app.id : undefined, 'active')
  const shipping = sessions.data?.items.find(s => s.id === open?.sessionId)?.shipping ?? null
  const sessionPath = (id: string) => `${appPath(app.slug)}/sessions/${id}`
  const ended = !open ? lastEndedUpgrade(history.data?.items ?? []) : null
  const label = requiresUpgradeLabel(kit)

  const upgrade = () =>
    start.mutate(undefined, {
      onSuccess: ({ sessionId }) => navigate(sessionPath(sessionId)),
      onError: err => {
        const refusal = startRefusal(err)
        showToast(refusal.message, refusal.tone === 'info' ? 'info' : 'error')
      },
    })

  return (
    <section aria-labelledby="kit-title" className="space-y-1.5">
      <SectionHeading
        id="kit-title"
        actions={
          !open &&
          kit.behind &&
          canStart &&
          app.viewerCanDeploy && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={start.isPending}
              onClick={upgrade}
            >
              {start.isPending && <span className="loading loading-spinner loading-xs" />}
              Upgrade
            </button>
          )
        }
      >
        Kit
      </SectionHeading>
      {label && (
        <p className="text-sm">
          {label}
          <span className="text-secondary">
            {' '}
            · on <span className="font-mono tabular-nums">{kit.current}</span>
          </span>
          {kit.notesUrl && (
            <>
              {' '}
              · <ExternalLink href={kit.notesUrl}>Release notes</ExternalLink>
            </>
          )}
        </p>
      )}
      {open && (
        <div className="text-sm space-y-1">
          <p data-testid="upgrade-sentence">{openUpgradeSentence(open, shipping, kit.current)}</p>
          {open.status === 'needs_attention' && open.error && (
            <p className="text-secondary">{open.error}</p>
          )}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {open.prUrl && open.prNumber && (
              <ExternalLink href={open.prUrl}>Pull request #{open.prNumber}</ExternalLink>
            )}
            {open.sessionId && (
              <Link to={sessionPath(open.sessionId)} className="link link-hover">
                Open the session →
              </Link>
            )}
          </p>
        </div>
      )}
      {ended && (
        <p className="text-xs text-muted">
          The last upgrade to {ended.toVersion} was {ended.status}
          {ended.error ? `: ${ended.error}` : '.'}
        </p>
      )}
      {!open && kit.behind && !app.viewerCanDeploy && (
        <p className="text-xs text-muted">The app's owners and admins can upgrade it.</p>
      )}
    </section>
  )
}
