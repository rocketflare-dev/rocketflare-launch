/**
 * A coding session's images (`routes/session-attachments.ts`, `services/sessions/attachments.ts`)
 * through the real Hono app: the upload's checks (the type by its BYTES too, the size, the
 * session's state, who may), the R2 key under the session's own prefix, the bytes streamed back
 * (`nosniff`, `private`), and `POST /:id/turns` naming them — each id found under THAT session,
 * stored as `pending_attachments`, shown as `queuedAttachments`, cleared by a withdraw. Another
 * tenant's session, or one the caller may not see, is the same 404; issue #5's reviewer may read
 * an image but never add one.
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import {
  SESSION_ATTACHMENT_MAX_BYTES,
  sessionAttachmentUploadResponseSchema,
  sessionDetailResponseSchema,
} from '@launch/shared/launch-sessions'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { isUploadPath } from '@/api/middleware/body-limit'
import { sessionAttachmentKey, sniffImageType } from '@/api/services/sessions/attachments'
import { approvalRequests, type SessionRow, sessions } from '@/db/schema'
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

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Bytes that START like a PNG (all the sniff reads), padded to `size`. */
function pngBytes(size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size)
  bytes.set(PNG_MAGIC)
  return bytes
}

function upload(
  sessionId: string,
  cookie: Record<string, string>,
  env: TestEnv,
  file: { bytes: Uint8Array<ArrayBuffer>; type: string; name?: string } | null
) {
  const form = new FormData()
  if (file)
    form.append('file', new File([file.bytes], file.name ?? 'shot.png', { type: file.type }))
  return request(
    `/api/sessions/${sessionId}/attachments`,
    { method: 'POST', headers: cookie, body: form },
    { env }
  )
}

const post = (path: string, cookie: Record<string, string>, env: TestEnv, body?: unknown) =>
  request(path, { method: 'POST', headers: cookie }, { env, json: body ?? {} })

async function reload(row: SessionRow): Promise<SessionRow> {
  const [latest] = await db.select().from(sessions).where(eq(sessions.id, row.id))
  if (!latest) throw new Error('gone')
  return latest
}

async function envWithInstance(row: SessionRow): Promise<TestEnv> {
  const env = createTestEnv()
  await stubs(env).sessionWorkflow?.create({ id: row.instanceId ?? row.id })
  return env
}

async function uploaded(row: SessionRow, cookie: Record<string, string>, env: TestEnv) {
  const res = await upload(row.id, cookie, env, { bytes: pngBytes(), type: 'image/png' })
  expect(res.status).toBe(201)
  return sessionAttachmentUploadResponseSchema.parse(await json(res))
}

describe('sniffImageType', () => {
  it('reads PNG, JPEG, GIF and WebP by their magic bytes, and nothing else', () => {
    const ascii = (text: string) => [...text].map(ch => ch.charCodeAt(0))
    expect(sniffImageType(pngBytes())).toBe('image/png')
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageType(new Uint8Array(ascii('GIF89a....')))).toBe('image/gif')
    expect(sniffImageType(new Uint8Array(ascii('RIFF\0\0\0\0WEBPVP8 ')))).toBe('image/webp')
    expect(sniffImageType(new Uint8Array(ascii('RIFF\0\0\0\0WAVEfmt ')))).toBeNull()
    expect(sniffImageType(new TextEncoder().encode('<html><script>'))).toBeNull()
    expect(sniffImageType(new Uint8Array())).toBeNull()
  })

  it('the upload path is exempt from the 1 MB JSON cap; the read path and the turn are not', () => {
    expect(isUploadPath('/api/sessions/0b7f6a52-3f1c-4a8e-9d0e-5a4b3c2d1e0f/attachments')).toBe(
      true
    )
    expect(isUploadPath('/api/sessions/x/attachments/y')).toBe(false)
    expect(isUploadPath('/api/sessions/x/turns')).toBe(false)
  })
})

describe('POST /api/sessions/:id/attachments', () => {
  it('stores the image under the session’s prefix with its type, and GET streams it back', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const row = await insertSession(db, f, { status: 'ready' })
    const env = createTestEnv()
    // Over the 1 MB JSON cap, under the image cap: the upload path is exempt.
    const bytes = pngBytes(2 * 1024 * 1024)
    const res = await upload(row.id, f.cookie, env, { bytes, type: 'image/png' })
    expect(res.status).toBe(201)
    const body = sessionAttachmentUploadResponseSchema.parse(await json(res))
    expect(body).toEqual({ id: expect.any(String), contentType: 'image/png', bytes: bytes.length })
    const stored = stubs(env).files.objects.get(sessionAttachmentKey(row.id, body.id))
    expect(stored?.httpMetadata?.contentType).toBe('image/png')
    expect(stored?.body.byteLength).toBe(bytes.length)

    const got = await request(
      `/api/sessions/${row.id}/attachments/${body.id}`,
      {
        headers: f.cookie,
      },
      { env }
    )
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(got.headers.get('x-content-type-options')).toBe('nosniff')
    expect(got.headers.get('cache-control')).toMatch(/^private/)
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes)

    // An id that is not there (or not a UUID) is a 404.
    const missing = await request(
      `/api/sessions/${row.id}/attachments/${crypto.randomUUID()}`,
      { headers: f.cookie },
      { env }
    )
    expect(missing.status).toBe(404)
    expect(await json(missing)).toMatchObject({ code: 'attachment_not_found' })
    // 2 MB through multipart parsing and back: ~1.5 s locally, over 5 s on a loaded CI runner.
  }, 20_000)

  it('refuses what is not an image by its bytes (415), too big (413), empty or absent (400)', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'working' })
    const env = createTestEnv()
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>')
    const cases = [
      [{ bytes: html, type: 'image/png' }, 415, 'unsupported_media_type'],
      [{ bytes: pngBytes(), type: 'image/jpeg' }, 415, 'unsupported_media_type'],
      [{ bytes: pngBytes(), type: 'image/svg+xml' }, 415, 'unsupported_media_type'],
      [{ bytes: new Uint8Array(), type: 'image/png' }, 400, 'file_empty'],
      [
        { bytes: pngBytes(SESSION_ATTACHMENT_MAX_BYTES + 1), type: 'image/png' },
        413,
        'payload_too_large',
      ],
      [null, 400, 'file_required'],
    ] as const
    for (const [file, status, code] of cases) {
      const res = await upload(row.id, f.cookie, env, file)
      expect(res.status, code).toBe(status)
      expect(await json(res)).toMatchObject({ code })
    }
    expect([...stubs(env).files.objects.keys()]).toEqual([])
  })

  it('only while the session can take a message; 503 without FILES', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    for (const status of ['shipping', 'ended', 'failed', 'blocked'] as const) {
      const row = await insertSession(db, f, { status })
      const res = await upload(row.id, f.cookie, createTestEnv(), {
        bytes: pngBytes(),
        type: 'image/png',
      })
      expect(res.status, status).toBe(409)
      expect(await json(res)).toMatchObject({ code: 'session_not_active' })
    }
    const row = await insertSession(db, f, { status: 'ready' })
    const res = await upload(row.id, f.cookie, createTestEnv({ FILES: undefined }), {
      bytes: pngBytes(),
      type: 'image/png',
    })
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({ code: 'storage_not_configured' })
  })

  it('another tenant, or a member who cannot see the session, gets 404 on both routes', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const row = await insertSession(db, f, { status: 'ready' })
    const env = createTestEnv()
    const image = await uploaded(row, f.cookie, env)
    const other = await createTestTenantWithUser(db, 'owner')
    const otherCookie = sessionCookieHeader(
      await createTestSession(db, other.user.id, other.tenant.id)
    )
    const colleague = await createTestUser(db)
    await linkUserToTenant(db, colleague.id, f.tenant.id, 'member')
    const colleagueCookie = sessionCookieHeader(
      await createTestSession(db, colleague.id, f.tenant.id)
    )
    for (const cookie of [otherCookie, colleagueCookie]) {
      const res = await upload(row.id, cookie, env, { bytes: pngBytes(), type: 'image/png' })
      expect(res.status).toBe(404)
      expect(await json(res)).toMatchObject({ code: 'session_not_found' })
      const got = await request(
        `/api/sessions/${row.id}/attachments/${image.id}`,
        { headers: cookie },
        { env }
      )
      expect(got.status).toBe(404)
    }
  })

  it('a pending merge’s reviewer may read an image but not add one', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const row = await insertSession(db, f, { status: 'ready' })
    const env = createTestEnv()
    const image = await uploaded(row, f.cookie, env)
    const reviewer = await createTestUser(db)
    await linkUserToTenant(db, reviewer.id, f.tenant.id, 'member')
    await db.insert(approvalRequests).values({
      tenantId: f.tenant.id,
      kind: 'session.merge',
      appId: f.app.id,
      subjectType: 'session',
      subjectId: row.id,
      requestedByUserId: f.user.id,
      context: {
        kind: 'session.merge',
        sessionId: row.id,
        shortId: row.shortId,
        title: null,
        appSlug: f.app.slug,
        prNumber: 1,
        prUrl: 'https://github.com/o/r/pull/1',
        prTitle: 'A change',
        summary: '',
        diffStat: '',
        headSha: 'abc',
        sessionPath: `/sessions/${row.id}`,
      },
      policy: {
        ...DEFAULT_APPROVAL_POLICIES['session.merge'],
        approvers: { appOwners: false, admins: false, groupIds: [], userIds: [reviewer.id] },
      },
      excludedUserIds: [f.user.id],
      expiresAt: new Date(Date.now() + 60 * 60_000),
    })
    const cookie = sessionCookieHeader(await createTestSession(db, reviewer.id, f.tenant.id))
    const got = await request(
      `/api/sessions/${row.id}/attachments/${image.id}`,
      { headers: cookie },
      { env }
    )
    expect(got.status).toBe(200)
    const res = await upload(row.id, cookie, env, { bytes: pngBytes(), type: 'image/png' })
    expect(res.status).toBe(404)
  })

  it('a session on its creator’s own account takes images only from them', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ready', credentialSource: 'user' })
    const admin = await createTestUser(db)
    await linkUserToTenant(db, admin.id, f.tenant.id, 'admin')
    const cookie = sessionCookieHeader(await createTestSession(db, admin.id, f.tenant.id))
    const res = await upload(row.id, cookie, createTestEnv(), {
      bytes: pngBytes(),
      type: 'image/png',
    })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'session_credential_owner_only' })
  })
})

describe('POST /api/sessions/:id/turns with images', () => {
  it('stores them as pending_attachments (the text may be empty), shown as queuedAttachments; withdraw clears them', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'working' })
    const env = await envWithInstance(row)
    const first = await uploaded(row, f.cookie, env)
    const second = await uploaded(row, f.cookie, env)

    const res = await post(`/api/sessions/${row.id}/turns`, f.cookie, env, {
      attachments: [first.id, second.id, first.id],
    })
    expect(res.status).toBe(202)
    const body = sessionDetailResponseSchema.parse(await json(res))
    expect(body.session).toMatchObject({
      pendingMessage: true,
      queuedMessage: '',
      queuedAttachments: [
        { id: first.id, contentType: 'image/png' },
        { id: second.id, contentType: 'image/png' },
      ],
    })
    expect(await reload(row)).toMatchObject({
      pendingMessage: '',
      pendingAttachments: [
        { id: first.id, contentType: 'image/png' },
        { id: second.id, contentType: 'image/png' },
      ],
    })

    const withdrawn = await post(`/api/sessions/${row.id}/queued/withdraw`, f.cookie, env)
    expect(withdrawn.status).toBe(200)
    expect(sessionDetailResponseSchema.parse(await json(withdrawn)).session).toMatchObject({
      queuedMessage: null,
      queuedAttachments: [],
    })
    expect(await reload(row)).toMatchObject({ pendingMessage: null, pendingAttachments: null })
  })

  it('400s: an id not on THIS session (attachment_not_found), nothing to send, more than five', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ready' })
    const elsewhere = await insertSession(db, f, { status: 'ready' })
    const env = await envWithInstance(row)
    const theirs = await uploaded(elsewhere, f.cookie, env)

    for (const id of [theirs.id, crypto.randomUUID()]) {
      const res = await post(`/api/sessions/${row.id}/turns`, f.cookie, env, {
        message: 'Look',
        attachments: [id],
      })
      expect(res.status).toBe(400)
      expect(await json(res)).toMatchObject({ code: 'attachment_not_found' })
    }
    const empty = await post(`/api/sessions/${row.id}/turns`, f.cookie, env, { message: '  ' })
    expect(empty.status).toBe(400)
    const many = await post(`/api/sessions/${row.id}/turns`, f.cookie, env, {
      message: 'x',
      attachments: Array.from({ length: 6 }, () => crypto.randomUUID()),
    })
    expect(many.status).toBe(400)
    expect(await reload(row)).toMatchObject({ pendingMessage: null, pendingAttachments: null })
  })
})
