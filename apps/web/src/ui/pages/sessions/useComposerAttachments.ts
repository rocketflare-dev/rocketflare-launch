/**
 * The images the NEXT message carries — the composer's chips. Owned by `SessionPage` rather than
 * the composer, because more than the composer adds to them: a paste, a drop or the paperclip
 * there, and the preview pane's "Screenshot preview" (which reserves a chip at once and fills it
 * when the server's capture lands).
 *
 * Every image uploads the moment it is added (`POST /:id/attachments`, after `downscaleImage`
 * shrinks it to `SESSION_ATTACHMENT_MAX_EDGE`), so Send only names ids. A chip is `uploading`
 * (Send waits), `ready` (its `id` goes with the message) or `error` (it says why; Send waits until
 * it is removed, so nothing is silently dropped). At most `SESSION_ATTACHMENTS_MAX`; past that, and
 * for a file that is not an image, `notice` says so instead of adding a chip.
 *
 * Removing a chip mid-upload only forgets it: the upload finishes into R2 and is never named.
 * Local previews are object URLs, revoked when their chip goes (and on unmount).
 */
import {
  isSessionAttachmentMimeType,
  SESSION_ATTACHMENT_MAX_BYTES,
  SESSION_ATTACHMENT_MAX_EDGE,
  SESSION_ATTACHMENTS_MAX,
  type SessionAttachment,
  type SessionAttachmentMimeType,
  sessionAttachmentPath,
} from '@launch/shared/launch-sessions'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { uploadSessionAttachment } from '@/ui/hooks/useSessions'
import { downscaleImage } from '@/ui/lib/images'

export interface ComposerAttachment {
  /** Local key: stable for the chip's life, whatever the server calls it. */
  key: string
  status: 'uploading' | 'ready' | 'error'
  /** The server's id once it has one. */
  id: string | null
  contentType: SessionAttachmentMimeType | null
  /** What the chip shows: the local file while it uploads, the server's copy otherwise. */
  previewUrl: string | null
  /** What it is, for the chip's label and alt text. */
  label: string
  error: string | null
}

export interface ComposerAttachments {
  items: readonly ComposerAttachment[]
  /** Pasted, dropped or picked files: each is checked, shrunk and uploaded. */
  addFiles(files: readonly File[]): void
  /** Images already on the server (a withdrawn message's) — added as `ready`. */
  addExisting(attachments: readonly SessionAttachment[]): void
  /**
   * A chip that waits on `work` (the preview screenshot): `uploading` now, `ready` with what it
   * resolves to, `error` with its message. Returns false when the message is already full.
   */
  addPending(label: string, work: () => Promise<SessionAttachment>): boolean
  remove(key: string): void
  /** After a send: the chips are the message's now. */
  clear(): void
  /** The `ready` ids, in order — what Send passes. */
  readyIds: string[]
  /** Something is still uploading or capturing: Send waits. */
  busy: boolean
  /** A chip failed: Send waits until it is removed. */
  failed: boolean
  /** No room for another image. */
  full: boolean
  /** Why the last add was refused, or null. */
  notice: string | null
}

const MAX_MB = SESSION_ATTACHMENT_MAX_BYTES / (1024 * 1024)

const objectUrl = (file: Blob): string | null =>
  typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null

const messageOf = (err: unknown) =>
  err instanceof Error && err.message ? err.message : 'The image could not be attached'

export function useComposerAttachments(sessionId: string): ComposerAttachments {
  const [items, setItems] = useState<ComposerAttachment[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const nextKey = useRef(0)
  const local = useRef(new Set<string>())
  // The count as of the last add in this tick: several files pasted at once must not overshoot.
  const count = useRef(0)
  count.current = items.length

  const release = useCallback((urls: readonly (string | null)[]) => {
    for (const url of urls) {
      if (url && local.current.delete(url)) URL.revokeObjectURL(url)
    }
  }, [])

  const patch = useCallback((key: string, next: Partial<ComposerAttachment>) => {
    setItems(current => current.map(item => (item.key === key ? { ...item, ...next } : item)))
  }, [])

  const reserve = useCallback(
    (label: string, previewUrl: string | null): ComposerAttachment | null => {
      if (count.current >= SESSION_ATTACHMENTS_MAX) {
        setNotice(`A message can carry up to ${SESSION_ATTACHMENTS_MAX} images.`)
        return null
      }
      count.current += 1
      const item: ComposerAttachment = {
        key: `a${nextKey.current++}`,
        status: 'uploading',
        id: null,
        contentType: null,
        previewUrl,
        label,
        error: null,
      }
      setItems(current => [...current, item])
      return item
    },
    []
  )

  const addPending = useCallback(
    (label: string, work: () => Promise<SessionAttachment>) => {
      setNotice(null)
      const item = reserve(label, null)
      if (!item) return false
      work().then(
        done =>
          patch(item.key, {
            status: 'ready',
            id: done.id,
            contentType: done.contentType,
            previewUrl: sessionAttachmentPath(sessionId, done.id),
          }),
        err => patch(item.key, { status: 'error', error: messageOf(err) })
      )
      return true
    },
    [patch, reserve, sessionId]
  )

  const addFiles = useCallback(
    (files: readonly File[]) => {
      setNotice(null)
      for (const file of files) {
        if (!isSessionAttachmentMimeType(file.type)) {
          setNotice('Attach a PNG, JPEG, GIF or WebP image.')
          continue
        }
        const preview = objectUrl(file)
        if (preview) local.current.add(preview)
        const item = reserve(file.name || 'Pasted image', preview)
        if (!item) {
          release([preview])
          break
        }
        void (async () => {
          try {
            const small = await downscaleImage(file, SESSION_ATTACHMENT_MAX_EDGE)
            if (small.size > SESSION_ATTACHMENT_MAX_BYTES) {
              throw new Error(`Images must be ${MAX_MB} MB or smaller`)
            }
            const stored = await uploadSessionAttachment(sessionId, small)
            patch(item.key, { status: 'ready', id: stored.id, contentType: stored.contentType })
          } catch (err) {
            patch(item.key, { status: 'error', error: messageOf(err) })
          }
        })()
      }
    },
    [patch, release, reserve, sessionId]
  )

  const addExisting = useCallback(
    (attachments: readonly SessionAttachment[]) => {
      setNotice(null)
      for (const attachment of attachments) {
        const item = reserve('Image', sessionAttachmentPath(sessionId, attachment.id))
        if (!item) break
        patch(item.key, { status: 'ready', id: attachment.id, contentType: attachment.contentType })
      }
    },
    [patch, reserve, sessionId]
  )

  const remove = useCallback(
    (key: string) => {
      setNotice(null)
      setItems(current => {
        release(current.filter(item => item.key === key).map(item => item.previewUrl))
        return current.filter(item => item.key !== key)
      })
    },
    [release]
  )

  const clear = useCallback(() => {
    setNotice(null)
    setItems(current => {
      release(current.map(item => item.previewUrl))
      return []
    })
  }, [release])

  // Another session's page: start empty. Leaving: let the local previews go.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the session id is the trigger
  useEffect(() => clear, [sessionId, clear])

  return useMemo(() => {
    const readyIds = items.flatMap(item => (item.status === 'ready' && item.id ? [item.id] : []))
    return {
      items,
      addFiles,
      addExisting,
      addPending,
      remove,
      clear,
      readyIds,
      busy: items.some(item => item.status === 'uploading'),
      failed: items.some(item => item.status === 'error'),
      full: items.length >= SESSION_ATTACHMENTS_MAX,
      notice,
    }
  }, [items, notice, addFiles, addExisting, addPending, remove, clear])
}
