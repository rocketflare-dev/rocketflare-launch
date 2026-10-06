/**
 * The instance flow's pure halves (config project, no network): reading `launch.deploy.env`'s
 * answers, where a second instance keeps its state, the zone audit, the `secrets` plan (NAMES
 * only — what `--dry-run` prints), the GitHub App manifest and the Cloudflare token link.
 */

import { GITHUB_WEBHOOK_EVENTS } from '@launch/shared/launch-github'
import { describe, expect, it } from 'vitest'
import { REQUIRED_GITHUB_PERMISSIONS } from '@/api/services/launch/setup'
import { zoneAuditFindings } from '../../scripts/provision/cloudflare-dns'
import { resolveDeployFile } from '../../scripts/provision/config'
import {
  buildGitHubAppManifest,
  GITHUB_EVENT_PERMISSION,
  installUrl,
  manifestFormUrl,
  manifestPage,
} from '../../scripts/provision/github-app'
import {
  instanceResourceNames,
  instanceTagOf,
  readInstance,
} from '../../scripts/provision/instance'
import { describeSecretPlan, planSecrets } from '../../scripts/provision/secrets'
import { cloudflareTokenTemplateUrl, TEMPLATE_KEYS } from '../../scripts/provision/token-template'

const getter = (values: Record<string, string>) => (k: string) => values[k]

describe('readInstance', () => {
  it('fills every default from the three required answers', () => {
    const { instance, missing, invalid } = readInstance(
      getter({
        LAUNCH_DOMAIN: 'Rocketflare.dev',
        LAUNCH_ADMIN_EMAILS: 'Owner@Example.com, second@example.com',
        LAUNCH_GITHUB_ORG: 'rocketflare-launch',
      })
    )
    expect(missing).toEqual([])
    expect(invalid).toEqual([])
    expect(instance).toEqual({
      domain: 'rocketflare.dev',
      host: 'launch.rocketflare.dev',
      name: 'launch',
      appUrl: 'https://launch.rocketflare.dev',
      adminEmails: ['owner@example.com', 'second@example.com'],
      githubOrg: 'rocketflare-launch',
      neonRegion: 'aws-eu-central-1',
      emailDomain: 'notifications.rocketflare.dev',
      emailRegion: 'us-east-1',
      previewUrl: 'https://{label}.rocketflare.dev',
      githubAppName: 'Launch rocketflare-launch',
    })
  })

  it('reports every missing required name and every wrong answer at once', () => {
    expect(readInstance(getter({})).missing).toEqual([
      'LAUNCH_DOMAIN',
      'LAUNCH_ADMIN_EMAILS',
      'LAUNCH_GITHUB_ORG',
    ])
    const { instance, invalid } = readInstance(
      getter({
        LAUNCH_DOMAIN: 'rocketflare.dev',
        LAUNCH_HOST: 'launch.elsewhere.com',
        LAUNCH_NAME: 'Bad_Name',
        LAUNCH_ADMIN_EMAILS: 'not-an-email',
        LAUNCH_GITHUB_ORG: 'org',
      })
    )
    expect(instance).toBeUndefined()
    expect(invalid).toHaveLength(3)
    expect(invalid.join('\n')).toMatch(/LAUNCH_HOST.*subdomain of LAUNCH_DOMAIN/)
  })

  it('the default name reproduces the committed template’s resource names', () => {
    expect(instanceResourceNames('launch')).toEqual({
      kv: 'LAUNCH_RATE_LIMIT',
      queue: 'launch-jobs',
      bucket: 'launch-files',
    })
    expect(instanceResourceNames('acme-staging').kv).toBe('ACME_STAGING_RATE_LIMIT')
  })
})

describe('instance files', () => {
  it('keeps a second instance’s state apart by its file name', () => {
    expect(instanceTagOf('/repo/launch.deploy.env')).toBe('')
    expect(instanceTagOf('/repo/launch.staging.deploy.env')).toBe('staging')
    expect(instanceTagOf('/elsewhere/acme.env')).toBe('acme')
  })
  it('resolves LAUNCH_DEPLOY_FILE against where pnpm was started', () => {
    expect(resolveDeployFile(undefined, '/x', '/repo')).toBe('/repo/launch.deploy.env')
    expect(resolveDeployFile('launch.staging.deploy.env', '/repo', '/repo')).toBe(
      '/repo/launch.staging.deploy.env'
    )
    expect(resolveDeployFile('/abs/file.env', '/repo', '/repo')).toBe('/abs/file.env')
  })
})

describe('zoneAuditFindings', () => {
  it('flags proxied subdomains a *.<domain>/* route would capture, and only those', () => {
    const out = zoneAuditFindings({
      domain: 'rocketflare.dev',
      host: 'launch.rocketflare.dev',
      records: [
        { name: 'rocketflare.dev', type: 'A', proxied: true }, // apex: not matched by *.
        { name: 'www.rocketflare.dev', type: 'CNAME', proxied: true }, // a custom domain
        { name: 'blog.rocketflare.dev', type: 'CNAME', proxied: true }, // CAPTURED
        { name: 'mail.rocketflare.dev', type: 'A', proxied: false }, // DNS-only
        { name: '*.rocketflare.dev', type: 'AAAA', proxied: true },
      ],
      customDomains: [{ hostname: 'www.rocketflare.dev', service: 'rocketflare-www' }],
    })
    expect(out).toEqual({ captured: ['blog.rocketflare.dev'] })
  })
  it('notices a record already sitting on Launch’s host', () => {
    const out = zoneAuditFindings({
      domain: 'example.com',
      host: 'launch.example.com',
      records: [{ name: 'launch.example.com', type: 'CNAME', proxied: false }],
      customDomains: [],
    })
    expect(out.hostTaken).toBe('CNAME launch.example.com')
  })
})

describe('planSecrets (what --dry-run prints)', () => {
  const optional = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'R2_ACCESS_KEY_ID']

  it('generates the OAuth key on a fresh instance and copies only what is set', () => {
    const plan = planSecrets({
      available: new Set(['ANTHROPIC_API_KEY']),
      existing: [],
      optional,
      rotate: false,
      needsDatabaseUrl: true,
    })
    expect(plan.refuse).toBeUndefined()
    expect(plan.actions).toEqual([
      { name: 'OAUTH_ENCRYPTION_KEY', action: 'generate' },
      { name: 'BOOTSTRAP_ADMIN_EMAILS', action: 'put', source: 'derived' },
      { name: 'DATABASE_URL', action: 'put', source: 'derived' },
      { name: 'ANTHROPIC_API_KEY', action: 'put', source: 'file' },
      { name: 'OPENAI_API_KEY', action: 'skip', reason: 'not set' },
      { name: 'R2_ACCESS_KEY_ID', action: 'skip', reason: 'not set' },
    ])
  })

  it('refuses to generate over a key the Worker already holds, unless --rotate', () => {
    const base = {
      available: new Set<string>(),
      existing: ['OAUTH_ENCRYPTION_KEY', 'DATABASE_URL'],
      optional,
      needsDatabaseUrl: true,
    }
    expect(planSecrets({ ...base, rotate: false }).refuse).toMatch(/--rotate/)
    const rotated = planSecrets({ ...base, rotate: true })
    expect(rotated.refuse).toBeUndefined()
    expect(rotated.actions[0]).toEqual({ name: 'OAUTH_ENCRYPTION_KEY', action: 'generate' })
  })

  it('re-puts the file’s key and leaves an existing DATABASE_URL alone', () => {
    const plan = planSecrets({
      available: new Set(['OAUTH_ENCRYPTION_KEY']),
      existing: ['OAUTH_ENCRYPTION_KEY', 'DATABASE_URL', 'RESEND_API_KEY'],
      optional,
      rotate: false,
      needsDatabaseUrl: true,
    })
    expect(plan.actions.slice(0, 3)).toEqual([
      { name: 'OAUTH_ENCRYPTION_KEY', action: 'put', source: 'file' },
      { name: 'BOOTSTRAP_ADMIN_EMAILS', action: 'put', source: 'derived' },
      { name: 'DATABASE_URL', action: 'skip', reason: 'already on the Worker (--rotate re-puts)' },
    ])
    const lines = describeSecretPlan(plan, [
      'OAUTH_ENCRYPTION_KEY',
      'DATABASE_URL',
      'RESEND_API_KEY',
    ])
    expect(lines.join('\n')).toContain('also on the Worker (left alone): RESEND_API_KEY')
  })

  it('prints names and actions only — never a value', () => {
    const secret = 'sk-ant-api03-SECRETSECRETSECRET'
    const plan = planSecrets({
      available: new Set(['ANTHROPIC_API_KEY', 'OAUTH_ENCRYPTION_KEY']),
      existing: [],
      optional,
      rotate: false,
      needsDatabaseUrl: false,
    })
    const text = describeSecretPlan(plan, []).join('\n')
    expect(text).not.toContain(secret)
    for (const line of describeSecretPlan(plan, []))
      expect(line).toMatch(/^ {2}([A-Z0-9_]+ +(put|skip|generate)|also on the Worker|REFUSED)/)
  })
})

describe('the GitHub App manifest', () => {
  const manifest = buildGitHubAppManifest({
    name: 'Launch rocketflare-launch-with-a-very-long-name',
    appUrl: 'https://launch.rocketflare.dev',
    redirectUrl: 'http://127.0.0.1:4567/callback',
  })

  it('asks for exactly the permissions Launch’s Setup check requires', () => {
    expect(manifest.default_permissions).toEqual(REQUIRED_GITHUB_PERMISSIONS)
    expect(manifest.default_permissions).toMatchObject({
      administration: 'write',
      contents: 'write',
      workflows: 'write',
      pull_requests: 'write',
      actions: 'write',
      environments: 'write',
      actions_variables: 'write',
      deployments: 'write',
      checks: 'write',
      statuses: 'read',
    })
    expect(manifest.public).toBe(false)
  })

  it('subscribes the webhook to the events a landing waits on (issue #19), with no new permission', () => {
    expect(manifest.hook_attributes).toEqual({
      url: 'https://launch.rocketflare.dev/api/github/webhook',
      active: true,
    })
    expect(manifest.default_events).toEqual([...GITHUB_WEBHOOK_EVENTS])
    // Each event is delivered under a permission the app already holds.
    for (const [event, permission] of Object.entries(GITHUB_EVENT_PERMISSION)) {
      expect(manifest.default_events, event).toContain(event)
      expect(manifest.default_permissions[permission], `${event} needs ${permission}`).toBeDefined()
    }
  })

  it('returns to the local server and fits GitHub’s 34-character name limit', () => {
    expect(manifest.redirect_url).toBe('http://127.0.0.1:4567/callback')
    expect(manifest.url).toBe('https://launch.rocketflare.dev')
    expect(manifest.name.length).toBeLessThanOrEqual(34)
  })

  it('posts to the org’s new-app page with the state, and escapes the manifest into the form', () => {
    expect(manifestFormUrl('rocketflare-launch', 'abc')).toBe(
      'https://github.com/organizations/rocketflare-launch/settings/apps/new?state=abc'
    )
    const page = manifestPage(manifestFormUrl('rocketflare-launch', 'abc'), manifest)
    expect(page).toContain('name="manifest"')
    expect(page).toContain('&quot;default_permissions&quot;')
    expect(page).not.toContain('"default_permissions"')
    expect(installUrl('launch-x')).toBe('https://github.com/apps/launch-x/installations/new')
  })
})

describe('the Cloudflare token link', () => {
  it('is the account-token template URL with every documented key', () => {
    const url = new URL(cloudflareTokenTemplateUrl())
    expect(url.origin).toBe('https://dash.cloudflare.com')
    expect(url.searchParams.get('to')).toBe('/:account/api-tokens')
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys') as string)).toEqual(TEMPLATE_KEYS)
    expect(url.searchParams.get('name')).toBe('Launch')
  })
})
