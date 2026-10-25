import { useEffect, useState } from 'react'
import type { AgentMessage, GptDrawing } from '../data/agents'
import { sentPicture, Thumbnails } from './AgentsImages'

// What a gpt_image call made, under its tool card: a picture (kept with the result, like a sent
// picture, so it is still there when the thread is opened again) or an icon from the library.
// While a picture is drawn: a dotted placeholder the shape of the picture, with an estimate and
// each rough preview as it comes (GptImageDrawing).

type IconResult = { slug: string; url: string; reused: boolean }

function iconOf(content: string): IconResult | null {
  try {
    const v = JSON.parse(content) as { icon?: Partial<IconResult> }
    const i = v.icon
    return i && typeof i.slug === 'string' && /^[a-z0-9_-]{1,64}$/.test(i.slug) ? { slug: i.slug, url: `/api/agents/icons/${i.slug}`, reused: !!i.reused } : null
  } catch {
    return null
  }
}

/**
 * An estimate from the time alone (gpt-image says nothing about how far it is): steady up to 90%
 * at the typical time for this quality and size, then slower and slower, never 100 before it is done.
 */
export function drawingPercent(elapsed: number, expected: number): number {
  const t = Math.max(0, elapsed)
  const e = Math.max(1000, expected)
  const p = t < e ? (90 * t) / e : 90 + 9 * (1 - Math.exp(-(t - e) / e))
  return Math.min(99, Math.floor(p))
}

/** The picture being drawn: same shape as the picture to come; the latest preview fills it once there is one. */
export function GptImageDrawing({ threadId, callId, width, height, drawing, infographic }: { threadId: string; callId: string; width: number; height: number; drawing: GptDrawing; infographic?: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  // Once a second is enough for a whole-number percentage; nothing while the page is hidden.
  useEffect(() => {
    let t = 0
    const run = () => {
      window.clearInterval(t)
      if (document.hidden) return
      setNow(Date.now())
      t = window.setInterval(() => setNow(Date.now()), 1000)
    }
    run()
    document.addEventListener('visibilitychange', run)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', run)
    }
  }, [])
  const [shown, setShown] = useState(0)
  const percent = drawingPercent(now - drawing.startedAt, drawing.expected)
  const src = drawing.previews > 0 ? `/api/agents/threads/${threadId}/gpt-preview/${callId}?n=${drawing.previews}` : null
  return (
    <div className="agt-gpt-drawing" style={{ aspectRatio: `${width} / ${height}` }} role="status" aria-live="polite" aria-busy="true">
      <div className="agt-gpt-dots" aria-hidden="true" />
      {src && <img src={src} alt="" draggable={false} className={shown > 0 ? 'is-shown' : ''} onLoad={() => setShown(drawing.previews)} onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />}
      <span className="agt-image-status">
        {infographic ? 'Drawing the infographic…' : 'Drawing…'} {percent}%{drawing.previews > 0 ? ` · preview ${drawing.previews}` : ''}
        <small>An estimate · use Stop to cancel</small>
      </span>
    </div>
  )
}

export function GptImageResult({ threadId, result, onEdit }: { threadId: string | null; result: AgentMessage; /** Edit: what should change, then the agent draws it again from this picture */ onEdit?: (name: string, ref: string) => void }) {
  const icon = iconOf(result.content)
  if (icon)
    return (
      <div className="agt-gpt-icon">
        <img src={`${icon.url}?m=${result.id}`} alt={icon.slug} width={48} height={48} draggable={false} onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
        <span>
          <code>icon:{icon.slug}</code>
          <span className="muted"> · {icon.reused ? 'from your icon library' : 'new in your icon library'}</span>
        </span>
      </div>
    )
  if (!threadId || !result.attachments?.length) return null
  const toPicture = sentPicture(threadId, result)
  const pictures = result.attachments.flatMap((f, i) => {
    const p = toPicture(f, i)
    // Pictures from before ids existed are still found by where they are kept.
    return p ? [{ picture: p, name: f.name, ref: f.ref ?? `attachment:${result.id}:${i}` }] : []
  })
  const edit = (i: number) => (onEdit && pictures[i] ? [{ label: 'Edit…', onSelect: () => onEdit(pictures[i].name, pictures[i].ref) }] : [])
  return (
    <div className="agt-gpt-picture">
      <Thumbnails pictures={pictures.map((p) => p.picture)} actions={edit} />
      {onEdit && pictures.length > 0 && (
        <button type="button" className="btn btn-small agt-gpt-edit" onClick={() => onEdit(pictures[0].name, pictures[0].ref)} title="Say what should change; the agent draws it again from this picture">
          Edit…
        </button>
      )}
    </div>
  )
}
