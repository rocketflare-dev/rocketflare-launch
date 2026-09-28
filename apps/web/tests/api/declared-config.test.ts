/**
 * The Rocketflare adapter's `declaredConfig` (Launch P5, slice 5e): what an app says it needs, read
 * from `launch.plugins.json` / `.rocketflare.json` → each plugin surface's `plugin.json` `vars[]`,
 * plus the kit's optional secrets. Pure: `read` is a fixture map, no GitHub.
 *
 * What it pins: the fake M365 connector's three keys (two vars, one secret); bare-string and
 * `name`-keyed vars; `secret` counting only when `true`; a missing or malformed anchor skipped
 * without hiding the others; a malformed manifest; no plugins (the kit's keys only); no manifest at
 * all (nothing); both manifests merged by anchor; a plugin key the kit also lists filed once, under
 * the plugin; and a failed READ thrown rather than swallowed.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { KIT_CONFIG_PLUGIN_ID } from '@launch/shared/launch-grants'
import { describe, expect, it } from 'vitest'
import {
  declaredConfig,
  KIT_OPTIONAL_CONFIG,
} from '@/api/services/launch/rocketflare/declared-config'

const M365_PLUGIN_JSON = readFileSync(
  path.resolve(__dirname, '../fixtures/plugins/m365-connector/plugin.json'),
  'utf8'
)
const M365_ANCHOR = 'apps/web/src/plugins/m365-connector/plugin.json'

/** A manifest recording `surfaces` as `pnpm plugin add` writes them. */
function manifest(surfaces: unknown[]): string {
  return JSON.stringify({ kitVersion: '0.15.0', app: { slug: 'shop' }, surfaces })
}

function pluginSurface(id: string, anchor?: string) {
  return { id, kind: 'plugin', label: id, ...(anchor ? { anchor } : {}), paths: [] }
}

function reader(files: Record<string, string>) {
  const reads: string[] = []
  const read = async (p: string) => {
    reads.push(p)
    return files[p] ?? null
  }
  return { read, reads }
}

const kitKeys = KIT_OPTIONAL_CONFIG.map(k => k.key)

describe('declaredConfig', () => {
  it("reads the M365 connector's two vars and its secret, then the kit's optional keys", async () => {
    const { read } = reader({
      'launch.plugins.json': manifest([pluginSurface('m365-connector', M365_ANCHOR)]),
      [M365_ANCHOR]: M365_PLUGIN_JSON,
    })
    const declared = await declaredConfig(read)
    expect(declared.slice(0, 3)).toEqual([
      {
        key: 'M365_TENANT_ID',
        secret: false,
        pluginId: 'm365-connector',
        example: '00000000-0000-0000-0000-000000000000',
      },
      {
        key: 'M365_CLIENT_ID',
        secret: false,
        pluginId: 'm365-connector',
        example: '00000000-0000-0000-0000-000000000000',
      },
      { key: 'M365_CLIENT_SECRET', secret: true, pluginId: 'm365-connector' },
    ])
    expect(declared.slice(3).map(d => d.key)).toEqual(kitKeys)
    expect(declared.slice(3).every(d => d.pluginId === KIT_CONFIG_PLUGIN_ID)).toBe(true)
    expect(declared.find(d => d.key === 'ANTHROPIC_API_KEY')?.secret).toBe(true)
    expect(declared.find(d => d.key === 'LANGFUSE_PUBLIC_KEY')?.secret).toBe(false)
  })

  it('takes bare strings and `name`, counts secret only when true, and skips entries with no key', async () => {
    const anchor = 'apps/web/src/plugins/crm/plugin.json'
    const { read } = reader({
      '.rocketflare.json': manifest([pluginSurface('crm', anchor)]),
      [anchor]: JSON.stringify({
        id: 'crm',
        vars: [
          'CRM_URL',
          { name: 'CRM_TOKEN', secret: true },
          { key: 'CRM_REGION', secret: 'true' },
          { example: 'no key' },
          42,
          '',
        ],
      }),
    })
    const declared = (await declaredConfig(read)).filter(d => d.pluginId === 'crm')
    expect(declared).toEqual([
      { key: 'CRM_URL', secret: false, pluginId: 'crm' },
      { key: 'CRM_TOKEN', secret: true, pluginId: 'crm' },
      { key: 'CRM_REGION', secret: false, pluginId: 'crm' },
    ])
  })

  it('defaults a surface with no anchor to the kit path, and ignores surfaces that are not plugins', async () => {
    const { read, reads } = reader({
      'launch.plugins.json': manifest([
        pluginSurface('m365-connector'),
        { id: 'example-agent', kind: 'example', anchor: 'apps/web/src/example.ts' },
        { kind: 'plugin' },
        'garbage',
      ]),
      [M365_ANCHOR]: M365_PLUGIN_JSON,
    })
    const declared = await declaredConfig(read)
    expect(declared.filter(d => d.pluginId === 'm365-connector')).toHaveLength(3)
    expect(reads).not.toContain('apps/web/src/example.ts')
  })

  it('skips a missing or malformed plugin.json without hiding the other plugins', async () => {
    const { read } = reader({
      'launch.plugins.json': manifest([
        pluginSurface('gone', 'apps/web/src/plugins/gone/plugin.json'),
        pluginSurface('broken', 'apps/web/src/plugins/broken/plugin.json'),
        pluginSurface('array', 'apps/web/src/plugins/array/plugin.json'),
        pluginSurface('m365-connector', M365_ANCHOR),
      ]),
      'apps/web/src/plugins/broken/plugin.json': '{ "id": "broken", "vars": [',
      'apps/web/src/plugins/array/plugin.json': '["M365_TENANT_ID"]',
      [M365_ANCHOR]: M365_PLUGIN_JSON,
    })
    const declared = await declaredConfig(read)
    expect([...new Set(declared.map(d => d.pluginId))]).toEqual([
      'm365-connector',
      KIT_CONFIG_PLUGIN_ID,
    ])
  })

  it('a plugin.json whose vars is not an array declares nothing', async () => {
    const { read } = reader({
      'launch.plugins.json': manifest([pluginSurface('odd', 'odd/plugin.json')]),
      'odd/plugin.json': JSON.stringify({ id: 'odd', vars: { KEY: true } }),
    })
    expect((await declaredConfig(read)).filter(d => d.pluginId === 'odd')).toEqual([])
  })

  it("no plugins → the kit's optional keys alone", async () => {
    const { read } = reader({ 'launch.plugins.json': manifest([]) })
    expect((await declaredConfig(read)).map(d => d.key)).toEqual(kitKeys)
  })

  it("a malformed manifest is a Rocketflare app with no readable plugins: the kit's keys", async () => {
    const { read } = reader({ '.rocketflare.json': '{ not json' })
    expect((await declaredConfig(read)).map(d => d.key)).toEqual(kitKeys)
  })

  it('no manifest at all is not a Rocketflare app: nothing is declared', async () => {
    const { read, reads } = reader({})
    expect(await declaredConfig(read)).toEqual([])
    expect(reads).toEqual(['.rocketflare.json', 'launch.plugins.json'])
  })

  it('merges both manifests by anchor, reading each plugin.json once', async () => {
    const crm = 'apps/web/src/plugins/crm/plugin.json'
    const { read, reads } = reader({
      '.rocketflare.json': manifest([pluginSurface('m365-connector', M365_ANCHOR)]),
      'launch.plugins.json': manifest([
        pluginSurface('m365-connector', M365_ANCHOR),
        pluginSurface('crm', crm),
      ]),
      [M365_ANCHOR]: M365_PLUGIN_JSON,
      [crm]: JSON.stringify({ id: 'crm', vars: ['CRM_URL'] }),
    })
    const declared = await declaredConfig(read)
    expect(declared.filter(d => d.pluginId !== KIT_CONFIG_PLUGIN_ID).map(d => d.key)).toEqual([
      'M365_TENANT_ID',
      'M365_CLIENT_ID',
      'M365_CLIENT_SECRET',
      'CRM_URL',
    ])
    expect(reads.filter(p => p === M365_ANCHOR)).toHaveLength(1)
  })

  it('a key a plugin declares is filed under the plugin, not repeated under the kit', async () => {
    const anchor = 'apps/web/src/plugins/ai/plugin.json'
    const { read } = reader({
      'launch.plugins.json': manifest([pluginSurface('ai', anchor)]),
      [anchor]: JSON.stringify({ id: 'ai', vars: [{ key: 'ANTHROPIC_API_KEY', secret: true }] }),
    })
    const declared = await declaredConfig(read)
    expect(declared.filter(d => d.key === 'ANTHROPIC_API_KEY')).toEqual([
      { key: 'ANTHROPIC_API_KEY', secret: true, pluginId: 'ai' },
    ])
  })

  it('a read that FAILS throws — the caller keeps the previous scan rather than a half-read', async () => {
    const read = async (p: string) => {
      if (p === M365_ANCHOR) throw new Error('GitHub 502')
      return p === 'launch.plugins.json'
        ? manifest([pluginSurface('m365-connector', M365_ANCHOR)])
        : null
    }
    await expect(declaredConfig(read)).rejects.toThrow('GitHub 502')
  })
})
