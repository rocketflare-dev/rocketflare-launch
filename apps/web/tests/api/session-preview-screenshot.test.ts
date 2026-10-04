/**
 * "Screenshot preview" (the preview pane's camera): `POST /api/sessions/:id/preview-screenshot`
 * only reserves an image id and enqueues `session.preview_screenshot` (202; 503 without Browser
 * Rendering or previews, before any enqueue; the upload's right, another tenant's session a 404;
 * the viewport within bounds), and the job — against a FAKE browser (the thumbnails'
 * `ScreenshotPort`) — opens a fresh grant for the person who asked, landing on their page
 * (`to=`), captures a PNG at their viewport, and writes it as the session's image. A capture that
 * fails leaves a marker the image's `GET` answers as 422 `screenshot_failed`, and is acked.
 * The preview grant says whether the camera may show (`screenshots`).
 */
import {
  PREVIEW_SCREENSHOT_BOUNDS,
  previewGrantResponseSchema,
  previewScreenshotResponseSchema,
} from '@launch/shared/launch-sessions'
import { describe, expect, it, vi } from 'vitest'
import { makeSessionPreviewScreenshotHandler } from '@/api/queues/handlers/session-preview-screenshot'
import { processJobsBatch } from '@/api/queues/jobs'
import { buildJobEnvelope } from '@/api/services/jobs'
import type { ScreenshotPort, ScreenshotRequest } from '@/api/services/launch/thumbnails/screenshot'
import { sessionAttachmentKey } from '@/api/services/sessions/attachments'
import { verifyGrant } from '@/api/services/sessions/preview'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import type { SessionRow } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { json, request } from '../helpers/request'
import { insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const TEMPLATE = 'http://{label}.localhost:3001'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9])

/** Browser Rendering is a binding with `fetch`; the route only checks it is there. */
const BROWSER = { fetch: async () => new Response(null, { status: 501 }) }

function env(overrides: Record<string, unknown> = {}): TestEnv {
  return createTestEnv({ SESSION_PREVIEW_URL: TEMPLATE, BROWSER, ...overrides } as never)
}

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

/** A browser that records where it was sent and answers `bytes` (a PNG by default). */
function fakeBrowser(options: { bytes?: Uint8Array; fail?: Error } = {}) {
  const calls: ScreenshotRequest[] = []
  const port: ScreenshotPort = {
    async capture(req) {
      calls.push(req)
      if (options.fail) throw options.fail
      return { bytes: options.bytes ?? PNG, contentType: 'image/png', finalUrl: req.url }
    },
  }
  return { port, calls }
}

const shoot = (row: SessionRow, cookie: Record<string, string>, e: TestEnv, body: unknown) =>
  request(
    `/api/sessions/${row.id}/preview-screenshot`,
    { method: 'POST', headers: cookie },
    { env: e, json: body }
  )

const VIEW = { width: 1024, height: 700 }

function payload(row: SessionRow, userId: string, extra: Record<string, unknown> = {}) {
  return {
    tenantId: row.tenantId,
    sessionId: row.id,
    userId,
    attachmentId: crypto.randomUUID(),
    path: '/orders?tab=open',
    port: 5173,
    ...VIEW,
    ...extra,
  }
}

async function runJob(e: TestEnv, port: ScreenshotPort | null, body: ReturnType<typeof payload>) {
  const handler = makeSessionPreviewScreenshotHandler(() => port)
  await handler(buildJobEnvelope({ type: 'session.preview_screenshot', payload: body }) as never, {
    env: e,
    config: loadConfig(e),
    logger: fakeLogger(),
    db,
  })
}

describe('POST /api/sessions/:id/preview-screenshot', () => {
  it('reserves an image id and enqueues the capture (202) with the page, the port and the viewport', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const row = await insertSession(db, f, { status: 'working' })
    const e = env()
    const res = await shoot(row, f.cookie, e, { path: '/orders', ...VIEW })
    expect(res.status).toBe(202)
    const { attachmentId } = previewScreenshotResponseSchema.parse(await json(res))
    expect(stubs(e).queue.messages.map(m => m.body)).toEqual([
      expect.objectContaining({
        type: 'session.preview_screenshot',
        payload: {
          tenantId: f.tenant.id,
          sessionId: row.id,
          userId: f.user.id,
          attachmentId,
          path: '/orders',
          port: 5173,
          ...VIEW,
        },
      }),
    ])
    // Nothing is captured in the request: the image is not there yet.
    const pending = await request(
      `/api/sessions/${row.id}/attachments/${attachmentId}`,
      { headers: f.cookie },
      { env: e }
    )
    expect(pending.status).toBe(404)
  })

  it('503 without Browser Rendering or previews, before anything is queued', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ready' })
    const cases = [
      [env({ BROWSER: undefined }), 'screenshots_not_configured'],
      [env({ SESSION_PREVIEW_URL: undefined }), 'previews_not_configured'],
      [env({ FILES: undefined }), 'storage_not_configured'],
    ] as const
    for (const [e, code] of cases) {
      const res = await shoot(row, f.cookie, e, VIEW)
      expect(res.status, code).toBe(503)
      expect(await json(res)).toMatchObject({ code })
      expect(stubs(e).queue.messages).toEqual([])
    }
  })

  it('keeps the viewport, the port and the page within bounds (400)', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ready' })
    const { width, height } = PREVIEW_SCREENSHOT_BOUNDS
    const bad = [
      { width: width.min - 1, height: 600 },
      { width: width.max + 1, height: 600 },
      { width: 800, height: height.min - 1 },
      { width: 800, height: height.max + 1 },
      { width: 800.5, height: 600 },
      { height: 600 },
      { ...VIEW, port: 3000 },
      { ...VIEW, path: '//evil.example' },
      { ...VIEW, path: '/__launch/grant' },
    ]
    for (const body of bad) {
      const e = env()
      const res = await shoot(row, f.cookie, e, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(stubs(e).queue.messages).toEqual([])
    }
    const edges = env()
    for (const body of [
      { width: width.min, height: height.min, port: 8787 },
      { width: width.max, height: height.max },
    ]) {
      expect((await shoot(row, f.cookie, edges, body)).status).toBe(202)
    }
  })

  it('another tenant, or a member who cannot see it, gets 404; a session with no preview is 409', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const row = await insertSession(db, f, { status: 'ready' })
    const other = await createTestTenantWithUser(db, 'owner')
    const colleague = await createTestUser(db)
    await linkUserToTenant(db, colleague.id, f.tenant.id, 'member')
    for (const cookie of [
      sessionCookieHeader(await createTestSession(db, other.user.id, other.tenant.id)),
      sessionCookieHeader(await createTestSession(db, colleague.id, f.tenant.id)),
    ]) {
      const e = env()
      const res = await shoot(row, cookie, e, VIEW)
      expect(res.status).toBe(404)
      expect(await json(res)).toMatchObject({ code: 'session_not_found' })
      expect(stubs(e).queue.messages).toEqual([])
    }
    for (const status of ['suspended', 'booting', 'ended'] as const) {
      const asleep = await insertSession(db, f, { status })
      const res = await shoot(asleep, f.cookie, env(), VIEW)
      expect(res.status, status).toBe(409)
      expect(await json(res)).toMatchObject({ code: 'preview_not_running' })
    }
  })

  it('the preview grant says whether the camera may show', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ready' })
    for (const [e, expected] of [
      [env(), true],
      [env({ BROWSER: undefined }), false],
    ] as const) {
      const res = await request(
        `/api/sessions/${row.id}/preview-grant`,
        { method: 'POST', headers: f.cookie },
        { env: e, json: {} }
      )
      expect(previewGrantResponseSchema.parse(await json(res)).screenshots).toBe(expected)
    }
  })
})

describe('the session.preview_screenshot job', () => {
  it('opens a fresh grant for the asker that lands on their page, and writes a PNG at their viewport', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'working' })
    const e = env()
    const browser = fakeBrowser()
    const body = payload(row, f.user.id)
    await runJob(e, browser.port, body)

    expect(browser.calls).toHaveLength(1)
    const call = browser.calls[0] as ScreenshotRequest
    expect(call).toMatchObject({ viewport: VIEW, format: 'png' })
    const url = new URL(call.url)
    expect(url.host).toBe(`5173-${row.shortId}-${row.previewToken}.localhost:3001`.toLowerCase())
    expect(url.pathname).toBe('/__launch/grant')
    expect(url.searchParams.get('to')).toBe('/orders?tab=open')
    const claims = await verifyGrant(loadConfig(e), url.searchParams.get('g'), { host: url.host })
    expect(claims).toMatchObject({ sid: row.id, uid: f.user.id })

    const stored = stubs(e).files.objects.get(sessionAttachmentKey(row.id, body.attachmentId))
    expect(stored?.httpMetadata?.contentType).toBe('image/png')
    expect(stored?.body).toEqual(PNG)
    const got = await request(
      `/api/sessions/${row.id}/attachments/${body.attachmentId}`,
      { headers: f.cookie },
      { env: e }
    )
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
  })

  it('a capture that fails leaves a marker: the image answers 422 screenshot_failed, and the job is not retried', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const live = await insertSession(db, f, { status: 'ready' })
    const gone = await insertSession(db, f, { status: 'suspended' })
    const cases = [
      [
        live,
        fakeBrowser({ fail: new Error('net::ERR_CONNECTION_REFUSED') }).port,
        /could not be captured/,
      ],
      [live, null, /not available/],
      [
        live,
        fakeBrowser({ bytes: new TextEncoder().encode('<html>') }).port,
        /could not be captured/,
      ],
      [gone, fakeBrowser().port, /not running/],
    ] as const
    for (const [row, port, reason] of cases) {
      const e = env()
      const body = payload(row, f.user.id)
      await expect(runJob(e, port, body)).resolves.toBeUndefined()
      expect(stubs(e).files.objects.has(sessionAttachmentKey(row.id, body.attachmentId))).toBe(
        false
      )
      const got = await request(
        `/api/sessions/${row.id}/attachments/${body.attachmentId}`,
        { headers: f.cookie },
        { env: e }
      )
      expect(got.status).toBe(422)
      const error = await json<{ code: string; error: string }>(got)
      expect(error.code).toBe('screenshot_failed')
      expect(error.error).toMatch(reason)
    }
  })

  it('is dispatched by the consumer and acked, even with no browser bound', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ready' })
    const e = env({ BROWSER: undefined })
    const body = payload(row, f.user.id)
    const message = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      body: buildJobEnvelope({ type: 'session.preview_screenshot', payload: body }),
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    }
    const batch = {
      queue: 'launch-jobs',
      messages: [message],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<unknown>
    await processJobsBatch(batch, {
      env: e,
      config: loadConfig(e),
      logger: fakeLogger(),
      createDb: () => ({ db, close: async () => {} }) as never,
    })
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(
      stubs(e).files.objects.has(`${sessionAttachmentKey(row.id, body.attachmentId)}.failed`)
    ).toBe(true)
  })
})
