/**
 * Connections → Public URL: is Launch reachable from the internet at its public URL (`APP_URL`)?
 * The scaffold job and every app's deploy job run on GitHub and call Launch back there, so
 * creating an app (and a create's retry, and "Deploy to production") is refused while this step
 * has FAILED. The URL is the Worker's own config, so this card only reports and re-checks it;
 * "Check now" makes Launch fetch its own `/ci/ping` through that URL.
 */
import type { SetupOverview, SetupStepStatus } from '@launch/shared/launch-setup'
import { useCheckPublicUrl } from '@/ui/hooks/useSetup'
import { timeAgo } from '@/ui/lib/format'
import { CheckList } from './StatusDot'
import { StepCard } from './StepCard'

export function PublicUrlCard({
  status,
  publicUrl,
}: {
  status: SetupStepStatus
  publicUrl: SetupOverview['publicUrl']
}) {
  const check = useCheckPublicUrl()
  return (
    <StepCard
      id="public_url"
      title="Public URL"
      status={status}
      description="GitHub's runners build every app and call Launch back at this URL, so it has to be reachable from the internet. Creating an app is refused until it is."
    >
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">URL</dt>
        <dd className="break-all font-mono text-xs leading-5">{publicUrl.url}</dd>
        <dt className="text-muted">Last check</dt>
        <dd>{publicUrl.checkedAt ? timeAgo(publicUrl.checkedAt) : 'Never'}</dd>
      </dl>
      {publicUrl.checks.length > 0 && <CheckList checks={publicUrl.checks} />}
      {check.isError && (
        <p className="text-sm text-error" role="alert">
          The check could not run: {check.error.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-sm"
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? 'Checking…' : 'Check now'}
        </button>
      </div>
      <p className="text-xs text-muted">
        It is the Worker's <code>APP_URL</code>. Locally, run <code>pnpm dev:tunnel</code> and
        restart <code>pnpm dev</code> so Launch serves under the tunnel's HTTPS URL — see SETUP.md
        §1.10.
      </p>
    </StepCard>
  )
}
