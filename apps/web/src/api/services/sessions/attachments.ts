/**
 * A coding session's images (the composer's paste, drop and attach): stored in R2 `FILES` at
 * `sessions/<sessionId>/attachments/<uuid>` with the content type in the object's `httpMetadata`.
 * There is no table — the session row is the only way in, so every read and write goes through
 * the route's `getVisibleSession` first, and an id is only ever looked up under ITS session's
 * prefix (another session's id is simply not there: 400 `attachment_not_found` / 404).
 *
 * - `storeSessionAttachment`: one upload — PNG, JPEG, GIF or WebP, at most
 *   `SESSION_ATTACHMENT_MAX_BYTES`, and the BYTES must say the same type the part declares
 *   (`sniffImageType`), so a renamed HTML file is a 415 rather than an "image" served back later.
 * - `resolveSessionAttachments`: the ids a turn names, in order, each `head`ed under the
 *   session's prefix — what `requestTurn` stores as `pending_attachments`.
 * - `stageAttachments`: the turn's half — each image from R2 into the container at
 *   `SESSION_ATTACHMENT_DIR/<id>.<ext>`, beside the checkout (`/workspace/app`), never in it, so a
 *   checkpoint can never commit one. What the runtime's command reads (`RuntimeAttachment`).
 *
 * A preview screenshot is one of these too: the preview's bridge renders it in the browser and
 * the composer uploads it like any image.
 *
 * Nothing deletes these objects: like the transcript (`sessions/<id>/claude.jsonl`) they outlive
 * the session, so its transcript's thumbnails keep working (`docs/CONCEPTS.md` §18, known gaps).
 */
import {
  isSessionAttachmentMimeType,
  SESSION_ATTACHMENT_MAX_BYTES,
  type SessionAttachment,
  type SessionAttachmentMimeType,
} from '@launch/shared/launch-sessions'
import { ApiError, BadRequestError, ServiceUnavailableError } from '../../utils/core/errors'
import { newId } from '../../utils/core/ids'
import { createR2Storage, type StorageService } from '../storage'
import { SESSION_LAUNCH_DIR } from './rocketflare-dev'
import type { RuntimeAttachment } from './runtimes/types'
import type { SandboxPort } from './sandbox-port'

/** Where a turn's images land in the container — outside the checkout, so never committed. */
export const SESSION_ATTACHMENT_DIR = `${SESSION_LAUNCH_DIR}/attachments`

/** The R2 key of one session image. */
export function sessionAttachmentKey(sessionId: string, attachmentId: string): string {
  return `sessions/${sessionId}/attachments/${attachmentId}`
}

const EXTENSIONS: Record<SessionAttachmentMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** The container path a turn writes `attachment` to. */
export function attachmentPath(attachment: SessionAttachment): string {
  return `${SESSION_ATTACHMENT_DIR}/${attachment.id}.${EXTENSIONS[attachment.contentType]}`
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0) =>
  bytes.length >= offset + prefix.length && prefix.every((b, i) => bytes[offset + i] === b)

const ascii = (text: string) => [...text].map(ch => ch.charCodeAt(0))

/** The image type the bytes themselves say, by their magic number; null for anything else. Pure. */
export function sniffImageType(bytes: Uint8Array): SessionAttachmentMimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp'
  return null
}

/** `FILES` as the storage seam, or 503 `storage_not_configured` — before anything is written. */
export function requireSessionStorage(env: { FILES?: R2Bucket }): StorageService {
  if (!env.FILES) {
    throw new ServiceUnavailableError('File storage is not configured', 'storage_not_configured')
  }
  return createR2Storage(env.FILES)
}

const unsupported = () =>
  new ApiError(415, 'Attach a PNG, JPEG, GIF or WebP image', 'unsupported_media_type')

/** Validate one uploaded image and store it under the session's prefix. */
export async function storeSessionAttachment(
  storage: StorageService,
  session: { id: string; tenantId: string },
  file: Blob,
  declaredType: string
): Promise<SessionAttachment & { bytes: number }> {
  if (file.size === 0) throw new BadRequestError('The file is empty', 'file_empty')
  if (file.size > SESSION_ATTACHMENT_MAX_BYTES) {
    throw new ApiError(
      413,
      `Images must be ${SESSION_ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB or smaller`,
      'payload_too_large',
      { maxBytes: SESSION_ATTACHMENT_MAX_BYTES, sizeBytes: file.size }
    )
  }
  if (!isSessionAttachmentMimeType(declaredType)) throw unsupported()
  const bytes = new Uint8Array(await file.arrayBuffer())
  // The declared type is the browser's guess from a file name: the bytes must agree with it.
  if (sniffImageType(bytes) !== declaredType) throw unsupported()
  const id = newId()
  await storage.put(sessionAttachmentKey(session.id, id), bytes, {
    contentType: declaredType,
    metadata: { tenantId: session.tenantId, sessionId: session.id },
  })
  return { id, contentType: declaredType, bytes: bytes.byteLength }
}

/**
 * The images a turn names, in order (duplicates dropped), each found under THIS session's prefix
 * with its stored type — 400 `attachment_not_found` for one that is not there.
 */
export async function resolveSessionAttachments(
  storage: StorageService,
  sessionId: string,
  ids: readonly string[]
): Promise<SessionAttachment[]> {
  const out: SessionAttachment[] = []
  for (const id of new Set(ids)) {
    const meta = await storage.head(sessionAttachmentKey(sessionId, id))
    if (!meta || !isSessionAttachmentMimeType(meta.contentType)) {
      throw new BadRequestError(
        'An attached image was not found on this session. Attach it again.',
        'attachment_not_found',
        { id }
      )
    }
    out.push({ id, contentType: meta.contentType })
  }
  return out
}

/** A turn's images could not be put into the container; the message is safe to show. */
export class AttachmentsUnavailableError extends Error {
  constructor(message = 'Launch could not load the images attached to this message') {
    super(message)
    this.name = 'AttachmentsUnavailableError'
  }
}

/**
 * Copy a turn's images from R2 into the container (see the header) and say where each went.
 * Throws `AttachmentsUnavailableError` when the bucket or an object is missing; a sandbox error
 * (a rollout's `SandboxInterruptedError`) propagates as it is.
 */
export async function stageAttachments(
  sandbox: SandboxPort,
  storage: StorageService | null,
  sessionId: string,
  attachments: readonly SessionAttachment[]
): Promise<RuntimeAttachment[]> {
  if (attachments.length === 0) return []
  if (!storage) throw new AttachmentsUnavailableError()
  const staged: RuntimeAttachment[] = []
  for (const attachment of attachments) {
    const object = await storage.get(sessionAttachmentKey(sessionId, attachment.id))
    if (!object) throw new AttachmentsUnavailableError()
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer())
    const path = attachmentPath(attachment)
    await sandbox.writeFileBytes(path, bytes)
    staged.push({ path, contentType: attachment.contentType })
  }
  return staged
}
