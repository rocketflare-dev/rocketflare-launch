/**
 * Launch P5's Cloudflare additions (slice 5a) against the stateful FakeCloud:
 * `CloudflareClient.deleteWorkerSecret` / `listWorkerSecrets`, and the fake's secret VERSIONS —
 * on a live script each secret write or delete creates and deploys a new version carrying the
 * active one's bindings, `envOf(script)` answers what the running Worker's `env` holds, a version
 * keeps the secret values it was uploaded with (`keep_bindings` copies them AS OF the upload, plan
 * §1.6), and a var named like a secret clashes (10053, plan §1.5). Nothing reaches Cloudflare.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CloudflareApiError,
  CloudflareClient,
  isCloudflareNotFound,
} from '@/api/services/launch/cloudflare'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'

let cloud: FakeCloud
let account: string
beforeEach(() => {
  cloud = createFakeCloud()
  account = cloud.opts.accountId
})

const cf = () => new CloudflareClient('cf-token-xxxxxxxxxxxxxxxxxxxx', { fetch: cloud.fetch })

/** A script with one deployed version carrying `bindings`, the way the deploy gateway leaves it. */
async function liveScript(
  client: CloudflareClient,
  name: string,
  bindings: Record<string, unknown>[] = [
    { type: 'plain_text', name: 'RELEASE_VERSION', text: '1.0.0' },
  ]
) {
  await client.putWorkerScript(account, name, { main_module: 'index.js' }, [
    { name: 'index.js', content: 'export default {}' },
  ])
  const version = await client.createVersion(
    account,
    name,
    { main_module: 'worker.js', bindings, keep_bindings: ['secret_text'] },
    [{ name: 'worker.js', content: new TextEncoder().encode('export default {}') }]
  )
  await client.createDeployment(account, name, version.id, 'first deploy')
  return version.id
}

describe('CloudflareClient secrets (P5)', () => {
  it('lists names only, deletes one, and a missing name is a 404 callers may treat as done', async () => {
    const client = cf()
    await client.putWorkerScript(account, 'shop-staging', { main_module: 'index.js' }, [
      { name: 'index.js', content: 'export default {}' },
    ])
    await client.putWorkerSecret(account, 'shop-staging', 'M365_CLIENT_SECRET', 'value-1')
    await client.putWorkerSecret(account, 'shop-staging', 'M365_TENANT_ID', 'tenant-1')
    const listed = await client.listWorkerSecrets(account, 'shop-staging')
    expect(listed).toEqual([
      { name: 'M365_CLIENT_SECRET', type: 'secret_text' },
      { name: 'M365_TENANT_ID', type: 'secret_text' },
    ])
    expect(JSON.stringify(listed)).not.toContain('value-1')

    await client.deleteWorkerSecret(account, 'shop-staging', 'M365_CLIENT_SECRET')
    const script = cloud.cloudflare.scripts.get('shop-staging')
    expect(script?.secretDeletes).toEqual(['M365_CLIENT_SECRET'])
    expect(script?.secrets.has('M365_CLIENT_SECRET')).toBe(false)
    const call = cloud.calls.at(-1)
    expect(call).toMatchObject({ method: 'DELETE', status: 200 })
    expect(call?.path).toMatch(/\/workers\/scripts\/shop-staging\/secrets\/M365_CLIENT_SECRET$/)

    const missing = await client
      .deleteWorkerSecret(account, 'shop-staging', 'M365_CLIENT_SECRET')
      .catch((err: unknown) => err)
    expect(missing).toBeInstanceOf(CloudflareApiError)
    expect(isCloudflareNotFound(missing)).toBe(true)
    await expect(client.listWorkerSecrets(account, 'nope')).rejects.toSatisfy(isCloudflareNotFound)
  })
})

describe('FakeCloudflare secret versions (P5)', () => {
  it('a placeholder (never deployed) takes secrets with no version, and envOf is null', async () => {
    const client = cf()
    await client.putWorkerScript(account, 'shop-staging', { main_module: 'index.js' }, [
      { name: 'index.js', content: 'export default {}' },
    ])
    await client.putWorkerSecret(account, 'shop-staging', 'DATABASE_URL', 'postgres://x')
    expect(cloud.cloudflare.scripts.get('shop-staging')?.versions).toEqual([])
    expect(cloud.cloudflare.envOf('shop-staging')).toBeNull()
    expect(cloud.cloudflare.envOf('no-such-script')).toBeNull()
  })

  it('a secret write on a live script is a new DEPLOYED version with the old bindings', async () => {
    const client = cf()
    const first = await liveScript(client, 'shop-staging')
    await client.putWorkerSecret(account, 'shop-staging', 'M365_CLIENT_SECRET', 'secret-v1')
    const script = cloud.cloudflare.scripts.get('shop-staging')
    expect(script?.versions).toHaveLength(2)
    const active = cloud.cloudflare.activeVersion('shop-staging')
    expect(active?.id).not.toBe(first)
    expect(script?.deployments.at(-1)?.versions).toEqual([
      { version_id: active?.id, percentage: 100 },
    ])
    expect(active?.bindings).toEqual([
      { type: 'plain_text', name: 'RELEASE_VERSION', text: '1.0.0' },
      { type: 'secret_text', name: 'M365_CLIENT_SECRET' },
    ])
    expect(cloud.cloudflare.envOf('shop-staging')).toEqual({
      RELEASE_VERSION: '1.0.0',
      M365_CLIENT_SECRET: 'secret-v1',
    })

    // Rotating is another version; the running env follows it. Deleting removes it.
    await client.putWorkerSecret(account, 'shop-staging', 'M365_CLIENT_SECRET', 'secret-v2')
    expect(cloud.cloudflare.envOf('shop-staging')?.M365_CLIENT_SECRET).toBe('secret-v2')
    await client.deleteWorkerSecret(account, 'shop-staging', 'M365_CLIENT_SECRET')
    expect(cloud.cloudflare.envOf('shop-staging')).toEqual({ RELEASE_VERSION: '1.0.0' })
    expect(script?.versions).toHaveLength(4)
    // The health answer still reads RELEASE_VERSION from the carried bindings.
    const route = await client.createWorkerRoute(
      cloud.opts.zoneId,
      'shop-staging.clewro.com/*',
      'shop-staging'
    )
    expect(route.id).toBeTruthy()
    const health = await cloud.fetch('https://shop-staging.clewro.com/api/health')
    expect(await health.json()).toEqual({ status: 'ok', version: '1.0.0' })
  })

  it('keep_bindings copies secret VALUES as of the upload: activating it later undoes a newer push', async () => {
    const client = cf()
    await liveScript(client, 'shop-staging')
    await client.putWorkerSecret(account, 'shop-staging', 'M365_CLIENT_SECRET', 'old')
    // A deploy uploads (keeping the secret as it is now)…
    const upload = await client.createVersion(
      account,
      'shop-staging',
      {
        main_module: 'worker.js',
        bindings: [{ type: 'plain_text', name: 'RELEASE_VERSION', text: '1.1.0' }],
        keep_bindings: ['secret_text'],
      },
      [{ name: 'worker.js', content: new TextEncoder().encode('export default {}') }]
    )
    // …a rotation lands before it is activated…
    await client.putWorkerSecret(account, 'shop-staging', 'M365_CLIENT_SECRET', 'new')
    expect(cloud.cloudflare.envOf('shop-staging')?.M365_CLIENT_SECRET).toBe('new')
    // …and activating the upload puts the OLD value back (what the §1.6 repair push is for).
    await client.createDeployment(account, 'shop-staging', upload.id, 'activate')
    expect(cloud.cloudflare.envOf('shop-staging')).toEqual({
      RELEASE_VERSION: '1.1.0',
      M365_CLIENT_SECRET: 'old',
    })
  })

  it('a secret named like a live var, or an upload whose var shadows a kept secret, is 10053', async () => {
    const client = cf()
    await liveScript(client, 'shop-staging', [
      { type: 'plain_text', name: 'M365_TENANT_ID', text: 'from-the-toml' },
    ])
    const clash = await client
      .putWorkerSecret(account, 'shop-staging', 'M365_TENANT_ID', 'granted')
      .catch((err: unknown) => err)
    expect(clash).toBeInstanceOf(CloudflareApiError)
    expect(String((clash as Error).message)).toMatch(/10053.*already in use/)

    // With the var gone from the live version the secret goes in; an upload that declares the var
    // again while keeping the secret clashes too (the gateway drops such a var, plan §1.5).
    await liveScript(client, 'crm-staging')
    await client.putWorkerSecret(account, 'crm-staging', 'M365_TENANT_ID', 'granted')
    const shadow = await client
      .createVersion(
        account,
        'crm-staging',
        {
          main_module: 'worker.js',
          bindings: [{ type: 'plain_text', name: 'M365_TENANT_ID', text: 'from-the-toml' }],
          keep_bindings: ['secret_text'],
        },
        [{ name: 'worker.js', content: new TextEncoder().encode('export default {}') }]
      )
      .catch((err: unknown) => err)
    expect(String((shadow as Error).message)).toMatch(/10053/)

    // The switch turns both off for a suite about something else.
    cloud.cloudflare.secretNameClash = false
    await client.putWorkerSecret(account, 'shop-staging', 'M365_TENANT_ID', 'granted')
    expect(cloud.cloudflare.envOf('shop-staging')?.M365_TENANT_ID).toBe('granted')
  })
})
