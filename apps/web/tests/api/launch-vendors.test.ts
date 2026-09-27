/**
 * Launch P2's vendor clients (`services/launch/{cloudflare,neon,resend,github-app}.ts`) against
 * the stateful FakeCloud: every method a pipeline step, the teardown or the deploy gateway calls,
 * each asserted on the request it made AND the state it left, plus Neon's 423 retry. Nothing here
 * reaches a vendor — every client takes `cloud.fetch`.
 */
import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CloudflareApiError,
  CloudflareClient,
  isCloudflareNotFound,
  workerModuleType,
} from '@/api/services/launch/cloudflare'
import {
  archiveRepo,
  commitFiles,
  createCommit,
  createOrgRepo,
  createTree,
  deleteRepo,
  dispatchWorkflow,
  GitHubApiError,
  getCommit,
  getRef,
  getRepo,
  getRepoFile,
  installationToken,
  isGitHubNotFound,
  listWorkflowRuns,
  putEnvironment,
  revokeInstallationToken,
  updateRef,
  upsertRepoVariable,
} from '@/api/services/launch/github-app'
import {
  isNeonNotFound,
  NeonApiError,
  NeonClient,
  neonSqlEndpoint,
  runSql,
} from '@/api/services/launch/neon'
import { isResendNotFound, ResendClient } from '@/api/services/launch/resend'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

let cloud: FakeCloud
let account: string
let zone: string
beforeEach(() => {
  cloud = createFakeCloud()
  account = cloud.opts.accountId
  zone = cloud.opts.zoneId
})

const cf = () => new CloudflareClient('cf-token-xxxxxxxxxxxxxxxxxxxx', { fetch: cloud.fetch })
const neon = (sleeps: number[] = []) =>
  new NeonClient('neon-key-xxxxxxxxxxxxxxxxxx', {
    fetch: cloud.fetch,
    sleep: async ms => {
      sleeps.push(ms)
    },
  })

describe('Cloudflare client', () => {
  it('KV: create, find by title, delete — and a deleted namespace is a 404', async () => {
    const client = cf()
    const ns = await client.createKvNamespace(account, 'shop-rate-limit-staging')
    expect(ns).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      title: 'shop-rate-limit-staging',
    })
    expect(await client.findKvByTitle(account, 'shop-rate-limit-staging')).toEqual(ns)
    expect(await client.findKvByTitle(account, 'nope')).toBeNull()
    await expect(client.createKvNamespace(account, 'shop-rate-limit-staging')).rejects.toThrow(
      /already exists/
    )
    await client.deleteKvNamespace(account, ns.id)
    const gone = await client.deleteKvNamespace(account, ns.id).catch(e => e)
    expect(isCloudflareNotFound(gone)).toBe(true)
    expect(cloud.resourcesFor('shop')).toEqual([])
  })

  it('findKvByTitle pages past the first hundred', async () => {
    for (let i = 0; i < 105; i++)
      cloud.cloudflare.kv.set(`id${i}`, { id: `id${i}`, title: `t${i}` })
    expect(await cf().findKvByTitle(account, 't104')).toEqual({ id: 'id104', title: 't104' })
  })

  it('queues and consumers: create, upsert a consumer (no duplicate), delete', async () => {
    const client = cf()
    const queue = await client.createQueue(account, 'shop-jobs')
    expect(queue.queue_name).toBe('shop-jobs')
    const first = await client.putQueueConsumer(account, queue.queue_id, {
      scriptName: 'shop',
      settings: { batch_size: 10, max_retries: 3 },
    })
    const again = await client.putQueueConsumer(account, queue.queue_id, {
      scriptName: 'shop',
      settings: { batch_size: 5 },
    })
    expect(again.consumer_id).toBe(first.consumer_id)
    expect(await client.listQueueConsumers(account, queue.queue_id)).toHaveLength(1)
    expect(cloud.resourcesFor('shop')).toEqual(
      expect.arrayContaining(['cloudflare:queue:shop-jobs', 'cloudflare:consumer:shop-jobs->shop'])
    )
    await client.deleteQueueConsumer(account, queue.queue_id, first.consumer_id)
    await client.deleteQueue(account, queue.queue_id)
    expect(cloud.resourcesFor('shop')).toEqual([])
  })

  it('R2: create, then empty and delete a bucket that has objects', async () => {
    const client = cf()
    await client.createR2Bucket(account, 'shop-files')
    const bucket = cloud.cloudflare.r2.get('shop-files')
    bucket?.objects.set('tenants/a/one.txt', '1')
    bucket?.objects.set('tenants/b/two.txt', '2')
    expect(await client.emptyAndDeleteR2Bucket(account, 'shop-files')).toEqual({
      deletedObjects: 2,
    })
    expect(cloud.cloudflare.r2.has('shop-files')).toBe(false)
    const gone = await client.emptyAndDeleteR2Bucket(account, 'shop-files').catch(e => e)
    expect(isCloudflareNotFound(gone)).toBe(true)
  })

  it('scripts: a multipart PUT with DO migrations, workers.dev off, a secret, a forced delete', async () => {
    const client = cf()
    await client.putWorkerScript(
      account,
      'shop-staging',
      {
        main_module: 'index.js',
        compatibility_date: '2026-06-01',
        migrations: { new_tag: 'v1', steps: [{ new_classes: ['NotificationsHub'] }] },
      },
      [{ name: 'index.js', content: 'export class NotificationsHub {}; export default {}' }]
    )
    const script = cloud.cloudflare.scripts.get('shop-staging')
    expect(script?.migrationTag).toBe('v1')
    expect(script?.modules['index.js']).toContain('NotificationsHub')
    await client.setWorkersDevSubdomain(account, 'shop-staging', false)
    expect(script?.workersDev).toBe(false)
    await client.putWorkerSecret(account, 'shop-staging', 'DATABASE_URL', 'postgres://secret')
    expect(script?.secretPuts).toEqual(['DATABASE_URL'])
    expect(script?.secrets.get('DATABASE_URL')).toBe('postgres://secret')

    // A consumer binds the script: only a FORCED delete removes it (and its consumers).
    const queue = await client.createQueue(account, 'shop-jobs-staging')
    await client.putQueueConsumer(account, queue.queue_id, { scriptName: 'shop-staging' })
    await expect(client.deleteWorkerScript(account, 'shop-staging', false)).rejects.toThrow(/force/)
    await client.deleteWorkerScript(account, 'shop-staging')
    expect(cloud.cloudflare.scripts.has('shop-staging')).toBe(false)
    expect(await client.listQueueConsumers(account, queue.queue_id)).toEqual([])
  })

  it('module types follow wrangler’s default rules', () => {
    expect(workerModuleType('worker.js')).toBe('application/javascript+module')
    expect(workerModuleType('chunks/a.mjs')).toBe('application/javascript+module')
    expect(workerModuleType('legacy.cjs')).toBe('application/javascript')
    expect(workerModuleType('x.wasm')).toBe('application/wasm')
    expect(workerModuleType('schema.sql')).toBe('text/plain')
    expect(workerModuleType('blob.bin')).toBe('application/octet-stream')
  })

  it('workflows and routes: register against a script, then delete', async () => {
    const client = cf()
    await expect(
      client.putWorkflow(account, 'shop-agent-run', {
        scriptName: 'shop',
        className: 'AgentRunWorkflow',
      })
    ).rejects.toBeInstanceOf(CloudflareApiError)
    await client.putWorkerScript(account, 'shop', { main_module: 'index.js' }, [
      { name: 'index.js', content: 'export default {}' },
    ])
    await client.putWorkflow(account, 'shop-agent-run', {
      scriptName: 'shop',
      className: 'AgentRunWorkflow',
    })
    expect(cloud.cloudflare.workflows.get('shop-agent-run')).toEqual({
      name: 'shop-agent-run',
      class_name: 'AgentRunWorkflow',
      script_name: 'shop',
    })
    const route = await client.createWorkerRoute(zone, 'shop.clewro.com/*', 'shop')
    expect(cloud.cloudflare.scriptForHost('shop.clewro.com')?.name).toBe('shop')
    await client.deleteWorkerRoute(zone, route.id)
    await client.deleteWorkflow(account, 'shop-agent-run')
    await client.deleteWorkerScript(account, 'shop')
    expect(cloud.resourcesFor('shop')).toEqual([])
  })

  it('deploys: assets session → buckets under the session jwt → version → deployment → schedules → settings', async () => {
    const client = cf()
    await client.putWorkerScript(account, 'shop-staging', { main_module: 'index.js' }, [
      { name: 'index.js', content: 'export default {}' },
    ])
    await client.putWorkerSecret(account, 'shop-staging', 'OIDC_CLIENT_SECRET', 's3cret-value')
    const manifest = {
      '/index.html': { hash: 'a'.repeat(32), size: 5 },
      '/app.js': { hash: 'b'.repeat(32), size: 4 },
    }
    const session = await client.assetsUploadSession(account, 'shop-staging', manifest)
    expect(session.buckets?.flat().sort()).toEqual(['a'.repeat(32), 'b'.repeat(32)])
    let completion: string | null = null
    for (const bucket of session.buckets ?? []) {
      const up = await client.uploadAssetBucket(
        account,
        session.jwt,
        bucket.map(hash => ({ hash, base64: btoa(hash), contentType: 'text/plain' }))
      )
      completion = up.jwt ?? completion
    }
    expect(completion).toMatch(/^completion-/)
    // The upload authenticated with the SESSION jwt, not the API token.
    const uploads = cloud.calls.filter(c => c.path.endsWith('/workers/assets/upload'))
    expect(uploads.every(c => c.authorization === `Bearer ${session.jwt}`)).toBe(true)

    const version = await client.createVersion(
      account,
      'shop-staging',
      {
        main_module: 'worker.js',
        bindings: [{ type: 'plain_text', name: 'RELEASE_VERSION', text: '1.0.0' }],
        keep_bindings: ['secret_text'],
        assets: { jwt: completion as string },
      },
      [{ name: 'worker.js', content: new TextEncoder().encode('export default {}') }]
    )
    expect(cloud.cloudflare.activeVersion('shop-staging')).toBeNull()
    await client.createDeployment(account, 'shop-staging', version.id, 'ticket 1')
    const active = cloud.cloudflare.activeVersion('shop-staging')
    expect(active?.id).toBe(version.id)
    // keep_bindings carried the secret across the code upload.
    expect(active?.bindings).toEqual(
      expect.arrayContaining([{ type: 'secret_text', name: 'OIDC_CLIENT_SECRET' }])
    )

    await client.putSchedules(account, 'shop-staging', ['0 4 * * *', '*/5 * * * *'])
    expect(cloud.cloudflare.scripts.get('shop-staging')?.schedules).toEqual([
      '0 4 * * *',
      '*/5 * * * *',
    ])
    await client.patchScriptSettings(account, 'shop-staging', { logpush: false })
    expect(cloud.cloudflare.scripts.get('shop-staging')?.settings).toEqual({ logpush: false })
  })

  it('a version upload cannot carry DO migrations (the reason the placeholder exists)', async () => {
    const client = cf()
    await client.putWorkerScript(account, 's', { main_module: 'i.js' }, [
      { name: 'i.js', content: '' },
    ])
    await expect(
      client.createVersion(account, 's', { main_module: 'i.js', migrations: { new_tag: 'v2' } }, [
        { name: 'i.js', content: '' },
      ])
    ).rejects.toThrow(/migrations/)
  })

  it('a failNext surfaces as a CloudflareApiError carrying the status', async () => {
    cloud.failNext('/r2/buckets', 500)
    const err = await cf()
      .createR2Bucket(account, 'x')
      .catch(e => e)
    expect(err).toBeInstanceOf(CloudflareApiError)
    expect(err.status).toBe(500)
    expect(cloud.cloudflare.r2.size).toBe(0)
  })
})

describe('Neon client', () => {
  it('creates a project, roles, a database and a branch — and every id is real', async () => {
    const client = neon()
    const created = await client.createProject({
      name: 'shop',
      regionId: 'aws-us-east-2',
      orgId: 'org-x-1',
    })
    expect(created.project).toMatchObject({
      name: 'shop',
      region_id: 'aws-us-east-2',
      pg_version: 17,
    })
    await client.waitForOperations(created.project.id, created.operations)
    const main = created.branch.id
    const migrator = await client.createRole(created.project.id, main, 'migrator')
    expect(migrator.role.password).toBeTruthy()
    await client.createRole(created.project.id, main, 'app')
    await client.createDatabase(created.project.id, main, { name: 'app', ownerName: 'migrator' })
    const branch = await client.createBranch(created.project.id, {
      name: 'staging',
      parentId: main,
    })
    expect(branch.endpoints[0].branch_id).toBe(branch.branch.id)
    await client.waitForOperations(created.project.id, branch.operations)

    const project = cloud.neon.projects.get(created.project.id)
    const staging = project?.branches.get(branch.branch.id)
    // A branch inherits its parent's roles AND passwords — why the pipeline resets them there.
    expect(staging?.roles.get('migrator')?.password).toBe(migrator.role.password)
    expect(staging?.databases.get('app')).toEqual({ name: 'app', owner_name: 'migrator' })

    const reset = await client.resetRolePassword(created.project.id, branch.branch.id, 'migrator')
    expect(reset.role.password).not.toBe(migrator.role.password)
    expect(cloud.neon.resetCount(created.project.id, 'migrator')).toBe(1)

    const pooled = await client.connectionUri(created.project.id, {
      branchId: branch.branch.id,
      databaseName: 'app',
      roleName: 'app',
      pooled: true,
    })
    expect(new URL(pooled).hostname).toMatch(/^ep-[^.]+-pooler\./)
    expect(new URL(pooled).username).toBe('app')

    await client.deleteProject(created.project.id)
    expect(cloud.resourcesFor('shop')).toEqual([])
    const gone = await client.deleteProject(created.project.id).catch(e => e)
    expect(isNeonNotFound(gone)).toBe(true)
  })

  it('rides out a 423 burst through the injected sleep', async () => {
    const sleeps: number[] = []
    cloud.lockNeon(4)
    const created = await neon(sleeps).createProject({ name: 'locked', regionId: 'aws-us-east-2' })
    expect(created.project.name).toBe('locked')
    expect(sleeps).toEqual([1000, 1000, 1000, 1000])
    expect(cloud.callsTo('neon').filter(c => c.status === 423)).toHaveLength(4)
  })

  it('gives up on a 423 after lockedRetries', async () => {
    cloud.lockNeon(5)
    const client = new NeonClient('k'.repeat(20), {
      fetch: cloud.fetch,
      sleep: async () => {},
      lockedRetries: 2,
    })
    const err = await client.createProject({ name: 'x', regionId: 'aws-us-east-2' }).catch(e => e)
    expect(err).toBeInstanceOf(NeonApiError)
    expect(err.status).toBe(423)
  })

  it('waitForOperations throws on a failed operation', async () => {
    const created = await neon().createProject({ name: 'ops', regionId: 'aws-us-east-2' })
    await expect(
      neon().waitForOperations(created.project.id, [{ id: 'op-x', status: 'failed' }])
    ).rejects.toThrow(/failed/)
  })

  it('runSql: HTTP SQL as the URI’s role, at the api. host, credential in a header', async () => {
    const client = neon()
    const created = await client.createProject({ name: 'sql', regionId: 'aws-us-east-2' })
    const main = created.branch.id
    await client.createRole(created.project.id, main, 'migrator')
    await client.createRole(created.project.id, main, 'app')
    const owner = await client.resetRolePassword(created.project.id, main, 'neondb_owner')
    const uri = await client.connectionUri(created.project.id, {
      branchId: main,
      databaseName: 'neondb',
      roleName: 'neondb_owner',
      pooled: false,
    })
    expect(new URL(uri).password).toBe(owner.role.password)
    expect(neonSqlEndpoint(uri)).toMatch(/^https:\/\/api\.us-east-2\.aws\.neon\.tech\/sql$/)

    const result = await runSql(uri, 'GRANT migrator TO app', [], cloud.fetch)
    expect(result.command).toBe('GRANT')
    expect(cloud.neon.grants).toEqual([
      { projectId: created.project.id, role: 'migrator', member: 'app' },
    ])
    const call = cloud.callsTo('neon-sql')[0]
    expect(call.url).not.toContain(owner.role.password as string)

    const stale = uri.replace(owner.role.password as string, 'wrong-password')
    await expect(runSql(stale, 'SELECT 1', [], cloud.fetch)).rejects.toThrow(
      /password authentication/
    )
  })
})

describe('Resend client', () => {
  it('creates a sending key bound to the domain, then deletes it', async () => {
    const client = new ResendClient('re_full_access_key', { fetch: cloud.fetch })
    const key = await client.createSendingKey('shop-staging', cloud.opts.resendDomainId)
    expect(key.token).toMatch(/^re_/)
    expect(cloud.resend.apiKeys.get(key.id)).toMatchObject({
      name: 'shop-staging',
      permission: 'sending_access',
      domain_id: cloud.opts.resendDomainId,
    })
    expect(cloud.resourcesFor('shop')).toEqual(['resend:key:shop-staging'])
    await client.deleteApiKey(key.id)
    expect(cloud.resourcesFor('shop')).toEqual([])
    expect(isResendNotFound(await client.deleteApiKey(key.id).catch(e => e))).toBe(true)
  })
})

describe('GitHub client', () => {
  const auth = () => ({ appId: String(cloud.opts.appId), privateKey })
  const org = () => cloud.opts.org

  async function repoToken(
    scope: { repositories?: string[]; permissions?: Record<string, string> } = {}
  ) {
    const minted = await installationToken(auth(), cloud.opts.installationId, scope, {
      fetch: cloud.fetch,
    })
    return minted.token
  }

  it('repos: create (auto_init), get, archive, delete — a deleted repo is null/404', async () => {
    const token = await repoToken()
    const repo = await createOrgRepo(
      token,
      org(),
      { name: 'shop', description: 'Shop' },
      { fetch: cloud.fetch }
    )
    expect(repo).toMatchObject({ name: 'shop', private: true, default_branch: 'main' })
    expect(typeof repo.id).toBe('number')
    expect((await getRepo(token, org(), 'shop', { fetch: cloud.fetch }))?.id).toBe(repo.id)
    await expect(
      createOrgRepo(token, org(), { name: 'shop' }, { fetch: cloud.fetch })
    ).rejects.toThrow(GitHubApiError)
    expect((await archiveRepo(token, org(), 'shop', { fetch: cloud.fetch })).archived).toBe(true)
    expect(cloud.resourcesFor('shop')).toEqual([])
    await deleteRepo(token, org(), 'shop', { fetch: cloud.fetch })
    expect(await getRepo(token, org(), 'shop', { fetch: cloud.fetch })).toBeNull()
    expect(
      isGitHubNotFound(await deleteRepo(token, org(), 'shop', { fetch: cloud.fetch }).catch(e => e))
    ).toBe(true)
  })

  it('Git Data: commitFiles writes (and deletes) files in one commit, readable through getRepoFile', async () => {
    const token = await repoToken()
    const opts = { fetch: cloud.fetch }
    await createOrgRepo(token, org(), { name: 'shop' }, opts)
    const { sha } = await commitFiles(
      token,
      org(),
      'shop',
      'main',
      [
        { path: '.github/workflows/launch-scaffold.yml', content: 'on: workflow_dispatch\n' },
        { path: '.launch/scaffold.mjs', content: 'console.log(1)\n', mode: '100755' },
        { path: 'README.md', content: null },
      ],
      'Add the scaffold job',
      opts
    )
    const ref = await getRef(token, org(), 'shop', 'heads/main', opts)
    expect(ref.object.sha).toBe(sha)
    const commit = await getCommit(token, org(), 'shop', sha, opts)
    expect(commit.message).toBe('Add the scaffold job')
    expect(await getRepoFile(token, org(), 'shop', '.launch/scaffold.mjs', undefined, opts)).toBe(
      'console.log(1)\n'
    )
    expect(await getRepoFile(token, org(), 'shop', 'README.md', undefined, opts)).toBeNull()
    expect(cloud.github.readFile(org(), 'shop', '.github/workflows/launch-scaffold.yml')).toContain(
      'workflow_dispatch'
    )

    // The four calls by hand: a non-fast-forward ref update is refused unless forced.
    const tree = await createTree(
      token,
      org(),
      'shop',
      { files: [{ path: 'x', content: 'y' }] },
      opts
    )
    const orphan = await createCommit(
      token,
      org(),
      'shop',
      { message: 'orphan', tree: tree.sha, parents: [] },
      opts
    )
    await expect(updateRef(token, org(), 'shop', 'heads/main', orphan.sha, opts)).rejects.toThrow(
      /fast forward/
    )
    await updateRef(token, org(), 'shop', 'heads/main', orphan.sha, { ...opts, force: true })
    expect(cloud.github.readFile(org(), 'shop', 'x')).toBe('y')
  })

  it('a token without workflows: write cannot push a workflow file', async () => {
    const admin = await repoToken()
    await createOrgRepo(admin, org(), { name: 'shop' }, { fetch: cloud.fetch })
    const contentsOnly = await repoToken({
      repositories: ['shop'],
      permissions: { contents: 'write' },
    })
    await expect(
      commitFiles(
        contentsOnly,
        org(),
        'shop',
        'main',
        [{ path: '.github/workflows/x.yml', content: 'x' }],
        'x',
        {
          fetch: cloud.fetch,
        }
      )
    ).rejects.toThrow(/workflows/)
  })

  it('an installation token scoped to one repo cannot touch another', async () => {
    const admin = await repoToken()
    await createOrgRepo(admin, org(), { name: 'shop' }, { fetch: cloud.fetch })
    await createOrgRepo(admin, org(), { name: 'other' }, { fetch: cloud.fetch })
    const scoped = await repoToken({
      repositories: ['shop'],
      permissions: { contents: 'write', workflows: 'write' },
    })
    expect(cloud.github.tokens.get(scoped)?.repositories).toEqual(['shop'])
    expect(await getRepo(scoped, org(), 'shop', { fetch: cloud.fetch })).not.toBeNull()
    const err = await getRepo(scoped, org(), 'other', { fetch: cloud.fetch }).catch(e => e)
    expect(err).toBeInstanceOf(GitHubApiError)
    expect(err.status).toBe(403)
  })

  it('Actions: dispatch is a 404 until the workflow file exists, then a run is listed', async () => {
    const token = await repoToken()
    const opts = { fetch: cloud.fetch }
    await createOrgRepo(token, org(), { name: 'shop' }, opts)
    const err = await dispatchWorkflow(
      token,
      org(),
      'shop',
      'deploy.yml',
      { ref: 'main' },
      opts
    ).catch(e => e)
    expect(isGitHubNotFound(err)).toBe(true)

    const dispatched: string[] = []
    cloud.github.onDispatch = run => {
      dispatched.push(run.inputs.environment)
    }
    cloud.github.pushCommit(org(), 'shop', {
      '.github/workflows/deploy.yml': 'on: workflow_dispatch',
    })
    await dispatchWorkflow(
      token,
      org(),
      'shop',
      'deploy.yml',
      { ref: 'main', inputs: { environment: 'staging' } },
      opts
    )
    expect(dispatched).toEqual(['staging'])
    const runs = await listWorkflowRuns(token, org(), 'shop', 'deploy.yml', {}, opts)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'queued', event: 'workflow_dispatch' })
  })

  it('settings: environments, variables (create then update), and revoking a token', async () => {
    const token = await repoToken()
    const opts = { fetch: cloud.fetch }
    await createOrgRepo(token, org(), { name: 'shop' }, opts)
    await putEnvironment(token, org(), 'shop', 'staging', {}, opts)
    await putEnvironment(token, org(), 'shop', 'production', {}, opts)
    await upsertRepoVariable(token, org(), 'shop', 'DEPLOYER_URL', 'https://launch.test/ci', opts)
    await upsertRepoVariable(
      token,
      org(),
      'shop',
      'DEPLOYER_URL',
      'https://launch.example/ci',
      opts
    )
    const repo = cloud.github.repo(org(), 'shop')
    expect([...(repo?.environments.keys() ?? [])]).toEqual(['staging', 'production'])
    expect(repo?.variables.get('DEPLOYER_URL')).toBe('https://launch.example/ci')

    await revokeInstallationToken(token, opts)
    expect(cloud.github.tokens.get(token)?.revoked).toBe(true)
    const err = await getRepo(token, org(), 'shop', opts).catch(e => e)
    expect(err.status).toBe(401)
  })
})
