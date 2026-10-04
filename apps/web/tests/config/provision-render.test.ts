/**
 * `scripts/provision/render-toml.ts` — one instance's `wrangler.deploy.toml`, rendered from the
 * committed template (config project, no network, no filesystem writes). The template itself is
 * never changed: the parity test keeps reading it as the neutral copy it is.
 */
import fs from 'node:fs'
import path from 'node:path'
import TOML from '@iarna/toml'
import { describe, expect, it } from 'vitest'
import { pluginSurfaces, readManifest } from '../../../../scripts/lib/manifest.mjs'
import { tomlPlaceholders } from '../../scripts/provision/patch-toml'
import { readPluginResources } from '../../scripts/provision/plugin-resources'
import {
  GENERATED_HEADER,
  renderDeployToml,
  reprefixNames,
} from '../../scripts/provision/render-toml'

const WEB_DIR = path.resolve(__dirname, '../..')
const REPO_ROOT = path.resolve(WEB_DIR, '../..')
const templatePath = path.join(WEB_DIR, 'wrangler.toml')
const template = fs.readFileSync(templatePath, 'utf8')
const plugins = readPluginResources(
  REPO_ROOT,
  pluginSurfaces(readManifest(REPO_ROOT).manifest) as Array<{
    id: string
    kind: string
    anchor: string
  }>
)

type Row = Record<string, unknown>
const parse = (text: string) => TOML.parse(text) as Record<string, any>

const SAMPLE = {
  name: 'launch',
  domain: 'rocketflare.dev',
  host: 'launch.rocketflare.dev',
  emailFrom: 'Launch <noreply@notifications.rocketflare.dev>',
  kvIds: { RATE_LIMIT_KV: '0123456789abcdef0123456789abcdef' },
  plugins,
}

/** Every account-scoped name a toml carries: queues, buckets, workflows. */
function accountScoped(doc: Record<string, any>): string[] {
  return [
    ...(doc.queues?.producers ?? []).map((q: Row) => q.queue),
    ...(doc.queues?.consumers ?? []).map((q: Row) => q.queue),
    ...(doc.r2_buckets ?? []).map((b: Row) => b.bucket_name),
    ...(doc.workflows ?? []).map((w: Row) => w.name),
  ] as string[]
}

describe('renderDeployToml', () => {
  const rendered = renderDeployToml(template, SAMPLE)
  const doc = parse(rendered)
  const base = parse(template)

  it('is valid TOML, marked generated, with no placeholder left once the KV id is known', () => {
    expect(rendered.startsWith(GENERATED_HEADER)).toBe(true)
    expect(tomlPlaceholders(rendered)).toEqual([])
  })

  it('serves the instance on its host plus the wildcard zone route, and nowhere else', () => {
    expect(doc.name).toBe('launch')
    expect(doc.workers_dev).toBe(false)
    expect(doc.routes).toEqual([
      { pattern: 'launch.rocketflare.dev', custom_domain: true },
      { pattern: '*.rocketflare.dev/*', zone_name: 'rocketflare.dev' },
    ])
  })

  it('sets the instance [vars] and keeps every other one the template has', () => {
    expect(doc.vars.APP_URL).toBe('https://launch.rocketflare.dev')
    expect(doc.vars.EMAIL_FROM).toBe('Launch <noreply@notifications.rocketflare.dev>')
    expect(doc.vars.SESSION_PREVIEW_URL).toBe('https://{label}.rocketflare.dev')
    expect(doc.vars.DATABASE_DRIVER).toBe('neon')
    expect(doc.vars.APP_ENV).toBe('production')
    for (const key of Object.keys(base.vars)) expect(doc.vars).toHaveProperty(key)
  })

  it('with the default name, every account-scoped name is exactly the template’s', () => {
    expect(accountScoped(doc)).toEqual(accountScoped(base))
    expect(doc.kv_namespaces[0]).toEqual({
      binding: 'RATE_LIMIT_KV',
      id: '0123456789abcdef0123456789abcdef',
    })
  })

  it('BACKUP_BUCKET stays on the FILES bucket', () => {
    const buckets = Object.fromEntries(
      (doc.r2_buckets as Row[]).map(b => [b.binding as string, b.bucket_name])
    )
    expect(buckets.BACKUP_BUCKET).toBe(buckets.FILES)
  })

  it('another LAUNCH_NAME re-prefixes the worker and every account-scoped name, nothing else', () => {
    const other = parse(renderDeployToml(template, { ...SAMPLE, name: 'acme' }))
    expect(other.name).toBe('acme')
    const names = accountScoped(other)
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) expect(n).toMatch(/^acme-/)
    expect(names).toEqual(accountScoped(base).map(n => n.replace(/^launch/, 'acme')))
    // Binding names and Durable Object names are code-facing and never prefixed.
    expect(other.durable_objects).toEqual(base.durable_objects)
    expect((other.workflows as Row[]).map(w => w.binding)).toEqual(
      (base.workflows as Row[]).map(w => w.binding)
    )
  })

  it('keeps the bindings, classes, containers and migrations the template declares', () => {
    expect(doc.durable_objects).toEqual(base.durable_objects)
    expect(doc.containers).toEqual(base.containers)
    expect(doc.ai).toEqual(base.ai)
    expect(doc.browser).toEqual(base.browser)
    expect(doc.assets).toEqual(base.assets)
    expect(doc.main).toBe(base.main)
  })

  it("applies every installed plugin's declarations (the analytics plugin's cron)", () => {
    for (const p of plugins) {
      for (const cron of p.crons ?? []) expect(doc.triggers.crons).toContain(cron)
    }
    for (const cron of base.triggers.crons) expect(doc.triggers.crons).toContain(cron)
  })

  it('leaves the RATE_LIMIT_KV placeholder until the cloudflare phase records an id', () => {
    const unprovisioned = renderDeployToml(template, { ...SAMPLE, kvIds: {} })
    expect(tomlPlaceholders(unprovisioned)).toEqual(['<KV_RATE_LIMIT_ID>'])
  })

  it('is pure: the committed template on disk is untouched', () => {
    expect(fs.readFileSync(templatePath, 'utf8')).toBe(template)
  })
})

describe('reprefixNames', () => {
  it('rewrites active name/queue/bucket lines only, never comments or unrelated values', () => {
    const text = [
      'name = "launch"',
      'queue = "launch-jobs"',
      '# dead_letter_queue = "launch-jobs-dlq"',
      'bucket_name = "launchpad"',
      'name = "NOTIFICATIONS_HUB"',
    ].join('\n')
    expect(reprefixNames(text, 'launch', 'acme').split('\n')).toEqual([
      'name = "acme"',
      'queue = "acme-jobs"',
      '# dead_letter_queue = "launch-jobs-dlq"',
      'bucket_name = "launchpad"',
      'name = "NOTIFICATIONS_HUB"',
    ])
  })
})
