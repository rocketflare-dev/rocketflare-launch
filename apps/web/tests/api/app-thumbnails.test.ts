/**
 * App thumbnails (`services/launch/thumbnails`): the `app.thumbnail` job against a FAKE browser
 * (the `ScreenshotPort` seam), the routes that serve and refresh the picture, and the list/detail
 * field that points at it.
 *
 * What it pins: the job only ever opens the root of the URL Launch recorded, and refuses anything
 * that is not https on a public host (or, for a created app, not the host Launch provisioned); a
 * version already pictured is skipped unless forced; no `BROWSER` binding is a quiet ack, never a
 * retry; the picture lands under the tenant's purge prefix with its metadata on the row and a
 * nudge for the open pages; the GET is tenant-scoped, Live-first and cache-friendly; the refresh
 * is `manage App` and taken at most once a minute.
 */
import {
  appDetailSchema,
  appListResponseSchema,
  appThumbnailRefreshResponseSchema,
} from '@launch/shared/launch-apps'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { makeAppThumbnailHandler } from '@/api/queues/handlers/app-thumbnail'
import { processJobsBatch } from '@/api/queues/jobs'
import { buildJobEnvelope } from '@/api/services/jobs'
import type { ScreenshotPort, ScreenshotRequest } from '@/api/services/launch/thumbnails/screenshot'
import {
  captureTarget,
  enqueueThumbnailAfterDeploy,
  THUMBNAIL_MAX_BYTES,
  thumbnailKey,
  thumbnailOf,
} from '@/api/services/launch/thumbnails/thumbnails'
import { createR2Storage, purgeTenantObjects, tenantStoragePrefix } from '@/api/services/storage'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { appEnvironments, apps } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps, seedApp } from '../helpers/launch-apps'
import { request } from '../helpers/request'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const tenantIds: string[] = []
afterAll(() => forgetApps(db, tenantIds))

function fakeLogger() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  }
  return log as unknown as Logger & typeof log
}

/** A browser that records where it was sent and answers a few WebP-ish bytes. */
function fakeBrowser(options: { bytes?: number; fail?: Error } = {}) {
  const calls: ScreenshotRequest[] = []
  const port: ScreenshotPort = {
    async capture(req) {
      calls.push(req)
      if (options.fail) throw options.fail
      return {
        bytes: new Uint8Array(options.bytes ?? 64).fill(7),
        contentType: 'image/webp',
        finalUrl: `${req.url}login`,
      }
    },
  }
  return { port, calls }
}

async function session(role: 'owner' | 'admin' | 'member', tenantId?: string) {
  if (tenantId) {
    const user = await createTestUser(db)
    await linkUserToTenant(db, user.id, tenantId, role)
    return { tenantId, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)) }
  }
  const { user, tenant } = await createTestTenantWithUser(db, role)
  tenantIds.push(tenant.id)
  return {
    tenantId: tenant.id,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

/** An app whose environments each run `version`. */
async function deployedApp(tenantId: string, version = '1.2.0') {
  const seeded = await seedApp(db, tenantId)
  await db
    .update(appEnvironments)
    .set({ lastDeployVersion: version })
    .where(eq(appEnvironments.appId, seeded.app.id))
  return seeded
}

function runner(env: TestEnv, port: ScreenshotPort | null) {
  const handler = makeAppThumbnailHandler(() => port)
  const logger = fakeLogger()
  return {
    logger,
    run: (payload: {
      tenantId: string
      appId: string
      environment: 'staging' | 'production'
      force?: boolean
    }) =>
      handler(buildJobEnvelope({ type: 'app.thumbnail', payload }) as never, {
        env,
        config: loadConfig(env),
        logger,
        db,
      }),
  }
}

async function envRow(appId: string, name: 'staging' | 'production') {
  const rows = await db.select().from(appEnvironments).where(eq(appEnvironments.appId, appId))
  const row = rows.find(r => r.name === name)
  if (!row) throw new Error(`no ${name} row`)
  return row
}

describe('captureTarget — where a capture may look', () => {
  const imported = { slug: 'expenses', source: 'imported' as const }
  const created = { slug: 'expenses', source: 'created' as const }

  it('opens the ROOT of the recorded https origin, whatever path the URL carried', () => {
    expect(captureTarget('https://expenses.example.com', imported, 'production', null)).toEqual({
      url: 'https://expenses.example.com/',
      problem: null,
    })
    expect(
      captureTarget('https://expenses.example.com/admin?x=1#y', imported, 'production', null).url
    ).toBe('https://expenses.example.com/')
  })

  it('refuses no URL, http, credentials and hosts only this network can reach', () => {
    for (const url of [
      null,
      'not a url',
      'http://expenses.example.com',
      'https://user:pw@expenses.example.com',
      'https://localhost',
      'https://app.localhost',
      'https://10.0.0.4',
      'https://192.168.1.10',
      'https://[::1]',
      'https://intranet',
      'https://box.internal',
    ]) {
      expect(captureTarget(url, imported, 'production', null).url, String(url)).toBeNull()
    }
  })

  it('pins a created app to the host Launch provisioned under apps_domain', () => {
    expect(
      captureTarget('https://expenses-staging.clewro.com', created, 'staging', 'clewro.com').url
    ).toBe('https://expenses-staging.clewro.com/')
    expect(
      captureTarget('https://expenses.clewro.com', created, 'production', 'clewro.com').url
    ).toBe('https://expenses.clewro.com/')
    // Another app's host, or a foreign one, is refused even though it is public https.
    expect(
      captureTarget('https://payroll.clewro.com', created, 'production', 'clewro.com')
    ).toEqual({
      url: null,
      problem: 'the recorded host is not expenses.clewro.com',
    })
    expect(
      captureTarget('https://evil.example', created, 'production', 'clewro.com').url
    ).toBeNull()
  })
})

describe('the app.thumbnail job', () => {
  it('captures the recorded root URL into R2 under the tenant prefix, records it and nudges', async () => {
    const admin = await session('admin')
    const { app } = await deployedApp(admin.tenantId)
    const env = createTestEnv()
    const browser = fakeBrowser()
    await runner(env, browser.port).run({
      tenantId: admin.tenantId,
      appId: app.id,
      environment: 'production',
    })

    expect(browser.calls).toEqual([
      {
        url: `https://${app.slug}.apps.test/`,
        viewport: { width: 1280, height: 800 },
        timeoutMs: 15_000,
      },
    ])
    const key = thumbnailKey(admin.tenantId, app.id, 'production')
    expect(key).toBe(`tenants/${admin.tenantId}/apps/${app.id}/thumbnail-production.webp`)
    const stored = stubs(env).files.objects.get(key)
    expect(stored?.body.byteLength).toBe(64)
    expect(stored?.httpMetadata?.contentType).toBe('image/webp')

    const row = await envRow(app.id, 'production')
    expect(row).toMatchObject({ thumbnailKey: key, thumbnailVersion: '1.2.0' })
    expect(row.thumbnailCapturedAt).toBeInstanceOf(Date)
    // Staging was not asked for.
    expect((await envRow(app.id, 'staging')).thumbnailKey).toBeNull()

    expect(stubs(env).hub.broadcasts).toEqual([
      {
        tenantId: admin.tenantId,
        args: [
          'broadcast',
          expect.objectContaining({
            type: 'entity.changed',
            payload: { entity: 'apps', id: app.id },
          }),
        ],
      },
    ])
  })

  it('skips a version already pictured, and recaptures it when forced', async () => {
    const admin = await session('admin')
    const { app } = await deployedApp(admin.tenantId, '2.0.0')
    const env = createTestEnv()
    const browser = fakeBrowser()
    const { run } = runner(env, browser.port)
    const payload = { tenantId: admin.tenantId, appId: app.id, environment: 'staging' as const }
    await run(payload)
    await run(payload)
    expect(browser.calls).toHaveLength(1)

    await run({ ...payload, force: true })
    expect(browser.calls).toHaveLength(2)

    // A new version is a new picture.
    await db
      .update(appEnvironments)
      .set({ lastDeployVersion: '2.0.1' })
      .where(eq(appEnvironments.appId, app.id))
    await run(payload)
    expect(browser.calls).toHaveLength(3)
    expect((await envRow(app.id, 'staging')).thumbnailVersion).toBe('2.0.1')
  })

  it('never navigates to a refused URL, and acks rather than retrying', async () => {
    const admin = await session('admin')
    const { app } = await seedApp(db, admin.tenantId, {
      environments: { production: 'http://intranet.example.com', staging: null },
    })
    const env = createTestEnv()
    const browser = fakeBrowser()
    const { run, logger } = runner(env, browser.port)
    await run({ tenantId: admin.tenantId, appId: app.id, environment: 'production' })
    await run({ tenantId: admin.tenantId, appId: app.id, environment: 'staging' })
    expect(browser.calls).toEqual([])
    expect(stubs(env).files.objects.size).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ problem: 'the recorded URL is not https' }),
      'thumbnail: refusing to capture'
    )
  })

  it('skips an archived app, another tenant’s app and an oversized picture', async () => {
    const admin = await session('admin')
    const other = await session('admin')
    const archived = await seedApp(db, admin.tenantId, { status: 'archived' })
    const { app } = await deployedApp(admin.tenantId)
    const env = createTestEnv()
    const browser = fakeBrowser()
    const { run } = runner(env, browser.port)
    await run({ tenantId: admin.tenantId, appId: archived.app.id, environment: 'production' })
    // The right app id under the WRONG tenant finds nothing.
    await run({ tenantId: other.tenantId, appId: app.id, environment: 'production' })
    expect(browser.calls).toEqual([])

    const huge = fakeBrowser({ bytes: THUMBNAIL_MAX_BYTES + 1 })
    await runner(env, huge.port).run({
      tenantId: admin.tenantId,
      appId: app.id,
      environment: 'production',
    })
    expect(huge.calls).toHaveLength(1)
    expect(stubs(env).files.objects.size).toBe(0)
    expect((await envRow(app.id, 'production')).thumbnailKey).toBeNull()
  })

  it('a failed capture throws (the consumer retries) and leaves the old picture alone', async () => {
    const admin = await session('admin')
    const { app } = await deployedApp(admin.tenantId)
    const env = createTestEnv()
    const failing = fakeBrowser({ fail: new Error('Navigation timeout of 15000 ms exceeded') })
    await expect(
      runner(env, failing.port).run({
        tenantId: admin.tenantId,
        appId: app.id,
        environment: 'production',
      })
    ).rejects.toThrow('Navigation timeout')
    expect((await envRow(app.id, 'production')).thumbnailKey).toBeNull()
  })

  it('without a BROWSER binding the real consumer logs and ACKS — no retry storm', async () => {
    const admin = await session('admin')
    const { app } = await deployedApp(admin.tenantId)
    const env = createTestEnv()
    expect((env as Record<string, unknown>).BROWSER).toBeUndefined()
    const logger = fakeLogger()
    const message = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      body: buildJobEnvelope({
        type: 'app.thumbnail',
        payload: { tenantId: admin.tenantId, appId: app.id, environment: 'production' },
      }),
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    }
    const close = vi.fn(async () => {})
    await processJobsBatch(
      {
        queue: 'launch-jobs',
        messages: [message],
        ackAll: vi.fn(),
        retryAll: vi.fn(),
      } as unknown as MessageBatch<unknown>,
      { env, config: loadConfig(env), logger, createDb: () => ({ db, close }) }
    )
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(stubs(env).files.objects.size).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ appId: app.id }),
      expect.stringContaining('no BROWSER binding')
    )
  })

  it('the picture is inside the tenant’s purge prefix, so tenant.purge removes it', async () => {
    const admin = await session('admin')
    const { app } = await deployedApp(admin.tenantId)
    const env = createTestEnv()
    await runner(env, fakeBrowser().port).run({
      tenantId: admin.tenantId,
      appId: app.id,
      environment: 'production',
    })
    const key = thumbnailKey(admin.tenantId, app.id, 'production')
    expect(key.startsWith(tenantStoragePrefix(admin.tenantId))).toBe(true)
    const deleted = await purgeTenantObjects(createR2Storage(env.FILES), admin.tenantId)
    expect(deleted).toBe(1)
    expect(stubs(env).files.objects.has(key)).toBe(false)
  })
})

describe('enqueue after a deploy goes live', () => {
  it('queues a capture of that environment, unless its version is already pictured', async () => {
    const admin = await session('admin')
    const { app } = await deployedApp(admin.tenantId, '3.0.0')
    const env = createTestEnv()
    const input = {
      tenantId: admin.tenantId,
      appId: app.id,
      environment: 'production' as const,
      version: '3.0.0',
    }
    expect(await enqueueThumbnailAfterDeploy(db, env.JOBS_QUEUE, input)).toBe(true)
    expect(stubs(env).queue.messages.map(m => m.body)).toEqual([
      expect.objectContaining({
        type: 'app.thumbnail',
        payload: { tenantId: admin.tenantId, appId: app.id, environment: 'production' },
      }),
    ])

    await runner(env, fakeBrowser().port).run(input)
    stubs(env).queue.clear()
    expect(await enqueueThumbnailAfterDeploy(db, env.JOBS_QUEUE, input)).toBe(false)
    expect(stubs(env).queue.messages).toEqual([])
    // The next version is queued again.
    expect(
      await enqueueThumbnailAfterDeploy(db, env.JOBS_QUEUE, { ...input, version: '3.0.1' })
    ).toBe(true)
  })

  it('never throws: a missing queue costs the picture, not the deploy', async () => {
    const admin = await session('admin')
    const { app } = await deployedApp(admin.tenantId)
    const logger = fakeLogger()
    await expect(
      enqueueThumbnailAfterDeploy(
        db,
        undefined,
        { tenantId: admin.tenantId, appId: app.id, environment: 'staging', version: '1.2.0' },
        logger
      )
    ).resolves.toBe(false)
    expect(logger.warn).toHaveBeenCalledOnce()
  })
})

describe('thumbnailOf — which picture an app shows', () => {
  const at = new Date('2026-10-02T12:00:00Z')
  it('is Live’s, else Staging’s, else none', () => {
    const staging = {
      name: 'staging' as const,
      thumbnailKey: 'k-s',
      thumbnailCapturedAt: at,
      thumbnailVersion: '1.1.0',
    }
    const live = { ...staging, name: 'production' as const, thumbnailKey: 'k-p' }
    expect(thumbnailOf('app-1', [staging, live])).toEqual({
      url: `/api/apps/app-1/thumbnail?v=${at.getTime()}`,
      capturedAt: at,
      env: 'production',
      version: '1.1.0',
    })
    expect(thumbnailOf('app-1', [staging, { ...live, thumbnailKey: null }])?.env).toBe('staging')
    expect(thumbnailOf('app-1', [])).toBeNull()
  })
})

describe('GET /api/apps/:id/thumbnail and the list/detail field', () => {
  it('404s with no picture, then serves Live’s with an ETag; the list and detail point at it', async () => {
    const admin = await session('admin')
    const member = await session('member', admin.tenantId)
    const { app } = await deployedApp(admin.tenantId)
    const env = createTestEnv()

    const none = await request(`/api/apps/${app.id}/thumbnail`, { headers: member.cookie }, { env })
    expect(none.status).toBe(404)
    expect(await none.json()).toMatchObject({ code: 'thumbnail_not_found' })

    const listBefore = appListResponseSchema.parse(
      await (await request('/api/apps', { headers: member.cookie }, { env })).json()
    )
    expect(listBefore.items.find(a => a.id === app.id)?.thumbnail).toBeNull()

    const { run } = runner(env, fakeBrowser().port)
    await run({ tenantId: admin.tenantId, appId: app.id, environment: 'staging' })
    const list = appListResponseSchema.parse(
      await (await request('/api/apps', { headers: member.cookie }, { env })).json()
    )
    expect(list.items.find(a => a.id === app.id)?.thumbnail).toMatchObject({
      env: 'staging',
      version: '1.2.0',
    })

    await run({ tenantId: admin.tenantId, appId: app.id, environment: 'production' })
    const detail = appDetailSchema.parse(
      await (await request(`/api/apps/${app.slug}`, { headers: member.cookie }, { env })).json()
    )
    expect(detail.thumbnail?.env).toBe('production')
    expect(detail.thumbnail?.url).toMatch(new RegExp(`^/api/apps/${app.id}/thumbnail\\?v=\\d+$`))

    const res = await request(detail.thumbnail?.url ?? '', { headers: member.cookie }, { env })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600')
    const etag = res.headers.get('etag') ?? ''
    expect(etag).not.toBe('')
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(64)

    const again = await request(
      `/api/apps/${app.id}/thumbnail`,
      { headers: { ...member.cookie, 'If-None-Match': etag } },
      { env }
    )
    expect(again.status).toBe(304)
  })

  it('is tenant-scoped: another organisation’s app is a 404', async () => {
    const admin = await session('admin')
    const stranger = await session('admin')
    const { app } = await deployedApp(admin.tenantId)
    const env = createTestEnv()
    await runner(env, fakeBrowser().port).run({
      tenantId: admin.tenantId,
      appId: app.id,
      environment: 'production',
    })
    const res = await request(
      `/api/apps/${app.id}/thumbnail`,
      { headers: stranger.cookie },
      { env }
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'app_not_found' })
  })
})

describe('POST /api/apps/:id/thumbnail/refresh', () => {
  it('queues a forced capture per environment with a URL; a member may not; once a minute', async () => {
    const admin = await session('admin')
    const member = await session('member', admin.tenantId)
    const { app } = await seedApp(db, admin.tenantId, {
      environments: { staging: 'https://refresh-staging.apps.test', production: null },
    })
    const env = createTestEnv()
    const path = `/api/apps/${app.id}/thumbnail/refresh`

    const forbidden = await request(path, { method: 'POST', headers: member.cookie }, { env })
    expect(forbidden.status).toBe(403)

    const res = await request(path, { method: 'POST', headers: admin.cookie }, { env })
    expect(res.status).toBe(202)
    expect(appThumbnailRefreshResponseSchema.parse(await res.json())).toEqual({
      queued: ['staging'],
    })
    expect(stubs(env).queue.messages.map(m => m.body)).toEqual([
      expect.objectContaining({
        type: 'app.thumbnail',
        payload: { tenantId: admin.tenantId, appId: app.id, environment: 'staging', force: true },
      }),
    ])

    const soon = await request(path, { method: 'POST', headers: admin.cookie }, { env })
    expect(soon.status).toBe(429)
    expect(stubs(env).queue.messages).toHaveLength(1)

    // A minute later the claim is free again.
    await db
      .update(apps)
      .set({ thumbnailRefreshAt: new Date(Date.now() - 61_000) })
      .where(eq(apps.id, app.id))
    expect((await request(path, { method: 'POST', headers: admin.cookie }, { env })).status).toBe(
      202
    )
  })

  it('409s for an archived app or one with no address, and 404s across tenants', async () => {
    const admin = await session('admin')
    const stranger = await session('admin')
    const archived = await seedApp(db, admin.tenantId, { status: 'archived' })
    const bare = await seedApp(db, admin.tenantId, { environments: {} })
    const env = createTestEnv()
    const post = (id: string, cookie: Record<string, string>) =>
      request(`/api/apps/${id}/thumbnail/refresh`, { method: 'POST', headers: cookie }, { env })

    const a = await post(archived.app.id, admin.cookie)
    expect(a.status).toBe(409)
    expect(await a.json()).toMatchObject({ code: 'app_archived' })
    const b = await post(bare.app.id, admin.cookie)
    expect(b.status).toBe(409)
    expect(await b.json()).toMatchObject({ code: 'no_environment_url' })
    expect((await post(bare.app.id, stranger.cookie)).status).toBe(404)
    expect(stubs(env).queue.messages).toEqual([])
  })
})
