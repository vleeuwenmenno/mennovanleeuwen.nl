import { useEffect, useRef, useState } from 'react'
import { saveImageMask, type AgentMask } from '../data/agentImages'
import { AgentsMaskEditor } from './AgentsMaskEditor'
import './AgentsMaskCard.css'

/** What the editor saved: a new owned mask for the same source. */
export type SavedMask = { mask_id: string; source_image_id: string; coverage?: number; from: AgentMask }

/** The mask over its picture, tinted in the theme accent (white selected). Drawn on a small canvas. */
function Tint({ mask }: { mask: AgentMask }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = true
    const image = new Image()
    image.onload = () => {
      const c = canvas.current
      if (!current || !c) return
      const scale = Math.min(1, 480 / Math.max(mask.width, mask.height))
      c.width = Math.max(1, Math.round(mask.width * scale)); c.height = Math.max(1, Math.round(mask.height * scale))
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(image, 0, 0, c.width, c.height)
      const data = ctx.getImageData(0, 0, c.width, c.height)
      for (let i = 0; i < data.data.length; i += 4) { data.data[i + 3] = data.data[i]; data.data[i] = data.data[i + 1] = data.data[i + 2] = 255 }
      ctx.putImageData(data, 0, 0)
      ctx.globalCompositeOperation = 'source-in'
      ctx.fillStyle = getComputedStyle(c).color
      ctx.fillRect(0, 0, c.width, c.height)
    }
    image.onerror = () => { if (current) setFailed(true) }
    image.src = mask.mask_url
    return () => { current = false; image.onload = null; image.onerror = null }
  }, [mask.mask_url, mask.width, mask.height])
  return failed ? <span className="agt-maskcard-gone">Mask no longer available</span> : <canvas ref={canvas} className="agt-maskcard-tint" aria-hidden="true" />
}

const STATUS: Record<string, string> = { used: 'Used', ready: 'Latest', rejected: 'Rejected', superseded: 'Superseded' }

/**
 * Masks the agent made or listed: the picture with the selection tinted, what it selected, and
 * Edit mask (Open mask editor when the agent handed it over), which opens the editor preloaded.
 */
export function MaskCards({ masks, threadId, disabled, onSaved }: { masks: AgentMask[]; threadId: string | null; disabled: boolean; onSaved: (saved: SavedMask) => void }) {
  const [editing, setEditing] = useState<AgentMask | null>(null)
  if (!masks.length) return null
  return <div className="agt-maskcards">
    {masks.map((mask) => {
      const facts = [
        mask.coverage_percent !== undefined ? `${mask.coverage_percent}% of the picture` : '',
        mask.made_by === 'user' ? 'Painted by you' : '',
        mask.status ? STATUS[mask.status] ?? mask.status : '',
      ].filter(Boolean).join(' · ')
      return <figure key={mask.mask_id} className="agt-maskcard">
        <div className="agt-maskcard-picture" style={{ aspectRatio: `${mask.width} / ${mask.height}` }}>
          <img src={mask.source_url} alt="" draggable={false} />
          <Tint mask={mask} />
        </div>
        <figcaption>
          <span className="agt-maskcard-title">{mask.target ? <>Mask: “{mask.target}”</> : 'Mask'}{mask.exclude && <span className="muted"> · keeps “{mask.exclude}”</span>}</span>
          {facts && <span className="muted">{facts}</span>}
          {mask.warning && <span className="t-yellow">{mask.warning}</span>}
        </figcaption>
        {threadId && <button type="button" className={`btn btn-small${mask.hand_off ? ' btn-primary' : ''}`} disabled={disabled} title="Fix the selection by hand: brush, erase, grow or shrink it, then save" onClick={() => setEditing(mask)}>{mask.hand_off ? 'Open mask editor' : 'Edit mask'}</button>}
      </figure>
    })}
    {editing && threadId && <AgentsMaskEditor sourceUrl={editing.source_url} sourceName={editing.target ? `${editing.target}` : 'Picture'} width={editing.width} height={editing.height} initialMaskUrl={editing.mask_url} applyLabel="Save mask"
      onCancel={() => setEditing(null)}
      onApply={async ({ mask }) => {
        const saved = await saveImageMask(threadId, editing.source_image_id, mask)
        setEditing(null)
        onSaved({ mask_id: saved.id, source_image_id: editing.source_image_id, coverage: saved.coverage, from: editing })
      }} />}
  </div>
}
