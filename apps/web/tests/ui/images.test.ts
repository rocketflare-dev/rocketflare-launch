/**
 * `ui/lib/images.ts`: the composer's downscale before an upload. The policy is pure and pinned
 * here — the long edge to `SESSION_ATTACHMENT_MAX_EDGE`, the aspect kept, PNG kept for PNG — and
 * `downscaleImage` hands a file back untouched when it cannot (jsdom has no `createImageBitmap`)
 * or should not (a GIF would lose its frames).
 */
import { SESSION_ATTACHMENT_MAX_EDGE } from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'
import { downscaleImage, downscaleSize, downscaleType } from '@/ui/lib/images'

describe('downscaleSize', () => {
  it('shrinks the long edge to the cap and keeps the aspect', () => {
    expect(downscaleSize(3136, 1960, SESSION_ATTACHMENT_MAX_EDGE)).toEqual({
      width: 1568,
      height: 980,
    })
    expect(downscaleSize(1000, 4000, 1568)).toEqual({ width: 392, height: 1568 })
  })

  it('leaves an image already within the cap (or a degenerate one) alone', () => {
    expect(downscaleSize(1568, 1568, 1568)).toBeNull()
    expect(downscaleSize(800, 600, 1568)).toBeNull()
    expect(downscaleSize(0, 0, 1568)).toBeNull()
  })

  it('never rounds an edge to nothing', () => {
    expect(downscaleSize(10_000, 1, 1568)).toEqual({ width: 1568, height: 1 })
  })
})

describe('downscaleType', () => {
  it('keeps PNG and WebP, and makes everything else JPEG', () => {
    expect(downscaleType('image/png')).toBe('image/png')
    expect(downscaleType('image/webp')).toBe('image/webp')
    expect(downscaleType('image/jpeg')).toBe('image/jpeg')
    expect(downscaleType('image/heic')).toBe('image/jpeg')
  })
})

describe('downscaleImage', () => {
  it('hands back the same file when the browser cannot decode it, and always for a GIF', async () => {
    const png = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })
    const gif = new File([new Uint8Array([1, 2, 3])], 'a.gif', { type: 'image/gif' })
    expect(await downscaleImage(png, 1568)).toBe(png)
    expect(await downscaleImage(gif, 1568)).toBe(gif)
  })
})
