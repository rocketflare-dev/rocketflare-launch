/**
 * Step 6 — how people sign in to Launch itself (spec/05). Read-only: the upstream IdP is the
 * Worker's own `GOOGLE_*` / `MICROSOFT_*` / `OIDC_*` config, set as vars and secrets at deploy
 * time, so this card reports it and says where to change it. No client secret is shown — only
 * whether one is set.
 */
import type { SetupIdentity, SetupStepStatus } from '@launch/shared/launch-setup'
import { CheckList } from './StatusDot'
import { StepCard } from './StepCard'

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  oidc: 'OIDC',
}

export function IdentityCard({
  status,
  identity,
}: {
  status: SetupStepStatus
  identity: SetupIdentity
}) {
  return (
    <StepCard
      id="identity"
      number={6}
      title="Identity provider"
      status={status}
      description="Where people sign in to Launch. Apps then sign in through Launch."
    >
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Providers</dt>
        <dd>
          {identity.providers.length > 0
            ? identity.providers.map(p => PROVIDER_LABELS[p] ?? p).join(', ')
            : 'Magic link only'}
        </dd>
        {identity.oidc && (
          <>
            <dt className="text-muted">OIDC issuer</dt>
            <dd className="break-all">{identity.oidc.issuer}</dd>
            <dt className="text-muted">Client id</dt>
            <dd className="break-all">{identity.oidc.clientId}</dd>
            <dt className="text-muted">Client secret</dt>
            <dd>{identity.oidc.hasClientSecret ? 'Set' : 'Not set'}</dd>
          </>
        )}
        <dt className="text-muted">SSO only</dt>
        <dd>{identity.oidcOnly ? 'Yes' : 'No — other sign-in methods are offered too'}</dd>
      </dl>
      <CheckList checks={identity.checks} />
      <p className="text-xs text-muted">
        Change it in the Worker's configuration (<code>OIDC_*</code>, <code>GOOGLE_*</code>,{' '}
        <code>MICROSOFT_*</code>) and redeploy — see SETUP.md.
      </p>
    </StepCard>
  )
}
