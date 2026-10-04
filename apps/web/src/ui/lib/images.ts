/**
 * Shrinking an image in the browser before it uploads (the session composer's paste, drop and
 * attach). Past a long edge of `SESSION_ATTACHMENT_MAX_EDGE` (1568 px) Anthropic resizes an image
 * anyway, so the extra pixels only cost upload time, R2 bytes and the 5 MB cap.
 *
 * `downscaleSize` and `downscaleType` are the whole policy and pure; `downscaleImage` is the canvas
 * around them, and hands the file back untouched when it is small enough already, when it is a
 * GIF (a canvas keeps only the first frame), or when the browser cannot decode it (jsdom, an odd
 * format) — the server's checks still apply to whatever is sent.
 */

/** The size to draw `width × height` at so its long edge is at most `maxEdge`; null = keep it. Pure. */
export function downscaleSize(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } | null {
  const edge = Math.max(width, height)
  if (!(edge > maxEdge) || width <= 0 || height <= 0) return null
  const scale = maxEdge / edge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * What a downscaled `type` is encoded as — PNG stays PNG (screenshots: sharp text, transparency),
 * WebP stays WebP, everything else becomes JPEG. Pure.
 */
export function downscaleType(type: string): 'image/png' | 'image/webp' | 'image/jpeg' {
  if (type === 'image/png') return 'image/png'
  if (type === 'image/webp') return 'image/webp'
  return 'image/jpeg'
}

/** JPEG/WebP quality for a downscaled photo: no visible loss at this size. */
const LOSSY_QUALITY = 0.85

/** `file` with its long edge at most `maxEdge` (see the header); the original when nothing to do. */
export async function downscaleImage(file: File, maxEdge: number): Promise<File> {
  if (file.type === 'image/gif' || typeof createImageBitmap !== 'function') return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return file
  }
  try {
    const size = downscaleSize(bitmap.width, bitmap.height, maxEdge)
    if (!size) return file
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) return file
    context.drawImage(bitmap, 0, 0, size.width, size.height)
    const type = downscaleType(file.type)
    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, type, type === 'image/png' ? undefined : LOSSY_QUALITY)
    )
    // A browser that cannot encode the type answers another one (or none): keep the original.
    if (!blob || blob.type !== type) return file
    return new File([blob], file.name, { type })
  } finally {
    bitmap.close()
  }
}
