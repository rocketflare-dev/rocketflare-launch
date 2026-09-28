/**
 * `/admin/setup` (spec/03, spec/04): the setup wizard — a stepper over seven cards, in the order a
 * company sets Launch up: the apps domain and zone, then the Cloudflare, Neon, Resend and GitHub
 * App credentials Launch acts with, then the upstream IdP (read-only), then whether Launch's own
 * public URL is reachable from the internet (the CI jobs call it back). Global admin (the `/admin`
 * layout's guard; the server's `globalAdminMiddleware`).
 *
 * Secrets are WRITE-ONLY: the API never returns one, so a set credential shows "Set — hidden" and
 * a "Replace" action, never a value. Every dot comes from the overview the server computed from
 * the stored check results; nothing here decides a status on its own.
 */
import {
  type CredentialKind,
  DEFAULT_NEON_REGION,
  NEON_REGIONS,
  type SetupOverview,
  type SetupStepId,
  type SetupStepStatus,
} from '@launch/shared/launch-setup'
import { SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useSetupOverview } from '@/ui/hooks/useSetup'
import { CredentialCard } from './setup/CredentialCard'
import { DomainCard } from './setup/DomainCard'
import { IdentityCard } from './setup/IdentityCard'
import { PublicUrlCard } from './setup/PublicUrlCard'
import { StatusDot, statusLabel } from './setup/StatusDot'
import { stepAnchor } from './setup/StepCard'

const STEP_TITLES: Record<SetupStepId, string> = {
  domain: 'Domain & zone',
  cloudflare: 'Cloudflare',
  neon: 'Neon',
  resend: 'Resend',
  github: 'GitHub App',
  identity: 'Identity provider',
  public_url: 'Public URL',
}

const STEP_CLASS: Record<SetupStepStatus, string> = {
  ok: 'step-success',
  warning: 'step-warning',
  failed: 'step-error',
  unchecked: '',
  todo: '',
}

function Stepper({ steps }: { steps: SetupOverview['steps'] }) {
  return (
    <nav aria-label="Setup steps">
      <ul className="steps steps-vertical sm:steps-horizontal w-full">
        {steps.map(step => (
          <li key={step.id} className={`step ${STEP_CLASS[step.status]}`}>
            <a href={`#${stepAnchor(step.id)}`} className="link link-hover text-sm">
              {STEP_TITLES[step.id]}
              <span className="sr-only">: {statusLabel(step.status)}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function credential(overview: SetupOverview, kind: CredentialKind) {
  const found = overview.credentials.find(c => c.kind === kind)
  if (!found) throw new Error(`no status for ${kind}`)
  return found
}

export default function Setup() {
  const { data, isLoading, isError } = useSetupOverview()

  if (isLoading) {
    return (
      <SectionPanel title="Setup">
        <SkeletonRows rows={6} />
      </SectionPanel>
    )
  }
  if (isError || !data) {
    return (
      <SectionPanel title="Setup">
        <div className="alert alert-error text-sm">The setup status could not be loaded.</div>
      </SectionPanel>
    )
  }

  const status = (id: SetupStepId) => data.steps.find(s => s.id === id)?.status ?? 'todo'
  const done = data.steps.filter(s => s.status === 'ok' || s.status === 'warning').length

  return (
    <div className="space-y-6">
      <SectionPanel
        title="Setup"
        description="The domain and platform credentials Launch runs on. Secrets are write-only: once saved, they are never shown again."
        actions={
          <span className="text-sm text-secondary tabular-nums">
            {done} of {data.steps.length} steps
          </span>
        }
      >
        <Stepper steps={data.steps} />
        <p className="text-xs text-muted mt-3 flex flex-wrap gap-x-4 gap-y-1">
          <StatusDot status="ok" withLabel />
          <StatusDot status="warning" withLabel />
          <StatusDot status="failed" withLabel />
          <StatusDot status="todo" withLabel />
        </p>
      </SectionPanel>

      <DomainCard
        status={status('domain')}
        settings={data.settings}
        effectiveNotificationsDomain={data.effectiveNotificationsDomain}
        cloudflare={credential(data, 'cloudflare_api_token')}
      />

      <CredentialCard
        id="cloudflare"
        number={2}
        title="Cloudflare"
        status={status('cloudflare')}
        kind="cloudflare_api_token"
        credential={credential(data, 'cloudflare_api_token')}
        settings={data.settings}
        description="An account-owned API token for the apps account. Launch creates every app's resources, Workers and routes with it."
        help={
          <p>
            Create it in the dashboard (Manage account → Account API tokens) as a Super
            Administrator: Workers Scripts, KV, Queues, R2 and Workflows <em>Edit</em> on the
            account; DNS and Workers Routes <em>Edit</em> on the apps zone.
          </p>
        }
        settingFields={[
          {
            key: 'cloudflare_account_id',
            label: 'Account id',
            placeholder: '32 hex characters',
            hint: 'The apps account — where the apps zone lives.',
          },
        ]}
        payloadFields={[
          { name: 'apiToken', label: 'API token', secret: true, placeholder: 'Paste the token' },
        ]}
      />

      <CredentialCard
        id="neon"
        number={3}
        title="Neon"
        status={status('neon')}
        kind="neon_org_api_key"
        credential={credential(data, 'neon_org_api_key')}
        settings={data.settings}
        description="An organization API key. Launch creates a Neon project per app; apps only ever get connection strings."
        help={
          <p>
            Use an <em>organization</em> key (Organization settings → API keys), not a personal one.
            The region is pinned once: Neon's default moves between creates.
          </p>
        }
        settingFields={[
          {
            key: 'neon_region_id',
            label: 'Region',
            placeholder: 'aws-us-east-2',
            options: NEON_REGIONS.map(r => ({ value: r.id, label: `${r.label} — ${r.id}` })),
            blankLabel: 'Pick on the first check',
            hint: `Left to the check, Launch pins the region most of the org's projects are in, or ${DEFAULT_NEON_REGION} when it has none. Every app's database is created there.`,
          },
          {
            key: 'neon_org_id',
            label: 'Organization id',
            placeholder: 'org-…',
            hint: 'Discovered from the key when the org has a project.',
          },
        ]}
        payloadFields={[{ name: 'apiKey', label: 'API key', secret: true, placeholder: 'napi_…' }]}
      />

      <CredentialCard
        id="resend"
        number={4}
        title="Resend"
        status={status('resend')}
        kind="resend_api_key"
        credential={credential(data, 'resend_api_key')}
        settings={data.settings}
        description={
          <>
            A full-access API key. Launch mints each app a sending key bound to{' '}
            <code>{data.effectiveNotificationsDomain ?? 'notifications.<apps domain>'}</code>.
          </>
        }
        help={<p>Add and verify the notifications domain in Resend before checking.</p>}
        settingFields={[]}
        payloadFields={[
          {
            name: 'apiKey',
            label: 'API key',
            secret: true,
            placeholder: 're_…',
            hint: 'Full access — a sending-only key cannot mint per-app keys.',
          },
        ]}
      />

      <CredentialCard
        id="github"
        number={5}
        title="GitHub App"
        status={status('github')}
        kind="github_app"
        credential={credential(data, 'github_app')}
        settings={data.settings}
        description="A GitHub App installed on the company organization. Launch creates repos, commits and dispatches deploys through it."
        help={
          <p>
            Repository permissions, all <em>Read and write</em>: Administration, Contents,
            Workflows, Pull requests, Actions, Environments, Variables and Deployments.
          </p>
        }
        settingFields={[{ key: 'github_org', label: 'Organization', placeholder: 'company' }]}
        payloadFields={[
          { name: 'appId', label: 'App id', secret: false, placeholder: '123456' },
          {
            name: 'privateKey',
            label: 'Private key',
            secret: true,
            multiline: true,
            placeholder: '-----BEGIN RSA PRIVATE KEY-----',
            hint: 'The .pem file GitHub generated, pasted whole.',
          },
        ]}
      />

      <IdentityCard status={status('identity')} identity={data.identity} />

      <PublicUrlCard status={status('public_url')} publicUrl={data.publicUrl} />
    </div>
  )
}
