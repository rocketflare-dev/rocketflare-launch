/**
 * Settings → Platform (spec/03, spec/04): one page per thing Launch runs on — the apps domain
 * and zone, then the Cloudflare, Neon, GitHub App and Resend credentials Launch acts with, then how
 * people sign in (the upstream IdP, read-only, and Launch's own OIDC issuer keys), then whether
 * Launch's own public URL is reachable from the internet (the CI jobs call it back). Each is a
 * route of its own (`CONNECTION_PATHS`), its status dot in the Settings menu, and — while any is
 * unfinished — a line in Home's "Finish setting up Launch". It replaced a seven-step wizard page.
 * `canAdministerPlatform` — a global admin, or in single mode the organisation's owner/admin (the
 * section's guard; the server's `platformAdminMiddleware`).
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
} from '@launch/shared/launch-setup'
import { SectionPanel, SkeletonRows } from '@/ui/components/shared'
import { useSetupOverview } from '@/ui/hooks/useSetup'
import Identity from './Identity'
import { CredentialCard } from './setup/CredentialCard'
import { DomainCard } from './setup/DomainCard'
import { IdentityCard } from './setup/IdentityCard'
import { PublicUrlCard } from './setup/PublicUrlCard'

function credential(overview: SetupOverview, kind: CredentialKind) {
  const found = overview.credentials.find(c => c.kind === kind)
  if (!found) throw new Error(`no status for ${kind}`)
  return found
}

export default function Connection({ step }: { step: SetupStepId }) {
  const { data, isLoading, isError } = useSetupOverview()

  if (isLoading) {
    return (
      <SectionPanel>
        <SkeletonRows rows={6} />
      </SectionPanel>
    )
  }
  if (isError || !data) {
    return (
      <SectionPanel>
        <div className="alert alert-error text-sm">The setup status could not be loaded.</div>
      </SectionPanel>
    )
  }

  const status = data.steps.find(s => s.id === step)?.status ?? 'todo'

  switch (step) {
    case 'domain':
      return (
        <DomainCard
          status={status}
          settings={data.settings}
          effectiveNotificationsDomain={data.effectiveNotificationsDomain}
          cloudflare={credential(data, 'cloudflare_api_token')}
        />
      )
    case 'cloudflare':
      return (
        <CredentialCard
          id="cloudflare"
          title="Cloudflare"
          status={status}
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
      )
    case 'neon':
      return (
        <CredentialCard
          id="neon"
          title="Neon"
          status={status}
          kind="neon_org_api_key"
          credential={credential(data, 'neon_org_api_key')}
          settings={data.settings}
          description="An organization API key. Launch creates a Neon project per app; apps only ever get connection strings."
          help={
            <p>
              Use an <em>organization</em> key (Organization settings → API keys), not a personal
              one. The region is pinned once: Neon's default moves between creates.
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
          payloadFields={[
            { name: 'apiKey', label: 'API key', secret: true, placeholder: 'napi_…' },
          ]}
        />
      )
    case 'github':
      return (
        <CredentialCard
          id="github"
          title="GitHub App"
          status={status}
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
      )
    case 'resend':
      return (
        <CredentialCard
          id="resend"
          title="Email (Resend)"
          status={status}
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
      )
    case 'identity':
      // Both halves of sign-in: how people reach Launch (the upstream IdP), and Launch as the
      // issuer every app signs its people in through.
      return (
        <div className="space-y-6">
          <IdentityCard status={status} identity={data.identity} />
          <Identity />
        </div>
      )
    case 'public_url':
      return <PublicUrlCard status={status} publicUrl={data.publicUrl} />
  }
}
