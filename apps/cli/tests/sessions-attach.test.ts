/**
 * Issue #6: `sessions attach <id> <file…>` — images for the next message, one multipart `file`
 * part per upload, checked against the composer's limits (type by magic bytes, size, count)
 * BEFORE any request; a refusal is the server's sentence (exit 1), a 403 exits 3.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_ATTACHMENT_MAX_BYTES } from '@launch/shared/launch-sessions'
import { afterEach, describe, expect, it } from 'vitest'
import { runSessionsAttach, sniffImageType } from '../src/commands/sessions-attach'
import { EXIT_ERROR, EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
import type { Route } from './helpers'
import { jsonResponse, mockFetch, testContext } from './helpers'
import { loggedInStore } from './p4-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

const ID = '5e551000-0000-4000-8000-000000000001'
const AID = 'a7700000-0000-4000-8000-000000000001'
const upload = `/api/sessions/${ID}/attachments`
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

async function file(name: string, bytes: Uint8Array) {
  const dir = await mkdtemp(join(tmpdir(), 'launch-attach-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, name)
  await writeFile(path, bytes)
  return path
}

async function run(files: string[], routes: Record<string, Route>, json = false) {
  const { fetch, calls } = mockFetch(routes)
  const t = await testContext({ store: await loggedInStore(cleanups), fetch, json })
  const error: any = await runSessionsAttach(t.ctx, ID, files).then(
    () => null,
    (e: unknown) => e
  )
  return { ...t, calls, error }
}

describe('sessions attach', () => {
  it('knows the four image types by their first bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageType(new TextEncoder().encode('GIF89a'))).toBe('image/gif')
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImageType(new TextEncoder().encode('%PDF-1.7'))).toBeNull()
  })

  it('uploads one multipart `file` part per image; --json is { items }', async () => {
    const path = await file('shot.png', PNG)
    const r = await run(
      [path],
      { [upload]: () => jsonResponse({ id: AID, contentType: 'image/png', bytes: 11 }, 201) },
      true
    )
    expect(r.error).toBeNull()
    const body = r.calls[0]?.init.body
    expect(r.calls[0]?.init.method).toBe('POST')
    expect(body).toBeInstanceOf(FormData)
    const part = (body as FormData).get('file') as File
    expect(part.type).toBe('image/png')
    expect(part.name).toBe('shot.png')
    expect(part.size).toBe(PNG.byteLength)
    expect(JSON.parse(r.out.content()).items[0]).toMatchObject({ id: AID, file: path })
  })

  it('refuses a non-image, an oversized image or too many before any upload', async () => {
    const pdf = await file('a.pdf', new TextEncoder().encode('%PDF-1.7'))
    const notImage = await run([pdf], {})
    expect(exitCodeFor(notImage.error)).toBe(EXIT_ERROR)
    expect(notImage.calls).toHaveLength(0)

    const big = new Uint8Array(SESSION_ATTACHMENT_MAX_BYTES + 1)
    big.set(PNG)
    const huge = await run([await file('big.png', big)], {})
    expect(huge.error.message).toContain('at most 5.0 MB')
    expect(huge.calls).toHaveLength(0)

    const png = await file('a.png', PNG)
    const many = await run([png, png, png, png, png, png], {})
    expect(many.error.message).toContain('At most 5 images')
    expect(many.calls).toHaveLength(0)
  })

  it('a session that takes no message is the server’s 409 (exit 1); a 403 exits 3', async () => {
    const png = await file('a.png', PNG)
    const ended = await run([png], {
      [upload]: () =>
        jsonResponse(
          { error: 'This session is ended', statusCode: 409, code: 'session_not_active' },
          409
        ),
    })
    expect(exitCodeFor(ended.error)).toBe(EXIT_ERROR)
    expect(ended.error.message).toBe('This session is ended')
    const denied = await run([png], {
      [upload]: () => jsonResponse({ error: 'Forbidden', statusCode: 403 }, 403),
    })
    expect(exitCodeFor(denied.error)).toBe(EXIT_FORBIDDEN)
  })
})
