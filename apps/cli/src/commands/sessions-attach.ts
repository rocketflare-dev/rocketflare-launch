/**
 * Images for a coding session's next message (issue #6) — the composer's attach, over `POST
 * /api/sessions/:id/attachments` (multipart, one `file` part per image →
 * `sessionAttachmentUploadResponseSchema`). The composer's limits, checked before any upload:
 * PNG, JPEG, GIF or WebP (by magic bytes, as the server checks them), at most
 * `SESSION_ATTACHMENT_MAX_BYTES` each and `SESSION_ATTACHMENTS_MAX` per message. Unlike the
 * composer it does not downscale: an image past the cap is refused, not shrunk.
 *
 * - `sessions attach <id> <file…>` uploads and prints the ids (`--json`: `{ items }`); they go
 *   into a message with `sessions say <id> <msg> --attach-id <id,…>`.
 * - `sessions say <id> <msg> --attach <file…>` uploads, then sends them with the message.
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  SESSION_ATTACHMENT_MAX_BYTES,
  SESSION_ATTACHMENTS_MAX,
  type SessionAttachmentMimeType,
  type SessionAttachmentUploadResponse,
  sessionAttachmentUploadResponseSchema,
} from '@launch/shared/launch-sessions'
import chalk from 'chalk'
import type { ApiClient } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import { renderTable } from '../utils/output'
import { sessionPath } from './sessions-common'

/** The image type from its first bytes, or null — what the server checks too. Pure. */
export function sniffImageType(bytes: Uint8Array): SessionAttachmentMimeType | null {
  const at = (i: number) => bytes[i] ?? -1
  const ascii = (from: number, text: string) =>
    [...text].every((c, i) => at(from + i) === c.charCodeAt(0))
  if (at(0) === 0x89 && ascii(1, 'PNG')) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (ascii(0, 'GIF8')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return null
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** Read and check every file BEFORE any upload, so a bad one sends nothing. */
async function readImages(files: readonly string[]) {
  if (files.length === 0) throw new CliError('Give at least one image file')
  if (files.length > SESSION_ATTACHMENTS_MAX)
    throw new CliError(`At most ${SESSION_ATTACHMENTS_MAX} images per message`)
  const images: { path: string; bytes: Uint8Array; type: SessionAttachmentMimeType }[] = []
  for (const path of files) {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await readFile(path))
    } catch (error) {
      throw new CliError(`cannot read ${path}: ${(error as { code?: string }).code ?? error}`)
    }
    const type = sniffImageType(bytes)
    if (!type) throw new CliError(`${path} is not a PNG, JPEG, GIF or WebP image`)
    if (bytes.byteLength > SESSION_ATTACHMENT_MAX_BYTES)
      throw new CliError(
        `${path} is ${mb(bytes.byteLength)}; an image may be at most ${mb(SESSION_ATTACHMENT_MAX_BYTES)}`,
        {
          hint: 'Scale it down (the longest edge past 1568 px only costs upload time) and try again.',
        }
      )
    images.push({ path, bytes, type })
  }
  return images
}

/** Upload each image (one `file` part per request); the ids in order. */
export async function uploadSessionImages(
  client: ApiClient,
  id: string,
  files: readonly string[]
): Promise<(SessionAttachmentUploadResponse & { file: string })[]> {
  const images = await readImages(files)
  const out: (SessionAttachmentUploadResponse & { file: string })[] = []
  for (const image of images) {
    const form = new FormData()
    form.append('file', new Blob([image.bytes], { type: image.type }), basename(image.path))
    const { data } = await client.request('POST', `${sessionPath(id)}/attachments`, {
      schema: sessionAttachmentUploadResponseSchema,
      body: form,
    })
    out.push({ ...data, file: image.path })
  }
  return out
}

export async function runSessionsAttach(
  ctx: CommandContext,
  id: string,
  files: readonly string[]
): Promise<void> {
  if (!id.trim()) throw new CliError('Give a session id')
  const items = await uploadSessionImages(requireClient(ctx), id, files)
  ctx.out.data({ items }, () =>
    [
      renderTable(items, [
        { header: 'Id', value: a => a.id },
        { header: 'Type', value: a => a.contentType },
        { header: 'Bytes', value: a => a.bytes },
        { header: 'File', value: a => a.file },
      ]),
      chalk.dim(
        `  Send them: ${ctx.binName} sessions say ${id} "<message>" --attach-id ${items.map(a => a.id).join(',')}`
      ),
    ].join('\n')
  )
}
