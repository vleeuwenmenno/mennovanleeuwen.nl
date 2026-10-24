import { useEffect, useRef, useState } from 'react'
import { discardImageMask, saveImageMask, type AgentMask } from '../data/agentImages'
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
  // Like InpaintDialog: each editor opening is a session. A save that finishes after its editor was
  // cancelled, replaced or unmounted is dropped and its uploaded mask deleted, never handed back.
  const [editing, setEditing] = useState<{ mask: AgentMask; session: number } | null>(null)
  const session = useRef(0)
  useEffect(() => () => { session.current++ }, [])
  const open = (mask: AgentMask) => setEditing({ mask, session: ++session.current })
  const close = () => { session.current++; setEditing(null) }
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
        {threadId && <button type="button" className={`btn btn-small${mask.hand_off ? ' btn-primary' : ''}`} disabled={disabled} title="Fix the selection by hand: brush, erase, grow or shrink it, then save" onClick={() => open(mask)}>{mask.hand_off ? 'Open mask editor' : 'Edit mask'}</button>}
      </figure>
    })}
    {editing && threadId && <AgentsMaskEditor key={editing.session} sourceUrl={editing.mask.source_url} sourceName={editing.mask.target ? `${editing.mask.target}` : 'Picture'} width={editing.mask.width} height={editing.mask.height} initialMaskUrl={editing.mask.mask_url} applyLabel="Save mask"
      onCancel={close}
      onApply={async ({ mask }) => {
        const { mask: from, session: mine } = editing
        const saved = await saveImageMask(threadId, from.source_image_id, mask)
        if (session.current !== mine) { await discardImageMask(saved.id).catch(() => {}); return }
        close()
        onSaved({ mask_id: saved.id, source_image_id: from.source_image_id, coverage: saved.coverage, from })
      }} />}
  </div>
}
