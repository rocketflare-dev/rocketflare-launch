/**
 * A ship in flight as the app's lists say it — the session summary's DERIVED `shipping`
 * (`sessionShippingOf` in `@launch/shared/launch-sessions`), which outlives the container: after
 * the merge the row is `shipped` while its landing still releases and deploys. The words match the
 * ship panel's steps (`sessionChatModel.ts`'s `stepLabel`, `STALLED_TEXT`), shortened for a row.
 *
 * Pure and light on purpose: the app page's Overview and Sessions tab import it, and neither may
 * pull the session page's chunk in with it.
 */
import type { SessionShipping } from '@launch/shared/launch-sessions'

/** `v1.4.2` — a version as people write it. */
const versionText = (version: string) => (version.startsWith('v') ? version : `v${version}`)

/** Where the ship stands, in a few words: "Waiting for a review", "Deploying v1.4.2 to staging". */
export function shippingStageText(
  shipping: Pick<SessionShipping, 'stage' | 'stalledReason' | 'version'>
): string {
  switch (shipping.stage) {
    case 'ci':
      return 'Waiting for CI'
    case 'approval':
      return 'Waiting for a review'
    case 'merging':
      return 'Merging'
    case 'releasing':
      return 'Merged, cutting a release'
    case 'deploying':
      return shipping.version
        ? `Deploying ${versionText(shipping.version)} to staging`
        : 'Deploying to staging'
    case 'stalled':
      return shipping.stalledReason === 'main_ci_failed'
        ? 'Merged, but CI failed on main'
        : 'Merged, but the release failed'
    default:
      return 'Shipping'
  }
}
