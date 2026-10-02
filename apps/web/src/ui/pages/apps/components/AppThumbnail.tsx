/**
 * An app's thumbnail: the screenshot Launch took of its root URL after a deploy went live (Live's,
 * else Staging's — `app.thumbnail` from `GET /api/apps`), or the app's initial on `bg-base-200`
 * when there is none yet or the picture fails to load.
 *
 * The box has a FIXED width and the 16:10 ratio of the 1280×800 capture whichever it shows, so
 * nothing moves when the image arrives; the image is lazy, served by Launch's authed route (never
 * the app's own host). It is decorative beside the app's name, hence `alt=""`; the capture's
 * environment and age are in `title`. One hairline frame, because a white page on a white panel
 * otherwise has no edge.
 */
import type { AppThumbnail as AppThumbnailData } from '@launch/shared/launch-apps'
import { useState } from 'react'
import { formatDateTime } from '@/ui/lib/format'
import { ENV_LABEL } from '../app/appPageModel'
import { v } from './promotionModel'

/** Literal classes, so Tailwind's scanner sees every one. */
const SIZES = {
  xs: 'w-12 text-xs',
  sm: 'w-16 text-sm',
  md: 'w-24 text-base',
  lg: 'w-72 text-3xl',
} as const

export type AppThumbnailSize = keyof typeof SIZES

/** The placeholder's letter: the first letter or digit of the name. Pure. */
export function appInitial(name: string): string {
  const match = name.match(/[\p{L}\p{N}]/u)
  return (match?.[0] ?? '?').toUpperCase()
}

/** "Live v1.4.2, captured 2 Oct 2026, 14:05" — what the picture is of. Pure. */
export function thumbnailTitle(thumbnail: AppThumbnailData): string {
  const version = thumbnail.version ? ` ${v(thumbnail.version)}` : ''
  return `${ENV_LABEL[thumbnail.env]}${version}, captured ${formatDateTime(thumbnail.capturedAt)}`
}

export function AppThumbnail({
  app,
  size = 'sm',
}: {
  app: { displayName: string; thumbnail?: AppThumbnailData | null }
  size?: AppThumbnailSize
}) {
  const thumbnail = app.thumbnail ?? null
  // Keyed on the URL: a new capture gets a fresh chance after an earlier one failed to load.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showImage = thumbnail !== null && failedUrl !== thumbnail.url
  return (
    <span
      className={`relative block shrink-0 aspect-[16/10] overflow-hidden rounded border border-base-300 bg-base-200 ${SIZES[size]}`}
      data-testid="app-thumbnail"
      title={showImage ? thumbnailTitle(thumbnail) : undefined}
    >
      {showImage ? (
        <img
          src={thumbnail.url}
          alt=""
          loading="lazy"
          decoding="async"
          width={1280}
          height={800}
          className="absolute inset-0 w-full h-full object-cover object-top"
          onError={() => setFailedUrl(thumbnail.url)}
        />
      ) : (
        <span
          aria-hidden="true"
          className="absolute inset-0 grid place-items-center font-semibold text-muted"
          data-testid="app-thumbnail-placeholder"
        >
          {appInitial(app.displayName)}
        </span>
      )}
    </span>
  )
}
