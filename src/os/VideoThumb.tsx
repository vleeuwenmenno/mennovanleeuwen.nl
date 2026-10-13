import type { CSSProperties, ReactNode } from 'react'
import { formatTime } from '../data/media'
import { useVideoThumb } from '../data/videoThumbs'

/**
 * A video's icon: a frame from it (src/data/videoThumbs.ts) with a small ▶ and its length, or
 * `fallback` (the usual icon) while that is being made, when it cannot be, or with video
 * thumbnails switched off in Settings → Apps → Files.
 */
export function VideoThumb({
  path,
  version,
  size = null,
  seafileFirst = true,
  badge = true,
  className = '',
  imgClassName,
  style,
  fallback,
}: {
  path: string | null
  version: string
  size?: number | null
  seafileFirst?: boolean
  badge?: boolean
  className?: string
  imgClassName?: string
  style?: CSSProperties
  fallback: ReactNode
}) {
  const { ref, thumb } = useVideoThumb(path, version, { size, seafileFirst })
  return (
    <span ref={ref} className={`vthumb ${thumb ? 'has-frame' : ''} ${className}`}>
      {thumb ? <img className={imgClassName} src={thumb.url} alt="" draggable={false} style={style} /> : fallback}
      {thumb && badge && (
        <span className="vthumb-badge" aria-hidden>
          ▶{thumb.duration !== null ? <span className="vthumb-time">{formatTime(thumb.duration)}</span> : null}
        </span>
      )}
    </span>
  )
}
